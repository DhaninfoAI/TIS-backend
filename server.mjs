// SmartFill backend: implements extension/docs/BACKEND_REQUIREMENTS.md (v0.2).
//   npm start            → http://localhost:4010   (API explorer at /, rules editor at /rules)
// Config in .env (see .env.example). With OPENAI_API_KEY set, the AI modules call OpenAI; without it
// they run as mock heuristics. Persistence: Postgres (DATABASE_URL) or data/state.json.

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(here, '.env')) && process.env.SKIP_DOTENV !== '1')
  for (const line of readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }

const { MODULES, MODULE_ORDER, aiFailureKind } = await import('./lib/pipeline.mjs');
const { priorFacts } = await import('./lib/prior.mjs');
const { runRules } = await import('./lib/rules.mjs');
const { estimate } = await import('./lib/cost.mjs');
const { rulesPack, loadKb, setDocsProvider } = await import('./lib/kb.mjs');
const { PRICES } = await import('./lib/pricing.mjs');
const { createStore } = await import('./lib/store.mjs');
const llm = await import('./lib/llm.mjs');
const { createAuth, DEFAULT_ORG } = await import('./lib/auth.mjs');
const { PLATFORMS } = await import('./lib/platforms.mjs');
const { buildDashboard } = await import('./lib/dashboard.mjs');
const { PHOTO_PROMPT_V } = await import('./lib/ai-modules.mjs');
const { sweepUnreviewedPhotos } = await import('./lib/photo-sweep.mjs');

const PORT = Number(process.env.PORT || 4010);
// Hosted under a path prefix (nginx: https://dashboard.boost-usa.com/tis/… → this app). nginx may strip the prefix or
// pass it on; either way routes see /v1/…, and the dashboard's sign-in cookie is scoped to <prefix>/v1/auth.
const BASE_PATH = (process.env.BASE_PATH || '').trim().replace(/\/+$/, '').replace(/^(?=[^/])/, '/');
const DEV_TOKEN = process.env.DEV_TOKEN || 'dev-token';
// The fixed developer token works only while ALLOW_DEV_TOKEN is not 0 (set ALLOW_DEV_TOKEN=0 before giving the product to a customer).
const ALLOW_DEV_TOKEN = process.env.ALLOW_DEV_TOKEN !== '0';
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 250);
const DATA = process.env.DATA_DIR || path.join(here, 'data');
const PIPELINE_VERSION = '0.3.0';
// the extension folder, only for the developer previews (harness, writer test); not needed on a hosted server
const EXT_DIR = path.resolve(here, process.env.EXTENSION_DIR || '../extension');
const BRAND_DIR = path.join(here, 'public/brand');   // SmartFill's star + the first customer's logo, served at /brand/
mkdirSync(path.join(DATA, 'photos'), { recursive: true });

// ---------------------------------------------------------------- store
const seedRules = JSON.parse(readFileSync(path.join(here, 'rules/rules.json'), 'utf8')).rules;
const store = await createStore({
  dataDir: DATA,
  databaseUrl: process.env.STORE === 'file' ? null : process.env.DATABASE_URL,
  seed: { meta: {
    rules: { version: 1, published: seedRules, drafts: {}, changelog: [{ version: 1, at: new Date().toISOString(), author: 'seed', note: 'Seeded from rules/rules.json' }] },
    ruleDocs: {}, hazardLibrary: [],
  } },
});
const { state, save } = store;
const meta = () => state.meta;
// New code rules shipped in rules.json are added to the live store (TIS edits are kept).
// Ship rule updates: new rules are added; built-in "code" rules follow rules.json (TIS edits DSL rules on /rules).
for (const r of seedRules) {
  const i = meta().rules.published.findIndex(x => x.id === r.id);
  if (i < 0) { meta().rules.published.push(r); save('meta', 'rules'); }
  else if (r.kind === 'code' && JSON.stringify(meta().rules.published[i]) !== JSON.stringify(r)) { meta().rules.published[i] = r; save('meta', 'rules'); }
}
// Rules TIS no longer wants (2026-11-05: comments are handled by the reviewer)
for (const id of ['general.no_answer_needs_comment']) { const i = meta().rules.published.findIndex(x => x.id === id); if (i >= 0) { meta().rules.published.splice(i, 1); save('meta', 'rules'); } }
const rulesWithVersion = () => meta().rules.published.map(r => ({ ...r, __version: meta().rules.version }));

// ---------------------------------------------------------------- accounts & licences (lib/auth.mjs)
if (!process.env.JWT_SECRET && !meta().authSecret) { meta().authSecret = randomBytes(48).toString('base64url'); save('meta', 'authSecret'); }
const A = createAuth({ state, save, secret: process.env.JWT_SECRET || meta().authSecret, devToken: DEV_TOKEN, allowDevToken: ALLOW_DEV_TOKEN,
  seatIdleHours: process.env.SEAT_IDLE_HOURS ?? undefined });   // hours without use before a computer's seat is freed (default 8, 0 = never)
A.ensureDefaultOrg();
// 2026-11-11: the first customer keeps its logo after SmartFill became Boost-branded (once; the dashboard can change it)
{ const o = state.orgs[DEFAULT_ORG], svg = f => 'data:image/svg+xml;base64,' + readFileSync(path.join(BRAND_DIR, f)).toString('base64');
  if (o && !o.brand && existsSync(path.join(BRAND_DIR, 'tis-logo-navy.svg'))) {
    A.updateOrg(DEFAULT_ORG, { platform: 'ez', brand: { name: 'TIS', logoLight: svg('tis-logo-navy.svg'), logoDark: svg('tis-logo-white.svg') } });
  } }
{ const r = A.bootstrapAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD); if (r) console.log('[auth]', r); }
const isAdmin = auth => auth?.role === 'admin';
const orgOf = x => x?.orgId || DEFAULT_ORG;
const mine = (auth, x) => isAdmin(auth) || orgOf(x) === auth?.orgId;

/** Did the AI part of this review run? Derived from the modules, so it also works for reviews made before
 *  `aiFailed` existed. kind: setup | limit | busy | unreachable | other (worst first); detail is for admins only. */
