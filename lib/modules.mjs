// Analysis modules. Each returns { engine, summary, items[] } using the common item shape
// (docs/BACKEND_REQUIREMENTS.md §5). Mock engines are heuristics over the snapshot so the
// API is realistic end to end; OpenAI engines kick in when LLM_PROVIDER=openai.

import { readFileSync, existsSync } from 'node:fs';
import { runRules, ACTION_VERBS } from './rules.mjs';
import { allFields, findQ, firstQ, num, totalSqft, narrativeText, overlap, isPropertyOnlyOrder, words, recTriggered } from './snapshot.mjs';
import { price, GUIDE } from './fees.mjs';
import { keywordCheck } from './narrative.mjs';
import { comparePrior } from './prior.mjs';
import { rulesPack, hazardPack, hazards } from './kb.mjs';
import { compactSnapshot } from './cost.mjs';

let seq = 0;
const mk = (module, o) => ({ id: `${module}_${++seq}`, module, severity: 'warning', status: 'needs_review', evidence: { fields: [], photos: [], text: [] }, proposedWrites: [], confidence: 0.6, reasoning: '', ...o });

// keyword → hazard id (mock photo engine; the real engine is vision)
const HAZARD_KEYWORDS = [
  [/extension cord|daisy|power strip/i, 'extension_cords', 'required', 'Remove daisy-chained extension cords/power strips and provide permanent wiring or outlets as needed.'],
  [/broken|cracked (window|glass)|damaged window/i, 'exterior_damage', 'required', 'Repair or replace broken/cracked window glass.'],
  [/clutter|debris|storage|housekeeping|refuse/i, 'housekeeping', 'required', 'Improve housekeeping, removing all accumulated storage, refuse and debris.'],
  [/loose wiring|exposed wiring|open wiring|wiring/i, 'improvised_wiring', 'required', 'Contract a licensed and insured electrician to inspect the electrical system and enclose any exposed or loose wiring.'],
  [/missing cover|open (panel|box)|missing.*plate/i, 'missing_electrical_covers', 'required', 'Install covers on all open electrical panels and junction boxes.'],
  [/sidewalk|uneven|trip/i, 'sidewalks_and_walkways', 'advisory', 'Restore sidewalks to a smooth and even condition, eliminating trip hazards.'],
  [/graffiti/i, 'graffiti', 'advisory', 'Remove graffiti from the building exterior.'],
  [/bbq|grill/i, 'bbq_units', 'required', 'Relocate barbecue grills at least 10 feet from the building and combustibles.'],
  [/handrail/i, 'missing_handrails', 'advisory', 'Install graspable handrails on all stairways.'],
  [/mold/i, 'mold', 'required', 'Have a qualified contractor remediate the mold and correct the moisture source.'],
  [/snow|ice/i, 'sidewalks_and_walkways', 'advisory', 'Provide for regular snow and ice removal on exterior walking areas.'],
  [/ponding|roof.*(damage|leak)/i, 'ponding', 'required', 'Have a licensed and insured roofing contractor inspect the roof and repair as needed.'],
  [/tape.*breaker|breaker.*tape/i, 'tape_on_breakers', 'required', 'Remove tape from breakers and have an electrician correct any tripping circuits.'],
  [/zinsco|stab.?lok|federal pacific/i, 'zinsco_breakers', 'required', 'Have a licensed electrician replace the Zinsco/Stab-Lok panel.'],
  [/expired|no (inspection )?tag/i, 'tools_spare_heads_and_tags', 'required', 'Provide for contracted annual inspection of the sprinkler system / extinguishers.'],
  [/water heater/i, 'water_heater_straps', 'advisory', 'Strap water heaters per local code.'],
];
const GENERIC_NAME = /(^|[\s-])(img|dsc|dscn|pxl|photo|image)[_-]?\d{2,}|^\d{6,}$|^[^a-z]*$/i;
// "130 east 72nd st-IMG_3699 basement clutter" → "basement clutter"
const cleanCaption = c => String(c || '').replace(/^.*?\b(img|dsc|dscn|pxl)[_-]?\d+\s*/i, '').replace(/^[\d\s\w.-]*?\b(st|street|ave|avenue|rd|road)\.?-/i, '').trim();

