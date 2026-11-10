// Seats free themselves after 8 hours without use (lib/auth.mjs, SEAT_IDLE_HOURS). In-memory, fake clock, no server.
//   node test/seat-idle.mjs
import assert from 'node:assert/strict';
import { createAuth, _setClock } from '../lib/auth.mjs';

let clock = Date.parse('2026-11-10T08:00:00Z');
_setClock(() => clock);
const H = 3600e3, PW = 'Sample-pass-2026';   // test-only password, never stored anywhere
const state = { users: {}, orgs: {}, sessions: {}, analyses: {}, photoInsights: {}, meta: {} };
const A = createAuth({ state, save: () => {}, secret: 'idle-test', seatIdleHours: 8 });
A.ensureDefaultOrg();
A.createOrg({ name: 'Idle Co', licence: { seats: 2, expiresAt: '2099-01-01' } });
A.createUser({ email: 'op@idle.test', password: PW, orgId: 'idle-co' });
const signIn = (dev, client = 'extension') => A.login({ email: 'op@idle.test', password: PW, client, deviceId: dev, deviceName: dev });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '→', e.message); } };

console.log('seat idle limit');
let a, b, c;
t('two computers fill the 2 seats', () => {
  a = signIn('pc-a'); b = signIn('pc-b'); assert.ok(a.accessToken && b.accessToken);
  assert.equal(A.seatsUsed('idle-co'), 2); assert.equal(signIn('pc-c').error.code, 'SEAT_LIMIT');
});
t('a computer in use keeps its seat past 8 hours (renewals count as use)', () => {
  for (let i = 0; i < 40; i++) { clock += 15 * 60e3; a = A.refresh({ refreshToken: a.refreshToken }); assert.ok(a.accessToken); }   // 10 h of work
  assert.equal(A.seatsUsed('idle-co'), 1);   // pc-b was untouched for 10 h: its seat is free
  assert.deepEqual(A.devices('idle-co').map(d => d.name), ['pc-a']);
});
t('the freed seat can be taken by another computer', () => { c = signIn('pc-c'); assert.ok(c.accessToken); assert.equal(A.seatsUsed('idle-co'), 2); });
t('the idle computer comes back while seats are full → refused with the reason, sign-in ended', () => {
  const r = A.refresh({ refreshToken: b.refreshToken }); assert.equal(r.error.code, 'SEAT_LIMIT');
  assert.match(r.error.message, /not used for 8 hours, so its seat was freed, and all 2 seats are now in use/);
  assert.equal(A.refresh({ refreshToken: b.refreshToken }).error.code, 'SESSION_ENDED');
});
t('an idle computer that comes back while a seat is free just carries on', () => {
  A.signOutDevice(A.devices('idle-co').find(d => d.name === 'pc-c').deviceId);
  b = signIn('pc-b'); clock += 9 * H;   // everyone idle now
  assert.equal(A.seatsUsed('idle-co'), 0);
  const r = A.refresh({ refreshToken: b.refreshToken }); assert.ok(r.accessToken); assert.equal(A.seatsUsed('idle-co'), 1);
});
t('dashboard sign-ins are not affected and still use no seat', () => { assert.ok(signIn('dash', 'dashboard').accessToken); assert.equal(A.seatsUsed('idle-co'), 1); });
t('limit 0 = seats never free themselves', () => {
  const s2 = { users: {}, orgs: {}, sessions: {}, analyses: {}, photoInsights: {}, meta: {} };
  const B = createAuth({ state: s2, save: () => {}, secret: 'x', seatIdleHours: 0 }); B.ensureDefaultOrg();
  B.createOrg({ name: 'Never Co', licence: { seats: 1, expiresAt: '2099-01-01' } }); B.createUser({ email: 'n@never.test', password: PW, orgId: 'never-co' });
  B.login({ email: 'n@never.test', password: PW, client: 'extension', deviceId: 'x' }); clock += 100 * H;
  assert.equal(B.seatsUsed('never-co'), 1); assert.equal(B.seatIdleHours, 0);
});

_setClock(null);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
