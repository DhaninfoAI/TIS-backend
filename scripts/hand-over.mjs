// Hand an organisation's account over to the customer (one-off, 2026-11-13): give an account a new email (same
// password), put the organisation on a plan, sign everyone out and remove the organisation's review data so the
// customer starts clean. Accounts, organisations, plans and AI rules are kept.
//
// Run it on the server while the service is STOPPED: the running server keeps everything in memory and would write
// its old copy back. Without --apply it only prints what it would do.
//   sudo systemctl stop smartfill
//   sudo -u smartfill node scripts/hand-over.mjs --org tis --from old@x.com --to new@y.com --plan starter --sign-out-all --delete-data
//   sudo -u smartfill node scripts/hand-over.mjs ...same... --apply
//   sudo systemctl start smartfill
//
// Removed with --delete-data, for the organisation only (records without an orgId count as the default org, as the
// server treats them): order reads (snapshots), reviews (analyses), Apply/Dismiss records (feedback), QC outcomes,
// batches, AI photo results (photoInsights: the photo allowance counts these) and the uploaded photo folders of those
// orders (data/photos/<order>) that no other organisation uses.
// --sign-out-all ends every session of every account (all organisations): everyone signs in again.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.mjs';
import { DEFAULT_ORG, DEFAULT_PLANS } from '../lib/auth.mjs';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (existsSync(path.join(here, '.env')) && process.env.SKIP_DOTENV !== '1')
  for (const line of readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }

const argv = process.argv.slice(2), has = k => argv.includes('--' + k), arg = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const orgId = arg('org'), from = (arg('from') || '').trim().toLowerCase(), to = (arg('to') || '').trim().toLowerCase(), planId = arg('plan');
const apply = has('apply'), signOutAll = has('sign-out-all'), deleteData = has('delete-data');
if (!orgId) { console.log('Usage: node scripts/hand-over.mjs --org tis [--from a@x.com --to b@y.com] [--plan starter] [--sign-out-all] [--delete-data] [--apply]'); process.exit(1); }
if (!!from !== !!to) { console.log('--from and --to go together.'); process.exit(1); }
if (to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { console.log('--to is not a valid email.'); process.exit(1); }

// the live server must not be running (it would overwrite these changes from memory)
const port = Number(process.env.PORT || 4010);
if (await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)) {
  console.log(`A server is answering on port ${port}. Stop it first (sudo systemctl stop smartfill), then run this again.`); process.exit(1);
}

const DATA = process.env.DATA_DIR || path.join(here, 'data');
const store = await createStore({ dataDir: DATA, databaseUrl: process.env.STORE === 'file' ? null : process.env.DATABASE_URL, seed: {} });
const { state, save } = store;
console.log(`Store: ${store.backend}. ${apply ? 'APPLYING changes.' : 'Dry run: nothing is changed (add --apply).'}\n`);

const org = state.orgs[orgId];
if (!org) { console.log(`No organisation "${orgId}". Organisations: ${Object.keys(state.orgs).join(', ') || 'none'}`); await store.close(); process.exit(1); }
const problems = [], steps = [];

// 1. email
let user = null;
if (from) {
  user = Object.values(state.users).find(u => u.email === from);
  if (!user) problems.push(`No account with the email ${from}.`);
  else if (user.orgId !== orgId) problems.push(`${from} belongs to organisation "${user.orgId}", not "${orgId}".`);
  else if (Object.values(state.users).some(u => u.email === to && u.userId !== user.userId)) problems.push(`Another account already uses ${to}.`);
  else steps.push(`Account ${from} (${user.role}, "${user.name}") → email ${to}. Password unchanged.`);
}

// 2. plan
let plan = null;
if (planId) {
  const plans = state.meta.plans || DEFAULT_PLANS;
  plan = plans.find(p => p.id === planId) || plans.find(p => p.name.toLowerCase() === planId.toLowerCase());
  if (!plan) problems.push(`No plan "${planId}". Plans: ${plans.map(p => `${p.id} (${p.imagesPerMonth} photos, ${p.seats} seats)`).join(', ')}`);
  else steps.push(`Organisation "${org.name || orgId}": plan ${org.licence?.plan || '-'} (${org.licence?.imagesPerMonth ?? '-'} photos, ${org.licence?.seats ?? '-'} seats)`
    + ` → ${plan.id} (${plan.imagesPerMonth} photos, ${plan.seats} seats), this month's photo count reset. Expiry date kept: ${org.licence?.expiresAt || 'none'}.`);
}

// 3. sessions
const open = Object.values(state.sessions).filter(s => !s.revokedAt);
if (signOutAll) steps.push(`Sign out every account: ${open.length} open session${open.length === 1 ? '' : 's'} of ${new Set(open.map(s => s.userId)).size} account(s) ended.`);

// 4. data
const inOrg = d => (d?.orgId || DEFAULT_ORG) === orgId;
const doomed = {}, orders = new Set();
if (deleteData) {
  for (const c of ['snapshots', 'analyses', 'feedback', 'outcomes', 'batches', 'photoInsights']) {
    doomed[c] = Object.entries(state[c] || {}).filter(([, d]) => inOrg(d)).map(([id]) => id);
    for (const id of doomed[c]) { const d = state[c][id]; const o = c === 'snapshots' ? id : d.orderId; if (o != null) orders.add(String(o)); }
  }
  // photo folders: only orders no other organisation still has a record of
  const keep = new Set(['snapshots', 'analyses', 'photoInsights'].flatMap(c => Object.entries(state[c] || {}).filter(([, d]) => !inOrg(d)).map(([id, d]) => String(c === 'snapshots' ? id : d.orderId))));
  doomed.photoFolders = [...orders].filter(o => !keep.has(o) && existsSync(path.join(DATA, 'photos', o)));
  steps.push(`Delete organisation "${orgId}" review data: ` + Object.entries(doomed).map(([c, l]) => `${c} ${l.length}`).join(', ') + ` (orders: ${orders.size}).`);
}

if (problems.length) { console.log('Not done:\n- ' + problems.join('\n- ')); await store.close(); process.exit(1); }
if (!steps.length) { console.log('Nothing to do: give --from/--to, --plan, --sign-out-all or --delete-data.'); await store.close(); process.exit(1); }
console.log((apply ? 'Done:' : 'Would do:') + '\n- ' + steps.join('\n- '));
if (!apply) { await store.close(); process.exit(0); }

const now = new Date().toISOString();
if (user) { user.email = to; save('users', user.userId); }
if (plan) { org.licence = { ...(org.licence || {}), plan: plan.id, imagesPerMonth: plan.imagesPerMonth, seats: plan.seats, usageResetAt: now }; save('orgs', orgId); }
if (signOutAll) for (const s of open) { s.revokedAt = now; s.revokedReason = 'hand-over'; save('sessions', s.sessionId); }
if (deleteData) {
  for (const [c, ids] of Object.entries(doomed)) if (c !== 'photoFolders') for (const id of ids) { delete state[c][id]; save(c, id); }
  for (const o of doomed.photoFolders) rmSync(path.join(DATA, 'photos', o), { recursive: true, force: true });
}
await store.close();
await new Promise(r => setTimeout(r, 400));   // file store writes 150 ms after the last change
console.log('\nStart the service again: sudo systemctl start smartfill');
