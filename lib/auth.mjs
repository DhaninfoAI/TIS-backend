// Accounts, licences and tokens. No dependencies (node:crypto only).
//   access token  = HS256 JWT, 15 min, sent as "Authorization: Bearer …" (or ?token= for <img>/EventSource)
//   refresh token = random 256-bit string, 30 days, stored only as a SHA-256 hash, rotated on every use;
//                   re-using an old one revokes the whole sign-in ("family") → stolen tokens die quickly
// Licence = the customer's organisation: plan → photos per month (what they pay for) + seats (computers signed in
// to the extension at once; dashboard sign-ins are free), expiry. A photo counts once, the first time the AI reviews it for that customer in a calendar month.
// Roles: admin (us: everything, incl. AI cost) · customer (the client's staff: extension + their own data).
// Each organisation also has a platform (which web tool the extension works in, lib/platforms.mjs) and a brand
// (its own logo, shown in the extension and on its dashboard after sign-in; SmartFill's own mark before sign-in).

import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash, randomUUID } from 'node:crypto';
import { PLATFORMS, DEFAULT_PLATFORM } from './platforms.mjs';

export const ACCESS_TTL = 15 * 60;              // seconds
export const REFRESH_TTL = 30 * 24 * 3600;      // seconds
export const DEFAULT_ORG = 'tis';
const ROLES = ['admin', 'customer'];
// Starting catalogue (amounts are placeholders: set the real ones in the dashboard → Customers & licences → Plans).
export const DEFAULT_PLANS = [
  { id: 'trial', name: 'Trial', imagesPerMonth: 500, seats: 2, price: '' },
  { id: 'starter', name: 'Starter', imagesPerMonth: 5000, seats: 3, price: '' },
  { id: 'professional', name: 'Professional', imagesPerMonth: 15000, seats: 10, price: '' },
  { id: 'enterprise', name: 'Enterprise', imagesPerMonth: 50000, seats: 25, price: '' },
];
let now = () => Date.now();
/** Tests only: replace the clock (null = real time again). */
export const _setClock = f => { now = f || (() => Date.now()); };
export const DEFAULT_SEAT_IDLE_HOURS = 8;
const iso = t => new Date(t).toISOString();
const hashToken = t => createHash('sha256').update(String(t)).digest('hex');
// customer logos are stored with the organisation as data: URLs (small images only)
export const LOGO_MAX = 150_000;   // characters of the data: URL (~110 KB image)
const LOGO_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

// ---------------------------------------------------------------- passwords (scrypt)
export function hashPassword(pw) {
  const salt = randomBytes(16), key = scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  try {
    const want = Buffer.from(key, 'base64');
    return timingSafeEqual(scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: Number(N), r: Number(r), p: Number(p) }), want);
  } catch { return false; }
}
export function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number.';
  return null;
}

// ---------------------------------------------------------------- JWT (HS256)
const b64u = s => Buffer.from(s).toString('base64url');
export function signJwt(payload, secret) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
export function verifyJwt(token, secret) {
  const [head, body, sig] = String(token || '').split('.');
  if (!sig) return { error: 'INVALID_TOKEN' };
  const want = createHmac('sha256', secret).update(`${head}.${body}`).digest(), got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { error: 'INVALID_TOKEN' };
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { error: 'INVALID_TOKEN' }; }
  if (p.typ !== 'access') return { error: 'INVALID_TOKEN' };
  if (p.exp * 1000 <= now()) return { error: 'TOKEN_EXPIRED' };
  return { payload: p };
}

