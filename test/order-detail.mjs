// The dashboard's order drill-down (2026-11-13): every finding of an order's latest review with what the reviewer did,
// customers only their own orders and nothing technical, admins also AI cost per step and every run.
//   node test/order-detail.mjs
import assert from 'node:assert/strict';
import { buildOrderDetail } from '../lib/dashboard.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '→', e.message); } };

const item = (id, severity, title, extra = {}) => ({ id, severity, title, message: title + ' details', status: 'fail', evidence: { photos: [] }, ...extra });
const run = (analysisId, finishedAt, items, extra = {}) => ({ analysisId, orderId: 900, orgId: 'tis', userId: 'u1', status: 'done', createdAt: finishedAt, finishedAt,
  engine: 'openai', models: { photo: 'gpt-4o', reason: 'gpt-4o' }, usage: { cost: 0.21, calls: 6, input: 1000, cached: 500, output: 200, bySchema: { narrative: { calls: 1, cost: 0.05 } } },
  modules: { questions: { engine: 'openai', items }, photoReview: { engine: 'openai', summary: { vision: true, photos: 9, analysed: 2, cached: 7, checked: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }, items: [] },
    narrative: { engine: 'mock (fallback)', aiFailed: 'busy', summary: { fallbackReason: 'OpenAI 429 rate limit' }, items: [item('n1', 'warning', 'Narrative rewrite', { kind: 'rewrite' })] } }, ...extra });
const state = {
  analyses: {
    a1: run('a1', '2026-11-12T10:00:00Z', [item('q1', 'blocker', 'Old run finding')]),
    a2: run('a2', '2026-11-13T10:00:00Z', [item('q1', 'blocker', 'Housekeeping'), item('q2', 'warning', 'Roof'), item('q3', 'advisory', 'Stairs'), item('q4', 'blocker', 'Passed', { status: 'pass' })]),
  },
  snapshots: { 900: { snapshot: { order: { insured: 'ACME LLC', location: '1 Main St', client: 'Seneca', inspector: 'Pat', orderForm: { requestType: 'Renewal', coverages: ['Package'], liability: ['CGL'] } }, photos: Array.from({ length: 10 }, (_, i) => ({ imageId: String(i + 1) })) } } },
  feedback: {
    f1: { analysisId: 'a2', receivedAt: '2026-11-13T10:05:00Z', items: [{ itemId: 'q1', decision: 'applied' }] },
    f2: { analysisId: 'a2', receivedAt: '2026-11-13T10:06:00Z', items: [{ itemId: 'q1', decision: 'reverted' }, { itemId: 'q2', decision: 'dismissed', reason: 'not_a_hazard' }] },
    f0: { analysisId: 'a1', receivedAt: '2026-11-12T10:05:00Z', items: [{ itemId: 'q3', decision: 'applied' }] },
  },
  outcomes: {}, users: { u1: { name: 'Riya' } },
};
const admin = buildOrderDetail(state, { role: 'admin' }, 900), cust = buildOrderDetail(state, { role: 'customer', orgId: 'tis' }, 900);

console.log('order drill-down');
t('the latest review is shown, with how many reviews the order had', () => { assert.equal(cust.findings[0].title, 'Housekeeping'); assert.equal(cust.reviews, 2); assert.equal(cust.reviewer, 'Riya'); });
t('only open findings, must fix first; the old narrative rewrite card is left out', () => assert.deepEqual(cust.findings.map(f => f.title), ['Housekeeping', 'Roof', 'Stairs']));
t('the last thing the reviewer did wins (applied, then undone)', () => assert.equal(cust.findings[0].decision, 'Undone'));
t('dismissed with its reason in words', () => { const r = cust.findings.find(f => f.title === 'Roof'); assert.equal(r.decision, 'Dismissed'); assert.equal(r.reason, 'Not a hazard'); });
t("an earlier run's decisions don't carry over", () => assert.equal(cust.findings.find(f => f.title === 'Stairs').decision, 'Not acted on'));
t('counts and photos checked by the AI (9 of 10)', () => { assert.deepEqual(cust.counts, { findings: 3, mustFix: 1, applied: 0, dismissed: 1, undone: 1, notActed: 1 }); assert.deepEqual(cust.photos, { total: 10, checkedByAi: 9 }); });
t('order facts', () => { assert.equal(cust.insured, 'ACME LLC'); assert.equal(cust.coverage, 'Package, CGL'); assert.equal(cust.request, 'Renewal'); });
t('customer: a plain "the AI part didn\'t run" for that area, nothing technical', () => {
  assert.deepEqual(cust.aiDidNotRun, ['Narrative']); assert.equal('ai' in cust, false);
  assert.doesNotMatch(JSON.stringify(cust), /gpt-|openai|mock|fallback|429|cost|token/i);
});
t('customer of another organisation: nothing', () => assert.equal(buildOrderDetail(state, { role: 'customer', orgId: 'acme' }, 900), null));
t('admin: AI cost per step, models, photos looked at / reused, fallback reason, every run (newest first)', () => {
  assert.equal(admin.ai.cost, 0.21); assert.equal(admin.ai.models, 'gpt-4o / gpt-4o'); assert.deepEqual(admin.ai.byStep, [{ step: 'Narrative', calls: 1, cost: 0.05 }]);
  assert.equal(admin.ai.photosLookedAt, 2); assert.equal(admin.ai.photosReused, 7);
  assert.equal(admin.ai.steps.find(s => s.step === 'Narrative').fallback, 'OpenAI 429 rate limit');
  assert.deepEqual(admin.ai.runs.map(r => r.analysisId), ['a2', 'a1']);
});
t('an order without a review: nothing', () => assert.equal(buildOrderDetail(state, { role: 'admin' }, 901), null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