const AI_KIND_ORDER = ['setup', 'limit', 'busy', 'unreachable', 'other'];
function aiStatusOf(a) {
  const failed = [];
  for (const [k, m] of Object.entries(a?.modules || {})) {
    const reason = m.summary?.fallbackReason || m.error || '';
    const kind = m.aiFailed
      || (m.engine === 'mock (fallback)' && reason && !/no photo files uploaded/i.test(reason) ? aiFailureKind(reason) : null)
      || (m.status === 'error' ? 'other' : null);
    if (kind) failed.push({ module: k, kind, reason });
  }
  if (!failed.length) return { ok: true };
  const kind = AI_KIND_ORDER.find(x => failed.some(f => f.kind === x)) || 'other';
  const partial = Object.values(a.modules || {}).some(m => m.engine === 'openai');   // some AI steps did run
  const detail = String(failed.find(f => f.kind === kind)?.reason || '').replace(/\b\w*sk-[\w*.-]+/g, '[key]').replace(/\s*You can find your API key.*$/i, '').replace(/https?:\/\/\S+/g, '').slice(0, 200).trim();   // never a key fragment, even for admins
  return { ok: false, kind, partial, modules: failed.map(f => f.module), detail };
}

/** What a caller may see of an analysis. For everyone: no narrative rewrite, no comment findings (TIS decisions of
 *  2026-11-05, also for reviews made before). For customers additionally no AI usage, cost, models or engines. */
function forClient(a, auth) {
  if (!a) return a;
  const out = { ...a, modules: {} };
  if (a.status === 'done') { const st = aiStatusOf(a); out.aiStatus = isAdmin(auth) ? st : (({ detail, ...rest }) => rest)(st); }   // a plain "the AI part didn't run" for the panel
  for (const [k, m] of Object.entries(a.modules || {})) {
    const items = (m.items || []).filter(i => !(k === 'narrative' && i.kind === 'rewrite') && i.kind !== 'comment' && !String(i.id || '').startsWith('general.no_answer_needs_comment'))
      .map(i => (k === 'questions' && (i.proposedWrites || []).some(w => w.kind === 'text') ? { ...i, proposedWrites: i.proposedWrites.filter(w => w.kind !== 'text') } : i));
    const mod = { ...m, items };
    if (!isAdmin(auth)) { delete mod.engine; if (mod.summary) { const { fallbackReason, ...s } = mod.summary; mod.summary = s; } delete mod.note; delete mod.error; }
    out.modules[k] = mod;
  }
  if (!isAdmin(auth)) { for (const f of ['usage', 'usageLog', 'models', 'engine', 'pipelineVersion', 'rulesVersion', 'autonomy']) delete out[f]; if (out.summary) { const { score, ...s } = out.summary; out.summary = s; } }
  return out;
}
setDocsProvider(() => meta().ruleDocs);   // TIS notes from /rules flow into every AI prompt
const subscribers = new Map();
const photoDir = oid => path.join(DATA, 'photos', String(oid));

// Photos of orders opened but never reviewed are deleted after UNREVIEWED_PHOTO_HOURS (default 24; 0 = never), checked
// at start and every hour. Reviewed orders keep theirs. lib/photo-sweep.mjs
const SWEEP_HOURS = Number(process.env.UNREVIEWED_PHOTO_HOURS ?? 24);
function sweepPhotos() {
  if (!(SWEEP_HOURS > 0)) return;
  const reviewed = new Set(Object.values(state.analyses).map(a => String(a.orderId)));
  const r = sweepUnreviewedPhotos({ root: path.join(DATA, 'photos'), maxAgeMs: SWEEP_HOURS * 3600e3,
    isReviewed: oid => reviewed.has(oid), lastOpened: oid => Date.parse(state.snapshots[oid]?.receivedAt || '') || null });
  if (r.deleted.length) console.log(`[photos] removed the photos of ${r.deleted.length} order(s) not reviewed within ${SWEEP_HOURS} h: `
    + r.deleted.map(d => `${d.orderId} (${d.files} files, ${(d.bytes / 1048576).toFixed(1)} MB)`).join(', '));
}
setTimeout(sweepPhotos, 5000).unref();
setInterval(sweepPhotos, 3600e3).unref();
const insightKey = (oid, id, model) => `${oid}:${id}:${model}`;

