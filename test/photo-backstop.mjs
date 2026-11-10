// Unit check for backstopHazards: a problem the AI described but did not list as a hazard.  node test/photo-backstop.mjs
import { backstopHazards } from '../lib/ai-modules.mjs';

const ext = 'fire_extinguishers';
const cases = [
  ['1166305 photo 18441051 (2026-11-09): on the floor by a door → hazard, clear of doors',
    { description: 'A room with an open door and a fire extinguisher on the floor. The walls are plain with some framed panels.', hazards: [] }, ext, /clear of doors/],
  ['extinguisher leaning in a storage room → hazard, no door wording',
    { description: 'Storage room with shelving. A fire extinguisher is leaning against the shelf.', hazards: [] }, ext, /^Mount the portable fire extinguisher on a wall hook or bracket in a visible, accessible location\.$/],
  ['expired tag → tag hazard', { description: 'Close-up of a fire extinguisher with an expired inspection tag.', hazards: [] }, ext, /inspected and tagged/],
  ['mounted and tagged → nothing', { description: 'A wall-mounted fire extinguisher with a current tag.', hazards: [] }, null],
  ['"not on the floor" → nothing', { description: 'The fire extinguisher is mounted on a bracket, not on the floor.', hazards: [] }, null],
  ['floor in another sentence → nothing', { description: 'Debris on the floor. A fire extinguisher is mounted near the exit.', hazards: [] }, null],
  ['AI already flagged it → nothing added', { description: 'A fire extinguisher on the floor.', hazards: [{ hazardType: ext, severity: 'advisory' }] }, null],
  ['AI flagged blocked egress for it → nothing added', { description: 'A fire extinguisher on the floor in front of the exit door.', hazards: [{ hazardType: 'blocked_egress', severity: 'advisory' }] }, null],
  ['no extinguisher → nothing', { description: 'Pallet jack and debris on the floor.', hazards: [] }, null],
];
let fail = 0;
for (const [name, ins, wantType, wantRec] of cases) {
  const got = backstopHazards(ins);
  const ok = wantType ? got.length === 1 && got[0].hazardType === wantType && got[0].severity === 'advisory' && wantRec.test(got[0].recommendation) : got.length === 0;
  if (!ok) { fail++; console.log('  got', JSON.stringify(got)); }
  console.log(ok ? '✓' : '✗', name);
}
console.log(fail ? `${fail} FAILED` : `ALL PASS ${cases.length}`);
process.exit(fail ? 1 : 0);
