// Unit check for questionField: which form question a TIS narrative question links to ("Go to question").
// 1168089 (2026-11-10): q16 "How many apartment units are there?" was linked to the form's "16. Number of years the
// insured has owned the building".  node test/narrative-links.mjs
import assert from 'node:assert/strict';
import { questionField } from '../lib/ai-modules.mjs';

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
console.log(fail ? `${fail} FAILED` : 'ALL PASS 6');
process.exit(fail ? 1 : 0);