// ---------------------------------------------------------------- helpers
const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body, null, 1)); };
const err = (res, code, c, message, retryable = false) => send(res, code, { error: { code: c, message, retryable } });
const readBody = req => new Promise((ok, bad) => { const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => ok(Buffer.concat(ch))); req.on('error', bad); });
const json = async req => { const b = await readBody(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; };
const sha = s => 'sha256:' + createHash('sha256').update(s).digest('hex');
const latestAnalysis = (oid, auth) => Object.values(state.analyses).filter(a => String(a.orderId) === String(oid) && a.status === 'done' && (!auth || mine(auth, a))).sort((a, b) => (a.finishedAt || '').localeCompare(b.finishedAt || '')).pop();

function parseMultipart(buf, contentType) {
  const bm = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/) || [];
  const sep = Buffer.from('--' + (bm[1] || bm[2]));
  const parts = []; let i = buf.indexOf(sep);
  while (i !== -1) {
    const next = buf.indexOf(sep, i + sep.length); if (next === -1) break;
    const part = buf.subarray(i + sep.length + 2, next - 2); const hEnd = part.indexOf('\r\n\r\n'); const head = part.subarray(0, hEnd).toString();
    parts.push({ name: (head.match(/name="([^"]+)"/) || [])[1], filename: (head.match(/filename="([^"]+)"/) || [])[1], data: part.subarray(hEnd + 4) });
    i = next;
  }
  return parts;
}
// live progress to each listener, cut to what that listener may see
function emit(aid, event, data) {
  for (const { res, auth } of subscribers.get(aid) || []) {
    let d = data;
    if (data.result) d = { ...data, result: forClient({ modules: { [data.module]: data.result } }, auth).modules[data.module] };
    if (!isAdmin(auth)) { const { spent, usage, ...rest } = d; d = rest; if (d.summary) { const { score, ...s } = d.summary; d = { ...d, summary: s }; } }
    res.write(`event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);
  }
}

// ---------------------------------------------------------------- analysis runner
async function runAnalysis(aid, modules) {
  const a = state.analyses[aid];
  const snap = state.snapshots[a.orderId]?.snapshot;
  const ctx = {
    rules: rulesWithVersion(), usage: [], photoDir, budget: llm.budget(),
    results: Object.fromEntries(Object.entries(a.modules || {}).filter(([, m]) => m.status === 'done')),
    getInsight: (oid, id, model) => state.photoInsights[insightKey(oid, id, model)] || null,
    // orgId + firstAt meter the customer's photo allowance (a re-made result keeps its first date: not charged twice)
    setInsight: (oid, id, model, v) => { const k = insightKey(oid, id, model), prev = state.photoInsights[k];
      state.photoInsights[k] = { ...v, orderId: String(oid), orgId: prev?.orgId || a.orgId || DEFAULT_ORG, firstAt: prev?.firstAt || v.at || new Date().toISOString() }; save('photoInsights', k); },
  };
  // reuse cached photo insights for downstream modules on re-runs
  const model = llm.MODELS.photo();
  const cachedIns = Object.fromEntries((snap.photos || []).map(p => [p.imageId, ctx.getInsight(a.orderId, p.imageId, model)]).filter(([, v]) => v).map(([k, v]) => [k, { ...v, caption: snap.photos.find(p => p.imageId === k)?.caption }]));
  if (Object.keys(cachedIns).length) ctx.photoInsights = cachedIns;
  a.status = 'running'; save('analyses', aid);
  for (const name of MODULE_ORDER.filter(m => modules.includes(m))) {
    a.modules[name] = { status: 'running', startedAt: new Date().toISOString() };
    emit(aid, 'module.started', { module: name });
    try {
      if (DELAY && !llm.enabled()) await new Promise(r => setTimeout(r, DELAY));
      const out = await MODULES[name](snap, ctx);
      a.modules[name] = { status: 'done', startedAt: a.modules[name].startedAt, finishedAt: new Date().toISOString(), ...out };
      ctx.results[name] = a.modules[name];
      emit(aid, 'module.completed', { module: name, result: a.modules[name], spent: +ctx.budget.spent.toFixed(4) });
    } catch (e) {
      a.modules[name] = { status: 'error', error: e.message, items: [] };
      emit(aid, 'error', { module: name, message: e.message });
    }
    save('analyses', aid);
  }
  // renames are improvements, not report defects: they don't count toward the score
  const items = Object.entries(a.modules).filter(([k]) => !['qcChecklist', 'captions'].includes(k)).flatMap(([, m]) => m.items || []);
  const open = i => i.status === 'fail';
  a.summary = { blockers: items.filter(i => i.severity === 'blocker' && open(i)).length, warnings: items.filter(i => i.severity === 'warning' && open(i)).length,
    advisories: items.filter(i => i.severity === 'advisory' && open(i)).length, hazardsMissed: (a.modules.photoReview?.items || []).filter(i => i.hazardType && (open(i) || i.recDrafted)).length,
    rating: a.modules.qcChecklist?.summary?.rating ?? null };
  // readiness score: each band is capped so a pile of minor items can't sink a report on its own
  a.summary.score = Math.round(Math.max(0, 100 - Math.min(60, a.summary.blockers * 12) - Math.min(25, a.summary.warnings * 3) - Math.min(15, a.summary.advisories * 1.5)));
  a.usageLog = [...(a.usageLog || []), ...ctx.budget.usage];
  a.usage = llm.summarizeUsage(a.usageLog);
  a.status = 'done'; a.finishedAt = new Date().toISOString();
  save('analyses', aid);
  emit(aid, 'analysis.completed', { analysisId: aid, summary: a.summary, usage: a.usage });
  for (const { res } of subscribers.get(aid) || []) res.end();
  subscribers.delete(aid);
}

/** Photos of an order the AI would review now: uploaded, and without a current saved result. */
function photosToReview(oid, snap) {
  const dir = photoDir(oid), model = llm.MODELS.photo();
  return (snap.photos || []).filter(ph => existsSync(path.join(dir, ph.imageId + '.jpg')) && state.photoInsights[insightKey(oid, ph.imageId, model)]?.v !== PHOTO_PROMPT_V).length;
}

function newAnalysis(orderId, snapshotId, modules, autonomy = 1, auth = null) {
  const aid = 'an_' + randomUUID().slice(0, 8);
  state.analyses[aid] = { analysisId: aid, orderId, snapshotId, autonomy, status: 'queued', createdAt: new Date().toISOString(), orgId: auth?.orgId || DEFAULT_ORG, userId: auth?.userId || null,
    rulesVersion: meta().rules.version, pipelineVersion: PIPELINE_VERSION, engine: llm.enabled() ? 'openai' : 'mock',
    models: llm.enabled() ? { photo: llm.MODELS.photo(), reason: llm.MODELS.reason() } : null, modules: {} };
  save('analyses', aid);
  setImmediate(() => runAnalysis(aid, modules).catch(e => console.error('[analysis]', aid, e)));
  return state.analyses[aid];
}

// ---------------------------------------------------------------- routes
const routes = [];
// open: no sign-in needed (the handler may still check one) · roles: limit to these roles (e.g. ['admin'])
const route = (method, pattern, handler, { open = false, roles = null } = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, open, roles });
const ADMIN = { roles: ['admin'] };
const authErr = (res, e) => err(res, e.status, e.code, e.message);

route('GET', '/v1/health', (req, res) => {
  const who = A.authenticate(req, new URL(req.url, 'http://x')).auth;
  if (!isAdmin(who)) return send(res, 200, { ok: true });   // nothing technical for anyone else
  send(res, 200, { ok: true, pipelineVersion: PIPELINE_VERSION, engine: llm.enabled() ? 'openai' : 'mock',
    models: llm.enabled() ? { photo: llm.MODELS.photo(), reason: llm.MODELS.reason() } : null, costCap: Number(process.env.MAX_COST_PER_ANALYSIS || 2),
    rulesVersion: meta().rules.version, store: store.backend, counts: store.counts(), kbLoaded: Object.keys(loadKb().clients || {}).length, devTokenAllowed: ALLOW_DEV_TOKEN });
}, { open: true });

route('GET', '/v1/config', (req, res) => send(res, 200, {
  autoApplyThresholds: { checks: 0.9, questions: 0.9, recPhotos: 0.85, recommendations: 0.95, captions: 0.85, qcChecklist: 0.9 },
  features: Object.fromEntries(MODULE_ORDER.map(m => [m, true])), killSwitch: false, minExtensionVersion: '0.4.0',
  ...(isAdmin(req.auth) ? { rulesVersion: meta().rules.version, engine: llm.enabled() ? 'openai' : 'mock', models: Object.keys(PRICES) } : {}) }));

// --- ingest
route('PUT', '/v1/orders/:orderId/snapshot', async (req, res, p) => {
  const snap = await json(req);
  if (!snap.order || String(snap.order.orderId) !== p.orderId) return err(res, 400, 'INVALID_PAYLOAD', 'order.orderId must match the URL');
  if (!Array.isArray(snap.forms)) return err(res, 400, 'INVALID_PAYLOAD', 'forms[] required');
  // prior report: keep only its facts (its forms are big); a snapshot read without it (final check) keeps the last one
  for (const pr of snap.priorReports || []) if (pr.forms) { pr.facts = priorFacts(pr); pr.sqft = pr.facts.sqft; pr.iso = pr.facts.iso?.raw || null; delete pr.forms; }
  if (!(snap.priorReports || []).length && state.snapshots[p.orderId]?.snapshot?.priorReports?.length) snap.priorReports = state.snapshots[p.orderId].snapshot.priorReports;
  const contentHash = snap.contentHash || sha(JSON.stringify({ ...snap, capturedAt: undefined }));
  const prev = state.snapshots[p.orderId];
  const snapshotId = prev?.contentHash === contentHash ? prev.snapshotId : 'sn_' + randomUUID().slice(0, 8);
  if (prev && !mine(req.auth, prev)) return err(res, 403, 'FORBIDDEN', 'This order belongs to another organisation.');
  state.snapshots[p.orderId] = { snapshotId, contentHash, receivedAt: new Date().toISOString(), snapshot: snap, orgId: req.auth.orgId, userId: req.auth.userId };
  save('snapshots', p.orderId);
  const have = existsSync(photoDir(p.orderId)) ? new Set(readdirSync(photoDir(p.orderId)).map(f => f.replace('.jpg', ''))) : new Set();
  send(res, 200, { snapshotId, contentHash, unchanged: prev?.contentHash === contentHash, photosNeeded: (snap.photos || []).map(x => x.imageId).filter(id => !have.has(String(id))),
    stats: { forms: snap.forms.length, fields: snap.forms.flatMap(f => f.sections || []).flatMap(s => s.fields || []).length, recommendations: (snap.recommendations || []).length, photos: (snap.photos || []).length } });
});
route('GET', '/v1/orders/:orderId/snapshot', (req, res, p) => state.snapshots[p.orderId] && mine(req.auth, state.snapshots[p.orderId]) ? send(res, 200, state.snapshots[p.orderId]) : err(res, 404, 'NOT_FOUND', 'no snapshot'));

route('POST', '/v1/orders/:orderId/photos', async (req, res, p) => {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) return err(res, 400, 'INVALID_PAYLOAD', 'multipart/form-data required');
  const parts = parseMultipart(await readBody(req), ct);
  mkdirSync(photoDir(p.orderId), { recursive: true });
  const stored = [], rejected = [];
  for (const part of parts.filter(x => x.name === 'files')) {
    const id = (part.filename || '').replace(/\.jpe?g$/i, '');
    if (!/^\w+$/.test(id) || part.data[0] !== 0xff || part.data[1] !== 0xd8) { rejected.push({ imageId: id, reason: 'not a JPEG' }); continue; }
    writeFileSync(path.join(photoDir(p.orderId), id + '.jpg'), part.data); stored.push(id);
  }
  send(res, 200, { stored, rejected });
});
// Photo file for panel thumbnails (<img> can't send headers → ?token=)
route('GET', '/v1/orders/:orderId/photos/:imageId', (req, res, p) => {
  const who = A.authenticate(req, new URL(req.url, 'http://x')); if (who.error) return authErr(res, who.error);
  if (state.snapshots[p.orderId] && !mine(who.auth, state.snapshots[p.orderId])) return err(res, 404, 'NOT_FOUND', 'photo not uploaded');
  const f = path.join(photoDir(p.orderId), path.basename(p.imageId) + '.jpg');
  if (!existsSync(f)) return err(res, 404, 'NOT_FOUND', 'photo not uploaded');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }); res.end(readFileSync(f));
}, { open: true });
route('GET', '/v1/orders/:orderId/photos/:imageId/insight', (req, res, p) => {
  const ins = Object.entries(state.photoInsights).filter(([k]) => k.startsWith(`${p.orderId}:${p.imageId}:`)).map(([, v]) => v)
    .filter(v => mine(req.auth, v)).map(v => (isAdmin(req.auth) ? v : (({ model, v: ver, orgId, firstAt, ...rest }) => rest)(v)));   // customers: what the AI saw, not which AI
  send(res, 200, { imageId: p.imageId, insights: ins });
});

// --- analysis
route('POST', '/v1/orders/:orderId/analyses', async (req, res, p) => {
  const b = await json(req); const s = state.snapshots[p.orderId];
  if (!s) return err(res, 404, 'NOT_FOUND', 'Upload a snapshot first (PUT /v1/orders/{id}/snapshot)');
  if (b.snapshotId && b.snapshotId !== s.snapshotId) return err(res, 409, 'SNAPSHOT_STALE', 'snapshotId is not the latest for this order');
  const url = new URL(req.url, 'http://x');
  const engine = llm.enabled() ? 'openai' : 'mock';
  if (url.searchParams.get('force') !== 'true') {
    // a review whose AI part failed is never reused: pressing Run again (without Fresh run) tries the AI again
    const cached = Object.values(state.analyses).find(a => a.snapshotId === s.snapshotId && a.status === 'done' && a.rulesVersion === meta().rules.version && a.engine === engine && !b.modules && mine(req.auth, a) && aiStatusOf(a).ok);
    if (cached) return send(res, 200, { analysisId: cached.analysisId, cached: true, status: 'done' });
  }
  const modules = b.modules?.length ? b.modules : MODULE_ORDER;
  const bad = modules.filter(m => !MODULES[m]); if (bad.length) return err(res, 400, 'INVALID_PAYLOAD', 'unknown modules: ' + bad.join(','));
  if (!isAdmin(req.auth) && llm.enabled() && modules.includes('photoReview')) {   // the plan's photos per month
    const cap = Number(A.org(req.auth.orgId)?.licence?.imagesPerMonth || 0), need = photosToReview(p.orderId, s.snapshot);
    if (cap && need) {
      const left = Math.max(0, cap - A.imagesThisMonth(req.auth.orgId));
      if (need > left) return err(res, 402, 'IMAGE_LIMIT', `This order has ${need} photos to review, but only ${left} of your plan's ${cap.toLocaleString('en-US')} photos are left this month. Please contact your administrator for more photos.`);
    }
  }
  const a = newAnalysis(Number(p.orderId), s.snapshotId, modules, b.autonomy, req.auth);
  send(res, 202, { analysisId: a.analysisId, status: a.status, modules, events: `/v1/analyses/${a.analysisId}/events`, ...(isAdmin(req.auth) ? { engine } : {}) });
});
route('GET', '/v1/analyses/:id', (req, res, p) => state.analyses[p.id] && mine(req.auth, state.analyses[p.id]) ? send(res, 200, forClient(state.analyses[p.id], req.auth)) : err(res, 404, 'NOT_FOUND', 'analysis not found'));
route('GET', '/v1/orders/:orderId/analyses/latest', (req, res, p) => { const a = latestAnalysis(p.orderId, req.auth); a ? send(res, 200, forClient(a, req.auth)) : err(res, 404, 'NOT_FOUND', 'no analysis yet'); });
route('GET', '/v1/analyses/:id/events', (req, res, p) => {
  const who = A.authenticate(req, new URL(req.url, 'http://x')); if (who.error) return authErr(res, who.error);   // EventSource can't send headers → ?token=
  const a = state.analyses[p.id]; if (!a || !mine(who.auth, a)) return err(res, 404, 'NOT_FOUND', 'analysis not found');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const view = forClient(a, who.auth);
  for (const [m, r] of Object.entries(view.modules)) if (r.status === 'done') res.write(`event: module.completed\ndata: ${JSON.stringify({ module: m, result: r })}\n\n`);
  if (a.status === 'done') { res.write(`event: analysis.completed\ndata: ${JSON.stringify({ analysisId: a.analysisId, summary: view.summary, ...(isAdmin(who.auth) ? { usage: a.usage } : {}) })}\n\n`); return res.end(); }
  if (!subscribers.has(p.id)) subscribers.set(p.id, new Set());
  const sub = { res, auth: who.auth };
  subscribers.get(p.id).add(sub); req.on('close', () => subscribers.get(p.id)?.delete(sub));
}, { open: true });
route('POST', '/v1/orders/:orderId/analyses/:id/rerun', async (req, res, p) => {
  const a = state.analyses[p.id]; if (!a || !mine(req.auth, a)) return err(res, 404, 'NOT_FOUND', 'analysis not found');
  const b = await json(req); const s = state.snapshots[p.orderId];
  a.snapshotId = s.snapshotId; a.status = 'queued';
  const modules = [...new Set([...(b.modules?.length ? b.modules : ['narrative']), 'qcChecklist'])];
  for (const m of modules) delete a.modules[m];
  setImmediate(() => runAnalysis(a.analysisId, modules));
  send(res, 202, { analysisId: a.analysisId, rerunning: modules });
});
// --- queue
route('POST', '/v1/batches', async (req, res) => {
  const b = await json(req); const id = 'bt_' + randomUUID().slice(0, 8);
  state.batches[id] = { batchId: id, orderIds: b.orderIds || [], createdAt: new Date().toISOString() }; save('batches', id);
  send(res, 201, { ...state.batches[id], note: 'Extension uploads each snapshot; analyses are tracked via /v1/orders/status.' });
});
route('GET', '/v1/batches/:id', (req, res, p) => state.batches[p.id] ? send(res, 200, state.batches[p.id]) : err(res, 404, 'NOT_FOUND', 'batch not found'));
route('GET', '/v1/orders/status', (req, res) => {
  const ids = (new URL(req.url, 'http://x').searchParams.get('ids') || '').split(',').filter(Boolean);
  send(res, 200, { orders: ids.map(id => { const a = Object.values(state.analyses).filter(x => String(x.orderId) === id && mine(req.auth, x)).pop();
    return { orderId: Number(id), analyzed: a?.status === 'done', status: a?.status || 'none', analysisId: a?.analysisId || null, ...(forClient(a, req.auth)?.summary || {}), updatedAt: a?.finishedAt || null }; }) });
});

