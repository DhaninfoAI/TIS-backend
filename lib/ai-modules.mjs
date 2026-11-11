// OpenAI-backed analysis modules. Same contract as the mock modules in modules.mjs:
//   async (snapshot, ctx) => { engine, summary, items[] }   (return null to fall back to mock)
// Every module shares one cached context (rules pack + compact order + photo insights) and adds
// its own task prompt from backend/prompts/*.md. Outputs are strict JSON and every finding cites evidence.

import { readFileSync, existsSync } from 'node:fs';
import { jsonCall, MODELS } from './llm.mjs';
import { prompt } from './prompts.mjs';
import { compactSnapshot } from './cost.mjs';
import { rulesPack, hazardPack, hazards } from './kb.mjs';
import { allFields, findQ, firstQ, isPropertyOnlyOrder, narrativeField, recTriggered, recSame } from './snapshot.mjs';
export { recSame };   // moved to snapshot.mjs (also used by the rule engine); kept here for existing imports
import { runRules } from './rules.mjs';
import { applicableQuestions, coverageNeeds, pickExamples } from './narrative.mjs';

let seq = 0;
const mk = (module, o) => ({ id: `${module}_ai_${++seq}`, module, severity: 'warning', status: 'fail', evidence: { fields: [], photos: [], text: [] }, proposedWrites: [], confidence: 0.6, reasoning: '', ...o });
const S = (props, required = Object.keys(props)) => ({ type: 'object', additionalProperties: false, required, properties: props });
const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' }, strArr = { type: 'array', items: { type: 'string' } };
const en = (...v) => ({ type: 'string', enum: v });
const sev = conf => (conf >= 0.8 ? 'blocker' : 'warning');
const HAZARD_IDS = new Set(hazards.map(h => h.id));
export const PHOTO_PROMPT_V = 4;   // bump when prompts/photo-review.md changes meaning → cached insights are re-made (3: photo source / Street View, 2026-11-06; 4: extinguishers + description/hazards consistency, 2026-11-10)

// ---------------------------------------------------------------- shared context
function insightsText(insights = {}) {
  const rows = Object.entries(insights).map(([id, p]) => `- ${id} | ${p.caption || ''} | ${p.scene} | ${p.description}${p.hazards?.length ? ' | hazards: ' + p.hazards.map(h => `${h.hazardType}(${h.severity}): ${h.evidence}`).join('; ') : ''}`);
  return rows.length ? rows.join('\n') : '(no photo analysis available: photos not uploaded or vision pass skipped)';
}
function sharedContext(snap, ctx) {
  if (!ctx.__context) ctx.__context = prompt('context', { rulesPack: rulesPack(snap).text, order: compactSnapshot(snap), photoInsights: insightsText(ctx.photoInsights) });
  return ctx.__context;
}
const call = (snap, ctx, o) => jsonCall({ model: MODELS.reason(), context: sharedContext(snap, ctx), budget: ctx.budget, ...o });

