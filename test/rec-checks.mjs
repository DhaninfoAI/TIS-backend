// Recommendation checks after order 1169277 (2026-11-11): a blank answer is not "needs a recommendation", two recs
// about different things are not duplicates, and duplicates are named by their words, not field codes.
//   node test/rec-checks.mjs
import assert from 'node:assert/strict';
import { recTriggered, recSame } from '../lib/snapshot.mjs';
import { runRules } from '../lib/rules.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '→', e.message); } };
const RULES = [
  { id: 'recs.flagged_answer_has_rec', kind: 'code', severity: 'blocker', checklistItem: '4.1', message: 'Answer triggers a recommendation but the recommendation box is empty.' },
  { id: 'recs.duplicates', kind: 'code', severity: 'warning', checklistItem: '5.1', message: 'Two recommendations address the same hazard.' },
];
const q27 = value => ({ key: 'F2_1', label: '27. Has the branch aluminum wiring been upgraded?', type: 'choice', value,
  rec: { box: 'question', key: 'F13_1', text: '', trigger: ['Yes-verbally, w/o documentation', 'No-not upgraded', ''] } });
const snap = (fields, recs = []) => ({ forms: [{ name: 'General Form', sections: [{ title: 'Property Hazards', fields }] }], recommendations: recs });
const run = s => runRules(s, RULES).filter(i => i.status === 'fail');

console.log('recommendation checks');
t('a blank answer never needs a recommendation, even when EZ lists "" as a trigger', () => {
  assert.equal(recTriggered(q27('')), false); assert.equal(recTriggered(q27('  ')), false);
  assert.equal(run(snap([q27('')])).length, 0);
});
t('a real trigger answer with an empty box is still a must-fix', () => {
  assert.equal(recTriggered(q27('No-not upgraded')), true);
  const out = run(snap([q27('No-not upgraded')])); assert.equal(out.length, 1); assert.equal(out[0].severity, 'blocker');
});
t('parking lot and sidewalks are two hazards, not duplicates', () => {
  assert.equal(recSame('Restore parking lot to a smooth & even condition.', 'Restore sidewalks to a smooth and even condition.'), false);
  assert.equal(run(snap([], [{ key: 'F13_a', text: 'Restore parking lot to a smooth & even condition.' }, { key: 'F13_b', text: 'Restore sidewalks to a smooth and even condition.' }])).length, 0);
});
t('ceilings and sidewalks are not duplicates either', () => assert.equal(recSame('Restore ceilings to good condition.', 'Restore sidewalks to a smooth and even condition.'), false));
t('the same subject in other words is still a duplicate, named by its words', () => {
  const a = 'Restore parking lot to a smooth & even condition.', b = 'Repair the parking lot potholes and restore it to a smooth condition.';
  assert.equal(recSame(a, b), true);
  const out = run(snap([], [{ key: 'F13_1056_1_1', text: a }, { key: 'F13_1056_1_2', text: b }]));
  assert.equal(out.length, 1);
  assert.match(out[0].message, /^"Restore parking lot to a smooth & even condition\." and "Repair the parking lot potholes and restore it to a smooth…" look like the same recommendation\.$/);
  assert.doesNotMatch(out[0].message, /F13_/);
});
t('a rec number is used when the snapshot has one', () => {
  const out = run(snap([], [{ key: 'k1', number: 3, text: 'Repair the parking lot potholes.' }, { key: 'k2', number: 5, text: 'Fill the potholes in the parking lot.' }]));
  assert.equal(out.length, 1); assert.match(out[0].message, /^Rec 3 and Rec 5 /);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
