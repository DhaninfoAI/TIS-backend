// Fixes from the 22-order test run (2026-11-08). No server, no OpenAI.
import assert from 'node:assert/strict';
import { sqftValue, buildingCount, firstQ, totalSqft, narrativeText } from '../lib/snapshot.mjs';
import { comparePrior, priorFacts } from '../lib/prior.mjs';
import { answerGuard, answerMeans, recSame } from '../lib/ai-modules.mjs';
import { MOCK } from '../lib/modules.mjs';
import { price } from '../lib/fees.mjs';

let n = 0, failed = 0;
const t = async (name, fn) => { n++; try { await fn(); console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n    ', e.message); } };
const form = (name, sections) => ({ name, sections });
const sec = (title, fields, extra = {}) => ({ sectionId: String(Math.random()).slice(2, 8), title, fields, ...extra });
const fld = (label, value, type = 'text', key = 'F1_1_1_' + Math.floor(Math.random() * 1e6)) => ({ key, label, value, type });

console.log('square footage');
await t('per-building list is added up (25,722 × 3)', () => assert.equal(sqftValue('25,722sf - B1, 25,722sf-B2, 25,722sf-B3'), 77166));
await t('"8,000sf-main bldg; 2,500sf-storage bldg" = 10,500', () => assert.equal(sqftValue('8,000sf-main bldg; 2,500sf-storage bldg'), 10500));
await t('a figure marked total wins over the parts', () => assert.equal(sqftValue('8,000sf-main; 2,500sf-storage; 10,500 sf total'), 10500));
await t('one figure stays as it was', () => { assert.equal(sqftValue('133186 sf-all bldgs'), 133186); assert.equal(sqftValue('14,450'), 14450); });
await t('building count from words: 8 apartment buildings, one clubhouse and 6 garages = 15', () => assert.equal(buildingCount('8 apartment buildings, one clubhouse and 6 garages'), 15));
const hotel = { forms: [form('Hotel & Motel Form', [sec('Construction (add a line and complete for EACH building)', [], {
  grid: { F16_1_1_9: [['0|0', 'Main'], ['0|1', '1937'], ['0|4', '13,049'], ['0|5', 'Frame'], ['1|0', 'Annex'], ['1|1', '1990'], ['1|4', '4,000'], ['1|5', 'Joisted Masonry']] },
  gridHeaders: { F16_1_1_9: ['Bldg name/#', 'Yr built', 'Yr rehab, if so', '# stories (exc. bsmt)', 'Total area', 'Construction Type*', 'Del'] } })])], order: { orderForm: {} } };
await t('Hotel & Motel: square footage, year built and ISO from the building table', () => {
  assert.equal(totalSqft(hotel), 17049);
  assert.equal(firstQ(hotel, 'year_built').value, '1937');
  assert.match(firstQ(hotel, 'iso_class').value, /Frame, Joisted Masonry/);
  assert.equal(firstQ(hotel, 'total_sqft').fromGrid, true);
});
const msi = { forms: [form('MSI Commercial Habitational', [
  sec('Operations', [fld('3. # of units?', '64'), fld('4. # of vacant units?', '16')]),
  sec('Sprinkler Protection (omit if no sprinkler system, duplicate as needed)', [fld('1. Is risk premises 100% sprinklered?', '', 'choice')], { omitted: true })])], order: { orderForm: {} } };
await t('MSI: occupancy % worked out from units and vacant units', () => assert.equal(firstQ(msi, 'occupancy_pct').value, '75%'));
await t('MSI: omitted "omit if no sprinkler system" section = no sprinklers', () => assert.equal(firstQ(msi, 'sprinklered').value, 'No'));
await t('narrative: the filled box wins over an empty one on another form', () => {
  const s = { forms: [form('General Form', [sec('Narrative', [fld('Narrative', '', 'longtext')])]), form('Hotel & Motel Form', [sec('Narrative', [fld('Narrative', 'The risk is a hotel.', 'longtext')])])] };
  assert.equal(narrativeText(s), 'The risk is a hotel.');
});
await t('pricing uses the added-up square footage (77,166 → Extra Large tier)', () => {
  const s = { order: { client: 'Seneca Insurance', location: '1 Main St, Everett, WA 98203', geo: { zip: '98203' }, orderForm: { requestType: 'Renewal', coverages: ['Monoline Property'] }, fees: { inspector: '0', client: '0' }, pricingNotes: {}, comments: '', pricing: {} },
    forms: [form('Seneca General-Property Only', [sec('Construction', [fld('3. Total square footage, excluding any unfinished basement area', '25,722sf - B1, 25,722sf-B2, 25,722sf-B3')])])] };
  assert.equal(price(s).kind.sqft, 77166);
});

console.log('prior report');
const gen = (sqft, bldgs) => ({ forms: [form('Seneca General Form', [sec('Occupancy', [fld('2. # of buildings?', bldgs), fld('3. Total square footage, excluding any unfinished basement area', sqft)])])] });
await t('different building counts → "different scope", not "differs"', () => {
  const cur = { ...gen('33,440', '5'), priorReports: [{ orderId: 1, date: '8/17/26', facts: priorFacts(gen('97200 - All Buildings', '11')) }] };
  const r = comparePrior(cur).rows.find(x => x.key === 'sqft');
  assert.equal(r.same, null); assert.match(r.scope, /11 buildings, this survey 5/);
});
await t('same building count, different SF → still "differs"', () => {
  const cur = { ...gen('6,000', '1'), priorReports: [{ orderId: 1, facts: priorFacts(gen('6880', '1')) }] };
  assert.equal(comparePrior(cur).rows.find(x => x.key === 'sqft').same, false);
});
await t('priorReport step: scope note is advisory, buildings row is not a separate failure', async () => {
  const cur = { ...gen('33,440', '5'), priorReports: [{ orderId: 1, facts: priorFacts(gen('97200', '11')) }] };
  const out = await MOCK.priorReport(cur);
  assert.equal(out.items.filter(i => i.status === 'fail').length, 0);
  assert.equal(out.items.find(i => i.kind === 'scope').severity, 'advisory');
});

console.log('inspector pay is a minimum');
const paid = entered => ({ order: { client: 'Seneca Insurance', location: '1 Main St, Rome, GA 30165', geo: { zip: '30165' }, orderForm: { requestType: 'New', coverages: ['Package'] }, fees: { inspector: String(entered), client: '0' }, pricingNotes: {}, comments: '', pricing: {} },
  forms: [form('Seneca General Form', [sec('Construction', [fld('3. Total square footage, excluding any unfinished basement area', '292,515')])])] });
await t('$192.50 entered on the $70 minimum → no warning', async () => assert.equal((await MOCK.pricing(paid(192.5))).items.filter(i => i.kind === 'inspector' && i.status === 'fail').length, 0));
await t('$50 entered → "below the $70 minimum"', async () => assert.match((await MOCK.pricing(paid(50))).items.find(i => i.kind === 'inspector').title, /below the \$70 minimum/));

console.log('Yes/No guards');
await t('answer meaning: "Housekeeping satisfactory? Yes" = no problem; "Any losses? Yes" = problem', () => {
  assert.equal(answerMeans('21. Housekeeping satisfactory and with premises free of accumulated refuse', 'Yes'), 'no_problem');
  assert.equal(answerMeans('1. Any high risk commercial occupancies', 'Yes'), 'problem');
});
await t('direction: problem in photos but suggests "Yes" to housekeeping → dropped', () =>
  assert.equal(answerGuard('21. Housekeeping satisfactory and with premises free of accumulated refuse', 'No', 'Yes', 'problem', 'Photos show accumulated refuse and debris.'), 'direction'));
await t('subject: housekeeping "No" because of missing bricks → dropped', () =>
  assert.equal(answerGuard('21. Housekeeping satisfactory and with premises free of accumulated refuse', 'Yes', 'No', 'problem', 'Photo shows missing bricks on the exterior wall.'), 'subject'));
await t('subject: FPE without the brand named → dropped', () =>
  assert.equal(answerGuard('28. Is risk free of Federal Pacific Electric (FPE) Stab-Lok type electrical panels', 'Yes', 'No', 'problem', 'Photos show rust on the electrical panels.'), 'subject'));
await t('hedged: "typically" is not evidence → dropped', () =>
  assert.equal(answerGuard('2. Brick (or stone) veneer', 'Yes', 'No', 'no_problem', 'Joisted masonry typically has no brick veneer.'), 'hedged'));
await t('re-run leftovers: off-subject note that changes nothing, "no visible" veneer, stairs flipped while a rec exists, dirt path, fire pit vs dead trees', () => {
  assert.equal(answerGuard('23. Is there a resident super or manager?', 'No', 'No', 'problem', 'Photos show water damage and clutter blocking access to roof hatch.'), 'subject');
  assert.equal(answerGuard('2. Brick (or stone) veneer (If Yes, MUST INCLUDE A CLOSE-UP EXTERIOR PHOTO', 'Yes (close-up photos required)', 'No', 'unclear', 'Photo 18488755 shows a multi-story building with no visible brick veneer pattern.'), 'absence');
  assert.equal(answerGuard('20. Are all stairways in good condition and to NFPA Life Safety 101 code', 'No', 'Yes', 'no_problem', 'Photos 1 and 2 show stairways in good condition with handrails.', ['Restore basement stairway(s) to good condition.']), 'has_rec');
  assert.equal(answerGuard('1. Sidewalks smooth & in good condition?', 'Yes', 'No', 'problem', 'Photo 18489548 shows a dirt path with scattered bushes.'), 'subject');
  assert.equal(answerGuard('3. Area about buildings and activity zones free of dead trees and branches?', 'Yes', 'No', 'problem', 'Photo 18489556 shows a fire pit near vegetation.'), 'subject');
});
await t('real finding stays: clutter piled in the corridor → housekeeping "No"', () =>
  assert.equal(answerGuard('21. Housekeeping satisfactory and with premises free of accumulated refuse', 'Yes', 'No', 'problem', 'Photo 123 shows storage piled in the corridor.'), null));

console.log('recommendation duplicates');
await t('three "relocate BBQ" wordings are the same rec', () => {
  assert.ok(recSame('Relocate BBQ units to ensure they are at least 10 feet from flammable structures.', 'Relocate BBQ units at least 10 feet away from structures and flammable materials.'));
  assert.ok(recSame('Relocate the barbecue unit at least 10 feet from the cabin to prevent fire hazards.', 'Relocate BBQ units to ensure they are at least 10 feet from flammable structures.'));
});
await t('different hazards in the same place are not', () => {
  assert.ok(!recSame('Install approved blank breakers to fill gaps in the electrical panel in Unit 352.', 'Inspect and repair corroded breakers in Unit 352 to prevent electrical hazards.'));
  assert.ok(!recSame('Clear stored items from the stairway to ensure safe egress.', 'Clear egress routes in the basement to ensure safe passage.'));
});

console.log(`\n${n - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
