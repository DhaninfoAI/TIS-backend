// End-to-end test of every backend endpoint against the fixtures.
//   npm test   (or node test/e2e.mjs)
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 4099, BASE = `http://localhost:${PORT}`, H = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'X-EZ-User': 'e2e' };
const TMP = mkdtempSync(path.join(os.tmpdir(), 'tisqc-test-'));   // isolated store: never touches Neon/OpenAI
const srv = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT, MOCK_DELAY_MS: '0', LLM_PROVIDER: 'mock', LOG_REQUESTS: '0', SKIP_DOTENV: '1', STORE: 'file', DATA_DIR: TMP, DEV_TOKEN: 'dev-token' }, stdio: 'pipe' });
await new Promise(r => srv.stdout.once('data', r));

const call = async (method, path, body, headers = H) => {
  const r = await fetch(BASE + path, { method, headers, body: body == null ? undefined : typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
};
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '→', e.message); } };

try {
  const snap = JSON.parse(readFileSync(new URL('./fixtures/demo-1164320-seneca.json', import.meta.url)));
  const OID = snap.order.orderId;
  let aid;
  console.log('ingest');
  await t('health is open', async () => assert.equal((await call('GET', '/v1/health', null, {})).status, 200));
  await t('auth required', async () => assert.equal((await call('GET', '/v1/config', null, {})).status, 401));
  await t('bad payload 400', async () => assert.equal((await call('PUT', `/v1/orders/${OID}/snapshot`, { order: { orderId: 1 } })).status, 400));
  await t('PUT snapshot', async () => { const r = await call('PUT', `/v1/orders/${OID}/snapshot`, snap); assert.equal(r.status, 200); assert.equal(r.body.photosNeeded.length, 12); });
  await t('same snapshot is unchanged', async () => assert.equal((await call('PUT', `/v1/orders/${OID}/snapshot`, snap)).body.unchanged, true));
  await t('photo upload (multipart)', async () => {
    const fd = new FormData();
    fd.append('meta', JSON.stringify([{ imageId: '18411612' }]));
    fd.append('files', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' }), '18411612.jpg');
    fd.append('files', new Blob([Buffer.from('nope')]), 'bad.jpg');
    const r = await call('POST', `/v1/orders/${OID}/photos`, fd, { Authorization: H.Authorization });
    assert.deepEqual(r.body.stored, ['18411612']); assert.equal(r.body.rejected.length, 1);
  });
  await t('photosNeeded shrinks after upload', async () => assert.equal((await call('PUT', `/v1/orders/${OID}/snapshot`, snap)).body.photosNeeded.length, 11));

  console.log('analysis');
  await t('POST analyses → 202', async () => { const r = await call('POST', `/v1/orders/${OID}/analyses`, {}); assert.equal(r.status, 202); aid = r.body.analysisId; });
  await t('SSE stream needs a token', async () => assert.equal((await fetch(`${BASE}/v1/analyses/${aid}/events`)).status, 401));
  await t('SSE stream completes (token in the query: EventSource sends no headers)', async () => {
    const r = await fetch(`${BASE}/v1/analyses/${aid}/events?token=dev-token`); const txt = await r.text();
    assert.match(txt, /event: analysis.completed/);
  });
  const a = (await call('GET', `/v1/analyses/${aid}`)).body;
  const items = m => a.modules[m].items || [];
  const has = (m, re) => items(m).some(i => re.test(i.title + ' ' + i.message));
  await t('all modules done', async () => assert.ok(Object.values(a.modules).every(m => m.status === 'done'), JSON.stringify(Object.fromEntries(Object.entries(a.modules).map(([k, v]) => [k, v.status])))));
  await t('checks: SF per unit 1,443', async () => assert.ok(has('checks', /1,443 sf\/unit/)));
  await t('checks: diagram SF ≠ form SF', async () => assert.ok(has('checks', /Diagram dimensions give 8,800/)));
  await t('checks: veneer No → backing N/A', async () => assert.ok(has('checks', /should be N\/A/)));
  await t('checks: rating vs recs', async () => assert.ok(has('checks', /Opinion of Risk is "Good"/)));
  await t('checks: prof. liability section should be omitted', async () => assert.ok(has('checks', /Professional liability not ordered/)));
  await t('uwConcerns without the AI: not checked, no guessed findings (backup removed 2026-11-10)', async () => { assert.equal(items('uwConcerns').length, 0); });
  await t('photoReview: basement clutter + loose wiring missed', async () => { assert.ok(has('photoReview', /housekeeping/)); assert.ok(has('photoReview', /improvised_wiring/)); });
  await t('recommendations: empty housekeeping rec box', async () => assert.ok(has('recommendations', /Housekeeping satisfactory/)));
  await t('recommendations: "Recommend…" style fix', async () => { const i = items('recommendations').find(x => /Recommend emergency/.test(x.message)); assert.ok(i); assert.ok(!(i.proposedWrites || []).some(w => /\[\[rewrite\]\]/.test(w.value)), 'no [[rewrite]] text offered for EZ'); assert.ok((i.proposedWrites || []).every(w => /^[A-Z][a-z]+/.test(w.value) && !/^Emergency/.test(w.value)), 'only an action-verb fix may be applied'); });
  await t('captions: IMG names cleaned', async () => assert.ok(items('captions').some(i => i.suggested === 'Basement clutter')));
  await t('narrative: contradicts housekeeping answer', async () => assert.ok(has('narrative', /Narrative contradicts/)));
  await t('pricing: NYC should be $135', async () => assert.ok(has('pricing', /\$135/)));
  await t('qcChecklist: section 6 + rating', async () => { assert.equal(typeof a.modules.qcChecklist.summary.rating, 'number'); assert.equal(a.modules.qcChecklist.summary.section6.missedHazards, true); });
  await t('cached analysis reused', async () => { const r = await call('POST', `/v1/orders/${OID}/analyses`, {}); assert.equal(r.body.cached, true); });
  await t('rerun narrative', async () => { const r = await call('POST', `/v1/orders/${OID}/analyses/${aid}/rerun`, { modules: ['narrative'] }); assert.equal(r.status, 202); });
  await t('final-check removed (2026-11-10)', async () => { const r = await call('POST', `/v1/orders/${OID}/final-check`, {}); assert.equal(r.status, 404); });
  await t('QC outcome saves every finding with its decision', async () => {
    const r = await call('POST', `/v1/orders/${OID}/qc-outcome`, { analysisId: 'x', items: [{ itemId: 'a', module: 'recommendations', title: 'Missing rec', decision: 'applied' },
      { itemId: 'b', module: 'uwConcerns', title: 'Rent rolls', decision: 'dismissed', reason: 'already_handled' }, { itemId: 'c', module: 'checks', title: 'SF', decision: 'bogus' }] });
    assert.equal(r.status, 200);
  });
  await t('orders status badge', async () => { const r = await call('GET', `/v1/orders/status?ids=${OID},1`); assert.equal(r.body.orders[0].analyzed, true); assert.equal(r.body.orders[1].status, 'none'); });
  await t('batch create', async () => assert.equal((await call('POST', '/v1/batches', { orderIds: [OID] })).status, 201));

  console.log('cost');
  await t('cost estimate gpt-4o', async () => { const r = await call('GET', `/v1/orders/${OID}/cost-estimate?model=gpt-4o&photos=66`); assert.ok(r.body.total > 0); assert.equal(r.body.photo.imageTokensEach, 765); });
  await t('cost compare', async () => assert.ok((await call('GET', `/v1/orders/${OID}/cost-compare`)).body.rows.length >= 6));
  await t('unknown model 400', async () => assert.equal((await call('GET', `/v1/orders/${OID}/cost-estimate?model=nope`)).status, 400));

  console.log('learning & rules');
  await t('feedback', async () => assert.equal((await call('POST', '/v1/feedback', { analysisId: aid, items: [{ itemId: 'x', module: 'checks', decision: 'accepted' }] })).status, 200));
  await t('qc-outcome + inspector card', async () => {
    await call('POST', `/v1/orders/${OID}/qc-outcome`, { inspector: 'mkan', rating: 5, section6: { squareFootage: true, missedHazards: true } });
    const r = await call('GET', '/v1/analytics/inspectors/mkan'); assert.equal(r.body.reports, 1); assert.equal(r.body.issueRates.squareFootage, 100);
  });
  await t('analytics summary', async () => assert.equal((await call('GET', '/v1/analytics/summary')).body.feedbackItems, 1));
  await t('rules tree has KB clients', async () => assert.ok(Object.keys((await call('GET', '/v1/rules/tree')).body.clients).length > 40));
  await t('client doc PUT/GET versions', async () => {
    await call('PUT', '/v1/rules/client/' + encodeURIComponent('Seneca Insurance- NYBO'), { markdown: '- Also look for Challenger breaker panels.', note: 'new client ask' });
    const r = await call('GET', '/v1/rules/client/' + encodeURIComponent('Seneca Insurance- NYBO')); assert.equal(r.body.versions, 1); assert.ok(r.body.kbEntry);
  });
  await t('draft → test → publish rule', async () => {
    const rule = { id: 'demo.housekeeping_no', kind: 'dsl', severity: 'warning', when: { q: 'housekeeping', equals: 'No' }, then: { q: 'housekeeping', in: ['Yes'] }, message: 'demo' };
    assert.equal((await call('PUT', '/v1/rules/rule/' + rule.id, { rule })).status, 200);
    assert.equal((await call('POST', `/v1/rules/rule/${rule.id}/test`, {})).body.ordersFlagged, 1);
    const v0 = (await call('GET', '/v1/rules/changelog')).body.rulesVersion;
    const p = await call('POST', '/v1/rules/publish', { note: 'demo' }); assert.equal(p.body.rulesVersion, v0 + 1);
  });
  await t('analysis re-runs after rules publish (cache invalidated)', async () => assert.equal((await call('POST', `/v1/orders/${OID}/analyses`, {})).status, 202));
  await t('hazard library + form registry', async () => {
    assert.equal((await call('POST', '/v1/hazard-library', { hazardType: 'bbq_units', severity: 'required' })).status, 201);
    assert.ok((await call('GET', '/v1/hazard-library')).body.taxonomy.length > 50);
    assert.ok((await call('GET', '/v1/form-registry')).body.keyQuestions.total_sqft);
  });
  await t('rules pack is order-specific and small', async () => { const r = await call('GET', `/v1/orders/${OID}/rules-pack`); assert.equal(r.body.clientKey, 'Seneca Insurance- NYBO'); assert.ok(r.body.approxTokens < 8000, String(r.body.approxTokens)); });
  await t('404 on unknown route', async () => assert.equal((await call('GET', '/v1/nope')).status, 404));

  console.log('real EZ captures (Boost AI sandbox)');
  const real = {};
  for (const id of [1166305, 1166307, 1166309, 1166310, 1166311, 1166312]) {
    const s = JSON.parse(readFileSync(new URL(`../fixtures/boost-${id}.json`, import.meta.url)));
    await call('PUT', `/v1/orders/${id}/snapshot`, s);
    const { analysisId } = (await call('POST', `/v1/orders/${id}/analyses`, {})).body;
    await fetch(`${BASE}/v1/analyses/${analysisId}/events`).then(r => r.text());
    real[id] = (await call('GET', `/v1/analyses/${analysisId}`)).body;
  }
  const fails = (id, re) => Object.values(real[id].modules).flatMap(m => m.items || []).filter(i => i.status === 'fail' && re.test(`${i.ruleRef || ''} ${i.message || ''}`));
  await t('1166312: Property-Only form on a Package+CGL order', async () => assert.ok(fails(1166312, /form_vs_coverage/).length));
  await t('1166312: 2 recs without photos', async () => assert.equal(fails(1166312, /recs\.photos_attached/).length, 2));
  await t('1166310 / 1166311: rec without photo', async () => { assert.ok(fails(1166310, /recs\.photos_attached/).length); assert.ok(fails(1166311, /recs\.photos_attached/).length); });
  await t('1166307: Monoline Property with full General Form', async () => assert.ok(fails(1166307, /Monoline Property/).length));
  await t('1166307: U/W instructions not checked without the AI (marked, no findings)', async () => assert.ok(real[1166307].modules.uwConcerns.summary.notChecked && !real[1166307].modules.uwConcerns.items.length));
  await t('1166305: recs with photos untouched', async () => assert.equal(fails(1166305, /recs\.photos_attached/).length, 0));
  await t('no "No answer needs a comment" findings (TIS handles comments)', async () => { for (const id of Object.keys(real)) assert.ok(fails(id, /no_answer_needs_comment/).length === 0, id); });
} finally {
  srv.kill();
  rmSync(new URL('../data/photos/1164320', import.meta.url), { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
