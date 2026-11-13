// Local test server on :4010 with the real AI but NOT the shared Neon database.
//   node scripts/local-test.mjs            (or the "tis-backend-local-test" launch config)
// The hosted server uses the same Neon database, and two servers on it overwrite each other's in-memory view
// (CLAUDE.md), so this one keeps its data in a throwaway file store (data/local-test/, gitignored with data/).
// OPENAI_API_KEY and the model settings still come from .env. Sign in with the developer token (dev-token):
// set the extension's apiBase to http://localhost:4010 and token to dev-token (common/config.js), reload it.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env,
  PORT: '4010', STORE: 'file', DATABASE_URL: '', DATA_DIR: path.join(here, 'data', 'local-test'),
  BASE_PATH: '', DEV_TOKEN: 'dev-token', ALLOW_DEV_TOKEN: '1', ADMIN_EMAIL: '', ADMIN_PASSWORD: '' };
const srv = spawn(process.execPath, ['server.mjs'], { cwd: here, stdio: 'inherit', env });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => srv.kill());
srv.on('exit', code => process.exit(code ?? 0));
