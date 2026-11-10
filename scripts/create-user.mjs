// Create an account on a running backend (asks for the password, never prints it).
//   npm run create-user -- --email you@company.com --role admin
//   npm run create-user -- --email reviewer@tis.com --role customer --org tis --name "Ross"
// Authenticates with the developer token (works while ALLOW_DEV_TOKEN is not 0) or an admin access token in
// TISQC_TOKEN. In production without the developer token, create the first admin with ADMIN_EMAIL / ADMIN_PASSWORD
// in .env instead (created on start-up when no admin exists), then manage everyone from /dashboard.
import { createInterface } from 'node:readline';

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const base = arg('api') || process.env.TISQC_API || 'http://localhost:4010';
const token = process.env.TISQC_TOKEN || process.env.DEV_TOKEN || 'dev-token';
const email = arg('email'), role = arg('role') || 'customer', orgId = arg('org') || 'tis', name = arg('name');
if (!email) { console.log('Usage: npm run create-user -- --email you@company.com [--role admin|customer] [--org tis] [--name "Full name"]'); process.exit(1); }

function ask(q) {   // hidden input: echo stars instead of the password
  return new Promise(res => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => rl.output.write(s.includes(q) ? s : '*');
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); res(a); });
  });
}
const password = process.env.TISQC_PASSWORD || await ask(`Password for ${email} (min 10 characters, letters + a number): `);
const r = await fetch(base + '/v1/admin/users', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, role, orgId, name }) })
  .catch(e => ({ ok: false, json: async () => ({ error: { message: `Cannot reach ${base} (${e.message}). Is the backend running?` } }) }));
const j = await r.json();
if (!r.ok) { console.log('Not created:', j.error?.message || r.status); process.exit(1); }
console.log(`Created ${j.user.role} ${j.user.email} in organisation "${j.user.orgId}". Sign in at ${base}/dashboard or in the extension.`);
