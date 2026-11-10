// Pricing guide (rules/pricing.json) → lib/fees.mjs. No server, no OpenAI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { price, parseFeeText } from '../lib/fees.mjs';
import { MOCK } from '../lib/modules.mjs';

let n = 0, failed = 0;
const t = (name, fn) => { n++; try { fn(); console.log('  ✓', name); } catch (e) { failed++; console.log('  ✗', name, '\n    ', e.message); } };

const order = ({ client = 'AmWins Brokerage of GA', zip = '06107', location = '1 Main St, West Hartford, CT 06107', request = 'New', coverages = ['Package'], nob = 'Offices',
  addl = '', fees = {}, notes = {}, comments = '', forms = [], sqft = 8000, feeOptions = [] } = {}) => ({
  order: { client, location, geo: { zip }, orderForm: { requestType: request, coverages, natureOfBusiness: nob, additionalAddresses: addl, climaticSupplements: [] },
    fees: { inspector: '0.00', client: '0.00', ...fees }, pricingNotes: notes, comments, pricing: { selectedFeeType: '', feeOptions } },
  forms: [{ name: 'General Form', sections: [{ sectionId: '1', title: 'Building', fields: [{ key: 'F8_1_1_1', type: 'text', label: '1. Total Square Footage', value: String(sqft) }] }] },
    ...forms.map(name => ({ name, sections: [] }))],
});

console.log('inspector pay');
t('full inspection pays the $70 minimum', () => assert.equal(price(order()).inspector.amount, 70));
t('rec check pays the $35 minimum', () => assert.equal(price(order({ request: 'Recommendation Check' })).inspector.amount, 35));
t('2.5 hours in the comments = $87.50', () => assert.equal(price(order({ comments: 'Took 2.5 hours on site' })).inspector.amount, 87.5));
t('travel fee is added to the minimum', () => assert.equal(price(order({ comments: 'travel fee $25' })).inspector.amount, 95));
t('a higher amount in the pricing note is paid', () => assert.equal(price(order({ notes: { inspector: '125' } })).inspector.amount, 125));
t('exterior + travel = $35 + travel', () => assert.equal(price(order({ request: 'Exterior only', notes: { inspector: 'Travel $40' } })).inspector.amount, 75));
t('fee text parser keeps travel apart from other amounts', () => assert.deepEqual(parseFeeText('$90 plus $20 travel'), { hours: [], travel: [20], amounts: [90] }));

console.log('standard client table (AmWins)');
for (const [fee, want] of [[70, 185], [75, 210], [100, 245], [150, 280], [151, 315]])
  t(`inspector fee $${fee} → $${want}`, () => assert.equal(price(order({ fees: { inspector: String(fee) } })).client.amount, want));
t('rec check → $85', () => assert.equal(price(order({ request: 'Recommendation Check' })).client.amount, 85));
t('band uses expected pay when EZ has none entered', () => assert.equal(price(order({ comments: '3 hours' })).client.amount, 280));   // 3 h = $105 → $101–150 band

console.log('other client rules');
t('Arrowhead $100+ → $257', () => assert.equal(price(order({ client: 'Arrowhead General', fees: { inspector: '100' } })).client.amount, 257));
t('Axon flat $300, $340 with Wildfire', () => { assert.equal(price(order({ client: 'Axon Underwriting' })).client.amount, 300); assert.equal(price(order({ client: 'Axon Underwriting', forms: ['Wildfire Supplement'] })).client.amount, 340); });
t('Church Mutual with a Freeze form uses the Freeze Project table', () => { const r = price(order({ client: 'Church Mutual Insurance Company', forms: ['Freeze Protection'] })); assert.equal(r.client.amount, 180); assert.match(r.client.schedule, /Freeze/); });
t('Church Mutual single-building exterior → $80', () => assert.equal(price(order({ client: 'Church Mutual Insurance Company', request: 'Exterior only' })).client.amount, 80));
t('Clear Risk 2 buildings + freeze → $330', () => assert.equal(price(order({ client: 'Clear Risk Solutions', addl: '2 Main St', forms: ['Freeze Protection'] })).client.amount, 330));
t('K&K camp, inspector fee $150 → $490', () => assert.equal(price(order({ client: 'K&K Insurance Group', nob: 'Summer camp', fees: { inspector: '150' } })).client.amount, 490));
t('K&K limited inspection → $140', () => assert.equal(price(order({ client: 'K&K Insurance Group', request: 'Exterior only' })).client.amount, 140));
t('LSR virtual, 2 buildings, RCV form → $208 and the For RCV step', () => { const r = price(order({ client: 'LSR', request: 'Virtual', addl: 'Bldg 2', forms: ['RCV Form'] })); assert.equal(r.client.amount, 208); assert.ok(r.client.actions.some(a => /For RCV/.test(a))); });
t('LSR 6 buildings adds $42 per building after 4 (flagged as an assumption)', () => { const r = price(order({ client: 'LSR', request: 'Virtual', addl: 'a\nb\nc\nd\ne' })); assert.equal(r.client.amount, 253 + 2 * 42); assert.ok(r.client.review.length); });
t('Marsh without pricing notes → refer to management', () => { const r = price(order({ client: 'Marsh & McLennan Agency' })); assert.equal(r.client.amount, null); assert.match(r.client.review[0], /management/); });
t('Marsh with a QC pricing note → that amount', () => assert.equal(price(order({ client: 'Marsh & McLennan Agency', notes: { qc: 'Client fee $400' } })).client.amount, 400));
t('Precision Risk virtual → $185', () => assert.equal(price(order({ client: 'Precision Risk Management', request: 'Virtual' })).client.amount, 185));
t('RPS Bollinger phone survey → $100', () => assert.equal(price(order({ client: 'RPS Bollinger', request: 'Telephone survey only' })).client.amount, 100));
t('unknown client → price by hand', () => { const r = price(order({ client: 'Acme Underwriters' })); assert.equal(r.client.amount, null); assert.ok(r.client.review.length); });

