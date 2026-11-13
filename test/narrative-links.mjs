// Unit check for questionField: which form question a TIS narrative question links to ("Go to question").
// 1168089 (2026-11-10): q16 "How many apartment units are there?" was linked to the form's "16. Number of years the
// insured has owned the building".  node test/narrative-links.mjs
import assert from 'node:assert/strict';
import { questionField, issueField, notAsked, numbersIn, restatesForm } from '../lib/ai-modules.mjs';

const field = (key, label, value = '', comment) => ({ key, label, value, ...(comment ? { comment: { key: comment, value } } : {}) });
const snap = { forms: [{ name: 'Seneca General Form', sections: [
  { title: "Occupancy cont'd", fields: [
    field('F1_5', '5. # of apartments?', 'N/A'),
    field('F4_15', '15. Risk free of observed/reported illegal subdivisions, e.g. illegal conversions of apartments into multiple units?', 'Yes'),
    field('F1_16', '16. Number of years the insured has owned the building (if the insured is a tenant, how long have they occupied)?', 'Owner-12 year', 'F1_16c'),
    field('F1_18', '18. % occupied (if occupancy rate is under 75%, FULLY explain)?', '100%')] },
  { title: 'Sprinklers (omit if no sprinkler system)', omitted: true, fields: [field('F4_S1', '1. Is risk premises 100% sprinklered?', '')] },
  { title: 'QC Checklist', internal: true, fields: [field('F2_QC', 'Square Footage issues:', '')] },
  { title: 'Construction', fields: [field('F1_3', '3. Total square footage, excluding any unfinished basement area?', '14,450')] },
] }] };

let fail = 0;
const t = (name, fn) => { try { fn(); console.log('✓', name); } catch (e) { fail++; console.log('✗', name, '-', e.message); } };
t('q16 linked to the form\'s "16." comment → corrected to "# of apartments"', () => assert.equal(questionField(snap, 'How many apartment units are there?', 'F1_16c'), 'F1_5'));
t('q16 with no key → "# of apartments", not the long illegal-conversions question', () => assert.equal(questionField(snap, 'How many apartment units are there?', ''), 'F1_5'));
t('a right key is kept', () => assert.equal(questionField(snap, 'What percentage of the building is currently occupied?', 'F1_18'), 'F1_18'));
t('internal QC fields are never picked', () => assert.equal(questionField(snap, 'What is the total square footage?', ''), 'F1_3'));
t('omitted sections are never picked', () => assert.notEqual(questionField(snap, 'Is the building sprinklered?', ''), 'F4_S1'));
t('nothing related on the form → no link', () => assert.equal(questionField(snap, 'Are there any Zinsco or Stab-Lok electrical panels?', 'F1_16'), ''));
// narrative issues (1166305, 2026-11-13): "Missing from the narrative: coverage" linked to "Date of Survey"
const snap2 = { forms: [{ name: 'General Form', sections: [
  { title: 'General Information', fields: [field('F1_DATE', 'Date of Survey:', '9/21/26')] },
  { title: 'Construction', fields: [field('F1_SF', '3. Total square footage, excluding any unfinished basement area?', '14,450'), field('F1_ROOF', 'Year roof updated?', '2017')] },
  { title: 'Occupancy', fields: [field('F1_OCC', '18. % occupied (if occupancy rate is under 75%, FULLY explain)?', '0%'), field('F4_HK', 'Housekeeping satisfactory?', 'No')] },
  { title: 'Sprinkler Protection', fields: [field('F2_SPR', '1. Is risk premises 100% sprinklered (if only partially sprinklered, indicate what areas have coverage)?', 'No')] },
  { title: 'QC Checklist', internal: true, fields: [field('F2_QC', 'Narrative describes operations:', '')] },
] }] };
t('issue "coverage" with the Date of Survey key → no link', () => assert.equal(issueField(snap2, { topic: 'coverage', fieldKey: 'F1_DATE' }), ''));
t('issue "coverage" without a key → no link (not the sprinkler question)', () => assert.equal(issueField(snap2, { topic: 'coverage', fieldKey: '' }), ''));
t('issue "square footage" keeps the square footage key', () => assert.equal(issueField(snap2, { topic: 'square footage', fieldKey: 'F1_SF' }), 'F1_SF'));
t('issue "roof age" keeps "Year roof updated?"', () => assert.equal(issueField(snap2, { topic: 'roof age', fieldKey: 'F1_ROOF' }), 'F1_ROOF'));
t('issue "occupancy" keeps "% occupied" (same word stem)', () => assert.equal(issueField(snap2, { topic: 'occupancy', fieldKey: 'F1_OCC' }), 'F1_OCC'));
t('contradiction keeps a key whose answer is the quoted form value', () => assert.equal(issueField(snap2, { topic: 'upkeep', fieldKey: 'F1_SF', formValue: '14,450' }), 'F1_SF'));
t('internal QC field never linked', () => assert.equal(issueField(snap2, { topic: 'operations', fieldKey: 'F2_QC' }), ''));
// hazardous-operations follow-up (q15) is not asked when there are no hazardous tenants (1166305: 100% vacant)
const A = (id, answer, inForm = true) => ({ id, answer, inForm, inNarrative: false });
t('q14 "No" → q15 not asked', () => assert.deepEqual([...notAsked([A('q14', 'No'), A('q15', '', false)])], ['q15']));
t('q14 "vacant building, no tenants" → q15 not asked', () => assert.deepEqual([...notAsked([A('q14', 'The building is 100% vacant.')])], ['q15']));
t('q14 "Yes, a restaurant" → q15 asked', () => assert.deepEqual([...notAsked([A('q14', 'Yes, a restaurant tenant')])], []));
t('q14 not in the report → q15 still asked', () => assert.deepEqual([...notAsked([A('q14', 'No', false)])], []));
// a "contradiction" that states the form's own number (1166305, 2026-11-13: "nine years" vs "9 years", a blocker)
t('numbers in words and digits', () => assert.deepEqual(numbersIn('nine years, twenty-five units, 14,450 sf, 100%'), [9, 25, 14450, 100]));
t('"approximately nine years" vs "9 years" → same, not a contradiction', () => assert.equal(restatesForm('has been owned by the insured for approximately nine years', '9 years'), true));
t('"six years" vs "9 years" → a real contradiction', () => assert.equal(restatesForm('owned for six years', '9 years'), false));
t('"14,450 square feet" vs "14450" → same', () => assert.equal(restatesForm('a 14,450-square-foot building', '14450'), true));
t('"two-story" vs "3" → a real contradiction', () => assert.equal(restatesForm('a two-story building', '3'), false));
t('no number in the form value (Yes/No) → left to the other checks', () => assert.equal(restatesForm('housekeeping is good', 'No'), false));
console.log(fail ? `${fail} FAILED` : 'ALL PASS 23');
process.exit(fail ? 1 : 0);
