// Sign-in, tokens, licences (photo plans) and what each role may see. Isolated: temp file store + the fake OpenAI
// server (test/fake-openai.mjs), with the real photos of 1166305 / 1166309 copied in so the photo allowance is metered.
//   npm test   (or node test/auth.mjs)
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync, cpSync, existsSync } from 'node:fs';
import { startFakeOpenAI } from './fake-openai.mjs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 4097, BASE = `http://localhost:${PORT}`, DEV = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const TMP = mkdtempSync(path.join(os.tmpdir(), 'tisqc-auth-'));
const photos = oid => new URL(`../data/photos/${oid}`, import.meta.url);
const HAVE_PHOTOS = existsSync(photos(1166305)) && existsSync(photos(1166309));
for (const oid of [1166305, 1166309]) if (existsSync(photos(oid))) cpSync(photos(oid), path.join(TMP, 'photos', String(oid)), { recursive: true });
const fake = await startFakeOpenAI(4598);
const srv = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT, MOCK_DELAY_MS: '0', LOG_REQUESTS: '0', SKIP_DOTENV: '1', STORE: 'file', DATA_DIR: TMP, DEV_TOKEN: 'dev-token', JWT_SECRET: 'test-secret-' + Date.now(),
  LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-fake', OPENAI_BASE_URL: 'http://localhost:4598', MODEL_PHOTO: 'gpt-4o', MODEL_REASON: 'gpt-4o', MAX_COST_PER_ANALYSIS: '5' }, stdio: 'pipe' });
await new Promise(r => srv.stdout.once('data', r));

const call = async (method, p, body, headers = DEV) => {
  const r = await fetch(BASE + p, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, headers: r.headers };
};
const bearer = tok => ({ Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' });
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '→', e.message); } };
const PW = 'Sample-pass-2026';   // test-only password for throwaway accounts in the temp store

