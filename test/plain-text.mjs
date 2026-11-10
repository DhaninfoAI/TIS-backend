// Unit check for plainText: drafted underwriter answers carry no EZ field keys or photo ids (1168089, 2026-11-10).
// node test/plain-text.mjs
import assert from 'node:assert/strict';
import { plainText } from '../lib/ai-modules.mjs';

const cases = [
  ['field key + "as confirmed in…"', 'There is no sprinkler system present as confirmed in the narrative and form [F4_112427_1_10704437].', 'There is no sprinkler system present.'],
  ['photo ids + "as confirmed by photos"', 'The roof is in good condition with no pooling of water or deteriorating areas as confirmed by photos 18488889 and 18488890.', 'The roof is in good condition with no pooling of water or deteriorating areas.'],
  ['"where" with a key', '[F8_112426_1_10703759] Date of Survey: = 08/24/2026', 'Date of Survey: 08/24/2026'],
  ['"(see photo …)"', 'Sidewalks were in good condition (see photo 18488901).', 'Sidewalks were in good condition.'],
  ['plain answer untouched', 'Occupancy is 100%. Rent rolls were not provided.', 'Occupancy is 100%. Rent rolls were not provided.'],
  ['numbers that are not photo ids stay', 'The building is 14,450 sf, built in 2017, and has 2 stories.', 'The building is 14,450 sf, built in 2017, and has 2 stories.'],
];
let fail = 0;
for (const [name, input, want] of cases) {
  try { assert.equal(plainText(input), want); console.log('✓', name); } catch (e) { fail++; console.log('✗', name, '-', JSON.stringify(plainText(input))); }
}
console.log(fail ? `${fail} FAILED` : `ALL PASS ${cases.length}`);
process.exit(fail ? 1 : 0);