function photoMock(snap) {
  const recText = (snap.recommendations || []).map(r => r.text).join(' \n ');
  const items = [];
  const strapState = ['NV', 'ID', 'MT', 'WY', 'AZ', 'AR', 'TX', 'WA'].includes(snap.order?.geo?.state || (snap.order?.location || '').match(/,\s*([A-Z]{2})\b/)?.[1]);
  for (const p of snap.photos || []) {
    for (const [re, hz, sev, rec] of HAZARD_KEYWORDS) {
      if (!re.test(p.caption || '')) continue;
      if (hz === 'water_heater_straps' && !strapState) break;   // KB: strap screening only in listed states
      const covered = (snap.recommendations || []).some(r => overlap(r.text, rec) > 0.25 || overlap(r.text, p.caption) > 0.34);
      items.push(mk('photoReview', {
        title: covered ? `Hazard covered by a rec: ${hz}` : `Possible hazard without a recommendation: ${hz}`,
        message: `Photo ${p.imageId} "${p.caption}" suggests ${hz.replace(/_/g, ' ')}.`, hazardType: hz, hazardSeverity: sev,
        severity: covered ? 'info' : sev === 'required' ? 'blocker' : 'advisory', status: covered ? 'pass' : 'fail',
        coveredByRec: covered, suggestedRec: covered ? null : rec, evidence: { photos: [p.imageId] }, confidence: 0.55,
        reasoning: 'MOCK: inferred from the caption only. The vision engine reviews the image.' }));
      break;
    }
    if (p.markedHazard && !items.some(i => i.evidence.photos.includes(p.imageId)) && !overlap(recText, p.caption))
      items.push(mk('photoReview', { title: 'Inspector marked this photo as a hazard but no rec covers it', message: `Photo ${p.imageId} "${p.caption}"`,
        severity: 'warning', status: 'fail', evidence: { photos: [p.imageId] }, confidence: 0.7 }));
  }
  if (isPropertyOnlyOrder(snap))
    for (const p of snap.photos || []) if (/pool|exit sign|playground|sidewalk/i.test(p.caption || ''))
      items.push(mk('photoReview', { title: 'GL-focused photo on a property-only order', message: `Consider removing photo ${p.imageId} "${p.caption}".`, severity: 'advisory', status: 'fail', evidence: { photos: [p.imageId] }, confidence: 0.6 }));
  return items;
}

