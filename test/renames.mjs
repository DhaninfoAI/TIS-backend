// Unit check for renameWorthIt: rename bad captions, typos and wrong subjects; never just to add detail.
//   npm test   (or node test/renames.mjs)
import { renameWorthIt } from '../lib/ai-modules.mjs';

const cases = [
  // the 6 renames proposed on 1166305 (all only add detail) → dropped
  ['Roof Closeup', 'Roof with Satellite Dish', false],
  ['Roof Closeup', 'Snow-Covered Roof', false],
  ['Roof Closeup', 'Rooftop with Satellite Dish', false],   // roof ≈ rooftop
  ['Front', 'Front elevation', false],
  ['Drive thru window broken', 'Broken drive-thru window', false],
  ['Fire Extinguisher Tag', 'Fire extinguisher inspection tag', false],
  // bad captions → renamed
  ['130 east 72nd st-IMG_3699 basement clutter', 'Basement – accumulated storage', true],
  ['IMG_3673', 'Front sidewalk', true],
  ['DSC00412.JPG', 'Rear exposure', true],
  ['', 'Electrical panel', true],
  ['12345', 'Gas meter', true],
  // typos and wrong subjects → renamed
  ['Electical panel', 'Electrical panel', true],
  ['Gas meter', 'Electric meter', true],
  ['Front', 'Rear exposure', true],
  // no change → nothing
  ['Gas meter', 'gas meter', false],
  ['Interior', '', false],
];
let fail = 0;
for (const [cur, sug, want] of cases) {
  const got = renameWorthIt(cur, sug);
  if (got !== want) fail++;
  console.log(got === want ? '✓' : '✗', `"${cur}" → "${sug}"`, got ? 'rename' : 'keep');
}
console.log(fail ? `${fail} FAILED` : `ALL PASS ${cases.length}`);
process.exit(fail ? 1 : 0);
