// Narrative knowledge: TIS's building question set, the global coverage rules and TIS's example narratives.
// Used by the AI narrative step (check + draft) and by its no-AI fallback (keyword check).

import { readFileSync } from 'node:fs';
import { allFields, isGLOrder, isPropertyOnlyOrder, narrativeText } from './snapshot.mjs';

const load = f => JSON.parse(readFileSync(new URL(`../rules/${f}`, import.meta.url), 'utf8'));
export const QUESTIONS = load('narrative-questions.json');
export const COVERAGE = load('coverage-rules.json');
export const EXAMPLES = load('narrative-examples.json').examples;
const DF = new Map(); for (const e of EXAMPLES) for (const k of e.keywords) DF.set(k, (DF.get(k) || 0) + 1);
const IDF = new Map([...DF].map(([k, n]) => [k, Math.log(EXAMPLES.length / n)]));

/** Is General Liability part of this order (Package, BOP, Monoline GL, CGL or any liability box)? */
export function hasGL(snap) {
  const of = snap.order?.orderForm || {};
  return !isPropertyOnlyOrder(snap) && (isGLOrder(snap) || (of.coverages || []).some(c => /general liability|\bcgl\b/i.test(c)));
}

/** Tenant types from the question set's hazardous blocks that appear in the order (business, forms, narrative). */
export function hazardTypes(snap) {
  const answered = (snap.forms || []).flatMap(f => (f.sections || []).filter(s => !s.omitted && (s.fields || []).some(x => String(x.value || '').trim())).map(s => s.title));
  const text = [snap.order?.orderForm?.natureOfBusiness, narrativeText(snap), ...answered].join(' \n ');
  return QUESTIONS.hazardous.filter(h => new RegExp(h.detect, 'i').test(text)).map(h => h.type);
}

/** The questions this order's narrative should answer, grouped by section. */
export function applicableQuestions(snap) {
  const gl = hasGL(snap), hz = hazardTypes(snap);
  const sections = QUESTIONS.sections.filter(s => s.when !== 'gl' || gl).map(s => ({ ...s }));
  for (const h of QUESTIONS.hazardous) if (hz.includes(h.type)) sections.push({ id: h.type, title: h.title, when: 'hazard', questions: h.questions });
  return { gl, hazards: hz, sections, all: sections.flatMap(s => s.questions.map(q => ({ ...q, section: s.title }))) };
}

/** Ordered coverages and where each is documented (GLOBAL-001). */
export function coverageNeeds(snap) {
  const of = snap.order?.orderForm || {};
  const labels = [...(of.coverages || []), ...(of.liability || []), of.crime ? 'Crime Coverage' : null, of.inlandMarine ? 'Inland/Ocean Marine Coverage' : null].filter(Boolean);
  const secs = (snap.forms || []).flatMap(f => (f.sections || []).map(s => ({ form: f.name, title: s.title || '', omitted: !!s.omitted, answered: (s.fields || []).filter(x => String(x.value || '').trim()).length })));
  const out = [];
  for (const label of labels) {
    const rule = COVERAGE.coverages.find(c => new RegExp(c.match, 'i').test(label));
    if (!rule || out.some(o => o.rule.id === rule.id)) continue;
    const sec = rule.section ? secs.find(s => new RegExp(rule.section, 'i').test(s.title) && !s.omitted) : null;
    const need = !rule.writing ? 'general' : rule.writing === 'none' ? (sec ? 'section' : 'none') : sec && !rule.alwaysSummarise ? 'section' : 'writing';
    out.push({ label, rule, section: sec ? `${sec.form} / ${sec.title}` : null, sectionAnswered: sec?.answered || 0, need });
  }
  return out;
}

/** The n TIS example narratives closest to this order (shared words with its business, tenants and construction). */
export function pickExamples(snap, n = 2) {
  // what the risk is: business, insured, free-text answers and the current narrative (not question labels, which every form shares)
  const f = allFields(snap).filter(x => x.type !== 'choice' && String(x.value || '').trim()).map(x => x.value).join(' ');
  const text = `${snap.order?.orderForm?.natureOfBusiness || ''} ${snap.order?.insured || ''} ${f}`.toLowerCase();
  const forms = w => [w, w.replace(/s$/, ''), w + 's'];
  const want = new Set((text.match(/[a-z]{4,}/g) || []).flatMap(forms));
  const kind = new Set((`${snap.order?.orderForm?.natureOfBusiness || ''} ${snap.order?.insured || ''}`.toLowerCase().match(/[a-z]{4,}/g) || []).flatMap(forms));   // what the risk is: counts triple
  const gl = hasGL(snap);
  // rarer shared words count more (a word every example uses says nothing about fit)
  return EXAMPLES.map(e => ({ e, s: e.keywords.filter(k => want.has(k)).reduce((a, k) => a + IDF.get(k) * (kind.has(k) ? 3 : 1), 0)
      + (kind.size && [...kind].some(k => k.length > 4 && new RegExp(`\\b${k}\\b`, 'i').test(e.text.slice(0, 300))) ? 3 : 0)
      - (e.words > 750 ? 6 : 0) - (!gl && /trip\/fall|handrail/i.test(e.text) ? 1 : 0) }))
    .sort((a, b) => b.s - a.s || a.e.id - b.e.id).slice(0, n).map(x => x.e);
}

/** No-AI fallback: which applicable topics the narrative never mentions, and which ordered coverages it skips. */
export function keywordCheck(snap, text = narrativeText(snap)) {
  const { all } = applicableQuestions(snap);
  const missing = all.filter(q => q.kw && !new RegExp(q.kw, 'i').test(text));
  const coverageGaps = coverageNeeds(snap).filter(c => c.need === 'writing' && c.rule.kw && !new RegExp(c.rule.kw, 'i').test(text));
  return { missing, coverageGaps };
}
