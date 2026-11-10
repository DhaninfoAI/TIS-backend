// Prior-report comparison: square footage, ISO class and sprinkler coverage of this order against the latest earlier
// survey of the same risk ("Matches:" on the EZ order page). Works for General Forms (key questions) and for forms that
// keep these per building in a table (Camp Supplement Section IV: "Total Sq. Ft.", "Construction Class").

import { firstQ, findQ, gridColumn, sqftValue, buildingCount } from './snapshot.mjs';

// ISO construction classes: 1 Frame, 2 Joisted Masonry, 3 Non-Combustible, 4 Masonry Non-Combustible,
// 5 Modified Fire Resistive, 6 Fire Resistive. Accepts "JM", "ISO 2", "ISO II", "Joisted Masonry (ISO-2)", "MNC"…
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };
const ISO_WORDS = [[/masonry non[- ]?combustible|\bmnc\b/i, 4], [/modified fire[- ]?resist|\bmfr\b/i, 5], [/fire[- ]?resist|\bfr\b/i, 6],
  [/joisted masonry|\bjm\b/i, 2], [/non[- ]?combustible|\bnc\b/i, 3], [/\bframe\b/i, 1]];
export const ISO_NAME = { 1: 'Frame', 2: 'Joisted Masonry', 3: 'Non-Combustible', 4: 'Masonry Non-Combustible', 5: 'Modified Fire Resistive', 6: 'Fire Resistive' };
export function isoClass(raw = '') {
  const s = String(raw);
  const n = s.match(/iso[\s-]*(?:class)?[\s-]*([1-6])\b/i) || s.match(/\(\s*iso[\s-]*([1-6])\s*\)/i); if (n) return Number(n[1]);
  const r = s.match(/iso[\s-]*(?:class)?[\s-]*(VI|IV|V|III|II|I)\b/i); if (r) return ROMAN[r[1].toUpperCase()];
  if (/^\s*[1-6]\s*$/.test(s)) return Number(s);
  for (const [re, c] of ISO_WORDS) if (re.test(s)) return c;
  return null;
}

// Sprinkler coverage as none / partial / full: "N", "No", "None", "0%" = none; "Y", "Yes", "Full", "100%" = full
export function sprinklerKind(raw = '') {
  const s = String(raw).trim();
  if (!s || /^(n\/?a|unknown|u\/?d)$/i.test(s)) return null;
  const pct = s.match(/(\d{1,3})\s*%/);
  if (pct) return Number(pct[1]) >= 100 ? 'full' : Number(pct[1]) === 0 ? 'none' : 'partial';
  if (/^(n|no|none|not sprinklered|unsprinklered)\b/i.test(s)) return 'none';
  if (/partial/i.test(s)) return 'partial';
  if (/^(y|yes|full|fully|100)\b|fully sprinklered|complete/i.test(s)) return 'full';
  return null;
}
const KIND_LABEL = { none: 'None', partial: 'Partial', full: 'Full' };

/** The facts of a snapshot (or of a prior report's forms). how = where they came from. */
export function priorFacts(snapLike) {
  const s = { forms: snapLike.forms || [] };
  const facts = { sqft: null, iso: null, sprinkler: null, buildings: null, how: {} };
  // square footage: the total question (per-building lists added up), else the building table (firstQ falls back to it)
  const tq = firstQ(s, 'total_sqft'); const tv = sqftValue(tq?.value);
  if (tv) { facts.sqft = tv; facts.how.sqft = tq.label; }
  // ISO class: the construction question, else the building table's classes
  const iq = findQ(s, 'iso_class').find(f => String(f.value || '').trim());
  if (iq) { facts.iso = { raw: iq.value, cls: [isoClass(iq.value)].filter(Boolean) }; facts.how.iso = iq.label; }
  else { const col = gridColumn(s.forms, /construction|^iso\b/i); if (col.length) { const raws = [...new Set(col.map(x => x.value))]; facts.iso = { raw: raws.join(', '), cls: [...new Set(col.map(x => isoClass(x.value)).filter(Boolean))].sort() }; facts.how.iso = 'building table'; } }
  // sprinkler coverage: the sprinkler question, else any answered "is it sprinklered" question, else a table column,
  // else an omitted "omit if no sprinkler system" section (= none)
  const real = f => String(f.value || '').trim() && !/^(n\/?a|u\/?d)$/i.test(String(f.value).trim());
  const sq = findQ(s, 'sprinklered').find(real)
    || allAnswered(s).find(f => real(f) && /sprinkler(ed)?\b.*(protect|coverage|system|%|percent)|sprinklered/i.test(f.label || '') && !/inspect|tag|contract|head|valve|test|maint|type of system|heated|good working/i.test(f.label || ''));
  if (sq) { facts.sprinkler = { raw: sq.value, kind: sprinklerKind(sq.value) }; facts.how.sprinkler = sq.label; }
  else {
    const col = gridColumn(s.forms, /sprinkl/i);
    if (col.length) { const kinds = [...new Set(col.map(x => sprinklerKind(x.value)).filter(Boolean))]; facts.sprinkler = { raw: [...new Set(col.map(x => x.value))].join(', '), kind: kinds.length === 1 ? kinds[0] : kinds.length ? 'partial' : null }; facts.how.sprinkler = 'building table'; }
    else { const d = firstQ(s, 'sprinklered'); if (d?.derived) { facts.sprinkler = { raw: 'No (sprinkler section omitted)', kind: 'none' }; facts.how.sprinkler = d.label; } }
  }
  // number of buildings: "# of buildings?", else the rows of the building table
  const bq = findQ(s, 'buildings').find(f => String(f.value || '').trim());
  const bn = buildingCount(bq?.value);
  if (bn) { facts.buildings = bn; facts.how.buildings = bq.label; }
  else { const rows = new Set(gridColumn(s.forms, /sq\.?\s*f|square f|^total (risk )?area|construction/i, /comm|vacant|parking/i).map(x => x.key + x.row)); if (rows.size) { facts.buildings = rows.size; facts.how.buildings = 'building table'; } }
  return facts;
}
function allAnswered(s) { return (s.forms || []).flatMap(f => (f.sections || []).filter(x => !x.omitted).flatMap(x => (x.fields || []).map(y => ({ ...y, label: y.label || x.title })))).filter(f => String(f.value || '').trim()); }