export const MOCK = {
  async orderBrief(snap) {
    const of = snap.order?.orderForm || {}, rp = rulesPack(snap);
    const facts = { total_sqft: firstQ(snap, 'total_sqft')?.value, units: firstQ(snap, 'units')?.value, stories: firstQ(snap, 'stories')?.value,
      year_built: firstQ(snap, 'year_built')?.value, iso_class: firstQ(snap, 'iso_class')?.value, sprinklered: firstQ(snap, 'sprinklered')?.value };
    return { engine: 'rules', summary: { client: snap.order?.client, kbClient: rp.clientKey, location: snap.order?.location, requestType: of.requestType,
      coverages: of.coverages, liability: of.liability, photosRequired: of.photosRequired, diagramRequired: of.diagramRequired,
      underwriterInstructions: of.additionalInstructions || null, keyFacts: facts, priorReports: snap.priorReports || [],
      forms: (snap.forms || []).map(f => f.name), rulesApplied: rp.formsUsed }, items: [] };
  },

  async checks(snap, ctx) {
    const items = runRules(snap, ctx.rules);
    return { engine: 'rules', summary: { rulesEvaluated: ctx.rules.length, failed: items.length }, items };
  },

  // No backup check for the underwriter's instructions (removed 2026-11-10 at TIS's request): word matching could
  // not tell whether a request was answered and turned table rows and headings into findings. Without the AI the
  // instructions are still shown on Overview, and the AI note lists "underwriter concerns" as not checked.
  async uwConcerns(snap) {
    const instr = snap.order?.orderForm?.additionalInstructions;
    return { engine: 'rules', summary: { concerns: 0, notChecked: !!instr }, items: [] };
  },

  async photoReview(snap, ctx) {
    const items = photoMock(snap);
    // without the AI only the caption can hint that a photo came from an online map
    for (const p of snap.photos || []) if (/street ?view|google|screen ?shot/i.test(p.caption || ''))
      items.push(mk('photoReview', { kind: 'photo_source', source: 'street_view', title: 'Photo may be from Street View', message: `Caption "${p.caption}". Check that the inspector took this photo on site.`,
        severity: 'advisory', status: 'fail', evidence: { photos: [p.imageId] }, confidence: 0.5 }));
    return { engine: 'mock', summary: { vision: false, photos: (snap.photos || []).length, hazards: items.length, missed: items.filter(i => i.status === 'fail').length }, items };
  },

  async recommendations(snap, ctx) {
    const items = [];
    // (a) flagged answers with an empty rec box
    for (const f of allFields(snap)) {
      if (!f.rec || f.rec.box === 'none' || f.omitted || f.internal) continue;   // no box on this form: nothing to fill
      if (recTriggered(f) && !String(f.rec.text || '').trim())
        items.push(mk('recommendations', { title: 'Answer triggers a recommendation but the rec box is empty', kind: 'missing', source: 'flagged_answer',
          message: `"${f.label}" = ${f.value}`, severity: 'blocker', status: 'fail', evidence: { fields: [f.key] },
          proposedWrites: [f.rec.list && f.rec.line ? { key: f.rec.key, value: f.rec.line, kind: 'recLine' }   // Seneca shared hazard list
            : { key: f.rec.key, value: `[[draft]] Correct the condition noted: ${f.label.replace(/\?$/, '').slice(0, 120)}.`, kind: 'rec' }], confidence: 0.6 }));
    }
    // (b) missed photo hazards → new free-form recs
    const pr = ctx.results.photoReview?.items || [];
    for (const h of pr.filter(i => i.status === 'fail' && i.suggestedRec))
      items.push(mk('recommendations', { title: `New recommendation from photo hazard (${h.hazardType})`, kind: 'missing', source: 'photo_hazard', requirement: h.hazardSeverity,
        message: h.suggestedRec, severity: h.hazardSeverity === 'required' ? 'warning' : 'advisory', status: 'fail', evidence: { photos: h.evidence.photos },
        proposedWrites: [{ key: 'F14:new', value: h.suggestedRec, kind: 'rec' }, { key: 'RECIMAGEID_F14:new', value: `${h.evidence.photos[0]}t.jpg`, kind: 'recImage' }], confidence: h.confidence }));
    // (c) quality / applicability from the rule engine (no duplicate check: removed 2026-11-13)
    for (const it of runRules(snap, ctx.rules, { only: ['recs.style', 'recs.emergency_lighting_applicability', 'recs.rating_vs_recs'] })) {
      const rec = (snap.recommendations || []).find(r => it.evidence.fields?.[0] === r.key);
      // wording fix only when dropping "Recommend (that)" leaves a rec that starts with an action verb; otherwise the
      // card just flags it (it used to offer "[[rewrite]] Observed wall damage…" as an Apply, 2026-11-10)
      const stripped = rec && it.ruleRef.startsWith('recs.style') ? rec.text.trim().replace(/^recommend(ed|ation)?( that)?\s*/i, '').replace(/^\w/, c => c.toUpperCase()) : null;
      const fix = stripped && stripped !== rec.text.trim() && ACTION_VERBS.test(stripped) ? stripped : null;
      items.push({ ...it, module: 'recommendations', kind: it.ruleRef.split('@')[0].split('.')[1],
        proposedWrites: fix ? [{ key: rec.key, value: fix, kind: 'rec' }] : it.ruleRef.startsWith('recs.style') ? [] : it.proposedWrites });
    }
    return { engine: 'mock', summary: { missing: items.filter(i => i.kind === 'missing').length, total: items.length }, items };
  },

  async recPhotos(snap) {
    const items = [];
    const marked = (snap.photos || []).filter(p => p.markedHazard);
    for (const r of (snap.recommendations || []).filter(r => String(r.text || '').trim() && !r.imageOptionValue)) {
      const absent = /^(install|provide|post|obtain|have a documented)/i.test(r.text) && !/repair|replace|remove|restore/i.test(r.text);
      const ranked = (snap.photos || []).map(p => ({ p, s: overlap(r.text, cleanCaption(p.caption)) + (p.markedHazard ? 0.1 : 0) })).sort((a, b) => b.s - a.s);
      const best = ranked[0];
      if (!best || best.s < 0.45) {
        items.push(mk('recPhotos', { title: `${r.number || '“' + r.text.slice(0, 44) + (r.text.length > 44 ? '…”' : '”')}: no matching photo`, message: absent ? 'Item is absent (nothing to photograph): no photo needed.' : 'No photo clearly matches. Pick one manually.',
          noPhotoNeeded: absent, severity: absent ? 'info' : 'warning', status: absent ? 'pass' : 'needs_review', evidence: { fields: [r.key] }, confidence: 0.4 }));
        continue;
      }
      const opt = (r.imageOptions || []).find(o => o.startsWith(best.p.imageId)) || `${best.p.imageId}t.jpg`;
      items.push(mk('recPhotos', { title: `${r.number || '“' + r.text.slice(0, 44) + (r.text.length > 44 ? '…”' : '”')}: attach photo ${best.p.imageId}`, message: `"${best.p.caption}" ↔ "${r.text.slice(0, 70)}"`,
        severity: 'warning', status: 'fail', evidence: { fields: [r.key], photos: [best.p.imageId] }, alternatives: ranked.slice(1, 4).map(x => x.p.imageId),
        proposedWrites: [{ key: 'RECIMAGEID_' + r.key, value: opt, kind: 'recImage' }], confidence: Math.min(0.9, 0.4 + best.s) }));
    }
    return { engine: 'mock', summary: { recsWithoutPhoto: items.length, markedHazardPhotos: marked.length }, items };
  },

  async questions(snap, ctx) {
    const items = [];
    const hz = ctx.results.photoReview?.items || [];
    for (const f of allFields(snap).filter(f => f.type === 'choice' && !f.omitted && !f.internal)) {
      if (/housekeeping/i.test(f.label) && /^(yes|good|satisfactory)/i.test(f.value || '') && hz.some(h => h.hazardType === 'housekeeping' && (h.status === 'fail' || h.recDrafted)))
        items.push(mk('questions', { title: f.label, status: 'fail', current: f.value, suggested: 'No', kind: 'differ', severity: 'warning',
          message: 'Photos show housekeeping problems.', evidence: { fields: [f.key], photos: hz.filter(h => h.hazardType === 'housekeeping').flatMap(h => h.evidence.photos) },
          proposedWrites: [{ key: f.key, value: 'No', kind: 'choice' }], confidence: 0.55 }));
      else if (!String(f.value || '').trim() && f.required)
        items.push(mk('questions', { title: f.label, status: 'fail', current: '', suggested: null, kind: 'fill', severity: 'warning', message: 'Required question is blank.', evidence: { fields: [f.key] }, confidence: 0.9 }));
    }
    for (const it of runRules(snap, ctx.rules, { only: ['general.veneer_backing_yes', 'general.veneer_backing_no', 'general.vacancy_utilities', 'general.aluminum_wiring_1965_1975'] }))
      items.push({ ...it, module: 'questions', kind: 'logic' });
    return { engine: 'mock', summary: { differ: items.filter(i => i.kind === 'differ').length, fill: items.filter(i => i.kind === 'fill').length, logic: items.filter(i => i.kind === 'logic').length }, items };
  },

  async captions(snap, ctx) {
    const items = [];
    for (const p of snap.photos || []) {
      const ins = ctx.photoInsights?.[p.imageId];
      let cap = p.caption || '';
      let suggested = ins?.suggestedCaption || null;
      if (!suggested) {
        const cleaned = cleanCaption(cap);
        if (GENERIC_NAME.test(cap) || cleaned !== cap) suggested = cleaned ? cleaned.replace(/^\w/, c => c.toUpperCase()) : '[[describe photo]]';
      }
      if (suggested && suggested !== cap)
        items.push(mk('captions', { title: `Rename photo ${p.imageId}`, message: `"${cap}" → "${suggested}"`, current: cap, suggested, severity: 'advisory', status: 'fail',
          evidence: { photos: [p.imageId] }, proposedWrites: [{ key: `caption${p.imageId}`, value: suggested, kind: 'caption' }], confidence: ins ? 0.85 : 0.5 }));
    }
    return { engine: ctx.photoInsights ? 'openai' : 'mock', summary: { renames: items.length }, items };
  },

  async narrative(snap, ctx) {
    const text = narrativeText(snap);
    const items = [];
    for (const it of runRules(snap, ctx.rules, { only: ['general.sqft_consistency'] })) items.push({ ...it, module: 'narrative', kind: 'contradiction' });
    const occ = firstQ(snap, 'occupancy_pct');
    if (occ && /100%\s*(occupied|occupancy)/i.test(text) && num(occ.value) != null && num(occ.value) < 100)
      items.push(mk('narrative', { kind: 'contradiction', title: 'Narrative says 100% occupied', message: `Form says ${occ.value}.`, severity: 'blocker', status: 'fail', evidence: { fields: [occ.key] }, confidence: 0.85 }));
    // narrative states something positive that a form answer contradicts (form wins)
    for (const [re, q, bad] of [[/housekeeping (is|was) (good|acceptable|satisfactory)/i, 'housekeeping', 'No'], [/sprinklered throughout|fully sprinklered|100% sprinklered/i, 'sprinklered', /partial|no/i]]) {
      if (!re.test(text)) continue;
      const f = findQ(snap, q).find(x => x.type === 'choice' && (bad instanceof RegExp ? bad.test(x.value || '') : x.value === bad));
      if (f) items.push(mk('narrative', { kind: 'contradiction', title: `Narrative contradicts "${f.label.slice(0, 60)}"`, message: `Narrative: "${text.match(re)[0]}". Form answer: ${f.value}${f.comment?.value ? ' (' + f.comment.value + ')' : ''}. The form wins.`,
        severity: 'blocker', status: 'fail', checklistItem: '5.2', evidence: { fields: [f.key] }, confidence: 0.85 }));
    }
    // TIS building question set + ordered coverages (GLOBAL-001), by keyword: the AI step does this properly
    const kc = keywordCheck(snap, text);
    if (text && kc.missing.length) items.push(mk('narrative', { kind: 'missing_required', title: `Narrative may not cover ${kc.missing.length} question${kc.missing.length > 1 ? 's' : ''} of the TIS question set`,
      message: kc.missing.map(q => q.q.replace(/\?.*$/, '?')).join(' · '), severity: 'advisory', status: 'fail', checklistItem: '5.3', confidence: 0.4, questions: kc.missing.map(q => q.id) }));
    for (const c of kc.coverageGaps) items.push(mk('narrative', { kind: 'coverage', title: `Not addressed: ${c.rule.label}`,
      message: `${c.label} is ordered${c.section ? ` (section ${c.section})` : ' and has no dedicated section'}, so the narrative should cover it (GLOBAL-001). Add: ${c.rule.topics}.`, severity: 'warning', status: 'fail', checklistItem: '5.3', confidence: 0.5, rule: 'GLOBAL-001' }));
    if (!text) items.push(mk('narrative', { kind: 'missing_required', title: 'Narrative is empty', severity: 'blocker', status: 'fail', confidence: 0.99 }));
    return { engine: 'mock', summary: { issues: items.length }, items };
  },

  async qcChecklist(snap, ctx) {
    const all = Object.values(ctx.results).flatMap(r => r.items || []).filter(i => i.checklistItem);
    const ITEMS = { '1.1': 'Square Footage consistent - Narrative, diagram, form', '1.2': 'Square footage matches prior report/ order form', '1.3': 'Square footage matches number of apartments',
      '1.4': 'Square footage checks out on Google Earth', '1.5': 'Square Footage of vacant areas correct', '2.1': 'ISO class consistent - Narrative, diagram, form', '2.2': 'Brick Veneer question matches ISO class',
      '2.3': 'ISO class matches photos', '2.4': 'ISO class matches prior report/ order form', '3.1': 'Inspector got access to all areas (if not why?)', '3.2': 'Questions for areas not accessed marked U/D or with appropriate comments',
      '3.3': 'Risk heated or utilities shut off', '3.4': 'Aluminum Wiring question correct', '3.5': 'Zinsco and Stab Lok questions correct', '3.6': 'Sprinkler Sections matches photos', '3.7': 'Sprinkler section matches prior reports',
      '4.1': 'Photos free of hazards without recs - and photos labeled', '4.2': 'Commercial cooking tag photos match form', '4.3': 'Photos match Coverage - No GL on property only', '4.4': 'Rec have photos attached',
      '5.1': 'Recs not redundant and match coverage', '5.2': 'Narrative matches the rest of the report (SF, ISO, Hazards)', '5.3': 'Narrative describes operations', '5.4': 'U/W concerns addressed in U/W concerns box' };
    const missed = (ctx.results.photoReview?.items || []).filter(i => i.status === 'fail' && i.severity !== 'advisory').length;
    const uwOpen = (ctx.results.uwConcerns?.items || []).filter(i => i.status === 'fail').length;
    // 1.4 is measured by hand on satellite imagery; the panel's square-footage helper links Google Earth at the address
    const sf = totalSqft(snap), stories = num(firstQ(snap, 'stories')?.value);
    const footprint = sf && stories ? Math.round(sf / stories).toLocaleString('en-US') : null;
    const manualNote = `Measure on Google Earth (Checks tab → Square footage)${footprint ? `: the outline should be about ${footprint} sf` : ''}.`;
    const items = Object.entries(ITEMS).map(([id, label]) => {
      let fails = all.filter(i => i.checklistItem === id && i.status === 'fail' && i.severity !== 'info');
      if (id === '4.1' && missed) fails = fails.concat([{ id: 'photoReview' }]);
      if (id === '5.4' && uwOpen) fails = fails.concat([{ id: 'uwConcerns' }]);
      const manual = id === '1.4';
      return mk('qcChecklist', { checklistItem: id, title: label, status: manual ? 'needs_review' : fails.length ? 'fail' : 'pass',
        severity: fails.length ? 'warning' : 'info', message: manual ? manualNote : fails.length ? `${fails.length} open item(s)` : 'No issues found',
        evidence: { items: fails.map(f => f.id) }, confidence: manual ? 0 : fails.length ? 0.8 : 0.7 });
    });
    const sec6 = { squareFootage: items.some(i => i.checklistItem.startsWith('1.') && i.status === 'fail'), iso: items.some(i => i.checklistItem.startsWith('2.') && i.status === 'fail'),
      missedHazards: missed > 0, operationsNotDescribed: (ctx.results.narrative?.items || []).some(i => /operations/.test(i.title)), narrative: (ctx.results.narrative?.items || []).some(i => i.kind === 'contradiction') };
    const failsN = items.filter(i => i.status === 'fail').length;
    const rating = Math.max(2, Math.min(10, 10 - Math.ceil(failsN / 2) - Math.min(2, missed)));   // heuristic; TIS rates subjectively
    return { engine: 'derived', summary: { section6: sec6, rating, ratingReason: `${failsN} checklist items with open issues, ${missed} missed hazards.`,
      section8Draft: [sec6.squareFootage && 'Square footage inconsistencies.', missed && `${missed} hazard(s) in photos without recommendations.`, uwOpen && 'Underwriter concerns not fully answered.'].filter(Boolean).join(' ') }, items };
  },

  // TIS Client and Inspector Pricing Guide (rules/pricing.json, lib/fees.mjs). Suggestions only: QC enters fees in EZ.
  async pricing(snap) {
    const r = price(snap);
    const $ = n => n == null ? '–' : '$' + (Number.isInteger(n) ? n : n.toFixed(2));
    const items = [];
    const compare = (what, expected, entered, lines, extra = {}) => {
      if (expected == null) return;
      const why = lines.join(' · ');
      if (!entered) items.push(mk('pricing', { kind: what, title: `${what === 'inspector' ? 'Inspector pay' : 'Client fee'}: ${extra.minimum ? 'at least ' : ''}${$(expected)}`, message: `Not entered in EZ yet. ${why}.`, severity: 'info', status: 'needs_review', confidence: 0.8 }));
      // the guide gives the inspector a MINIMUM (plus hours / travel / an amount in the notes): more than that is the
      // inspector's own rate (22-order test: $87.50–$192.50 entered on a $70 minimum), only less is a problem
      else if (extra.minimum) { if (entered < expected - 0.01) items.push(mk('pricing', { kind: what, title: `Inspector pay is below the ${$(expected)} minimum`, message: `EZ has ${$(entered)}. ${why}.`, severity: 'warning', status: 'fail', confidence: 0.8 })); }
      else if (Math.abs(entered - expected) >= 0.01) items.push(mk('pricing', { kind: what, title: `${what === 'inspector' ? 'Inspector pay' : 'Client fee'} should be ${$(expected)}`, message: `EZ has ${$(entered)}. ${why}.`, severity: 'warning', status: 'fail', confidence: 0.8 }));
    };
    compare('inspector', r.inspector.amount, r.inspector.entered, r.inspector.lines, { minimum: r.inspector.basis === 'minimum' && !r.inspector.travel });
    compare('client', r.client.amount, r.client.entered, [r.client.schedule, ...r.client.lines, r.client.keyedOnEntered ? '' : r.client.lines.some(l => /inspector fee/.test(l)) ? 'band uses the expected inspector pay' : ''].filter(Boolean));
    const ft = r.feeType;
    if (ft.expected && !ft.selected)
      items.push(mk('pricing', { kind: 'feeType', title: 'Order not priced yet', message: `Suggested fee type: "${ft.expected}".`, severity: 'info', status: 'needs_review', confidence: 0.8 }));
    else if (ft.expected && ft.selected !== ft.expected)
      items.push(mk('pricing', { kind: 'feeType', title: 'Fee type looks wrong', message: `Selected "${ft.selected}", expected "${ft.expected}" (${r.client.lines.join(' · ')}).`, severity: 'advisory', status: 'fail', confidence: 0.8 }));
    for (const note of r.client.review || []) items.push(mk('pricing', { kind: 'review', title: 'Check pricing by hand', message: note, severity: 'advisory', status: 'needs_review', confidence: 0.5 }));
    for (const a of r.client.actions || []) items.push(mk('pricing', { kind: 'action', title: 'Pricing step', message: a, severity: 'info', status: 'needs_review', confidence: 0.9 }));
    return { engine: 'rules', summary: {
      guide: GUIDE.version, schedule: r.client.schedule, request: r.kind.requestType, limited: r.kind.limited, nyc: r.kind.nyc, sqft: r.kind.sqft, buildings: r.kind.buildings,
      inspector: { expected: r.inspector.amount, entered: r.inspector.entered, lines: r.inspector.lines, minimum: r.inspector.basis === 'minimum' && !r.inspector.travel },
      client: { expected: r.client.amount, entered: r.client.entered, lines: r.client.lines, review: r.client.review },
      feeType: { selected: ft.selected, expected: ft.expected } }, items };
  },

  // Latest earlier survey of the same risk ("Matches:") vs this order: square footage, ISO class, sprinkler coverage
  // (lib/prior.mjs). The extension reads the prior order's forms; the server keeps only these facts.
  async priorReport(snap) {
    const cmp = comparePrior(snap);
    if (!cmp) return { engine: 'rules', summary: { priorReports: 0 }, items: [] };
    if (cmp.prior.error) return { engine: 'rules', summary: { priorReports: 1, prior: cmp.prior, rows: [] }, items: [] };
    const p = cmp.prior, ref = `prior report ${p.orderId}${p.date ? ` (${p.date})` : ''}`;
    const what = { sqft: 'Square footage', iso: 'ISO class', sprinkler: 'Sprinkler coverage' };
    const items = cmp.rows.filter(r => r.same === false && !r.info).map(r => {
      // a big square-footage jump with no building counts to explain it: say it may be another property / scope
      const big = r.key === 'sqft' && (() => { const a = Number(String(r.prior).replace(/,/g, '')), b = Number(String(r.current).replace(/,/g, '')); return a && b && Math.max(a, b) / Math.min(a, b) > 2; })();
      return mk('priorReport', { kind: r.key, title: `${what[r.key]} differs from the ${ref}`,
        message: `Prior report = ${r.prior} · current = ${r.current}. ${big ? 'A difference this large often means the prior report covered other buildings or another property: check the scope first, then explain or correct.' : 'Explain the change in the report or correct it.'}`, before: null, after: null,
        severity: 'warning', status: 'fail', checklistItem: r.checklistItem, confidence: big ? 0.6 : 0.85, evidence: { fields: [], photos: [], text: [] } });
    });
    for (const r of cmp.rows.filter(r => r.scope)) items.push(mk('priorReport', { kind: 'scope', title: `Square footage: different scope from the ${ref}`,
      message: `Prior report = ${r.prior} · current = ${r.current}. ${r.scope}`, severity: 'advisory', status: 'needs_review', checklistItem: r.checklistItem, confidence: 0.7, evidence: { fields: [], photos: [], text: [] } }));
    return { engine: 'rules', summary: { priorReports: (snap.priorReports || []).length, prior: p, rows: cmp.rows }, items };
  },
};