console.log('Seneca tiers');
const SENECA_OPTS = ['$135 ALL NYC Risks', '$156 Up to 10,000 sq ft, outside of NYC', '$197 10001-20000 sf outside of NYC', '$234 20,001-50,000 sq ft-outside of NYC', '$270 50,001-99,999 sq ft-outside of NYC', '$306 100,000 sq ft', '$85 Exterior/Rec Check'];
const sen = o => order({ client: 'Seneca Insurance- NYBO', feeOptions: SENECA_OPTS, ...o });
t('Brooklyn ZIP → Tier 1 $135', () => assert.equal(price(sen({ zip: '11215', sqft: 30000 })).client.amount, 135));
t('Nassau ZIP 11020 is not NYC', () => assert.equal(price(sen({ zip: '11020', location: 'Great Neck, NY 11020', sqft: 9000 })).client.amount, 156));
for (const [sf, want] of [[10000, 156], [10001, 197], [50000, 234], [99999, 270], [100000, 306]])
  t(`${sf.toLocaleString()} sf outside NYC → $${want}`, () => assert.equal(price(sen({ sqft: sf })).client.amount, want));
t('supplement adds $50, fee type stays on the tier', () => { const r = price(sen({ sqft: 14450, forms: ['Manufacturing Supplement'] })); assert.equal(r.client.amount, 247); assert.equal(r.feeType.expected, SENECA_OPTS[2]); });
t('cooking outside NYC: first free, then $25 each', () => assert.equal(price(sen({ sqft: 5000, forms: ['Cooking Supplement', 'Cooking Supplement', 'Cooking Supplement'] })).client.amount, 156 + 50));
t('cooking in NYC: first 4 free', () => assert.equal(price(sen({ zip: '10001', forms: Array(5).fill('Cooking Supplement') })).client.amount, 135 + 25));
t('rec check → $85 and the Exterior/Rec Check option', () => { const r = price(sen({ request: 'Recommendation Check' })); assert.equal(r.client.amount, 85); assert.equal(r.feeType.expected, SENECA_OPTS[6]); });
t('travel billed by the inspector adds Seneca\'s $50 travel fee', () => assert.equal(price(sen({ sqft: 5000, comments: 'travel fee $30' })).client.amount, 206));

console.log('pricing step on the sandbox orders');
const fx = f => JSON.parse(readFileSync(new URL(`../fixtures/boost-${f}.json`, import.meta.url), 'utf8'));
const r05 = await MOCK.pricing(fx(1166305));
t('1166305: inspector $70, client $197, fee type Tier 3', () => { assert.equal(r05.summary.inspector.expected, 70); assert.equal(r05.summary.client.expected, 197); assert.match(r05.summary.feeType.expected, /^\$197/); });
const r07 = await MOCK.pricing(fx(1166307));
t('1166307: pricing note 125 → inspector $125; Freeze supplement on top of $270', () => { assert.equal(r07.summary.inspector.expected, 125); assert.equal(r07.summary.client.expected, 320); assert.match(r07.summary.feeType.expected, /^\$270/); });
t('items are suggestions (needs_review) while EZ has no fees', () => assert.ok(r07.items.length && r07.items.every(i => i.status === 'needs_review')));

console.log(`\n${n - failed}/${n} pricing checks passed`);
if (failed) process.exit(1);
