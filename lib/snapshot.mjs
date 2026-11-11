// Helpers for reading an OrderSnapshot (schema in docs/BACKEND_REQUIREMENTS.md §3.2).

import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync(new URL('../rules/form-registry.json', import.meta.url), 'utf8'));

export function formType(name = '') {
  const hit = registry.forms.find(f => f.name.endsWith('*')
    ? name.startsWith(f.name.slice(0, -1))
    : f.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit;
  if (/property.?only/i.test(name)) return { name, type: 'property_only', qcRelevant: true };
  if (/general form/i.test(name)) return { name, type: 'general', qcRelevant: true };
  if (/recommendation/i.test(name)) return { name, type: 'recommendations', qcRelevant: true };
  return { name, type: 'supplement', qcRelevant: true };
}

/** Flatten every field of every QC-relevant form, carrying form/section context. */
export function allFields(snap) {
  const out = [];
  for (const form of snap.forms || []) {
    const ft = formType(form.name);
    if (form.qcRelevant === false || ft.qcRelevant === false) continue;
    for (const sec of form.sections || []) {
      for (const f of sec.fields || []) {
        out.push({ ...f, form: form.name, formType: ft.type, sectionId: sec.sectionId,
                   sectionTitle: sec.title, omitted: !!sec.omitted, internal: !!sec.internal });
      }
    }
  }
  return out;
}

const qRegex = Object.fromEntries(Object.entries(registry.keyQuestions)
  .map(([k, pats]) => [k, pats.map(p => new RegExp(p, 'i'))]));

/** Find fields answering a "key question" (see form-registry.json). Non-omitted first. */
export function findQ(snap, q, { includeOmitted = false } = {}) {
  const pats = qRegex[q];
  if (!pats) return [];
  return allFields(snap)
    .filter(f => (includeOmitted || !f.omitted) && !f.internal)
    .filter(f => pats.some(r => r.test(f.label || '')));
}

/**
 * The answer to a key question. When no form question answers it, falls back to:
 *  - the per-building table (Hotel & Motel "Construction", Camp "Section IV", General Form "Occupancy" grid), see GRID_COLS;
 *  - occupancy % worked out from "# of units" and "# of vacant units" (MSI asks no % question);
 *  - "No" sprinklers when the sprinkler section says "omit if no sprinkler system" and is omitted.
 * Fallbacks are read-only (fromGrid / derived): nothing should be written to their keys.
 */
export function firstQ(snap, q) {
  const hits = findQ(snap, q);
  return hits.find(f => String(f.value ?? '').trim() !== '') || gridFact(snap, q) || derivedFact(snap, q) || hits[0] || null;
}

export function num(v) {
  if (v == null) return null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * Square footage as written on the forms. The question says "if multiple buildings, so indicate & label for each e.g.
 * 8,000sf-main bldg; 2,500sf-storage bldg", so "25,722sf - B1, 25,722sf-B2, 25,722sf-B3" is 77,166, not 25,722.
 * A figure marked total / all buildings wins; otherwise the figures with a unit (sf, sq ft, square feet) are added up.
 * Numbers without a unit (B1, Bldg 2) are labels, unless no figure has a unit (then the first number, as before).
 */
export function sqftValue(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(s\.?f\.?\b|sq\.?\s*f(?:ee|oo)?t\.?|square\s*f(?:ee|oo)?t)?([^\d;,]{0,24})/gi;
  const figs = [...s.matchAll(re)].map(m => ({ n: Number(m[1].replace(/,/g, '')), unit: !!m[2], tail: m[3] || '' }));
  const withUnit = figs.filter(f => f.unit);
  if (!withUnit.length) return num(s);
  const total = withUnit.find(f => /total|all\s*(bldg|building)s?|combined|overall/i.test(f.tail));
  if (total || withUnit.length === 1) return (total || withUnit[0]).n;
  return withUnit.reduce((a, f) => a + f.n, 0);
}

/** Total square footage of the risk (form question, else the building table). */
export function totalSqft(snap) {
  const f = firstQ(snap, 'total_sqft');
  return f ? sqftValue(f.value) : null;
}

/** Number of buildings in a free-text answer: "11", "8 apartment buildings, one clubhouse and 6 garages" = 15. */
const WORD_N = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
export function buildingCount(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).toLowerCase().replace(/\(.*?\)/g, ' ');
  const ns = [...s.matchAll(/\b(\d{1,3})\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g)].map(m => m[1] ? Number(m[1]) : WORD_N[m[2]]).filter(n => n > 0 && n < 400);
  return ns.length ? ns.reduce((a, b) => a + b, 0) : null;
}

/** Columns of the per-building tables (type-16 grids) whose heading matches re: [{ row, value, building }]. */
export function gridColumn(forms, re, not = null) {
  const out = [];
  for (const f of forms || []) {
    if (formType(f.name).qcRelevant === false) continue;
    for (const s of f.sections || []) {
      if (s.omitted) continue;
      for (const [key, cells] of Object.entries(s.grid || {})) {
        const heads = s.gridHeaders?.[key] || [], col = heads.findIndex(h => re.test(h) && !(not && not.test(h)));
        if (col < 0) continue;
        const name = heads.findIndex(h => /bldg|building|name/i.test(h));
        const byRow = {}; for (const [rc, v] of cells) { const [r, c] = rc.split('|').map(Number); (byRow[r] ||= {})[c] = v; }
        for (const [r, row] of Object.entries(byRow)) if (String(row[col] ?? '').trim()) out.push({ row: Number(r), value: String(row[col]).trim(), building: name >= 0 ? row[name] || '' : '', key, header: heads[col] });
      }
    }
  }
  return out;
}

// key question → building-table column (heading pattern, headings to skip, how rows combine)
const GRID_COLS = {
  total_sqft: [/sq\.?\s*f|square f|^total (risk )?area/i, /comm|vacant|parking|garage|basement/i, 'sum'],
  year_built: [/^yr\.? built|^yb\b|year built/i, null, 'first'],
  stories: [/# ?(of )?stories|^stories/i, null, 'first'],
  iso_class: [/construction (type|class)|^iso\b/i, null, 'list'],
  brick_veneer: [/veneer/i, null, 'list'],
};
function gridFact(snap, q) {
  const spec = GRID_COLS[q]; if (!spec) return null;
  const [re, not, how] = spec;
  const col = gridColumn(snap.forms, re, not); if (!col.length) return null;
  const value = how === 'sum' ? (col.map(c => sqftValue(c.value)).filter(Boolean).reduce((a, b) => a + b, 0) || null)
    : how === 'first' ? col[0].value : [...new Set(col.map(c => c.value))].join(', ');
  if (value == null || value === '') return null;
  return { key: `grid:${col[0].key}`, label: `${col[0].header} (building table, ${col.length} row${col.length > 1 ? 's' : ''})`, value: String(value), type: 'grid', fromGrid: true, rows: col.length };
}
function derivedFact(snap, q) {
  if (q === 'occupancy_pct') {
    const u = num(findQ(snap, 'units').find(f => String(f.value ?? '').trim())?.value);
    const vf = findQ(snap, 'vacant_units').find(f => String(f.value ?? '').trim());
    const v = vf && /^(n\/?a|none|no)$/i.test(String(vf.value).trim()) ? 0 : num(vf?.value);
    if (u > 0 && v != null && v <= u) return { key: 'derived:occupancy_pct', label: '% occupied (worked out from # of units and # of vacant units)', value: `${Math.round((u - v) / u * 100)}%`, type: 'derived', derived: true };
  }
  if (q === 'sprinklered') {
    const omitted = (snap.forms || []).some(f => formType(f.name).qcRelevant !== false && (f.sections || []).some(s => s.omitted && /sprinkler/i.test(s.title || '') && /omit if no sprinkler/i.test(s.title || '')));
    if (omitted) return { key: 'derived:sprinklered', label: 'Sprinkler section omitted ("omit if no sprinkler system")', value: 'No', type: 'derived', derived: true };
  }
  return null;
}

/** The narrative box: the first one with text (a K&K order can carry an empty General Form narrative and a filled Hotel one). */
export function narrativeField(snap) {
  const all = findQ(snap, 'narrative').filter(x => x.type === 'longtext');
  return all.find(x => String(x.value || '').trim()) || all[0] || null;
}

export function narrativeText(snap) {
  const f = narrativeField(snap);
  return f ? String(f.value || '') : '';
}

export function uwResponse(snap) {
  return findQ(snap, 'uw_response').find(x => x.type === 'longtext') || null;
}

export function isGLOrder(snap) {
  const of = snap.order?.orderForm || {};
  const cov = (of.coverages || []).join(' ');
  return /package|bop|monoline gl/i.test(cov) || (of.liability || []).length > 0;
}

export function isPropertyOnlyOrder(snap) {
  const of = snap.order?.orderForm || {};
  return (of.coverages || []).some(c => /monoline property/i.test(c)) && !(of.liability || []).length;
}

export function words(s) {
  return new Set(String(s || '').toLowerCase().match(/[a-z]{4,}/g) || []);
}

/** An answer that needs a recommendation by EZ's own flag. A blank answer never does: EZ's trigger lists sometimes end
 *  with "|" ("Yes-verbally…|No-not upgraded|"), which read as "blank triggers a rec" (Q27 on 1169277, 2026-11-11). */
export function recTriggered(f) {
  const v = String(f?.value ?? '').trim();
  return !!v && (f?.rec?.trigger || []).some(t => String(t).trim() && String(t).trim() === v);
}

// Same recommendation, different words ("Relocate BBQ units at least 10 feet…" ×3 on one order): content words,
// singular, with the filler every rec shares removed; ≥ 60% of the shorter one's words in common.
const REC_FILLER = new Set(['ensure', 'make', 'sure', 'safe', 'safety', 'safely', 'prevent', 'reduce', 'potential', 'hazard', 'hazards', 'risk', 'area', 'areas',
  'proper', 'properly', 'regularly', 'regular', 'maintain', 'from', 'with', 'that', 'this', 'into', 'onto', 'away', 'there', 'their', 'they', 'within', 'around', 'near', 'all', 'any',
  'the', 'and', 'for', 'are', 'was', 'its', 'per', 'not', 'use', 'install', 'repair', 'replace', 'remove', 'provide', 'clear', 'relocate', 'have', 'keep', 'inspect',
  'unit', 'building', 'bldg', 'one', 'two', 'three', 'interior', 'exterior', 'item', 'stored', 'storage',
  // the state every repair asks for ("Restore X to a smooth & even condition", 1169277): not what the rec is about
  'restore', 'restored', 'smooth', 'even', 'condition', 'good', 'working', 'order', 'damaged', 'damage', 'worn', 'level',
  'adequate', 'adequately', 'entire', 'free', 'like', 'new']);
const REC_SYN = { bbq: 'barbecue', barbeque: 'barbecue', grill: 'barbecue', bbqs: 'barbecue' };
const recWords = t => new Set(String(t || '').toLowerCase().match(/[a-z]{3,}/g)?.map(w => REC_SYN[w] || w).map(w => w.replace(/(?<=\w{3})(es|s)$/, '')).filter(w => !REC_FILLER.has(w) && w.length > 2) || []);
export function recSame(a, b) {
  const A = recWords(a), B = recWords(b);
  if (A.size < 2 || B.size < 2) return false;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  const small = Math.min(A.size, B.size);
  return n >= Math.min(3, small) && n / small >= 0.6;   // at least 3 shared subject words (fewer only for very short recs)
}

export function overlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export { registry };