// --- cost
route('GET', '/v1/orders/:orderId/cost-estimate', (req, res, p) => {
  const s = state.snapshots[p.orderId]; if (!s) return err(res, 404, 'NOT_FOUND', 'no snapshot');
  const q = new URL(req.url, 'http://x').searchParams;
  try { const model = q.get('model');
    send(res, 200, estimate(s.snapshot, { photoModel: q.get('photoModel') || model || llm.MODELS.photo(), reasonModel: q.get('reasonModel') || model || llm.MODELS.reason(),
      batch: q.get('batch') === 'true', photoCount: q.get('photos') ? Number(q.get('photos')) : undefined, detail: q.get('detail') || 'high' }));
  } catch (e) { err(res, 400, 'INVALID_PAYLOAD', e.message); }
}, ADMIN);
route('GET', '/v1/orders/:orderId/cost-compare', (req, res, p) => {
  const s = state.snapshots[p.orderId]; if (!s) return err(res, 404, 'NOT_FOUND', 'no snapshot');
  const combos = [['gpt-4o', 'gpt-4o'], ['gpt-4o-mini', 'gpt-4o-mini'], ['gpt-4.1', 'gpt-4.1'], ['gpt-4.1-mini', 'gpt-4.1'], ['gpt-5.4-mini', 'gpt-5.4-mini'], ['gpt-5.4-mini', 'gpt-5.4'], ['gpt-5.4', 'gpt-5.4'], ['gpt-5.5', 'gpt-5.5']];
  send(res, 200, { orderId: Number(p.orderId), rows: combos.map(([ph, re]) => { const e = estimate(s.snapshot, { photoModel: ph, reasonModel: re });
    return { photoModel: ph, reasonModel: re, perOrder: e.total, perOrderBatch: estimate(s.snapshot, { photoModel: ph, reasonModel: re, batch: true }).total, photoPart: +e.photo.cost.toFixed(4), reasonPart: +e.reason.cost.toFixed(4) }; }) });
}, ADMIN);