function clientNotes(snap) {
  const rp = rulesPack(snap);
  const m = rp.text.split(/\n# Client:/)[1];
  return m ? ('# Client:' + m).slice(0, 4000) : '(no client-specific notes)';
}
const coverageText = snap => `${(snap.order?.orderForm?.coverages || []).join(', ') || 'unknown'}; liability: ${(snap.order?.orderForm?.liability || []).join(', ') || 'none'}${isPropertyOnlyOrder(snap) ? ' (PROPERTY ONLY)' : ''}`;

// Rec keys: General Form F13_<sec>_<copy>_<recId>  ↔  Recommendations form F13_<recSec>_1_<recId>
function recFormKey(snap, generalKey) {
  const recId = generalKey.split('_').pop();
  return (snap.recommendations || []).find(r => r.key.endsWith('_' + recId))?.key
    || (snap.recommendations?.[0] ? snap.recommendations[0].key.replace(/_\d+$/, '_' + recId) : null);
}
function optionFor(snap, recKey, imageId) {
  const r = (snap.recommendations || []).find(x => x.key === recKey);
  return r?.imageOptions?.find(o => o.startsWith(imageId)) || `${imageId}t.jpg`;
}

// ---------------------------------------------------------------- photo review (vision)
const PHOTO_SCHEMA = S({ photos: { type: 'array', items: S({
  imageId: str, description: str, scene: str, suggestedCaption: str, captionOk: bool,
  source: en('on_site', 'street_view', 'aerial', 'screenshot', 'other'), sourceEvidence: str, sourceConfidence: num,
  hazards: { type: 'array', items: S({ hazardType: str, severity: en('required', 'advisory', 'info'), evidence: str, confidence: num, recommendation: str }) },
}) } });

async function photoReview(snap, ctx) {
  const oid = snap.order.orderId, dir = ctx.photoDir(oid), model = MODELS.photo();
  const photos = (snap.photos || []).filter(p => existsSync(`${dir}/${p.imageId}.jpg`));
  if (!photos.length) { ctx.note = 'No photo files uploaded for this order: vision skipped (captions only).'; return null; }
  const insights = {}, todo = [];
  for (const p of photos) { const c = ctx.getInsight(oid, p.imageId, model); if (c && c.v === PHOTO_PROMPT_V) insights[p.imageId] = { ...c, caption: p.caption }; else todo.push(p); }
  const system = prompt('photo-review', { coverage: coverageText(snap), state: snap.order?.geo?.state || '?', hazards: hazardPack().text, clientNotes: clientNotes(snap) });
  const batches = []; for (let i = 0; i < todo.length; i += 6) batches.push(todo.slice(i, i + 6));
  const runBatch = async batch => {
    const images = batch.map(p => ({ dataUrl: 'data:image/jpeg;base64,' + readFileSync(`${dir}/${p.imageId}.jpg`).toString('base64'), detail: process.env.PHOTO_DETAIL || 'high' }));
    const { data } = await jsonCall({ model, system, images, schemaName: 'photo_review', schema: PHOTO_SCHEMA, budget: ctx.budget,
      user: `Review these ${batch.length} photos, in this order:\n${batch.map((p, i) => `Image ${i + 1}: id ${p.imageId}, current caption "${p.caption}"${p.markedHazard ? ' (inspector marked as hazard)' : ''}`).join('\n')}\nReturn exactly one entry per image with its id.` });
    data.photos.forEach((ph, i) => {
      const p = batch.find(x => x.imageId === ph.imageId) || batch[i]; if (!p) return;
      const ins = { ...ph, imageId: p.imageId, hazards: ph.hazards.filter(h => HAZARD_IDS.has(h.hazardType) || h.severity !== 'info'), model, v: PHOTO_PROMPT_V, at: new Date().toISOString() };
      insights[p.imageId] = { ...ins, caption: p.caption };
      ctx.setInsight(oid, p.imageId, model, ins);
    });
  };
  for (let i = 0; i < batches.length; i += 3) await Promise.all(batches.slice(i, i + 3).map(runBatch));   // 3 batches in parallel
  // code has the last word: a problem the AI described but did not list (kept out of the cache, so a better rule
  // here applies to photos already looked at)
  for (const ins of Object.values(insights)) { const extra = backstopHazards(ins); if (extra.length) ins.hazards = [...(ins.hazards || []), ...extra]; }
  ctx.photoInsights = insights; ctx.__context = null;   // context must now include the insights
  await checkPhotoSources(snap, insights, photos, dir, ctx, model);

  const recText = (snap.recommendations || []).map(r => r.text.toLowerCase()).join(' | ');
  const items = [];
  for (const [id, ins] of Object.entries(insights)) for (const h of ins.hazards || []) {
    if (h.severity === 'info') continue;
    const words = h.recommendation.toLowerCase().match(/[a-z]{5,}/g) || [];
    const covered = words.length && words.filter(w => recText.includes(w)).length / words.length >= 0.45;
    items.push(mk('photoReview', { title: (covered ? 'Hazard covered by a recommendation: ' : 'Hazard without a recommendation: ') + (hazards.find(x => x.id === h.hazardType)?.name || h.hazardType),
      message: h.evidence, hazardType: h.hazardType, hazardSeverity: h.severity, coveredByRec: !!covered, suggestedRec: covered ? null : h.recommendation,
      severity: covered ? 'info' : h.severity === 'required' ? 'blocker' : 'advisory', status: covered ? 'pass' : 'fail', checklistItem: '4.1',
      evidence: { photos: [id], fields: [], text: [] }, confidence: h.confidence, reasoning: ins.description }));
  }
  items.push(...photoSourceItems(snap, insights, photos, dir));
  if (isPropertyOnlyOrder(snap)) for (const [id, ins] of Object.entries(insights)) if (['sidewalk', 'pool', 'parking'].includes(ins.scene))
    items.push(mk('photoReview', { title: 'GL-focused photo on a property-only order', message: `${ins.caption}: ${ins.description}`, severity: 'advisory', checklistItem: '4.3', evidence: { photos: [id] }, confidence: 0.6 }));
  return { engine: 'openai', summary: { vision: true, photos: photos.length, analysed: todo.length, cached: photos.length - todo.length, hazards: items.length, missed: items.filter(i => i.status === 'fail').length }, items };
}

// ---------------------------------------------------------------- description → hazard backstop
// The AI can describe a problem and still return no hazard: 1166305 photo 18441051 on 2026-11-09 was "A room with an
// open door and a fire extinguisher on the floor", hazards []. The 2026-11-05 look had flagged it, and the empty
// answer was then reused on every Run. Clear phrases about an extinguisher in the description add the hazard.
const EXT = /\bextinguishers?\b/i;
const EXT_FLOOR = /\b(on the floor|on floor|sitting on the ground|lying|leaning|unmounted|not (wall[- ])?mounted|not hung|not on (its|a|the) (wall )?(hook|bracket)|under (a|the) sink)\b/i;
const EXT_TAG = /\b((expired|missing|no) (inspection |service )?tags?|tags? (is |are )?(missing|expired|out of date))\b/i;
const EXT_FINE = /\bnot (lying |sitting |standing |placed |left )?on the floor\b/i;
const EXT_EXIT = /\b(door|doorway|exit|egress|aisle|hallway|corridor|stair)/i;
export function backstopHazards(ins) {
  const have = new Set((ins?.hazards || []).map(h => h.hazardType));
  if (have.has('fire_extinguishers') || have.has('blocked_egress')) return [];
  const sentences = String(ins?.description || '').split(/(?<=[.;!?])\s+/).filter(s => EXT.test(s));
  const floor = sentences.find(s => EXT_FLOOR.test(s) && !EXT_FINE.test(s)), tag = sentences.find(s => EXT_TAG.test(s));
  if (!floor && !tag) return [];
  const atExit = floor && EXT_EXIT.test(floor);
  const recommendation = floor
    ? `Mount the portable fire extinguisher on a wall hook or bracket in a visible, accessible location${atExit ? ', clear of doors and exit routes' : ''}.`
    : 'Have all portable fire extinguishers inspected and tagged by a licensed contractor at least annually.';
  return [{ hazardType: 'fire_extinguishers', severity: 'advisory', evidence: (floor || tag).trim(), confidence: 0.6, recommendation, backstop: true }];
}

// ---------------------------------------------------------------- photo source (Street View, map views)
// EZ strips the camera data (EXIF) from every photo, so whether a photo was taken on site comes from the vision
// pass (prompts/photo-review.md: source, sourceEvidence, sourceConfidence), backed by free checks: the caption,
// a .png file, and a shape that differs from the rest of the order's photos.
const SOURCE_TITLE = { street_view: 'Photo may be from Street View', aerial: 'Photo looks like a satellite or map view', screenshot: 'Photo looks like a screenshot' };
const SV_CAPTION = /street ?view|google|screen ?shot/i;   // not "map": inspectors add site maps on purpose (false flag on 1168099, 2026-11-06)
/** Width and height of a JPEG from its SOF marker (no decoding). */
export function jpegSize(buf) {
  for (let i = 2; i < buf.length - 9 && buf[i] === 0xff;) {
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
/** The order's usual photo shape (long side / short side) and which photos differ from it: a screen capture
 *  usually has another shape than the inspector's camera. Only meaningful when most photos share one shape. */
/** A photo's shape in words (ratio = long side ÷ short side, so turning the photo does not matter). The reviewer read
 *  "(1.11:1 vs 1.33:1)" as a puzzle (1169277, 2026-11-11). */
export function shapeWords(r) {
  r = Number(r);
  if (!r) return 'an unknown shape';
  if (r < 1.18) return 'almost square';
  if (Math.abs(r - 4 / 3) < 0.05) return '4:3, the usual phone-camera shape';
  if (Math.abs(r - 1.5) < 0.05) return '3:2, a camera shape';
  if (Math.abs(r - 16 / 9) < 0.06) return '16:9, a wide screen shape';
  return r < 4 / 3 ? 'squarer than a camera photo' : 'longer and narrower than a camera photo';
}
function photoShapes(photos, dir) {
  const shape = {}; for (const p of photos) { try { const d = jpegSize(readFileSync(`${dir}/${p.imageId}.jpg`)); if (d) shape[p.imageId] = Math.round(Math.max(d.w, d.h) / Math.min(d.w, d.h) * 100) / 100; } catch {} }
  const counts = {}; for (const r of Object.values(shape)) counts[r] = (counts[r] || 0) + 1;
  const [usual, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  return { shape, usual, odd: id => !!(usual && n >= 0.6 * Object.keys(shape).length && shape[id] && Math.abs(shape[id] - Number(usual)) >= 0.06) };   // phone 4:3 = 1.33; a 1.41 screen crop must count
}

// The batch pass looks at 6 photos at once and can carry a "Street View" judgement over to its neighbours
// (tested 2026-11-06: it invented "Google watermark visible" for 3 photos with none). So every candidate gets a
// second, focused look on its own (prompts/photo-source-check.md), and that answer decides the flag.
const SOURCE_CHECK_SCHEMA = S({ source: en('street_view', 'unsure', 'on_site'), signs: { type: 'array', items: S({ kind: en('text', 'controls', 'blurring', 'camera'), detail: str }) }, confidence: num });
async function checkPhotoSources(snap, insights, photos, dir, ctx, model) {
  const { odd } = photoShapes(photos, dir);
  const todo = photos.filter(p => {
    const ins = insights[p.imageId]; if (!ins || ins.sourceCheck) return false;   // already checked (cached with the insight)
    const why = [ins.source === 'street_view' && (ins.sourceConfidence ?? 0) >= 0.5 && 'the first look said it may be from Street View',
      SV_CAPTION.test(p.caption || '') && `its caption is "${p.caption}"`, /\.png$/i.test(p.ext || '') && odd(p.imageId) && 'it is a PNG with a different shape from the other photos'].filter(Boolean);
    if (why.length) p.__why = why.join('; ');
    return why.length > 0;
  });
  const system = prompt('photo-source-check');
  const one = async p => {
    try {
      const { data } = await jsonCall({ model, system, schemaName: 'photo_source_check', schema: SOURCE_CHECK_SCHEMA, budget: ctx.budget,
        images: [{ dataUrl: 'data:image/jpeg;base64,' + readFileSync(`${dir}/${p.imageId}.jpg`).toString('base64'), detail: 'high' }],
        user: `Photo ${p.imageId}. Check it now.` });   // no caption, no reason it was picked: a hint makes the model "find" signs (tested 2026-11-06)
      const ins = { ...insights[p.imageId], sourceCheck: { ...data, at: new Date().toISOString() } };
      insights[p.imageId] = ins;
      const { caption, ...keep } = ins; ctx.setInsight(snap.order.orderId, p.imageId, model, keep);
    } catch (e) { console.error(`[ai] photo source check ${p.imageId} failed: ${e.message}`); }   // the batch answer stays
  };
  for (let i = 0; i < todo.length; i += 3) await Promise.all(todo.slice(i, i + 3).map(one));
}

export function photoSourceItems(snap, insights, photos, dir) {
  const req = String(snap.order?.orderForm?.requestType || '');
  const remoteOk = /telephone|phone|virtual|desk/i.test(req);   // online imagery is expected on these surveys
  const { shape, usual, odd } = photoShapes(photos, dir);
  const items = [];
  for (const p of photos) {
    const ins = insights[p.imageId] || {};
    const support = [SV_CAPTION.test(p.caption || '') && `caption "${p.caption}"`, /\.png$/i.test(p.ext || '') && 'uploaded as a PNG file (phone cameras save JPG)',
      odd(p.imageId) && `a different shape from the order's other photos (this one is ${shapeWords(shape[p.imageId])}; the others are ${shapeWords(usual)})`].filter(Boolean);
    const chk = ins.sourceCheck;   // the focused single-photo check, when it ran
    const seen = chk ? (chk.source === 'street_view' && chk.confidence >= 0.7 ? 'street_view' : null)
      : ins.source && !['on_site', 'other'].includes(ins.source) && (ins.sourceConfidence ?? 0) >= 0.5 ? ins.source : null;
    const captionHit = support.some(x => x.startsWith('caption'));
    // a PNG with a shape unlike the order's camera photos = a screen capture, even when the AI sees nothing (clean
    // Street View crops carry no Google marks: tested 2026-11-06). Shape or PNG alone is too weak to flag.
    const screenCapture = /\.png$/i.test(p.ext || '') && odd(p.imageId);
    if (!seen && !captionHit && !screenCapture) continue;
    const source = seen || (captionHit ? 'street_view' : 'unknown');
    const conf = Math.min(0.95, (seen ? (chk ? chk.confidence : ins.sourceConfidence) : 0.5) + 0.1 * support.length);
    const signs = chk ? (chk.signs || []).filter(s => s.kind !== 'camera' || seen).map(s => s.detail) : [ins.sourceEvidence];
    // the AI's verdict held up in testing, its quoted details did not always (it misread "© 2012 Google" as 2023, and
    // once reported a watermark that isn't there): say what it reports, never present it as fact
    const reported = signs.filter(Boolean).join(', ');
    const why = [seen && (reported ? `the AI reports ${reported}` : 'the AI thinks it looks like an online map image'), ...support].filter(Boolean).join('; ');
    const flag = (source === 'street_view' || source === 'unknown') && !remoteOk;   // map / satellite views are often added on purpose: noted, not counted
    items.push(mk('photoReview', { kind: 'photo_source', source, title: SOURCE_TITLE[source] || 'Check where this photo came from',
      message: `${why ? why.charAt(0).toUpperCase() + why.slice(1) + '. ' : ''}${remoteOk ? `Online imagery is expected on a "${req}" order.` : 'Check that the inspector took this photo on site.'}`,
      severity: flag ? (conf >= 0.8 ? 'warning' : 'advisory') : 'info', status: flag ? 'fail' : 'pass',
      evidence: { photos: [p.imageId], fields: [], text: [] }, confidence: conf, reasoning: ins.description || '' }));
  }
  return items;
}

// ---------------------------------------------------------------- underwriter concerns
const UW_SCHEMA = S({ draftResponse: str, concerns: { type: 'array', items: S({ concern: str, addressed: en('yes', 'partial', 'no'), where: str, answer: str, contradiction: str }) } });

// Text a reviewer or underwriter reads must not carry EZ's internal field keys or photo ids (1168089, 2026-11-10:
// "There is no sprinkler system present as confirmed in the narrative and form [F4_112427_1_10704437].").
const FIELD_KEY = /\[?\b(F\d+_\d+_\d+_\d+)\b\]?/g;
export function plainText(s = '') {
  return String(s)
    .replace(/\b(photos?|images?)\s+\d{6,}((\s*,\s*|\s+and\s+)\d{6,})*/gi, '$1')   // photo ids first, then the phrase they sat in
    .replace(FIELD_KEY, '')
    .replace(/,?\s*\(?(as )?(confirmed|shown|noted|documented|seen|stated|see) ((by|in) )?(the )?(narrative|form|photos?|report|answers?)(\s*(,|and)\s*(the )?(narrative|form|photos?|report|answers?))*\)?/gi, '').replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+([.,;:])/g, '$1').replace(/:\s*=\s*/g, ': ').replace(/[ \t]{2,}/g, ' ').replace(/^\s*[,;:]\s*/, '').trim();
}

async function uwConcerns(snap, ctx) {
  const instr = snap.order?.orderForm?.additionalInstructions;
  if (!instr) return { engine: 'rules', summary: { concerns: 0 }, items: [] };
  const resp = findQ(snap, 'uw_response').find(x => x.type === 'longtext');
  const { data } = await call(snap, ctx, { schemaName: 'uw_concerns', schema: UW_SCHEMA, system: prompt('uw-concerns', { instructions: instr }), user: 'Check the underwriter concerns now.' });
  const open = data.concerns.filter(c => c.addressed !== 'yes').length;
  const draftResponse = String(data.draftResponse || '').split('\n').map(plainText).join('\n');
  const keysIn = w => [...String(w || '').matchAll(FIELD_KEY)].map(m => m[1]);
  return { engine: 'openai', summary: { concerns: data.concerns.length, unanswered: open, draftResponse },
    items: data.concerns.map(c => mk('uwConcerns', { title: c.concern, addressed: c.addressed, draftAnswer: plainText(c.answer),
      message: plainText(c.contradiction) || (c.addressed === 'yes' ? `Answered: ${plainText(c.where) || 'in the report'}` : c.addressed === 'partial' ? `Partly answered: ${plainText(c.where) || 'not clearly'}` : 'Not answered in the report.'),
      severity: c.addressed === 'yes' ? 'info' : c.contradiction ? 'blocker' : 'warning', status: c.addressed === 'yes' && !c.contradiction ? 'pass' : 'fail', checklistItem: '5.4',
      evidence: { fields: keysIn(c.where).length ? keysIn(c.where).slice(0, 2) : resp ? [resp.key] : [], text: [plainText(c.where)].filter(Boolean) },
      proposedWrites: resp && open ? [{ key: resp.key, value: draftResponse, kind: 'text' }] : [], confidence: 0.75 })) };
}

// ---------------------------------------------------------------- recommendations
const REC_SCHEMA = S({ recommendations: { type: 'array', items: S({
  action: en('add', 'rewrite', 'remove', 'merge'), targetKey: str, mergeKeys: strArr, sourceType: en('flagged_answer', 'photo_hazard', 'existing'),
  sourceRef: str, text: str, requirement: en('required', 'advisory'), photoId: str, noPhotoNeeded: bool, reason: str, confidence: num }) } });

// low-value photo recs from the 22-order test: housekeeping-as-decor, signage nobody requires, "ensure X is inspected"
const WEAK_REC = /^(organi[sz]e|declutter|tidy|consider|recommend)\b|^ensure\b.*\b(inspected|tagged|marked|signage|maintained)\b|\b(decorat|aesthetic|cosmetic)/i;

async function recommendations(snap, ctx) {
  const fields = allFields(snap);
  const flagged = fields.filter(f => f.rec && !f.omitted && !f.internal && recTriggered(f) && !String(f.rec.text || '').trim());
  const facts = ['stories', 'units', 'occupancy_pct', 'year_built', 'iso_class', 'sprinklered'].map(q => `${q}: ${firstQ(snap, q)?.value || '?'}`).join('; ') + `; coverage: ${coverageText(snap)}`;
  const photoHazards = Object.entries(ctx.photoInsights || {}).flatMap(([id, p]) => (p.hazards || []).filter(h => h.severity !== 'info').map(h => `- photo ${id} | ${h.hazardType} (${h.severity}) | ${h.evidence} | suggested: ${h.recommendation}`));
  const { data } = await call(snap, ctx, { schemaName: 'recommendations', schema: REC_SCHEMA, user: 'Review the recommendations now.',
    system: prompt('recommendations', { facts,
      existing: (snap.recommendations || []).map(r => `- [${r.key}] ${r.number || ''} ${r.text} | photo: ${r.imageOptionValue || 'none'}`).join('\n') || '(none)',
      flagged: flagged.map(f => `- [${f.key}] ${f.label} = ${f.value}${f.comment?.value ? ` | comment: ${f.comment.value}` : ''} | rec box: ${f.rec.box === 'none' ? 'NONE on this form: add a recommendation only if no existing one covers it' : f.rec.key}`).join('\n') || '(none)',
      photoHazards: photoHazards.join('\n') || '(none)' }) });
  const recKeys = new Set((snap.recommendations || []).map(r => r.key));
  const items = [], dropped = { duplicate: 0, covered: 0, weak: 0 };
  for (const r of data.recommendations) {
    const writes = [];
    const photo = r.photoId && (snap.photos || []).some(p => p.imageId === r.photoId) ? r.photoId : '';
    if (r.action === 'add' && r.sourceType === 'flagged_answer') {
      const ff = flagged.find(f => f.key === r.sourceRef) || flagged.find(f => f.rec.key === r.targetKey);
      const key = /^F13_/.test(r.targetKey) ? r.targetKey : ff?.rec.key;
      if (!key) continue;
      if (ff?.rec.list) writes.push({ key, value: ff.rec.line || r.text, kind: 'recLine' });   // Seneca: EZ's own line in the shared hazard list
      else if (ff?.rec.box === 'none') { writes.push({ key: 'F14:new', value: r.text, kind: 'rec' }); if (photo) writes.push({ key: 'RECIMAGEID_F14:new', value: `${photo}t.jpg`, kind: 'recImage' }); }   // no box on the form: a free-form rec
      else {
        writes.push({ key, value: r.text, kind: 'rec' });
        const rk = recFormKey(snap, key); if (photo && rk) writes.push({ key: 'RECIMAGEID_' + rk, value: optionFor(snap, rk, photo), kind: 'recImage' });
      }
    } else if (r.action === 'add') {
      writes.push({ key: 'F14:new', value: r.text, kind: 'rec' });
      if (photo) writes.push({ key: 'RECIMAGEID_F14:new', value: `${photo}t.jpg`, kind: 'recImage' });
    } else if (r.action === 'rewrite' && recKeys.has(r.targetKey)) writes.push({ key: r.targetKey, value: r.text, kind: 'rec' });
    else if (r.action === 'remove' && recKeys.has(r.targetKey)) writes.push({ key: r.targetKey, value: '', kind: 'rec', clear: true });
    else if (r.action === 'merge' && recKeys.has(r.targetKey)) {
      // the model sometimes lists the kept rec among the duplicates (it would be written, then cleared) or names no
      // other rec at all: only real other recs are cleared; with none left it is a rewrite (or nothing)
      const dups = [...new Set(r.mergeKeys)].filter(k => k !== r.targetKey && recKeys.has(k));
      const cur = (snap.recommendations || []).find(x => x.key === r.targetKey)?.text || '';
      if (!dups.length) { if (!r.text.trim() || r.text.trim() === cur.trim()) continue; r.action = 'rewrite'; writes.push({ key: r.targetKey, value: r.text, kind: 'rec' }); }
      else { writes.push({ key: r.targetKey, value: r.text, kind: 'rec' }); for (const k of dups) writes.push({ key: k, value: '', kind: 'rec', clear: true }); }
    }
    else continue;
    // new photo recommendations: one per hazard, nothing an existing rec already says, no low-value extras
    if (r.action === 'add' && r.sourceType === 'photo_hazard') {
      if (r.requirement !== 'required' && (r.confidence ?? 0) < 0.6) { dropped.weak++; continue; }
      if (WEAK_REC.test(r.text)) { dropped.weak++; continue; }
      if ((snap.recommendations || []).some(x => recSame(x.text, r.text))) { dropped.covered++; continue; }
      const twin = items.find(i => i.kind === 'missing' && i.source === 'photo_hazard' && recSame(i.after, r.text));
      if (twin) { if (photo && !twin.evidence.photos.includes(photo)) twin.evidence.photos.push(photo); if (r.requirement === 'required' && twin.requirement !== 'required') Object.assign(twin, { requirement: 'required', severity: 'blocker', title: 'Missing recommendation' }); dropped.duplicate++; continue; }
    }
    const existing = (snap.recommendations || []).find(x => x.key === r.targetKey);
    items.push(mk('recommendations', { kind: r.action === 'add' ? 'missing' : r.action, source: r.sourceType, requirement: r.requirement,
      title: { add: r.requirement === 'required' ? 'Missing recommendation' : 'Suggested recommendation', rewrite: 'Rewrite recommendation', remove: 'Recommendation does not apply', merge: 'Duplicate recommendations' }[r.action],
      message: r.reason, before: existing?.text || null, after: (writes[0]?.kind === 'recLine' ? writes[0].value : r.text) || null, photoId: photo || null, noPhotoNeeded: r.noPhotoNeeded,
      severity: r.action === 'add' ? (r.requirement === 'required' ? 'blocker' : 'advisory') : 'warning', checklistItem: r.action === 'add' ? '4.1' : '5.1',
      evidence: { fields: [r.sourceType === 'flagged_answer' ? r.sourceRef : r.targetKey].filter(k => /^F\d/.test(k || '')), photos: photo ? [photo] : [], text: [] },
      proposedWrites: writes, confidence: r.confidence }));
  }
  // The recommendations step is the judge of coverage: a photo hazard is "missed" only if the model
  // had to add a recommendation for that photo. (Word matching flagged hazards that existing recs covered.)
  const addedForPhoto = new Set(items.filter(i => i.kind === 'missing' && i.source === 'photo_hazard').flatMap(i => i.evidence.photos));
  for (const r of data.recommendations) if (r.action === 'add' && r.sourceType === 'photo_hazard' && items.some(i => i.kind === 'missing' && i.source === 'photo_hazard' && recSame(i.after, r.text))) addedForPhoto.add(r.sourceRef);
  for (const it of ctx.results.photoReview?.items || []) {
    if (!it.hazardType || it.status !== 'fail') continue;
    if (!it.evidence.photos.some(p => addedForPhoto.has(p))) {
      Object.assign(it, { status: 'pass', severity: 'info', coveredByRec: true, title: it.title.replace('Hazard without a recommendation', 'Hazard covered by a recommendation') });
    } else {
      // the drafted recommendation (Recs tab) is the one place to act: the photo hazard becomes a pointer to it,
      // not counted and without its own Apply / Dismiss (2026-11-10: the same hazard was counted on both tabs)
      const rec = items.find(i => i.kind === 'missing' && i.source === 'photo_hazard' && i.evidence.photos.some(p => it.evidence.photos.includes(p)));
      Object.assign(it, { status: 'needs_review', severity: 'info', recDrafted: true, recItemId: rec?.id || null, hazardSeverity: it.hazardSeverity,
        title: it.title.replace('Hazard without a recommendation: ', '') });
    }
  }
  if (ctx.results.photoReview?.summary) ctx.results.photoReview.summary.missed = (ctx.results.photoReview.items || []).filter(i => i.hazardType && (i.status === 'fail' || i.recDrafted)).length;
  // deterministic extras the model may not restate
  const touched = new Set(items.flatMap(i => i.proposedWrites.map(w => w.key)));
  for (const it of runRules(snap, ctx.rules, { only: ['recs.rating_vs_recs', 'recs.emergency_lighting_applicability'] }))
    if (!(it.evidence.fields || []).some(k => touched.has(k))) items.push({ ...it, module: 'recommendations', kind: 'rule' });
  // the Checks tab's wording / duplicate warnings on recs this step already rewrites or merges: don't report them twice
  for (const it of ctx.results.checks?.items || []) {
    if (!/^recs\.(style|duplicates)\b/.test(it.id || '') || it.status !== 'fail') continue;
    const keys = it.evidence.fields || [];
    if (keys.length && keys.every(k => touched.has(k))) Object.assign(it, { status: 'pass', severity: 'info', coveredByAi: true, message: `${it.message} A rewrite is drafted (Recs).` });
  }
  return { engine: 'openai', summary: { missing: items.filter(i => i.kind === 'missing').length, rewrites: items.filter(i => i.kind === 'rewrite').length, removals: items.filter(i => i.kind === 'remove').length, total: items.length, dropped }, items };
}

// ---------------------------------------------------------------- rec photos
const RECPHOTO_SCHEMA = S({ matches: { type: 'array', items: S({ recKey: str, imageId: str, noPhotoNeeded: bool, alternatives: strArr, reason: str, confidence: num }) } });

async function recPhotos(snap, ctx) {
  const recs = (snap.recommendations || []).filter(r => r.text);
  if (!recs.length || !(snap.photos || []).length) return { engine: 'rules', summary: { recs: recs.length }, items: [] };
  const ids = new Set(snap.photos.map(p => p.imageId));
  const { data } = await call(snap, ctx, { schemaName: 'rec_photos', schema: RECPHOTO_SCHEMA, user: 'Match photos to recommendations now.',
    system: prompt('rec-photos', {
      recs: recs.map(r => `- [${r.key}] ${r.number || ''} ${r.text} | current photo: ${r.imageOptionValue ? r.imageOptionValue.replace(/t\.jpg$/i, '') : 'NONE'}`).join('\n'),
      photos: snap.photos.map(p => `- ${p.imageId} | ${p.caption} | ${p.markedHazard ? 'HAZARD' : ''} | ${ctx.photoInsights?.[p.imageId]?.description || ''}`).join('\n') }) });
  const items = [];
  for (const m of data.matches) {
    const r = recs.find(x => x.key === m.recKey); if (!r) continue;
    const cur = (r.imageOptionValue || '').replace(/t\.jpe?g$/i, '');
    if (m.noPhotoNeeded) { if (!cur) items.push(mk('recPhotos', { title: `${r.number || '“' + r.text.slice(0, 44) + (r.text.length > 44 ? '…”' : '”')}: no photo needed`, message: m.reason, noPhotoNeeded: true, severity: 'info', status: 'pass', evidence: { fields: [r.key] }, confidence: m.confidence })); continue; }
    if (!ids.has(m.imageId) || m.imageId === cur) continue;
    items.push(mk('recPhotos', { title: `${r.number || '“' + r.text.slice(0, 44) + (r.text.length > 44 ? '…”' : '”')}: ${cur ? 'better photo' : 'attach photo'} ${m.imageId}`, message: m.reason, recText: r.text, currentPhoto: cur || null,
      severity: cur ? 'advisory' : 'warning', checklistItem: '4.4', evidence: { fields: [r.key], photos: [m.imageId], text: [] }, alternatives: m.alternatives.filter(a => ids.has(a)),
      proposedWrites: [{ key: 'RECIMAGEID_' + r.key, value: optionFor(snap, r.key, m.imageId), kind: 'recImage' }], confidence: m.confidence }));
  }
  return { engine: 'openai', summary: { recs: recs.length, withoutPhoto: recs.filter(r => !r.imageOptionValue).length, suggestions: items.filter(i => i.status === 'fail').length }, items };
}

// ---------------------------------------------------------------- yes/no questions
// Two kinds of finding are checked against the vision results and dropped when every area they name
// appears in some photo's scene / caption / description:
//   - "no roof photos" style claims (any question);
//   - "not fully accessed" claims on an access question: photos taken on the roof prove the roof was
//     reached, whatever else the model read into the narrative (e.g. snow limiting what could be seen).
const AREA_RE = /\b(roof|basement|attic|boiler|electrical panel|panel|meter|kitchen|stair|sprinkler|hatch|crawl ?space|garage|parking|pool)/gi;
const NO_PHOTO_RE = /\b(no|lack(ing)?|missing|absent|without|not (shown|visible|provided|photographed|evidenced|documented))\b[^.]{0,80}\b(photo|image|picture)|\b(photo|image|picture)s?\b[^.]{0,60}\b(missing|absent|lacking|not (shown|provided|available))/i;
export function photoClaimRefuted(reason = '', insights = {}, label = '') {
  const accessQ = /\baccess(ed)?\b/i.test(label);
  if (!NO_PHOTO_RE.test(reason) && !accessQ) return false;
  const areas = [...new Set((reason.match(AREA_RE) || []).map(a => a.toLowerCase()))];
  if (!areas.length) return false;
  const seen = Object.values(insights).map(p => `${p.scene} ${p.caption || ''} ${p.description || ''}`.toLowerCase());
  return areas.every(a => seen.some(t => t.includes(a)));
}

const Q_SCHEMA = S({ findings: { type: 'array', items: S({ key: str, kind: en('differ', 'fill', 'logic'), current: str, suggested: str, evidenceShows: en('problem', 'no_problem', 'unclear'), reason: str, evidencePhotos: strArr, confidence: num }) } });

// Guards on "change this answer" findings (22-order test, 2026-11-08). The model:
//  - flipped the direction: photos show a problem, then it suggested "Yes" to "Housekeeping satisfactory…?";
//  - pinned evidence on the wrong question: housekeeping "No" because of missing bricks, a missing gym-rules sign or
//    slip mats; the BBQ question because of pool signage; "resident super" because of roof access;
//  - guessed: "dusty breakers may indicate FPE", "joisted masonry typically has no brick veneer".
// Code decides: (1) which answer means "problem" for this question; (2) the reason must name evidence of the
// question's subject (families below); (3) hedged reasons don't change an answer.
const GOOD_IF_YES = /\b(free of|good (condition|repair|working order)|satisfactory|smooth (and|&) even|to code|adequate(ly)?|secured|properly|well[- ]maintained|unobstructed|slip[- ]resistant|in place|safely arranged|working|currently tagged|equipped with|provided)\b/i;
const BAD_IF_YES = /^\s*\d*\.?\s*(any|are there any|is there any|have there been any)\b|\bany (losses|history|violations|claims)\b|\b(evidence|signs) of\b/i;
export function answerMeans(label = '', answer = '') {
  const a = String(answer).trim().toLowerCase();
  const yes = /^(yes|y)\b/.test(a), no = /^(no|n)\b/.test(a);
  if (!yes && !no) return null;
  if (BAD_IF_YES.test(label)) return yes ? 'problem' : 'no_problem';
  if (GOOD_IF_YES.test(label)) return yes ? 'no_problem' : 'problem';
  return null;
}
const SUBJECTS = [
  [/housekeeping/i, /clutter|debris|refuse|trash|garbage|rubbish|stor(ed|age)|junk|accumulat|litter|combustible|mess|pile/i],
  [/federal pacific|stab-?lok/i, /federal pacific|\bfpe\b|stab-?lok/i],
  [/zinsco|sylvania/i, /zinsco|sylvania/i],
  [/propane|bbq|grill/i, /grill|bbq|barbe|propane|fire ?pit|smoker|charcoal/i],
  [/resident super|super or manager/i, /\bsuper\b|superintendent|manager|management|on-?site staff/i],
  // a defect, not just "a dirt path" (1168099)
  [/sidewalk|walkway/i, /crack|uneven|heav|trip|broken|lift|settl|pothole|hole|gap|raised|damage|good condition|smooth/i],
  [/dead trees|branches|overhanging/i, /dead|tree|branch|limb|overhang/i],
  [/brush/i, /brush|overgrow|weed|shrub|dry vegetation/i],
  [/veneer/i, /brick|veneer|stone|header|stretcher|weep|siding|cladding/i],
  [/ceiling/i, /ceiling|stain|water damage|leak/i],
  [/pull ?station|fire alarm|alarm/i, /alarm|pull|strobe|horn|detector|sounder/i],
  [/egress|exit door/i, /egress|exit|door|corridor|hall|stair|path|block/i],
  [/aluminum wiring/i, /alumin|\bal\b|co\/alr|pigtail/i],
  [/electric|wiring|overprotection|breaker|panel/i, /wir|electric|panel|breaker|outlet|junction|cord|fuse|cable|romex|receptacle/i],
  [/roof/i, /roof|shingle|membrane|flashing|gutter|parapet|hatch/i],
  [/handrail|stairway|step tread/i, /stair|step|tread|handrail|railing|riser|guard/i],
  [/air condition/i, /air ?condition|a\/?c|bracket|window unit/i],
  [/parking lot/i, /parking|lot|pavement|asphalt|light|fence/i],
  [/unauthorized access|secured from/i, /lock|fence|gate|secur|access|door|trespass|open|vacant|board/i],
  [/commercial (occupanc|tenant)|high risk commercial/i, /tenant|commercial|store|restaurant|business|retail|office|occupan/i],
  [/sprinkler/i, /sprinkler|head|riser|valve|pipe/i],
  [/extinguisher/i, /extinguisher|tag/i],
  [/emergency light|exit sign/i, /emergency light|exit sign|illuminat|light/i],
];
const HEDGED = /\b(may|might|could|possibly|potential(ly)?|typically|usually|likely|suggests?|presumably|seems?|appears? to (be|have|indicate))\b/i;
// "No visible brick pattern" in a street photo is not proof there is no veneer (it needs the close-up)
const ABSENCE_ONLY = [[/veneer/i, /\bno visible\b|\bnot (clearly )?visible\b|\bcannot (be )?see|\bdoes not show\b|\bnot shown\b/i]];
/** Why a "change this answer" finding should be dropped, or null when it can stand.
 *  recTexts: the order's recommendations (and this question's rec box): the inspector flagged the condition. */
export function answerGuard(label, current, suggested, evidenceShows, reason, recTexts = []) {
  const fam = SUBJECTS.find(([q]) => q.test(label));
  // also for "logic" notes that change nothing (1168083: "resident super" because of water damage at the roof hatch)
  if (fam && !fam[1].test(reason || '')) return 'subject';
  if (HEDGED.test(reason || '')) return 'hedged';
  if (!suggested || suggested === current) return null;
  const means = answerMeans(label, suggested);
  if (means && evidenceShows && evidenceShows !== 'unclear' && means !== evidenceShows) return 'direction';
  if (ABSENCE_ONLY.some(([q, a]) => q.test(label) && a.test(reason || ''))) return 'absence';
  // turning the inspector's "problem" into "fine" while a recommendation addresses it (1168088: stairs "No" →
  // "Yes" from photos of other stairs, with "Restore basement stairway…" on the report)
  if (means === 'no_problem' && answerMeans(label, current) === 'problem' && fam && recTexts.some(t => fam[1].test(t || ''))) return 'has_rec';
  return null;
}

async function questions(snap, ctx) {
  const qs = allFields(snap).filter(f => f.type === 'choice' && !f.omitted && !f.internal && f.options?.length);
  const byKey = new Map(qs.map(f => [f.key, f]));
  const { data } = await call(snap, ctx, { schemaName: 'questions', schema: Q_SCHEMA, user: 'Verify the answers now.',
    system: prompt('questions', {
      photoNote: Object.keys(ctx.photoInsights || {}).length
        ? 'use only the photo review results above as photo evidence; cite their ids.'
        : 'the photos were NOT analysed for this order. Do not claim anything is shown or not shown in photos and leave evidencePhotos empty. Rely on answers, comments and the narrative only.',
      questions: qs.map(f => `- [${f.key}] ${f.label.slice(0, 160)} | ${f.options.join(' / ')} | ${f.value || '(blank)'}${f.comment?.value ? ` | ${f.comment.value}` : ''}`).join('\n') }) });
  const items = [], analysed = ctx.photoInsights || {}, guarded = {}, recTexts = (snap.recommendations || []).map(r => r.text);
  let refuted = 0;
  for (const q of data.findings) {
    const f = byKey.get(q.key); if (!f) continue;
    if (photoClaimRefuted(q.reason, analysed, f.label)) { refuted++; continue; }   // e.g. "no roof photos" while 6 roof photos exist
    const suggested = f.options.includes(q.suggested) ? q.suggested : '';
    const why = answerGuard(f.label, f.value, suggested, q.evidenceShows, q.reason, recTexts.concat(f.rec?.text || []));
    if (why) { guarded[why] = (guarded[why] || 0) + 1; continue; }
    const writes = [];
    if (suggested && suggested !== f.value) writes.push({ key: f.key, value: suggested, kind: 'choice' });
    if (!writes.length && q.kind !== 'logic') continue;
    const photos = q.evidencePhotos.filter(id => analysed[id]);   // only photos the vision pass actually looked at
    const photoBased = /\b(photo|image|picture)/i.test(q.reason);
    items.push(mk('questions', { kind: q.kind, title: f.label.slice(0, 140), message: q.reason, current: f.value, suggested: suggested || null,
      // blocker only with direct evidence (an analysed photo, or another answer for a logic conflict that isn't about photos)
      severity: q.confidence >= 0.85 && (photos.length || (q.kind === 'logic' && !photoBased)) ? 'blocker' : 'warning', section: f.sectionTitle,
      evidence: { fields: [f.key], photos, text: [] }, proposedWrites: writes, confidence: q.confidence }));
  }
  const seen = new Set(items.map(i => i.evidence.fields[0]));
  for (const it of runRules(snap, ctx.rules, { only: ['general.veneer_backing_yes', 'general.veneer_backing_no', 'general.vacancy_utilities', 'general.aluminum_wiring_1965_1975'] }))
    if (!seen.has(it.evidence.fields?.at(-1))) items.push({ ...it, module: 'questions', kind: 'logic' });
  return { engine: 'openai', summary: { checked: qs.length, refuted, guarded, differ: items.filter(i => i.kind === 'differ').length, fill: items.filter(i => i.kind === 'fill').length, logic: items.filter(i => i.kind === 'logic').length }, items };
}

// ---------------------------------------------------------------- captions (image renaming)
// The vision prompt says "don't rename just to add detail", but the model still turns "Roof Closeup" into
// "Roof with Satellite Dish". Code decides: rename a bad caption (camera number, address, file name, blank), or
// one whose words the suggestion drops or replaces (typo, wrong subject); never one it only adds words to.
const FILLER = new Set(['closeup', 'close', 'up', 'view', 'photo', 'picture', 'pic', 'shot', 'overall', 'area', 'image', 'general', 'misc', 'other',
  'of', 'the', 'a', 'an', 'and', 'with', 'at', 'in', 'on', 'to', 'from', 'for']);
const BAD_CAPTION = /(^|[\s_-])(img|dsc|dscn|pxl|photo|image)[_-]?\d{2,}|\.(jpe?g|png|heic)\b|^\s*\d[\d\s_-]*$|^\d+\s+\w+.*\b(st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane)\b/i;
const capWords = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !FILLER.has(w)).map(w => w.replace(/(?<=\w{3})s$/, ''));
export function renameWorthIt(current, suggested) {
  const cur = String(current || '').trim(), sug = String(suggested || '').trim();
  if (!sug || sug.toLowerCase() === cur.toLowerCase()) return false;
  if (!cur || BAD_CAPTION.test(cur)) return true;
  const have = capWords(sug), kept = w => have.some(h => h === w || (w.length >= 4 && h.length >= 4 && (h.startsWith(w) || w.startsWith(h))));   // roof ≈ rooftop
  return capWords(cur).some(w => !kept(w));   // a word was dropped or replaced: typo or wrong subject
}

async function captions(snap, ctx) {
  if (!ctx.photoInsights || !Object.keys(ctx.photoInsights).length) return null;
  const items = [];
  for (const p of snap.photos || []) {
    const ins = ctx.photoInsights[p.imageId];
    if (!ins || ins.captionOk || !renameWorthIt(p.caption, ins.suggestedCaption)) continue;
    items.push(mk('captions', { title: `Rename photo ${p.imageId}`, message: `"${p.caption}" → "${ins.suggestedCaption}"`, current: p.caption, suggested: ins.suggestedCaption,
      severity: 'advisory', checklistItem: '4.1', evidence: { photos: [p.imageId] }, proposedWrites: [{ key: `caption${p.imageId}`, value: ins.suggestedCaption, kind: 'caption' }], confidence: 0.85, reasoning: ins.description }));
  }
  return { engine: 'openai', summary: { photos: (snap.photos || []).length, renames: items.length }, items };
}

// ---------------------------------------------------------------- narrative
// Check + draft (2026-11-06, replaces "issues only" of 2026-11-05): TIS's building question set
// (rules/narrative-questions.json), the global coverage rules (GLOBAL-001, rules/coverage-rules.json) and a draft
// in the style of TIS's example narratives (rules/narrative-examples.json). The reviewer applies the draft or not.
const N_SCHEMA = S({
  answers: { type: 'array', items: S({ id: str, answer: str, inForm: bool, inNarrative: bool, fieldKey: str }) },
  hazardousTenants: { type: 'array', items: en('restaurant', 'woodworking', 'auto_body') },
  coverage: { type: 'array', items: S({ coverage: str, addressed: en('yes', 'partial', 'no'), where: str, topics: str }) },
  issues: { type: 'array', items: S({ type: en('contradiction', 'missing_required', 'stale_value', 'spelling', 'grammar', 'style'), topic: str, quote: str, formValue: str, meaningDiffers: bool, problem: str, fix: str, fieldKey: str, confidence: num }) },
  draft: str,
});
const CONFIRM_RE = /\[\[confirm:[^\]]*\]\]/gi;
const HAZARD_BLOCKS = new Set(['restaurant', 'woodworking', 'auto_body']);
// primary use, occupancy %, construction, stories, square footage, roof condition, hazardous tenants (+ their operations),
// apartment count, sprinklers: what the QC checklist (5.2 / 5.3) compares the narrative with
const CORE_Q = new Set(['q2', 'q4', 'q5', 'q6', 'q7', 'q10', 'q14', 'q15', 'q16', 'q18']);
const NOT_A_FACT = /^(n\/?a|none|not applicable|no(ne)? (units|apartments)|0|zero)\.?$/i;
// The form field that answers a TIS narrative question. The AI's fieldKey is kept only when that field's question
// shares a word with ours ("apartment", "sprinkler", "roof"…); otherwise the best-matching field on the form is used,
// or none. 1168089 (2026-11-10): q16 "How many apartment units are there?" was linked to the form's "16. Number of
// years the insured has owned the building", so "Go to question" opened the wrong question.
const Q_STOP = new Set(['what', 'which', 'when', 'where', 'there', 'their', 'many', 'much', 'does', 'have', 'with', 'this', 'that', 'were', 'been', 'being', 'building', 'buildings', 'property', 'current', 'currently', 'last', 'type', 'types', 'describe', 'nature', 'provide', 'details', 'risk', 'insured', 'premises', 'from', 'than', 'other', 'into', 'about', 'year']);
const qWords = s => new Set((String(s).toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !Q_STOP.has(w)).map(w => w.replace(/(ies)$/, 'y').replace(/s$/, '')));
export function questionField(snap, question, key) {
  const want = qWords(question); if (!want.size) return key || '';
  const all = (snap.forms || []).flatMap(f => (f.sections || []).filter(s => !s.internal && !s.omitted).flatMap(s => (s.fields || []).flatMap(x => [{ key: x.key, label: x.label, value: x.value }, x.comment ? { key: x.comment.key, label: x.label, value: x.comment.value } : null]))).filter(Boolean);   // not TIS's internal QC fields
  const score = f => [...qWords(f.label)].filter(w => want.has(w)).length;
  const given = key && all.find(f => f.key === key);
  if (given && score(given) > 0) return key;
  // shared words, weighed against the length of the form's question: "5. # of apartments?" beats a long question
  // that mentions apartments and units in passing (illegal conversions…); then one that has an answer
  const len = f => Math.max(1, (String(f.label).match(/[a-z]{3,}/gi) || []).length);
  const best = all.map(f => ({ f, s: score(f) / Math.sqrt(len(f)) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || !!String(b.f.value || '').trim() - !!String(a.f.value || '').trim())[0];
  return best?.f.key || '';
}
const ISSUE_TITLE = { contradiction: 'Narrative contradicts the form', missing_required: 'Narrative is missing required content', stale_value: 'Stale value in narrative', spelling: 'Spelling', grammar: 'Grammar', style: 'Style' };

async function narrative(snap, ctx) {
  const f = narrativeField(snap);
  if (!f) return null;
  const current = String(f.value || '').trim();
  const qs = applicableQuestions(snap), needs = coverageNeeds(snap), examples = pickExamples(snap, 2);
  const writingNeeds = needs.filter(c => c.need === 'writing');
  const { data } = await call(snap, ctx, { schemaName: 'narrative', schema: N_SCHEMA, temperature: 0.3,
    user: current ? 'Check the narrative and write the draft now.' : 'The narrative is empty: answer the questions from the report and write the draft now.',
    system: prompt('narrative', {
      coverage: coverageText(snap), instructions: f.help || '(none)', narrative: current || '(empty)',
      questions: qs.sections.map(s => `${s.title}${s.when === 'gl' ? ' (GL)' : s.when === 'hazard' ? ' (only if this tenant is present)' : ''}:\n` + s.questions.map(q => `- ${q.id}: ${q.q}`).join('\n')).join('\n'),
      coverageNeeds: writingNeeds.length ? writingNeeds.map(c => `- ${c.label} (${c.rule.profile}${c.rule.extra ? ', ' + c.rule.extra : ''})${c.section ? `: dedicated section ${c.section}, summarise its material findings` : ': no dedicated section on the attached forms'}. Topics: ${c.rule.topics || c.rule.scope}`).join('\n') : '(none: return an empty coverage list)',
      glNote: qs.gl ? 'walking surfaces, lighting, stairs and handrails, sidewalks, signs, emergency lighting and exit signs (GL is ordered),' : '(property only: leave out trip/fall, handrail and sidewalk content)',
      examples: examples.map((e, i) => `Example ${i + 1}:\n"""\n${e.text}\n"""`).join('\n\n'),
    }) });

  const items = [];
  // issues: a contradiction must quote both sides; otherwise it is an omission
  const kept = data.issues.filter(i => i.type !== 'contradiction' || (i.meaningDiffers && i.quote.trim() && i.formValue.trim() && i.confidence >= 0.6 && !/consistent with|matches|agrees with/i.test(i.problem)));
  // one card per type + topic (the test run showed "Narrative is missing required content" three times in a row)
  const issues = [];
  for (const i of kept) {
    let topic = String(i.topic || '').trim().replace(/[.:]+$/, '');
    if ([i.type, i.type.replace('_', ' '), ISSUE_TITLE[i.type]].some(x => x.toLowerCase() === topic.toLowerCase())) topic = '';   // "Grammar: grammar"
    const twin = topic && issues.find(x => x.type === i.type && x.topic.toLowerCase() === topic.toLowerCase());
    if (twin) { twin.problem += ` ${i.problem}`; if (!twin.fix && i.fix) twin.fix = i.fix; twin.confidence = Math.max(twin.confidence, i.confidence); continue; }
    issues.push({ ...i, topic });
  }
  for (const i of issues) items.push(mk('narrative', { kind: i.type, title: !i.topic ? ISSUE_TITLE[i.type] : i.type === 'missing_required' ? `Missing from the narrative: ${i.topic}` : `${ISSUE_TITLE[i.type]}: ${i.topic}`,
    message: `${i.problem}${i.type === 'contradiction' ? ` Narrative: “${i.quote}” · Form: “${i.formValue}”.` : ''}${i.fix ? ` Fix: ${i.fix}` : ''}`, quote: i.quote,
    severity: (i.type === 'contradiction' || i.type === 'stale_value') && i.confidence >= 0.85 ? 'blocker' : i.type === 'contradiction' || i.type === 'stale_value' || i.type === 'missing_required' ? 'warning' : 'advisory',
    checklistItem: i.type === 'missing_required' ? '5.3' : '5.2', evidence: { fields: [i.fieldKey].filter(k => /^F\d/.test(k)), text: [i.quote].filter(Boolean) }, confidence: i.confidence }));

  // question set: only questions that apply (GL decided in code, hazardous tenants confirmed by the model)
  const confirmed = new Set(data.hazardousTenants || []);
  const applies = new Map(qs.sections.filter(s => !HAZARD_BLOCKS.has(s.id) || confirmed.has(s.id)).flatMap(s => s.questions.map(q => [q.id, q])));
  const answers = (data.answers || []).filter(a => applies.has(a.id));
  const short = q => q.replace(/\?.*$/, '?');
  const upTo8 = list => list.slice(0, 8).join(' · ') + (list.length > 8 ? ` · and ${list.length - 8} more` : '');
  // "leaves out N facts" counted every question of the set (16–26 on several orders). TIS's checklist asks the narrative
  // to match the report on SF, ISO and hazards and to describe operations: only those facts (CORE_Q, and the questions
  // of a hazardous tenant the model confirmed) are reported; the rest stay in the summary and the draft covers them.
  const isCore = a => CORE_Q.has(a.id) || HAZARD_BLOCKS.has(qs.sections.find(s => s.questions.some(q => q.id === a.id))?.id);
  for (const a of answers) a.fieldKey = questionField(snap, applies.get(a.id).q, a.fieldKey);   // the AI can mix q16 up with the form's "16."
  // "N/A" / "none" is not a fact the narrative has to state (1168089: "How many apartment units are there? N/A" on a strip center)
  const leftAll = answers.filter(a => a.inForm && !a.inNarrative && a.answer.trim() && !NOT_A_FACT.test(a.answer.trim()));
  const left = leftAll.filter(isCore);
  const unknown = answers.filter(a => !a.inForm && !a.inNarrative && isCore(a));
  if (current && left.length) items.push(mk('narrative', { kind: 'missing_required', title: `Narrative leaves out ${left.length} fact${left.length > 1 ? 's' : ''} from the form`,
    message: upTo8(left.map(a => `${short(applies.get(a.id).q)} ${a.answer}`)), severity: 'advisory', checklistItem: '5.3',
    evidence: { fields: left.map(a => a.fieldKey).filter(k => /^F\d/.test(k)).slice(0, 3), text: [] }, confidence: 0.7, questions: left.map(a => a.id) }));
  if (unknown.length) items.push(mk('narrative', { kind: 'not_in_report', title: `Not in the report: ${unknown.length} narrative question${unknown.length > 1 ? 's' : ''}`,
    message: upTo8(unknown.map(a => short(applies.get(a.id).q))) + ' Ask the inspector, or leave out if not applicable.', severity: 'advisory', checklistItem: '5.3', confidence: 0.6, questions: unknown.map(a => a.id) }));

  // ordered coverages that must be addressed in writing (GLOBAL-001)
  for (const c of data.coverage || []) {
    if (c.addressed === 'yes') continue;
    const need = writingNeeds.find(n => [n.label, n.rule.label].some(l => l.toLowerCase() === c.coverage.toLowerCase())) || writingNeeds.find(n => new RegExp(n.rule.match, 'i').test(c.coverage));
    if (!need) continue;
    items.push(mk('narrative', { kind: 'coverage', title: `${c.addressed === 'no' ? 'Not addressed' : 'Partly addressed'}: ${need.rule.label}`,
      message: `${need.label} is ordered${need.section ? ` (section ${need.section})` : ' and has no dedicated section'}, so the narrative should cover it (GLOBAL-001). Add: ${c.topics || need.rule.topics}.`,
      severity: c.addressed === 'no' ? 'warning' : 'advisory', checklistItem: '5.3', confidence: 0.75, rule: 'GLOBAL-001' }));
  }

  // the draft: an offer, not a defect (needs_review keeps it out of the score)
  const draft = String(data.draft || '').trim();
  const confirm = draft.match(CONFIRM_RE) || [];
  if (draft) items.push(mk('narrative', { kind: 'draft', title: current ? 'Draft narrative in TIS style' : 'Draft narrative (the narrative is empty)',
    message: confirm.length ? `${confirm.length} fact${confirm.length > 1 ? 's' : ''} to confirm before saving: ${confirm.map(m => m.replace(/^\[\[confirm:\s*|\]\]$/gi, '')).join(' · ')}` : 'Built from the form answers, recommendations and photos.',
    before: current || null, after: draft, confirm: confirm.length, severity: 'info', status: 'needs_review', confidence: 0.7, examples: examples.map(e => e.id),
    evidence: { fields: [f.key], text: [] }, proposedWrites: [{ key: f.key, value: draft, kind: 'text' }] }));

  return { engine: 'openai', summary: { issues: issues.length, questions: applies.size, answered: answers.filter(a => a.inForm || a.inNarrative).length, leftOut: left.length, leftOutOther: leftAll.length - left.length, notInReport: unknown.length,
    coverageGaps: items.filter(i => i.kind === 'coverage').length, gl: qs.gl, hazardousTenants: [...confirmed], draft: !!draft, confirm: confirm.length }, items };
}

export const AI = { photoReview, uwConcerns, recommendations, recPhotos, questions, captions, narrative };
