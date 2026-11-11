// Unit check for photoClaimRefuted: "no photos of X" claims vs. what the vision pass saw.  node test/photo-claims.mjs
import { photoClaimRefuted, shapeWords } from '../lib/ai-modules.mjs';

const roof = { 18441044: { scene: 'roof', caption: 'Roof Closeup', description: 'The image shows a snow-covered flat roof.' },
  18441041: { scene: 'roof', caption: 'Roof Hatch Lock', description: 'A roof hatch with a lock mechanism is visible.' } };
const noRoof = { 1: { scene: 'exterior', caption: 'Front', description: 'Brick facade.' }, 2: { scene: 'basement', caption: 'Basement', description: 'Boiler room.' } };
const ACCESS = '22. Was access provided to all required areas, including flat rooftop, if any (if No, explain)?';
const cases = [
  ['1166305 claim, roof photos exist → refuted', 'Claim of access to all areas is contradicted by lack of roof access evidence in photos and narrative.', roof, true],
  ['1166305 re-run: snow on an access question, roof photos exist → refuted', 'The narrative states that the roof was covered with snow, limiting observation of the roof surface, which contradicts the claim of full access.', roof, true, ACCESS],
  ['access question, basement not reached and no basement photo → kept', 'The narrative says the basement was locked, so access was not provided to all areas.', roof, false, ACCESS],
  ['snow on a roof-condition question (not access) → kept', 'The roof was covered with snow, so its condition could not be verified.', roof, false, '13. Roof free of any evidenced damage?'],
  ['same claim, no roof photos → kept', 'Claim of access to all areas is contradicted by lack of roof access evidence in photos and narrative.', noRoof, false],
  ['roof + basement claim, only basement photo → kept', 'Access "Yes" but no roof or basement photos.', noRoof, false],
  ['roof + basement claim, both photographed → refuted', 'Access "Yes" but no roof or basement photos.', { ...roof, ...noRoof }, true],
  ['claim that is not about missing photos → kept', 'The roof photo shows ponding water, so "free of damage" should be No.', roof, false],
  ['missing photo of an area the list has no word for → kept', 'No photos of the fire escape.', roof, false],
];
let fail = 0;
for (const [name, reason, ins, want, label] of cases) {
  const got = photoClaimRefuted(reason, ins, label);
  if (got !== want) fail++;
  console.log(got === want ? '✓' : '✗', name);
}
// photo shapes in words, not "1.11:1 vs 1.33:1" (1169277)
for (const [r, want] of [[1.11, 'almost square'], [1.33, '4:3, the usual phone-camera shape'], [1.5, '3:2, a camera shape'], [1.78, '16:9, a wide screen shape'], [1.41, 'longer and narrower than a camera photo'], [1.22, 'squarer than a camera photo']]) {
  const got = shapeWords(r); if (got !== want) fail++; console.log(got === want ? '✓' : '✗', `shape ${r} → ${got}`);
}
console.log(fail ? `${fail} FAILED` : `ALL PASS ${cases.length + 6}`);
process.exit(fail ? 1 : 0);