// --- learning & analytics
route('POST', '/v1/feedback', async (req, res) => {
  const b = await json(req); const fid = 'fb_' + randomUUID().slice(0, 8);
  state.feedback[fid] = { feedbackId: fid, receivedAt: new Date().toISOString(), user: req.headers['x-ez-user'] || null, ...b, orgId: req.auth.orgId, userId: req.auth.userId }; save('feedback', fid);
  send(res, 200, { feedbackId: fid, items: (b.items || []).length });
});
route('POST', '/v1/orders/:orderId/qc-outcome', async (req, res, p) => {
  const b = await json(req); const id = `${p.orderId}:${Date.now()}`;
  // every finding of the review and what the reviewer did with it (applied / dismissed + reason / undone / not acted)
  const DECISIONS = ['applied', 'dismissed', 'undone', 'not acted'];
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 1000).map(i => ({ itemId: String(i.itemId || '').slice(0, 120), module: String(i.module || '').slice(0, 40),
    kind: i.kind ? String(i.kind).slice(0, 40) : null, title: String(i.title || '').slice(0, 200), severity: String(i.severity || '').slice(0, 20),
    decision: DECISIONS.includes(i.decision) ? i.decision : 'not acted', reason: i.reason ? String(i.reason).slice(0, 60) : null, at: i.at ?? null }));
  state.outcomes[id] = { orderId: Number(p.orderId), at: new Date().toISOString(), user: req.headers['x-ez-user'] || null, ...b, items, orgId: req.auth.orgId, userId: req.auth.userId }; save('outcomes', id);
  send(res, 200, { ok: true });
});
route('GET', '/v1/analytics/inspectors/:inspector', (req, res, p) => {
  const o = Object.values(state.outcomes).filter(x => x.inspector === decodeURIComponent(p.inspector));
  const pct = k => o.length ? Math.round(100 * o.filter(x => x.section6?.[k]).length / o.length) : 0;
  send(res, 200, { inspector: decodeURIComponent(p.inspector), reports: o.length, avgRating: o.length ? +(o.reduce((a, x) => a + (x.rating || 0), 0) / o.length).toFixed(1) : null,
    issueRates: { squareFootage: pct('squareFootage'), iso: pct('iso'), missedHazards: pct('missedHazards'), operationsNotDescribed: pct('operationsNotDescribed'), narrative: pct('narrative') } });
});
route('GET', '/v1/analytics/summary', (req, res) => {
  const items = Object.values(state.feedback).flatMap(f => f.items || []);
  const by = {}; for (const i of items) { const m = (by[i.module] ||= { total: 0, accepted: 0, rejected: 0, edited: 0, applied: 0, dismissed: 0 }); m.total++; if (m[i.decision] != null) m[i.decision]++; }
  const usage = llm.summarizeUsage(Object.values(state.analyses).flatMap(a => a.usageLog || []));
  send(res, 200, { analyses: Object.keys(state.analyses).length, outcomes: Object.keys(state.outcomes).length, feedbackItems: items.length, acceptanceByModule: by, llmUsage: usage });
}, ADMIN);