/** Compare this order with its latest prior report. Rows read like a QC note: "SF – Prior report = 4,712 – current = 4,440". */
export function comparePrior(snap) {
  const prior = (snap.priorReports || []).find(p => p.facts || p.sqft != null || p.iso || p.sprinkler) || (snap.priorReports || [])[0];
  if (!prior) return null;
  if (prior.error) return { prior: { orderId: prior.orderId, date: prior.date, error: prior.error }, rows: [] };
  const now = priorFacts(snap), was = prior.facts || { sqft: prior.sqft ?? null, iso: prior.iso ? { raw: prior.iso, cls: [isoClass(prior.iso)].filter(Boolean) } : null, sprinkler: prior.sprinkler ? { raw: prior.sprinkler, kind: sprinklerKind(prior.sprinkler) } : null };
  const fmt = n => n == null ? null : Number(n).toLocaleString('en-US');
  const rows = [];
  // square footage: a difference of more than 1% needs explaining, unless the two surveys cover a different number of
  // buildings (a complex surveyed in parts, or the "Matches:" link pointing at another property): then it is a scope note
  const sfSame = now.sqft != null && was.sqft != null ? Math.abs(now.sqft - was.sqft) <= Math.max(1, 0.01 * was.sqft) : null;
  const bDiffer = now.buildings && was.buildings && now.buildings !== was.buildings;
  const scope = sfSame === false && bDiffer ? `The prior report covered ${was.buildings} building${was.buildings > 1 ? 's' : ''}, this survey ${now.buildings}: compare building by building, or check that the prior report is the same property.` : null;
  rows.push({ key: 'sqft', label: 'SF', prior: fmt(was.sqft), current: fmt(now.sqft), same: scope ? null : sfSame, scope, checklistItem: '1.2' });
  if (bDiffer) rows.push({ key: 'buildings', label: 'Buildings', prior: String(was.buildings), current: String(now.buildings), same: false, info: true, checklistItem: '1.2' });
  const isoTxt = f => f ? `${f.raw}${f.cls?.length && !/iso|\d/i.test(f.raw) ? ` (ISO ${f.cls.join('/')})` : ''}` : null;
  const isoSame = now.iso?.cls?.length && was.iso?.cls?.length ? now.iso.cls.join() === was.iso.cls.join() : now.iso && was.iso ? String(now.iso.raw).toLowerCase() === String(was.iso.raw).toLowerCase() : null;
  rows.push({ key: 'iso', label: 'ISO', prior: isoTxt(was.iso), current: isoTxt(now.iso), same: isoSame, checklistItem: '2.4' });
  const spTxt = f => f ? `${f.raw}${f.kind && KIND_LABEL[f.kind].toLowerCase() !== String(f.raw).toLowerCase() ? ` (${KIND_LABEL[f.kind]})` : ''}` : null;
  const spSame = now.sprinkler?.kind && was.sprinkler?.kind ? now.sprinkler.kind === was.sprinkler.kind : null;
  rows.push({ key: 'sprinkler', label: 'Sprinkler coverage', prior: spTxt(was.sprinkler), current: spTxt(now.sprinkler), same: spSame, checklistItem: '3.7' });
  return { prior: { orderId: prior.orderId, date: prior.date || '', status: prior.status || '' }, rows, how: { now: now.how, prior: was.how || {} } };
}
