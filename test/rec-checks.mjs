// Recommendation checks after order 1169277 (2026-11-11): a blank answer is not "needs a recommendation", two recs
// about different things are not the same rec. (The duplicate-recommendation card was removed on 2026-11-13.)
//   node test/rec-checks.mjs
import assert from 'node:assert/strict';
import { recTriggered, recSame } from '../lib/snapshot.mjs';
import { runRules } from '../lib/rules.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '→', e.message); } };
const RULES = [
  { id: 'recs.flagged_answer_has_rec', kind: 'code', severity: 'blocker', checklistItem: '4.1', message: 'Answer triggers a recommendation but the recommendation box is empty.' },
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
// recSame stays: it stops the AI adding a new rec an existing one already says. Duplicate cards are gone (2026-11-13).
t('parking lot and sidewalks are two hazards', () => assert.equal(recSame('Restore parking lot to a smooth & even condition.', 'Restore sidewalks to a smooth and even condition.'), false));
t('ceilings and sidewalks are different too', () => assert.equal(recSame('Restore ceilings to good condition.', 'Restore sidewalks to a smooth and even condition.'), false));
t('the same subject in other words is the same rec', () => assert.equal(recSame('Restore parking lot to a smooth & even condition.', 'Repair the parking lot potholes and restore it to a smooth condition.'), true));
t('no duplicate-recommendation card, even for two recs that say the same thing (rule removed)', () => {
  const recs = [{ key: 'F13_1', text: 'Repair the parking lot potholes.' }, { key: 'F13_2', text: 'Fill the potholes in the parking lot.' }];
  assert.equal(runRules(snap([], recs), [{ id: 'recs.duplicates', kind: 'code', severity: 'warning', message: 'x' }]).length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