// --- rules & knowledge (TIS-editable)
route('GET', '/v1/rules/tree', (req, res) => {
  const k = loadKb();
  send(res, 200, { rulesVersion: meta().rules.version, universal: (k.global_quality_control_standards?.requirements || []).map(r => r.topic),
    forms: Object.keys(k.global_forms || {}), clients: Object.fromEntries(Object.entries(k.clients || {}).map(([c, v]) => [c, { status: v.status, forms: Object.keys(v.forms || {}) }])),
    structuredRules: meta().rules.published.map(r => ({ id: r.id, severity: r.severity, kind: r.kind, message: r.message, checklistItem: r.checklistItem })),
    drafts: Object.keys(meta().rules.drafts), docs: Object.keys(meta().ruleDocs) });
}, ADMIN);
route('GET', '/v1/rules/changelog', (req, res) => send(res, 200, { rulesVersion: meta().rules.version, changelog: meta().rules.changelog }), ADMIN);
route('POST', '/v1/rules/publish', async (req, res) => {
  const b = await json(req); const r = meta().rules; const ids = Object.keys(r.drafts);
  if (!ids.length) return err(res, 400, 'INVALID_PAYLOAD', 'no drafts to publish');
  for (const id of ids) { const i = r.published.findIndex(x => x.id === id); const d = r.drafts[id];
    if (d.deleted) { if (i >= 0) r.published.splice(i, 1); } else if (i >= 0) r.published[i] = d; else r.published.push(d); }
  r.version++; r.drafts = {};
  r.changelog.push({ version: r.version, at: new Date().toISOString(), author: req.auth?.email || b.author || 'unknown', note: b.note || '', changed: ids });
  save('meta', 'rules'); send(res, 200, { rulesVersion: r.version, published: ids });
}, ADMIN);
route('GET', '/v1/rules/:scope/:id', (req, res, p) => {
  const id = decodeURIComponent(p.id), r = meta().rules;
  if (p.scope === 'rule') { const x = r.drafts[id] || r.published.find(y => y.id === id); return x ? send(res, 200, { rule: x, draft: !!r.drafts[id] }) : err(res, 404, 'NOT_FOUND', 'rule not found'); }
  const versions = meta().ruleDocs[`${p.scope}/${id}`] || []; const k = loadKb();
  const kbEntry = p.scope === 'client' ? k.clients?.[id] : p.scope === 'form' ? k.global_forms?.[id] : null;
  send(res, 200, { scope: p.scope, id, markdown: versions.at(-1)?.markdown || null, versions: versions.length, history: versions.map(v => ({ at: v.at, author: v.author, note: v.note })), kbEntry });
}, ADMIN);
route('PUT', '/v1/rules/:scope/:id', async (req, res, p) => {
  const id = decodeURIComponent(p.id); const b = await json(req);
  if (p.scope === 'rule') {
    if (!b.rule?.id || b.rule.id !== id || !['dsl', 'code'].includes(b.rule.kind)) return err(res, 400, 'INVALID_PAYLOAD', 'body.rule with matching id and kind dsl|code required');
    meta().rules.drafts[id] = b.rule; save('meta', 'rules'); return send(res, 200, { draft: true, id, publishWith: 'POST /v1/rules/publish' });
  }
  const docKey = `${p.scope}/${id}`; (meta().ruleDocs[docKey] ||= []).push({ markdown: String(b.markdown || ''), author: req.auth?.email || b.author || null, note: b.note || '', at: new Date().toISOString() });
  meta().rules.version++;   // notes change what the AI is told → cached analyses are no longer current
  meta().rules.changelog.push({ version: meta().rules.version, at: new Date().toISOString(), author: req.auth?.email || b.author || null, note: `doc ${docKey}: ${b.note || ''}` });
  save('meta', 'ruleDocs'); save('meta', 'rules'); send(res, 200, { scope: p.scope, id, version: meta().ruleDocs[docKey].length });
}, ADMIN);
route('POST', '/v1/rules/:scope/:id/test', async (req, res, p) => {
  const id = decodeURIComponent(p.id); const rule = meta().rules.drafts[id] || meta().rules.published.find(x => x.id === id);
  if (p.scope !== 'rule' || !rule) return err(res, 404, 'NOT_FOUND', 'only structured rules can be dry-run');
  const results = Object.entries(state.snapshots).map(([oid, s]) => ({ orderId: Number(oid), hits: runRules(s.snapshot, [rule]).map(i => i.message) }));
  send(res, 200, { ruleId: id, ordersTested: results.length, ordersFlagged: results.filter(r => r.hits.length).length, results });
}, ADMIN);
route('GET', '/v1/orders/:orderId/rules-pack', (req, res, p) => { const s = state.snapshots[p.orderId]; if (!s) return err(res, 404, 'NOT_FOUND', 'no snapshot'); send(res, 200, rulesPack(s.snapshot)); });
route('GET', '/v1/hazard-library', (req, res) => send(res, 200, { items: meta().hazardLibrary, taxonomy: JSON.parse(readFileSync(path.join(here, 'rules/hazard_taxonomy.json'), 'utf8')).hazards.map(h => ({ id: h.id, name: h.name, parent: h.parent })) }));
route('POST', '/v1/hazard-library', async (req, res) => { const b = await json(req); const item = { id: 'hz_' + randomUUID().slice(0, 8), ...b, at: new Date().toISOString() }; meta().hazardLibrary.push(item); save('meta', 'hazardLibrary'); send(res, 201, item); });
route('GET', '/v1/form-registry', (req, res) => send(res, 200, JSON.parse(readFileSync(path.join(here, 'rules/form-registry.json'), 'utf8'))));