try {
  console.log('accounts');
  await t('plans carry a fixed photo allowance; a customer on a plan gets its photos + seats', async () => {
    const plans = (await call('GET', '/v1/admin/plans')).body.plans; assert.ok(plans.length >= 3 && plans.every(p => p.imagesPerMonth > 0));
    const r = await call('POST', '/v1/admin/orgs', { name: 'Plan Check', licence: { plan: 'professional', expiresAt: '2099-01-01' } });
    const pro = plans.find(p => p.id === 'professional');
    assert.equal(r.body.org.licence.imagesPerMonth, pro.imagesPerMonth); assert.equal(r.body.org.licence.seats, pro.seats); assert.equal(r.body.org.licence.planName, pro.name);
  });
  await t('admin can change the plan catalogue', async () => {
    const plans = (await call('GET', '/v1/admin/plans')).body.plans;
    const r = await call('PUT', '/v1/admin/plans', { plans: [...plans, { name: 'Tiny', imagesPerMonth: 40, seats: 1, price: '$9' }] });
    assert.equal(r.status, 200); assert.ok(r.body.plans.some(p => p.id === 'tiny' && p.imagesPerMonth === 40));
  });
  await t('admin creates a customer organisation on the 40-photo plan', async () => {
    const r = await call('POST', '/v1/admin/orgs', { name: 'Acme Inspections', licence: { plan: 'tiny', expiresAt: '2099-01-01' } });
    assert.equal(r.status, 201); assert.equal(r.body.org.orgId, 'acme-inspections'); assert.equal(r.body.org.licence.seats, 1); assert.equal(r.body.org.licence.imagesPerMonth, 40);
  });
  await t('weak password refused', async () => assert.equal((await call('POST', '/v1/admin/users', { email: 'weak@acme.test', password: 'short', orgId: 'acme-inspections' })).status, 400));
  await t('admin creates users', async () => {
    for (const [email, role, orgId] of [['amy@acme.test', 'customer', 'acme-inspections'], ['ben@acme.test', 'customer', 'acme-inspections'], ['boss@vendor.test', 'admin', 'tis']])
      assert.equal((await call('POST', '/v1/admin/users', { email, password: PW, role, orgId, name: email.split('@')[0] })).status, 201, email);
  });
  await t('duplicate email refused', async () => assert.equal((await call('POST', '/v1/admin/users', { email: 'AMY@acme.test', password: PW, orgId: 'acme-inspections' })).status, 409));

  console.log('sign-in');
  let amy;
  await t('wrong password → 401 INVALID_CREDENTIALS', async () => { const r = await call('POST', '/v1/auth/login', { email: 'amy@acme.test', password: 'nope-nope-1' }, {}); assert.equal(r.status, 401); assert.equal(r.body.error.code, 'INVALID_CREDENTIALS'); });
  await t('login → access + refresh token', async () => {
    const r = await call('POST', '/v1/auth/login', { email: 'amy@acme.test', password: PW, client: 'extension' }, {});
    assert.equal(r.status, 200); assert.ok(r.body.accessToken.split('.').length === 3 && r.body.refreshToken.length > 30); assert.equal(r.body.expiresIn, 900);
    assert.equal(r.body.user.role, 'customer'); assert.ok(!('passwordHash' in r.body.user)); amy = r.body;
  });
  await t('access token works; no token → 401', async () => {
    assert.equal((await call('GET', '/v1/auth/me', null, bearer(amy.accessToken))).body.user.email, 'amy@acme.test');
    assert.equal((await call('GET', '/v1/auth/me', null, {})).status, 401);
  });
  await t('tampered token → 401', async () => assert.equal((await call('GET', '/v1/auth/me', null, bearer(amy.accessToken.slice(0, -2) + 'xx'))).status, 401));
  await t('second person on a 1-seat licence → 403 SEAT_LIMIT', async () => { const r = await call('POST', '/v1/auth/login', { email: 'ben@acme.test', password: PW }, {}); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'SEAT_LIMIT'); });
  let rotated;
  await t('refresh rotates the refresh token', async () => {
    const r = await call('POST', '/v1/auth/refresh', { refreshToken: amy.refreshToken }, { 'Content-Type': 'application/json' });
    assert.equal(r.status, 200); assert.notEqual(r.body.refreshToken, amy.refreshToken); rotated = r.body;
  });
  await t('re-using the old refresh token ends the whole sign-in', async () => {
    assert.equal((await call('POST', '/v1/auth/refresh', { refreshToken: amy.refreshToken }, { 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await call('POST', '/v1/auth/refresh', { refreshToken: rotated.refreshToken }, { 'Content-Type': 'application/json' })).status, 401);
    assert.equal((await call('GET', '/v1/auth/me', null, bearer(rotated.accessToken))).status, 401);
  });
  await t('seat is free again after that → Ben can sign in', async () => { const r = await call('POST', '/v1/auth/login', { email: 'ben@acme.test', password: PW }, {}); assert.equal(r.status, 200); await call('POST', '/v1/auth/logout', { refreshToken: r.body.refreshToken }, { 'Content-Type': 'application/json' }); });
  await t('dashboard login puts the refresh token in an HttpOnly cookie, not the body', async () => {
    const r = await call('POST', '/v1/auth/login', { email: 'boss@vendor.test', password: PW, client: 'dashboard' }, {});
    assert.equal(r.status, 200); assert.ok(!r.body.refreshToken); assert.match(r.headers.get('set-cookie') || '', /tisqc_rt=.+HttpOnly; SameSite=Strict/);
  });

  console.log('seats = computers signed in to the extension');
  await t('a dashboard sign-in uses no seat (1-seat licence already full)', async () => {
    const r = await call('POST', '/v1/auth/login', { email: 'ben@acme.test', password: PW, client: 'dashboard' }, {}); assert.equal(r.status, 200);
  });
  const JSON_H = { 'Content-Type': 'application/json' }, WIN = { ...JSON_H, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' };
  const ext = (dev, name, email = 'op@seat.test') => call('POST', '/v1/auth/login', { email, password: PW, client: 'extension', deviceId: dev, deviceName: name }, WIN);
  let pcA, opDash;
  await t('one login fills one seat per computer (2-seat licence)', async () => {
    await call('POST', '/v1/admin/orgs', { name: 'Seat Co', licence: { seats: 2, expiresAt: '2099-01-01' } });
    assert.equal((await call('POST', '/v1/admin/users', { email: 'op@seat.test', password: PW, orgId: 'seat-co', name: 'Operator' })).status, 201);
    pcA = (await ext('dev-a', 'QC desk 1')).body; assert.ok(pcA.accessToken);
    assert.equal((await ext('dev-b', 'QC desk 2')).status, 200);
    assert.equal((await call('GET', '/v1/auth/me', null, bearer(pcA.accessToken))).body.org.usage.seatsUsed, 2);
  });
  await t('signing in again on the same computer keeps one seat and ends its old sign-in', async () => {
    const again = (await ext('dev-a', 'QC desk 1')).body; assert.ok(again.accessToken);
    assert.equal((await call('GET', '/v1/auth/me', null, bearer(pcA.accessToken))).status, 401);
    assert.equal((await call('GET', '/v1/auth/me', null, bearer(again.accessToken))).body.org.usage.seatsUsed, 2); pcA = again;
  });
  await t('a third computer → 403 SEAT_LIMIT pointing to the dashboard', async () => {
    const r = await ext('dev-c', 'Laptop'); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'SEAT_LIMIT');
    assert.match(r.body.error.message, /All 2 seats .*Sign out a computer on the SmartFill dashboard/);
  });
  await t('the operator signs in to the dashboard with the same login (no seat) and sees both computers', async () => {
    const r = await call('POST', '/v1/auth/login', { email: 'op@seat.test', password: PW, client: 'dashboard' }, {}); assert.equal(r.status, 200); opDash = bearer(r.body.accessToken);
    const d = (await call('GET', '/v1/devices', null, opDash)).body.devices;
    assert.deepEqual(d.map(x => x.name).sort(), ['QC desk 1', 'QC desk 2']); assert.equal(d[0].browser, 'Chrome on Windows'); assert.equal(d[0].user.email, 'op@seat.test');
    assert.ok(d.every(x => x.signedInAt && x.lastActiveAt && !('orgId' in x)));
    const dash = (await call('GET', '/v1/dashboard', null, opDash)).body; assert.equal(dash.devices.length, 2); assert.equal(dash.licence.seatsUsed, 2);
  });
  await t('another customer cannot see or sign out these computers', async () => {
    const amyTok = bearer((await call('POST', '/v1/auth/login', { email: 'amy@acme.test', password: PW, client: 'dashboard' }, {})).body.accessToken);
    assert.ok(!(await call('GET', '/v1/devices', null, amyTok)).body.devices.some(x => x.user.email === 'op@seat.test'));
    const id = (await call('GET', '/v1/devices', null, opDash)).body.devices[0].deviceId;
    assert.equal((await call('POST', `/v1/devices/${id}/sign-out`, null, amyTok)).status, 404);
  });
  await t('operator signs out one computer → its seat is free, that computer is told why', async () => {
    const a = (await call('GET', '/v1/devices', null, opDash)).body.devices.find(x => x.name === 'QC desk 1');
    assert.equal((await call('POST', `/v1/devices/${a.deviceId}/sign-out`, null, opDash)).status, 200);
    const me = await call('GET', '/v1/auth/me', null, bearer(pcA.accessToken)); assert.equal(me.status, 401); assert.match(me.body.error.message, /signed out from the SmartFill dashboard/);
    const rf = await call('POST', '/v1/auth/refresh', { refreshToken: pcA.refreshToken }, JSON_H); assert.equal(rf.status, 401); assert.match(rf.body.error.message, /signed out from the SmartFill dashboard/);
    assert.equal((await ext('dev-c', 'Laptop')).status, 200);
    assert.deepEqual((await call('GET', '/v1/devices', null, opDash)).body.devices.map(x => x.name).sort(), ['Laptop', 'QC desk 2']);
  });
  await t('admin sees every customer\'s computers (with the customer) and can sign one out', async () => {
    const d = (await call('GET', '/v1/devices?org=seat-co')).body.devices; assert.equal(d.length, 2); assert.equal(d[0].orgName, 'Seat Co');
    assert.equal((await call('POST', `/v1/devices/${d[0].deviceId}/sign-out`)).status, 200);
    assert.equal((await call('GET', '/v1/devices?org=seat-co')).body.devices.length, 1);
    const u = (await call('GET', '/v1/dashboard?org=seat-co')).body.users.find(x => x.email === 'op@seat.test'); assert.equal(u.computers, 1);
  });

  console.log('licence + what a customer sees');
  amy = (await call('POST', '/v1/auth/login', { email: 'amy@acme.test', password: PW }, {})).body;
  const A = bearer(amy.accessToken);
  const snap = JSON.parse(readFileSync(new URL('../fixtures/boost-1166305.json', import.meta.url)));
  const snap2 = JSON.parse(readFileSync(new URL('../fixtures/boost-1166309.json', import.meta.url)));
  const waitDone = async id => { for (let i = 0; i < 100 && (await call('GET', `/v1/analyses/${id}`, null, A)).body.status !== 'done'; i++) await new Promise(r => setTimeout(r, 100)); };
  let aid;
  await t('customer reviews an order', async () => {
    assert.equal((await call('PUT', '/v1/orders/1166305/snapshot', snap, A)).status, 200);
    const r = await call('POST', '/v1/orders/1166305/analyses', {}, A); assert.equal(r.status, 202); assert.ok(!('engine' in r.body)); aid = r.body.analysisId;
    await waitDone(aid);
  });
  await t('customer sees findings but no AI usage, cost, models, engines or score', async () => {
    const a = (await call('GET', `/v1/analyses/${aid}`, null, A)).body, s = JSON.stringify(a);
    assert.ok(Object.keys(a.modules).length > 5);
    for (const k of ['usage', 'usageLog', 'models', 'engine']) assert.ok(!(k in a), k);
    assert.ok(!/"engine"|"cost"|fallbackReason|gpt-/.test(s)); assert.ok(!('score' in a.summary));
  });
  await t('admin (dev token) still sees usage and engine', async () => { const a = (await call('GET', `/v1/analyses/${aid}`)).body; assert.ok('usage' in a && 'engine' in a); });
  await t('health is minimal for customers', async () => assert.deepEqual((await call('GET', '/v1/health', null, A)).body, { ok: true }));
  await t('cost and analytics routes are admin-only', async () => {
    assert.equal((await call('GET', '/v1/analytics/summary', null, A)).status, 403);
    assert.equal((await call('GET', '/v1/orders/1166305/cost-estimate', null, A)).status, 403);
    assert.equal((await call('GET', '/v1/admin/users', null, A)).status, 403);
  });
  if (HAVE_PHOTOS) {
    await t('the 38 photos of 1166305 used 38 of the 40', async () => assert.equal((await call('GET', '/v1/auth/me', null, A)).body.org.usage.imagesThisMonth, 38));
    await t('re-running 1166305 reuses the photo results: allowed and not counted again', async () => {
      const r = await call('POST', '/v1/orders/1166305/analyses?force=true', {}, A); assert.equal(r.status, 202); await waitDone(r.body.analysisId);
      assert.equal((await call('GET', '/v1/auth/me', null, A)).body.org.usage.imagesThisMonth, 38);
    });
    await t('before Run, the panel can see that the order does not fit (49 new photos, 2 left)', async () => {
      assert.equal((await call('PUT', '/v1/orders/1166309/snapshot', snap2, A)).status, 200);
      const al = (await call('GET', '/v1/orders/1166309/photo-allowance', null, A)).body;
      assert.deepEqual([al.limited, al.need, al.left, al.cap, al.enough], [true, 49, 2, 40, false]);
      assert.match(al.message, /49 new photos for the AI to review, but only 2 of your plan's 40 photos are left this month\. The allowance resets on \w{3} \d+\. Ask your administrator/);
      const again = (await call('GET', '/v1/orders/1166305/photo-allowance', null, A)).body;   // already reviewed: free
      assert.deepEqual([again.need, again.enough], [0, true]);
      assert.equal((await call('GET', '/v1/orders/1166309/photo-allowance')).body.limited, false);   // admins are not limited
    });
    await t('an order with 49 new photos when 2 are left → 402 IMAGE_LIMIT with a clear message and the numbers', async () => {
      const r = await call('POST', '/v1/orders/1166309/analyses', {}, A); assert.equal(r.status, 402); assert.equal(r.body.error.code, 'IMAGE_LIMIT');
      assert.match(r.body.error.message, /49 new photos for the AI to review, but only 2 of your plan's 40 photos/);
      assert.deepEqual([r.body.error.details.need, r.body.error.details.left, r.body.error.details.cap], [49, 2, 40]);
    });
    await t('admin raises the allowance → the same order can be reviewed', async () => {
      await call('PATCH', '/v1/admin/orgs/acme-inspections', { licence: { imagesPerMonth: 200 } });
      const r = await call('POST', '/v1/orders/1166309/analyses', {}, A); assert.equal(r.status, 202); await waitDone(r.body.analysisId);
      assert.equal((await call('GET', '/v1/auth/me', null, A)).body.org.usage.imagesThisMonth, 87);
    });
    await t('customers see what the AI saw in a photo, not which AI', async () => {
      const r = (await call('GET', '/v1/orders/1166305/photos/18441046/insight', null, A)).body.insights[0];
      assert.ok(r.description && !('model' in r) && !('orgId' in r));
    });
  } else console.log('  (photo allowance checks skipped: data/photos/1166305 and 1166309 not present)');
  await t('customer dashboard: their figures + licence, nothing technical', async () => {
    const d = (await call('GET', '/v1/dashboard', null, A)).body, s = JSON.stringify(d);
    assert.equal(d.view, 'customer'); assert.equal(d.licence.organisation, 'Acme Inspections'); assert.equal(d.licence.plan, 'Tiny');
    if (HAVE_PHOTOS) { assert.equal(d.totals.ordersReviewed, 2); assert.equal(d.licence.imagesThisMonth, 87); assert.equal(d.totals.photosReviewed, 87); }
    assert.ok(!d.ai && !d.orgs && !d.users); assert.ok(!/cost|tokens|gpt-|engine/i.test(s));
  });
  await t('admin dashboard: AI usage + every organisation + users', async () => {
    const d = (await call('GET', '/v1/dashboard')).body;
    assert.equal(d.view, 'admin'); assert.ok(d.ai && 'cost' in d.ai && 'tokens' in d.ai); assert.ok(d.orgs.some(o => o.orgId === 'acme-inspections')); assert.ok(d.users.length >= 3);
    assert.ok(d.orders.every(o => 'cost' in o && 'orgId' in o));
  });
  await t('another organisation cannot open this order', async () => {
    await call('POST', '/v1/admin/orgs', { name: 'Other Co', licence: { seats: 2, expiresAt: '2099-01-01' } });
    await call('POST', '/v1/admin/users', { email: 'oz@other.test', password: PW, orgId: 'other-co' });
    const oz = bearer((await call('POST', '/v1/auth/login', { email: 'oz@other.test', password: PW }, {})).body.accessToken);
    assert.equal((await call('GET', `/v1/analyses/${aid}`, null, oz)).status, 404);
    assert.equal((await call('GET', '/v1/orders/1166305/analyses/latest', null, oz)).status, 404);
    assert.equal((await call('PUT', '/v1/orders/1166305/snapshot', snap, oz)).status, 403);
  });
  await t('expired licence → existing tokens and new sign-ins refused (403 LICENCE_EXPIRED)', async () => {
    await call('PATCH', '/v1/admin/orgs/acme-inspections', { licence: { expiresAt: '2020-01-01' } });
    assert.equal((await call('GET', '/v1/auth/me', null, A)).body.error.code, 'LICENCE_EXPIRED');
    assert.equal((await call('POST', '/v1/auth/login', { email: 'amy@acme.test', password: PW }, {})).status, 403);
  });
  await t('disabled user is signed out everywhere', async () => {
    const users = (await call('GET', '/v1/admin/users')).body.users, oz = users.find(u => u.email === 'oz@other.test');
    const tok = (await call('POST', '/v1/auth/login', { email: 'oz@other.test', password: PW }, {})).body.accessToken;
    await call('PATCH', `/v1/admin/users/${oz.userId}`, { status: 'disabled' });
    assert.equal((await call('GET', '/v1/auth/me', null, bearer(tok))).status, 401);
  });
  await t('5 wrong passwords lock the account for a while', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/v1/auth/login', { email: 'boss@vendor.test', password: 'wrong-wrong-' + i }, {});
    assert.equal((await call('POST', '/v1/auth/login', { email: 'boss@vendor.test', password: PW }, {})).body.error.code, 'ACCOUNT_LOCKED');
  });
} finally {
  srv.kill(); fake.srv.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
