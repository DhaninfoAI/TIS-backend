// Persistence: an in-memory working set, written through to Postgres (Neon) when
// DATABASE_URL is set, else to data/state.json. One table holds every collection as JSONB:
//   tisqc_docs(collection, id, data, updated_at)
// Collections: snapshots, analyses, feedback, outcomes, batches, photoInsights, meta, orgs, users, sessions.
// The working set is small (orders under QC), so everything is loaded at startup.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const COLLECTIONS = ['snapshots', 'analyses', 'feedback', 'outcomes', 'batches', 'photoInsights', 'meta', 'orgs', 'users', 'sessions'];

export async function createStore({ dataDir, databaseUrl, seed }) {
  const state = Object.fromEntries(COLLECTIONS.map(c => [c, {}]));
  let pool = null, backend = 'file';
  const file = path.join(dataDir, 'state.json');
  mkdirSync(dataDir, { recursive: true });

  if (databaseUrl) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: databaseUrl.replace(/sslmode=require/, 'sslmode=verify-full'), max: 4, idleTimeoutMillis: 30000 });
    pool.on('error', e => console.error('[db] pool error:', e.message));
    await pool.query(`create table if not exists tisqc_docs (
      collection text not null, id text not null, data jsonb not null,
      updated_at timestamptz not null default now(), primary key (collection, id))`);
    const { rows } = await pool.query('select collection, id, data from tisqc_docs');
    for (const r of rows) if (state[r.collection]) state[r.collection][r.id] = r.data;
    backend = 'postgres';
  } else if (existsSync(file)) {
    Object.assign(state, JSON.parse(readFileSync(file, 'utf8')));
  }

  // first run: seed meta docs (rules store, rule docs, hazard library)
  for (const [id, value] of Object.entries(seed.meta || {})) if (!state.meta[id]) state.meta[id] = value;

  let fileTimer = null;
  const pending = new Map();   // collection:id -> value, coalesced writes
  let flushing = null;

  async function flush() {
    if (!pool) return;
    while (pending.size) {
      const batch = [...pending.entries()]; pending.clear();
      for (const [key, value] of batch) {
        const i = key.indexOf(':'); const collection = key.slice(0, i), id = key.slice(i + 1);
        try {
          if (value === undefined) await pool.query('delete from tisqc_docs where collection=$1 and id=$2', [collection, id]);
          else await pool.query(`insert into tisqc_docs (collection, id, data, updated_at) values ($1,$2,$3,now())
            on conflict (collection, id) do update set data=excluded.data, updated_at=now()`, [collection, id, JSON.stringify(value)]);
        } catch (e) { console.error(`[db] write ${key} failed:`, e.message); }
      }
    }
  }

  /** Persist one document (call after mutating state[collection][id]). */
  function save(collection, id) {
    if (pool) {
      pending.set(`${collection}:${id}`, state[collection][id]);
      flushing = flushing || setTimeout(() => { flushing = null; flush(); }, 150);
    } else {
      clearTimeout(fileTimer);
      fileTimer = setTimeout(() => writeFileSync(file, JSON.stringify(state)), 150);
    }
  }

  async function close() { clearTimeout(flushing); await flush(); await pool?.end(); }

  for (const c of COLLECTIONS) if (!state[c]) state[c] = {};
  return { state, save, close, backend, counts: () => Object.fromEntries(COLLECTIONS.map(c => [c, Object.keys(state[c]).length])) };
}