// --- sign-in (access + refresh tokens). The dashboard keeps its refresh token in an HttpOnly cookie; the extension in its own storage.
const RT_COOKIE = 'tisqc_rt';
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const prefixOf = req => BASE_PATH || String(req.headers['x-forwarded-prefix'] || '').replace(/[^\w\-/]/g, '').replace(/\/+$/, '');
const setRt = (req, res, token, maxAge) => res.setHeader('Set-Cookie', `${RT_COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=${prefixOf(req)}/v1/auth; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : ''}`);
const tokensOut = (req, res, r, dashboard) => {
  if (!dashboard) return send(res, 200, r);
  setRt(req, res, r.refreshToken, r.refreshExpiresIn);
  const { refreshToken, refreshExpiresIn, ...rest } = r; send(res, 200, rest);
};
route('POST', '/v1/auth/login', async (req, res) => {
  const b = await json(req), r = A.login({ email: b.email, password: b.password, client: b.client, userAgent: req.headers['user-agent'], deviceId: b.deviceId, deviceName: b.deviceName });
  if (r.error) return authErr(res, r.error);
  tokensOut(req, res, r, b.client === 'dashboard');
}, { open: true });
route('POST', '/v1/auth/refresh', async (req, res) => {
  const b = await json(req), fromCookie = !b.refreshToken, r = A.refresh({ refreshToken: b.refreshToken || cookie(req)[RT_COOKIE], userAgent: req.headers['user-agent'] });
  if (r.error) { if (fromCookie) setRt(req, res, '', 0); return authErr(res, r.error); }
  tokensOut(req, res, r, fromCookie);
}, { open: true });
route('POST', '/v1/auth/logout', async (req, res) => {
  const b = await json(req); A.logout({ refreshToken: b.refreshToken || cookie(req)[RT_COOKIE] }); setRt(req, res, '', 0); send(res, 200, { ok: true });
}, { open: true });
route('GET', '/v1/auth/me', (req, res) => {
  const a = req.auth; if (a.dev) return send(res, 200, { user: { userId: 'dev', name: 'Developer', role: 'admin' }, org: A.publicOrg(A.org(DEFAULT_ORG)), dev: true });
  send(res, 200, { user: A.publicUser(state.users[a.userId]), org: A.publicOrg(A.org(a.orgId)) });
});

// --- computers signed in to the extension (each uses a seat). Customers see and sign out their own organisation's;
//     admins every organisation's (?org= to pick one).
route('GET', '/v1/devices', (req, res) => {
  const a = req.auth, org = a.role === 'admin' ? new URL(req.url, 'http://x').searchParams.get('org') || null : a.orgId;
  send(res, 200, { devices: A.devices(org, { currentFamily: a.family }).map(d => a.role === 'admin' ? d : (({ orgId, orgName, ...x }) => x)(d)) });
});
route('POST', '/v1/devices/:id/sign-out', (req, res, p) => { const r = A.signOutDevice(p.id, req.auth.role === 'admin' ? null : req.auth.orgId); r.error ? authErr(res, r.error) : send(res, 200, r); });