// ---------------------------------------------------------------- the service
export function createAuth({ state, save, secret, devToken, allowDevToken, seatIdleHours = DEFAULT_SEAT_IDLE_HOURS }) {
  // A computer not used for this long stops holding its seat (0 = never). Used = any call that renews its sign-in
  // (about every 15 min while SmartFill is in use). It gets a seat back when used again, if one is free.
  const IDLE_MS = Math.max(0, Number(seatIdleHours) || 0) * 3600e3;
  const fail = (status, code, message) => ({ error: { status, code, message } });
  const failures = new Map();   // email → { n, until }: 5 wrong passwords lock the account for 5 minutes

  const users = () => Object.values(state.users);
  const userByEmail = email => users().find(u => u.email === String(email || '').trim().toLowerCase());
  const org = id => state.orgs[id] || null;
  const activeSessions = orgId => Object.values(state.sessions).filter(s => s.orgId === orgId && !s.revokedAt && !s.replacedBy && Date.parse(s.expiresAt) > now());
  // A seat = one computer signed in to the extension (one active sign-in "family"). One login may fill several seats;
  // dashboard sign-ins and admins never use one. A sign-in made before `client` was recorded counts as a seat.
  const takesSeat = s => s.client !== 'dashboard' && state.users[s.userId]?.role === 'customer';
  // the active session of a sign-in was issued at its last renewal, so its times are the computer's last activity
  const lastActive = s => Math.max(Date.parse(s.createdAt) || 0, Date.parse(s.lastUsedAt) || 0);
  const idle = s => IDLE_MS > 0 && now() - lastActive(s) > IDLE_MS;
  const seatSessions = orgId => activeSessions(orgId).filter(s => takesSeat(s) && !idle(s));
  const seatsUsed = orgId => seatSessions(orgId).length;
  const monthStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  /** Orders reviewed this calendar month (re-runs of the same order count once). For information; not a limit. */
  const ordersThisMonth = orgId => new Set(Object.values(state.analyses)
    .filter(a => (a.orgId || DEFAULT_ORG) === orgId && Date.parse(a.createdAt) >= monthStart()).map(a => String(a.orderId))).size;
  /** Photos the AI reviewed for this customer this calendar month: the plan's meter. A photo whose saved result is
   *  reused (re-runs, a later review of the same order) is not counted again. */
  // An admin can set this month's count back to 0 (Reset photos used): photos first reviewed before the reset no
  // longer count; photos reviewed before it are still reused for free. A new month starts from 0 anyway.
  const usageResetAt = orgId => Date.parse(state.orgs[orgId]?.licence?.usageResetAt || '') || 0;
  const imagesThisMonth = (orgId, since = monthStart()) => { const from = Math.max(since, usageResetAt(orgId));
    return new Set(Object.values(state.photoInsights || {})
      .filter(i => (i.orgId || DEFAULT_ORG) === orgId && Date.parse(i.firstAt || i.at) >= from).map(i => `${i.orderId || ''}:${i.imageId}`)).size; };
  const plans = () => state.meta.plans || DEFAULT_PLANS;
  const planById = id => plans().find(p => p.id === id) || null;

  function licenceState(o) {
    if (!o) return { ok: false, code: 'NO_LICENCE', message: 'No SmartFill licence is set up for your organisation.' };
    const L = o.licence || {};
    if (o.status === 'suspended') return { ok: false, code: 'ORG_SUSPENDED', message: 'Your SmartFill access is paused. Please contact your administrator.' };
    if (L.expiresAt && Date.parse(L.expiresAt) <= now()) return { ok: false, code: 'LICENCE_EXPIRED', message: 'Your SmartFill licence has expired. Please contact your administrator.' };
    return { ok: true };
  }
  const publicOrg = o => o && ({ orgId: o.orgId, name: o.name, status: o.status,
    platform: o.platform || DEFAULT_PLATFORM, brand: { name: o.brand?.name || o.name, logoLight: o.brand?.logoLight || null, logoDark: o.brand?.logoDark || null },
    licence: { ...o.licence, planName: planById(o.licence?.plan)?.name || o.licence?.plan || '' },
    usage: { seatsUsed: seatsUsed(o.orgId), imagesThisMonth: imagesThisMonth(o.orgId), ordersThisMonth: ordersThisMonth(o.orgId) } });
  const publicUser = u => u && ({ userId: u.userId, orgId: u.orgId, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null });

  function ensureDefaultOrg() {
    if (!state.meta.plans) { state.meta.plans = DEFAULT_PLANS; save('meta', 'plans'); }
    // licences from before photo plans had an order allowance: move them onto their plan's photo allowance
    for (const o of Object.values(state.orgs)) if (o.licence && o.licence.imagesPerMonth === undefined) {
      const { ordersPerMonth, ...L } = o.licence; o.licence = { ...L, imagesPerMonth: planById(L.plan)?.imagesPerMonth ?? planById('trial').imagesPerMonth }; save('orgs', o.orgId);
    }
    if (state.orgs[DEFAULT_ORG]) return;
    const t = planById('trial') || DEFAULT_PLANS[0];
    state.orgs[DEFAULT_ORG] = { orgId: DEFAULT_ORG, name: 'Technical Insurance Services', status: 'active', createdAt: iso(now()),
      licence: { plan: t.id, seats: t.seats, imagesPerMonth: t.imagesPerMonth, expiresAt: iso(now() + 30 * 864e5) } };
    save('orgs', DEFAULT_ORG);
  }

  const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  function issue(u, { family, client, userAgent, deviceId, deviceName, signedInAt } = {}) {
    const refreshToken = randomBytes(32).toString('base64url'), sid = 'ss_' + randomUUID().slice(0, 12);
    state.sessions[sid] = { sessionId: sid, userId: u.userId, orgId: u.orgId, tokenHash: hashToken(refreshToken), family: family || sid,
      client: client || 'unknown', userAgent: String(userAgent || '').slice(0, 160), deviceId: clean(deviceId, 64) || null, deviceName: clean(deviceName, 40) || null,
      signedInAt: signedInAt || iso(now()), createdAt: iso(now()), lastUsedAt: iso(now()), expiresAt: iso(now() + REFRESH_TTL * 1000) };
    save('sessions', sid);
    const t = Math.floor(now() / 1000);
    const accessToken = signJwt({ typ: 'access', sub: u.userId, org: u.orgId, role: u.role, sid, iat: t, exp: t + ACCESS_TTL }, secret);
    return { accessToken, expiresIn: ACCESS_TTL, refreshToken, refreshExpiresIn: REFRESH_TTL, sessionId: sid, user: publicUser(u), org: publicOrg(org(u.orgId)) };
  }
  /** End one sign-in (all its rotated tokens). reason: 'self' | 'remote' (signed out from the dashboard) | 'replaced'. */
  const revokeFamily = (family, reason = 'self') => { for (const s of Object.values(state.sessions)) if (s.family === family && !s.revokedAt) { s.revokedAt = iso(now()); s.revokedReason = reason; save('sessions', s.sessionId); } };
  const ENDED = { remote: 'This computer was signed out from the SmartFill dashboard. Sign in again to continue.' };
  const ended = s => fail(401, 'SESSION_ENDED', ENDED[s?.revokedReason] || 'Please sign in again.');

  function login({ email, password, client, userAgent, deviceId, deviceName }) {
    const key = String(email || '').trim().toLowerCase(), f = failures.get(key);
    if (f?.until > now()) return fail(429, 'ACCOUNT_LOCKED', 'Too many attempts. Please wait a few minutes and try again.');
    const u = userByEmail(key);
    if (!u || u.status !== 'active' || !checkPassword(password, u.passwordHash)) {
      const n = (f?.n || 0) + 1; failures.set(key, { n, until: n >= 5 ? now() + 5 * 60e3 : 0 });
      return fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    failures.delete(key);
    deviceId = clean(deviceId, 64);
    // signing in again on the same computer replaces that computer's earlier sign-in instead of taking a second seat
    const sameComputer = deviceId && client !== 'dashboard' ? activeSessions(u.orgId).filter(s => s.deviceId === deviceId && s.client !== 'dashboard') : [];
    if (u.role !== 'admin') {
      const o = org(u.orgId), L = licenceState(o); if (!L.ok) return fail(403, L.code, L.message);
      const seats = Number(o.licence?.seats || 0), used = seatSessions(u.orgId).filter(s => !sameComputer.includes(s)).length;
      if (client !== 'dashboard' && seats && used >= seats)
        return fail(403, 'SEAT_LIMIT', `All ${seats} seat${seats === 1 ? '' : 's'} of your licence are in use. Sign out a computer on the SmartFill dashboard (Licence & team) or ask your administrator for more seats.`);
    }
    for (const s of sameComputer) revokeFamily(s.family, 'replaced');
    u.lastLoginAt = iso(now()); save('users', u.userId);
    return issue(u, { client, userAgent, deviceId, deviceName });
  }

  function refresh({ refreshToken, userAgent }) {
    const h = hashToken(refreshToken), s = Object.values(state.sessions).find(x => x.tokenHash === h);
    if (!s || s.revokedAt || Date.parse(s.expiresAt) <= now()) return ended(s);
    if (s.replacedBy) { revokeFamily(s.family); return fail(401, 'SESSION_ENDED', 'Please sign in again.'); }   // reuse of an old token
    const u = state.users[s.userId];
    if (!u || u.status !== 'active') { revokeFamily(s.family); return fail(401, 'SESSION_ENDED', 'Please sign in again.'); }
    if (u.role !== 'admin') {
      const o = org(u.orgId), L = licenceState(o); if (!L.ok) return fail(403, L.code, L.message);
      // back after the idle limit: take a seat again if one is free, else this sign-in ends
      const seats = Number(o.licence?.seats || 0);
      if (takesSeat(s) && idle(s) && seats && seatsUsed(u.orgId) >= seats) {
        revokeFamily(s.family, 'idle');
        return fail(403, 'SEAT_LIMIT', `This computer was not used for ${IDLE_MS / 3600e3} hours, so its seat was freed, and all ${seats} seat${seats === 1 ? ' is' : 's are'} now in use. Sign out a computer on the SmartFill dashboard (Licence & team) or ask your administrator for more seats.`);
      }
    }
    const next = issue(u, { family: s.family, client: s.client, userAgent, deviceId: s.deviceId, deviceName: s.deviceName, signedInAt: s.signedInAt || s.createdAt });
    s.replacedBy = next.sessionId; s.lastUsedAt = iso(now()); save('sessions', s.sessionId);
    return next;
  }

  function logout({ refreshToken }) {
    const s = Object.values(state.sessions).find(x => x.tokenHash === hashToken(refreshToken));
    if (s) revokeFamily(s.family);
    return { ok: true };
  }

  /** Who is calling: { auth } or { error }. Tokens come from the Authorization header or ?token= (img, EventSource). */
  function authenticate(req, url) {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url?.searchParams.get('token') || '';
    if (!raw) return fail(401, 'UNAUTHORIZED', 'Please sign in.');
    if (allowDevToken && devToken && raw === devToken) return { auth: { userId: 'dev', orgId: DEFAULT_ORG, role: 'admin', name: 'Developer', dev: true } };
    const v = verifyJwt(raw, secret);
    if (v.error) return fail(401, v.error, v.error === 'TOKEN_EXPIRED' ? 'Session expired.' : 'Please sign in.');
    const u = state.users[v.payload.sub], s = state.sessions[v.payload.sid];
    if (!u || u.status !== 'active' || !s || s.revokedAt) return ended(s);
    if (u.role !== 'admin') { const L = licenceState(org(u.orgId)); if (!L.ok) return fail(403, L.code, L.message); }
    return { auth: { userId: u.userId, orgId: u.orgId, role: u.role, name: u.name, email: u.email, sessionId: s.sessionId, family: s.family } };
  }

  // ---------------------------------------------------------------- admin operations
  function createOrg({ orgId, name, licence = {}, status = 'active', platform, brand }) {
    const id = String(orgId || name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!id || !name) return fail(400, 'INVALID_PAYLOAD', 'Organisation name required.');
    if (state.orgs[id]) return fail(409, 'EXISTS', 'An organisation with that id exists.');
    const pf = cleanPlatform(platform); if (pf.error) return pf;
    const b = cleanBrand(brand); if (b.error) return b;
    state.orgs[id] = { orgId: id, name: String(name).slice(0, 120), status, createdAt: iso(now()), platform: pf.platform, brand: b.brand, licence: cleanLicence(licence) };
    save('orgs', id); return { org: publicOrg(state.orgs[id]) };
  }
  function cleanPlatform(p) {
    const id = String(p ?? DEFAULT_PLATFORM).trim().toLowerCase();
    return PLATFORMS[id] ? { platform: id } : fail(400, 'INVALID_PAYLOAD', `Unknown platform. Known: ${Object.keys(PLATFORMS).join(', ')}.`);
  }
  /** brand = { name?, logoLight?, logoDark? }; a logo is a data: URL (png, jpeg, webp, svg); null or '' removes it. */
  function cleanBrand(b = {}, prev = {}) {
    if (b === null || typeof b !== 'object') b = {};
    const out = { name: b.name === undefined ? prev.name || '' : String(b.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80) };
    for (const k of ['logoLight', 'logoDark']) {
      const v = b[k] === undefined ? prev[k] || null : b[k] || null;
      if (v && (v.length > LOGO_MAX || !LOGO_RE.test(v))) return fail(400, 'INVALID_PAYLOAD', `The logo must be a PNG, JPEG, WebP or SVG image under ${Math.round(LOGO_MAX * 0.73 / 1000)} KB.`);
      out[k] = v;
    }
    return { brand: out };
  }
  /** The plan gives the photos per month and seats; either can be set differently for one customer. */
  function cleanLicence(L = {}, prev = {}) {
    const planId = String(L.plan ?? prev.plan ?? 'trial'), plan = planById(planId), changed = L.plan !== undefined && L.plan !== prev.plan;
    const n = (v, fromPlan, old) => v !== undefined && v !== '' && v !== null ? Math.max(0, Math.floor(Number(v) || 0)) : changed || old == null ? fromPlan ?? 0 : old;
    return { plan: planId.slice(0, 40), imagesPerMonth: n(L.imagesPerMonth, plan?.imagesPerMonth, prev.imagesPerMonth), seats: n(L.seats, plan?.seats, prev.seats),
      usageResetAt: prev.usageResetAt || null,   // kept across edits; set only by resetPhotoCount
      expiresAt: L.expiresAt === undefined ? prev.expiresAt ?? null : L.expiresAt ? iso(Date.parse(L.expiresAt)) : null };
  }
  function setPlans(list) {
    if (!Array.isArray(list) || !list.length) return fail(400, 'INVALID_PAYLOAD', 'At least one plan is required.');
    const out = [];
    for (const p of list) {
      const id = String(p.id || p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
      if (!id || out.some(x => x.id === id)) return fail(400, 'INVALID_PAYLOAD', 'Each plan needs a unique name.');
      out.push({ id, name: String(p.name || id).slice(0, 40), imagesPerMonth: Math.max(0, Math.floor(Number(p.imagesPerMonth) || 0)), seats: Math.max(0, Math.floor(Number(p.seats) || 0)), price: String(p.price || '').slice(0, 40) });
    }
    state.meta.plans = out; save('meta', 'plans'); return { plans: out };
  }
  function updateOrg(id, patch = {}) {
    const o = state.orgs[id]; if (!o) return fail(404, 'NOT_FOUND', 'Organisation not found.');
    if (patch.name) o.name = String(patch.name).slice(0, 120);
    if (patch.status) { if (!['active', 'suspended'].includes(patch.status)) return fail(400, 'INVALID_PAYLOAD', 'status must be active or suspended'); o.status = patch.status; }
    if (patch.licence) o.licence = cleanLicence(patch.licence, o.licence);
    if (patch.platform !== undefined) { const pf = cleanPlatform(patch.platform); if (pf.error) return pf; o.platform = pf.platform; }
    if (patch.brand !== undefined) { const b = cleanBrand(patch.brand, o.brand); if (b.error) return b; o.brand = b.brand; }
    if (patch.resetPhotoCount === true) o.licence = { ...(o.licence || {}), usageResetAt: iso(now()) };   // this month's photos used → 0
    save('orgs', id); return { org: publicOrg(o) };
  }
  function createUser({ email, name, password, role = 'customer', orgId = DEFAULT_ORG }) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return fail(400, 'INVALID_PAYLOAD', 'A valid email is required.');
    if (!ROLES.includes(role)) return fail(400, 'INVALID_PAYLOAD', 'role must be admin or customer');
    if (!state.orgs[orgId]) return fail(400, 'INVALID_PAYLOAD', 'Unknown organisation.');
    if (userByEmail(e)) return fail(409, 'EXISTS', 'A user with that email exists.');
    const p = passwordProblem(password); if (p) return fail(400, 'WEAK_PASSWORD', p);
    const id = 'us_' + randomUUID().slice(0, 12);
    state.users[id] = { userId: id, orgId, email: e, name: String(name || e.split('@')[0]).slice(0, 80), role, status: 'active', passwordHash: hashPassword(password), createdAt: iso(now()) };
    save('users', id); return { user: publicUser(state.users[id]) };
  }
  function updateUser(id, patch = {}) {
    const u = state.users[id]; if (!u) return fail(404, 'NOT_FOUND', 'User not found.');
    if (patch.name) u.name = String(patch.name).slice(0, 80);
    if (patch.role) { if (!ROLES.includes(patch.role)) return fail(400, 'INVALID_PAYLOAD', 'role must be admin or customer'); u.role = patch.role; }
    if (patch.orgId) { if (!state.orgs[patch.orgId]) return fail(400, 'INVALID_PAYLOAD', 'Unknown organisation.'); u.orgId = patch.orgId; }
    if (patch.status) { if (!['active', 'disabled'].includes(patch.status)) return fail(400, 'INVALID_PAYLOAD', 'status must be active or disabled'); u.status = patch.status; }
    if (patch.password) { const p = passwordProblem(patch.password); if (p) return fail(400, 'WEAK_PASSWORD', p); u.passwordHash = hashPassword(patch.password); }
    save('users', id);
    if (patch.status === 'disabled' || patch.password || patch.role || patch.orgId) revokeUser(id);   // changed rights → sign in again
    return { user: publicUser(u) };
  }
  function revokeUser(id, reason = 'remote') { for (const s of Object.values(state.sessions)) if (s.userId === id && !s.revokedAt) { s.revokedAt = iso(now()); s.revokedReason = reason; save('sessions', s.sessionId); } return { ok: true }; }

  // ---------------------------------------------------------------- computers signed in to the extension (= seats)
  /** "Chrome on Windows" from a user-agent string. */
  function browserOf(ua = '') {
    const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
    return [b, os].filter(Boolean).join(' on ') || 'Unknown browser';
  }
  /** Computers using a seat: one row per sign-in, latest activity first. orgId null = every organisation (admin). */
  function devices(orgId, { currentFamily } = {}) {
    const all = Object.values(state.sessions), list = orgId ? seatSessions(orgId) : Object.keys(state.orgs).flatMap(seatSessions);
    return list.map(s => {
      const fam = all.filter(x => x.family === s.family), u = state.users[s.userId];
      const lastActiveAt = iso(lastActive(s));
      const signedInAt = s.signedInAt || fam.reduce((m, x) => (x.createdAt < m ? x.createdAt : m), s.createdAt);
      return { deviceId: s.family, name: s.deviceName || '', browser: browserOf(s.userAgent), orgId: s.orgId, orgName: state.orgs[s.orgId]?.name || s.orgId,
        user: { name: u?.name || '', email: u?.email || '' }, signedInAt, lastActiveAt, thisComputer: !!currentFamily && s.family === currentFamily };
    }).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }
  /** Sign one computer out (frees its seat at once). orgId set = a customer, who may only sign out their own organisation's computers. */
  function signOutDevice(deviceId, orgId) {
    const s = Object.values(state.sessions).find(x => x.family === deviceId && !x.revokedAt);
    if (!s || !takesSeat(s) || (orgId && s.orgId !== orgId)) return fail(404, 'NOT_FOUND', 'That computer is not signed in.');
    revokeFamily(deviceId, 'remote'); return { ok: true };
  }

  /** First admin from ADMIN_EMAIL / ADMIN_PASSWORD when no admin exists yet (production bootstrap). */
  function bootstrapAdmin(email, password) {
    ensureDefaultOrg();
    if (!email || !password || users().some(u => u.role === 'admin')) return null;
    const r = createUser({ email, password, name: 'Administrator', role: 'admin', orgId: DEFAULT_ORG });
    return r.error ? r.error.message : `admin ${email} created`;
  }

  return { login, refresh, logout, authenticate, createOrg, updateOrg, createUser, updateUser, revokeUser, devices, signOutDevice, browserOf, bootstrapAdmin, ensureDefaultOrg,
    publicUser, publicOrg, licenceState, seatsUsed, ordersThisMonth, imagesThisMonth, plans, planById, setPlans, org, seatIdleHours: IDLE_MS / 3600e3 };
}
