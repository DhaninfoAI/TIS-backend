// Deterministic rule engine for the `checks` module.
// DSL rules are generic (form-registry key questions); code rules are below.

import { allFields, findQ, firstQ, num, totalSqft, narrativeText, isGLOrder, isPropertyOnlyOrder, formType, overlap } from './snapshot.mjs';

const ACTION_VERBS = /^(install|provide|repair|replace|remove|have|contract|ensure|maintain|improve|post|restore|secure|clear|relocate|eliminate|obtain|repaint|re-?secure|cover|label|test|service|inspect|seal|trim|mount|fill|fix|enclose|discontinue|keep|store|add|implement|schedule|establish|clean|retain|engage|correct|reinstall|block|board|close)\b/i;

function item(rule, extra) {
  return { id: rule.id + (extra.suffix ? ':' + extra.suffix : ''), module: 'checks', ruleRef: rule.id + '@v' + (rule.__version || 1),
           severity: extra.severity || rule.severity, checklistItem: extra.checklistItem || rule.checklistItem, status: 'fail', title: rule.message,
           message: extra.message || rule.message, evidence: { fields: [], photos: [], text: [], ...(extra.evidence || {}) },
           proposedWrites: extra.proposedWrites || [], confidence: extra.confidence ?? 0.95, reasoning: extra.reasoning || '' };
}

const val = f => String(f?.value ?? '').trim();

function evalDsl(rule, snap) {
  const when = findQ(snap, rule.when.q).filter(f => val(f) === rule.when.equals);
  const out = [];
  for (const w of when) {
    const targets = findQ(snap, rule.then.q).filter(t => t.form === w.form && t.sectionId === w.sectionId);
    for (const t of targets) {
      const v = val(t);
      const bad = rule.then.notIn ? rule.then.notIn.includes(v) : rule.then.in ? !rule.then.in.includes(v) : false;
      if (bad) out.push(item(rule, { suffix: t.key, evidence: { fields: [w.key, t.key] },
        message: `${rule.message} ("${w.label}" = ${val(w)}; "${t.label}" = ${v || 'blank'}).`,
        proposedWrites: rule.then.in ? [{ key: t.key, value: rule.then.in[0], kind: 'choice' }] : [] }));
    }
  }
  return out;
}