// --- administration (admins only): organisations + licences, users, sign-outs
route('GET', '/v1/admin/orgs', (req, res) => send(res, 200, { orgs: Object.values(state.orgs).map(A.publicOrg) }), ADMIN);
route('GET', '/v1/platforms', (req, res) => send(res, 200, { platforms: Object.values(PLATFORMS) }), ADMIN);
route('POST', '/v1/admin/orgs', async (req, res) => { const r = A.createOrg(await json(req)); r.error ? authErr(res, r.error) : send(res, 201, r); }, ADMIN);
route('PATCH', '/v1/admin/orgs/:id', async (req, res, p) => { const r = A.updateOrg(p.id, await json(req)); r.error ? authErr(res, r.error) : send(res, 200, r); }, ADMIN);
route('GET', '/v1/admin/plans', (req, res) => send(res, 200, { plans: A.plans() }), ADMIN);
route('PUT', '/v1/admin/plans', async (req, res) => { const r = A.setPlans((await json(req)).plans); r.error ? authErr(res, r.error) : send(res, 200, r); }, ADMIN);
route('GET', '/v1/admin/users', (req, res) => send(res, 200, { users: Object.values(state.users).map(A.publicUser) }), ADMIN);
route('POST', '/v1/admin/users', async (req, res) => { const r = A.createUser(await json(req)); r.error ? authErr(res, r.error) : send(res, 201, r); }, ADMIN);
route('PATCH', '/v1/admin/users/:id', async (req, res, p) => { const r = A.updateUser(p.id, await json(req)); r.error ? authErr(res, r.error) : send(res, 200, r); }, ADMIN);
route('POST', '/v1/admin/users/:id/sign-out', (req, res, p) => send(res, 200, A.revokeUser(p.id)), ADMIN);

// --- dashboard figures (the role decides what is included)
route('GET', '/v1/dashboard', (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  send(res, 200, buildDashboard(state, req.auth, { orgId: q.get('org') || null, from: q.get('from'), to: q.get('to'), auth: A }));
});

// ---------------------------------------------------------------- static (dev tools)
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/rules': 'rules.html', '/writer-test': 'writer-test.html', '/dashboard': 'dashboard.html' };
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, url) {
  if (PAGES[url.pathname]) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); res.end(readFileSync(path.join(here, 'public', PAGES[url.pathname]))); return true; }
  if (url.pathname === '/harness-chrome-stub.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); res.end(readFileSync(path.join(here, 'public/harness-chrome-stub.js'))); return true; }
  if (url.pathname.startsWith('/brand/')) {   // logos the dashboard uses (no extension folder needed)
    const f = path.join(BRAND_DIR, path.basename(url.pathname));
    if (!existsSync(f)) { err(res, 404, 'NOT_FOUND', 'not served'); return true; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' }); res.end(readFileSync(f)); return true;
  }
  if (url.pathname.startsWith('/ext/')) {   // the extension's own files, for the side-panel preview harness
    const rel = path.normalize(decodeURIComponent(url.pathname.slice(5))).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(EXT_DIR, rel);
    if (!/^(sidepanel|viewer|common|icons|content|fonts)[/\\]/.test(rel) || !existsSync(file)) { err(res, 404, 'NOT_FOUND', 'not served'); return true; }
    let body = readFileSync(file);
    if (url.searchParams.get('harness') && file.endsWith('.html')) body = body.toString().replace('<script type="module"', '<script src="/harness-chrome-stub.js"></script>\n  <script type="module"');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(body); return true;
  }
  if (url.pathname === '/content/snapshot.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); res.end(readFileSync(path.join(EXT_DIR, 'content/snapshot.js'))); return true; }
  if (url.pathname.startsWith('/fixtures/')) {
    if (url.pathname === '/fixtures/') { send(res, 200, readdirSync(path.join(here, 'fixtures')).filter(x => x.endsWith('.json'))); return true; }
    const f = path.join(here, 'fixtures', path.basename(url.pathname));
    if (existsSync(f)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(readFileSync(f)); return true; }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-EZ-User');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Private-Network', 'true'); res.writeHead(204); return res.end(); }
  if (BASE_PATH && (req.url === BASE_PATH || req.url.startsWith(BASE_PATH + '/') || req.url.startsWith(BASE_PATH + '?'))) req.url = req.url.slice(BASE_PATH.length) || '/';
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && serveStatic(req, res, url)) return;
  if (url.pathname.startsWith('/v1/') && process.env.LOG_REQUESTS !== '0' && !/\/photos\/\w+$/.test(url.pathname)) {
    const t0 = Date.now(), from = (req.headers.origin || '').replace(/^chrome-extension:\/\/(\w{6})\w*/, 'ext:$1');
    res.on('finish', () => console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname} → ${res.statusCode} ${Date.now() - t0}ms ${from}`));
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re); if (!m) continue;
    if (!r.open) {
      const who = A.authenticate(req); if (who.error) return authErr(res, who.error);
      req.auth = who.auth;
      if (r.roles && !r.roles.includes(req.auth.role)) return err(res, 403, 'FORBIDDEN', 'Your account cannot do this.');
    }
    try { return await r.handler(req, res, m.groups || {}); }
    catch (e) { return err(res, e instanceof SyntaxError ? 400 : 500, e instanceof SyntaxError ? 'INVALID_PAYLOAD' : 'SERVER_ERROR', e.message, !(e instanceof SyntaxError)); }
  }
  err(res, 404, 'NOT_FOUND', `${req.method} ${url.pathname} is not an endpoint`);
});

// HOST=127.0.0.1 on a hosted server: only nginx (same machine) can reach the app; default = all interfaces
server.listen({ port: PORT, host: process.env.HOST || undefined }, () => console.log(`SmartFill backend on http://localhost:${PORT}  (engine: ${llm.enabled() ? 'openai ' + llm.MODELS.photo() + '/' + llm.MODELS.reason() : 'mock'} · store: ${store.backend} · ${JSON.stringify(store.counts())}${ALLOW_DEV_TOKEN ? ' · developer token ON (set ALLOW_DEV_TOKEN=0 for customers)' : ''})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await store.close().catch(() => {}); process.exit(0); });
export default server;
