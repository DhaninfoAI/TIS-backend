// Each organisation has a platform (which web tool) and a brand (its own logo), sent with every sign-in
// (lib/auth.mjs, lib/platforms.mjs). In-memory, no server.
//   node test/org-brand.mjs
import assert from 'node:assert/strict';
import { createAuth } from '../lib/auth.mjs';

const PW = 'Sample-pass-2026';   // test-only password, never stored anywhere
const state = { users: {}, orgs: {}, sessions: {}, analyses: {}, photoInsights: {}, meta: {} };
const A = createAuth({ state, save: () => {}, secret: 'brand-test' });
A.ensureDefaultOrg();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '→', e.message); } };

console.log('organisation platform + brand');
t('a new organisation defaults to the EZSurveyForm platform and no logo', () => {
  const { org } = A.createOrg({ name: 'Plain Co', licence: { seats: 1, expiresAt: '2099-01-01' } });
  assert.equal(org.platform, 'ez'); assert.deepEqual(org.brand, { name: 'Plain Co', logoLight: null, logoDark: null });
});
t('an unknown platform is refused', () => {
  assert.equal(A.createOrg({ name: 'Odd Co', platform: 'nope' }).error.code, 'INVALID_PAYLOAD');
  assert.equal(A.updateOrg('plain-co', { platform: 'nope' }).error.code, 'INVALID_PAYLOAD');
});
t('a logo is stored and comes back with the sign-in', () => {
  A.updateOrg('plain-co', { brand: { name: 'Plain', logoLight: PNG } });
  A.createUser({ email: 'op@plain.test', password: PW, orgId: 'plain-co' });
  const r = A.login({ email: 'op@plain.test', password: PW, client: 'extension', deviceId: 'pc' });
  assert.equal(r.org.platform, 'ez'); assert.equal(r.org.brand.name, 'Plain'); assert.equal(r.org.brand.logoLight, PNG); assert.equal(r.org.brand.logoDark, null);
  assert.equal(A.refresh({ refreshToken: r.refreshToken }).org.brand.logoLight, PNG);
});
t('changing one field keeps the others; null removes a logo', () => {
  A.updateOrg('plain-co', { brand: { logoDark: PNG } });
  let o = A.publicOrg(A.org('plain-co')); assert.equal(o.brand.logoLight, PNG); assert.equal(o.brand.logoDark, PNG); assert.equal(o.brand.name, 'Plain');
  A.updateOrg('plain-co', { brand: { logoLight: null, logoDark: null } });
  o = A.publicOrg(A.org('plain-co')); assert.equal(o.brand.logoLight, null); assert.equal(o.brand.name, 'Plain');
});
t('only small images as data: URLs are accepted (no links, no HTML, no huge files)', () => {
  for (const bad of ['https://example.test/logo.png', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,' + 'A'.repeat(200_000), 'javascript:alert(1)'])
    assert.equal(A.updateOrg('plain-co', { brand: { logoLight: bad } }).error.code, 'INVALID_PAYLOAD', bad.slice(0, 30));
});
t('the brand name is cleaned', () => {
  A.updateOrg('plain-co', { brand: { name: '<b>Plain</b>\u0007 Co' } });
  assert.equal(A.publicOrg(A.org('plain-co')).brand.name, 'bPlain/b Co');
});

console.log('photos used this month: reset to 0');
t('an admin reset sets the count to 0; later photos count again; plan edits keep the reset', () => {
  const at = h => new Date(Date.now() - h * 3600e3).toISOString();
  for (let i = 0; i < 5; i++) state.photoInsights['p' + i] = { orgId: 'plain-co', orderId: '1', imageId: 'a' + i, firstAt: at(1) };
  assert.equal(A.imagesThisMonth('plain-co'), 5);
  A.updateOrg('plain-co', { resetPhotoCount: true });
  assert.equal(A.imagesThisMonth('plain-co'), 0);
  assert.equal(A.publicOrg(A.org('plain-co')).usage.imagesThisMonth, 0);
  state.photoInsights.p9 = { orgId: 'plain-co', orderId: '2', imageId: 'b9', firstAt: new Date(Date.now() + 1000).toISOString() };
  assert.equal(A.imagesThisMonth('plain-co'), 1);
  A.updateOrg('plain-co', { licence: { seats: 4 } });   // editing the licence keeps the reset point
  assert.equal(A.imagesThisMonth('plain-co'), 1); assert.ok(A.org('plain-co').licence.usageResetAt);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