const code = {
  'general.sqft_per_unit'(rule, snap) {
    const total = totalSqft(snap);
    const units = num(firstQ(snap, 'units')?.value);
    if (!total || !units) return [];
    const comm = num(firstQ(snap, 'commercial_sqft')?.value) || 0;
    const { min, max, commonAreaFactor } = rule.params;
    const per = Math.round((total - comm) * commonAreaFactor / units);
    if (per >= min && per <= max) return [];
    return [item(rule, { evidence: { fields: [firstQ(snap, 'total_sqft').key, firstQ(snap, 'units').key].filter(k => /^F\d/.test(k)) },
      message: `(${total.toLocaleString()} − ${comm.toLocaleString()}) × ${commonAreaFactor} ÷ ${units} units = ${per.toLocaleString()} sf/unit (expected ${min}–${max}).`,
      confidence: 0.99, reasoning: 'Ballpark check from TIS: flag for a human, not an error by itself.' })];
  },
  'general.sqft_consistency'(rule, snap) {
    const formSf = totalSqft(snap);
    if (!formSf) return [];
    const narr = narrativeText(snap);
    const narrNums = [...narr.matchAll(/([\d,]{3,})[- ]square[- ]f(oo|ee)t|([\d,]{3,})\s*(sq\.? ?ft|sf)\b/gi)]
      .map(m => num(m[1] || m[3])).filter(Boolean);
    const out = [];
    const off = narrNums.filter(n => Math.abs(n - formSf) / formSf > 0.05);
    if (off.length) out.push(item(rule, { suffix: 'narrative', evidence: { fields: [firstQ(snap, 'total_sqft').key].filter(k => /^F\d/.test(k)), text: off.map(String) },
      message: `Narrative states ${off.map(n => n.toLocaleString()).join(', ')} sf but the form says ${formSf.toLocaleString()} sf.` }));
    // the prior-report comparison lives in the priorReport step (lib/prior.mjs), so it isn't reported twice
    if (snap.diagram?.sqft && Math.abs(snap.diagram.sqft - formSf) / formSf > 0.05)
      out.push(item(rule, { suffix: 'diagram', message: `Diagram dimensions give ${snap.diagram.sqft.toLocaleString()} sf vs ${formSf.toLocaleString()} sf on the form.` }));
    return out;
  },
  'general.vacancy_utilities'(rule, snap) {
    // The form's "If building is vacant…" questions refer to the WHOLE building (TIS walkthrough).
    const util = firstQ(snap, 'utilities_vacant');
    if (!util) return [];
    const u = val(util);
    const occF = firstQ(snap, 'occupancy_pct'), occ = num(occF?.value);
    const fullyVacant = occ === 0 || /fully vacant|100% vacant|entirely vacant/i.test(String(occF?.value || '') + ' ' + String(occF?.comment?.value || ''));
    const fullyOccupied = occ === 100 && !num(firstQ(snap, 'vacant_units')?.value);
    if (fullyOccupied && u && u !== 'N/A')
      return [item(rule, { evidence: { fields: [util.key, occF.key] }, message: `Building is 100% occupied, but "${util.label}" is answered "${u}". Either vacancy is missing elsewhere or this should be N/A.`,
        proposedWrites: [{ key: util.key, value: 'N/A', kind: 'choice' }] })];
    if (fullyVacant && (!u || u === 'N/A'))
      return [item(rule, { evidence: { fields: [util.key, occF.key] }, message: `Building is fully vacant but "${util.label}" is ${u || 'blank'}. State which utilities remain on (heat off + water on = freeze hazard).` })];
    if (fullyVacant && /water/i.test(u) && !/heat/i.test(u))
      return [item(rule, { severity: 'blocker', evidence: { fields: [util.key] }, message: `Vacant building with water on and heat off (${u}): freeze hazard. A recommendation is required.` })];
    return [];
  },
  'general.aluminum_wiring_1965_1975'(rule, snap) {
    const yb = num(firstQ(snap, 'year_built')?.value);
    if (!yb || yb < 1965 || yb > 1975) return [];
    const units = num(firstQ(snap, 'units')?.value) || 0;
    if (units < 3 && !/apartment|mixed/i.test(snap.order?.orderForm?.natureOfBusiness || '')) return [];
    return findQ(snap, 'aluminum_wiring').filter(f => !/^\d+\.\s*if "?no"? to the above/i.test(f.label))   // follow-up Q is legitimately N/A
      .filter(f => ['', 'N/A'].includes(val(f)))
      .map(f => item(rule, { suffix: f.key, evidence: { fields: [f.key] }, message: `Built ${yb}: "${f.label}" cannot be ${val(f) || 'blank'}.` }));
  },
  'order.form_vs_coverage'(rule, snap) {
    const types = (snap.forms || []).map(f => formType(f.name).type);
    const out = [];
    if (isGLOrder(snap) && types.includes('property_only') && !types.includes('general'))
      out.push(item(rule, { message: `Order coverage is ${(snap.order.orderForm.coverages || []).join(', ')} + ${(snap.order.orderForm.liability || []).join(', ') || 'liability'}, but only a Property-Only form is attached. The GL sections are missing.` }));
    if (isPropertyOnlyOrder(snap) && types.includes('general') && !types.includes('property_only'))
      out.push(item(rule, { severity: 'warning', message: 'Order is Monoline Property but the full General Form (with GL sections) is attached. Omit the liability sections.' }));
    return out;
  },
  'order.omit_sections_vs_coverage'(rule, snap) {
    const of = snap.order?.orderForm || {};
    const liab = (of.liability || []).join(' ');
    const checks = [
      [/professional liability/i, !/professional/i.test(liab), 'Professional liability not ordered'],
      [/auto liability/i, !/auto/i.test(liab), 'Auto liability not ordered'],
      // only the General Form's "Crime (omit unless Crime is checked…)": the Hotel & Motel "Crime" section is guest security
      [/^crime.*omit unless/i, !of.crime, 'Crime not ordered'],
      [/liability hazards/i, isPropertyOnlyOrder(snap), 'Property-only order'],
    ];
    const out = [];
    for (const form of snap.forms || []) for (const s of form.sections || []) {
      for (const [re, cond, why] of checks)
        if (!s.omitted && re.test(s.title || '') && cond && (s.fields || []).some(f => val(f)))
          out.push(item(rule, { suffix: s.sectionId, message: `"${s.title}" is filled in, but ${why}. Consider omitting it.`,
            proposedWrites: [{ key: `cbox${s.sectionId}_${s.copy || 1}`, value: true, kind: 'omitSection' }], confidence: 0.75 }));
    }
    return out;
  },
  'order.photos_required'(rule, snap) {
    const of = snap.order?.orderForm || {};
    if (/telephone/i.test(of.requestType || '')) return [];
    return (snap.order?.counts?.photos || (snap.photos || []).length) ? [] : [item(rule, {})];
  },
  'order.diagram_required'(rule, snap) {
    const req = snap.order?.orderForm?.diagramRequired;
    const has = (snap.order?.counts?.diagrams || 0) > 0 || snap.diagram?.present;
    if (req === true && !has) return [item(rule, { message: 'Order requires a diagram but none is attached.' })];
    if (req === false && has) return [item(rule, { message: 'Order says no diagram, but one is attached. Flag it for removal.' })];
    if (req == null) return [item(rule, { severity: 'advisory', message: 'Diagram requirement is not selected on the order form. Clarify.' })];
    return [];
  },
  'recs.flagged_answer_has_rec'(rule, snap) {
    // box 'none' = the form points to a box it doesn't have (Seneca Property Only): the AI step checks coverage instead
    return allFields(snap).filter(f => f.rec && f.rec.box !== 'none' && !f.omitted && !f.internal && (f.rec.trigger || []).includes(val(f)) && !String(f.rec.text || '').trim())
      .map(f => item(rule, { suffix: f.key, evidence: { fields: [f.key] }, message: `"${f.label.slice(0, 110)}" = ${val(f)} but no recommendation was written.` }));
  },
  'recs.photos_attached'(rule, snap) {
    return (snap.recommendations || []).filter(r => String(r.text || '').trim() && !r.imageOptionValue)
      .map(r => item(rule, { suffix: r.key, evidence: { fields: [r.key] }, message: `${r.number || 'Rec'} has no photo: "${r.text.slice(0, 90)}"`,
        reasoning: 'Some recs need no photo (absent item); recPhotos decides.', confidence: 0.99 }));
  },
  'recs.rating_vs_recs'(rule, snap) {
    const recs = (snap.recommendations || []).filter(r => String(r.text || '').trim());
    const op = firstQ(snap, 'opinion_of_risk');
    if (!recs.length || !op) return [];
    return /^(excellent|good)$/i.test(val(op))
      ? [item(rule, { evidence: { fields: [op.key] }, message: `${recs.length} recommendations exist but the Opinion of Risk is "${val(op)}".`,
          proposedWrites: [{ key: op.key, value: 'Good with Recommendations', kind: 'choice' }] })] : [];
  },
  'recs.emergency_lighting_applicability'(rule, snap) {
    const stories = num(firstQ(snap, 'stories')?.value), units = num(firstQ(snap, 'units')?.value);
    if (stories == null && units == null) return [];
    if ((stories || 0) >= rule.params.minStories || (units || 0) > rule.params.minUnitsExclusive) return [];
    return (snap.recommendations || []).filter(r => /emergency light/i.test(r.text || ''))
      .map(r => item(rule, { suffix: r.key, evidence: { fields: [r.key] }, message: `${r.number || 'Rec'} asks for emergency lighting but the building has ${stories ?? '?'} stories and ${units ?? '?'} units.` }));
  },
  'recs.style'(rule, snap) {
    return (snap.recommendations || []).filter(r => String(r.text || '').trim() && (/^recommend/i.test(r.text.trim()) || !ACTION_VERBS.test(r.text.trim())))
      .map(r => item(rule, { suffix: r.key, evidence: { fields: [r.key] }, message: `${r.number || 'Rec'}: "${r.text.slice(0, 80)}" doesn't start with an action verb.` }));
  },
  'recs.duplicates'(rule, snap) {
    const recs = (snap.recommendations || []).filter(r => String(r.text || '').trim());
    const out = [];
    for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++)
      if (overlap(recs[i].text, recs[j].text) >= 0.7)
        out.push(item(rule, { suffix: recs[i].key + '~' + recs[j].key, evidence: { fields: [recs[i].key, recs[j].key] },
          message: `${recs[i].number || recs[i].key} and ${recs[j].number || recs[j].key} look like the same recommendation.`, confidence: 0.7 }));
    return out;
  },
  'state.water_heater_straps'(rule, snap) {
    const st = snap.order?.geo?.state;
    return rule.params.states.includes(st) ? [item(rule, { message: `Risk is in ${st}: check photos for unstrapped water heaters.` })] : [];
  },
};

export function runRules(snap, rules, { only } = {}) {
  const items = [];
  for (const r of rules) {
    if (only && !only.includes(r.id)) continue;
    try {
      if (r.kind === 'dsl') items.push(...evalDsl(r, snap));
      else if (code[r.id]) items.push(...code[r.id](r, snap));
    } catch (e) {
      items.push({ id: r.id + ':error', module: 'checks', severity: 'info', status: 'needs_review', title: 'Rule error', message: `${r.id}: ${e.message}`, evidence: {}, proposedWrites: [], confidence: 0 });
    }
  }
  return items;
}

export { ACTION_VERBS };
