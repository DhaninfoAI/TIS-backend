// Run the full analysis on the 6 Boost AI sandbox orders against a running backend and write a report.
//   npm run eval                 (backend must be running: npm start)
//   node scripts/eval.mjs --force --orders 1166305,1166310
// Uses whatever engine the backend is configured with (OpenAI when the key is set). Photos are analysed
// for orders whose photos were uploaded (open the order in EZ and press Analyze once in the extension).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const env = Object.fromEntries((existsSync(path.join(root, '.env')) ? readFileSync(path.join(root, '.env'), 'utf8') : '').split(/\r?\n/).map(l => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(m => [m[1], m[2]]));
const BASE = process.env.API_BASE || `http://localhost:${env.PORT || 4010}`;
const H = { Authorization: `Bearer ${env.DEV_TOKEN || 'dev-token'}`, 'Content-Type': 'application/json' };
const args = process.argv.slice(2);
const force = args.includes('--force');
const orders = (args[args.indexOf('--orders') + 1] && args.includes('--orders') ? args[args.indexOf('--orders') + 1].split(',') : null)
  || readdirSync(path.join(root, 'fixtures')).filter(f => /^boost-\d+\.json$/.test(f)).map(f => f.match(/\d+/)[0]);

const api = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error?.message || r.status}`); return j; };

const health = await api('GET', '/v1/health').catch(e => { console.error(`Backend not reachable at ${BASE}. Start it with: npm start\n${e.message}`); process.exit(1); });
console.log(`Backend: engine ${health.engine}${health.models ? ` (${health.models.photo} / ${health.models.reason})` : ''}, store ${health.store}, cost cap $${health.costCap}/analysis\n`);

const rows = [], details = [];
for (const oid of orders) {
  const snap = JSON.parse(readFileSync(path.join(root, 'fixtures', `boost-${oid}.json`), 'utf8'));
  // keep the latest snapshot from the extension if it is newer (e.g. it has photos uploaded with it)
  const existing = await api('GET', `/v1/orders/${oid}/snapshot`).catch(() => null);
  if (!existing) await api('PUT', `/v1/orders/${oid}/snapshot`, snap);
  const t0 = Date.now();
  const run = await api('POST', `/v1/orders/${oid}/analyses${force ? '?force=true' : ''}`, {});
  process.stdout.write(`${oid}: ${run.cached ? 'cached' : 'running'}… `);
  if (!run.cached) await fetch(`${BASE}/v1/analyses/${run.analysisId}/events`).then(r => r.text());
  const a = await api('GET', `/v1/analyses/${run.analysisId}`);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const fails = Object.entries(a.modules).filter(([k]) => k !== 'qcChecklist').flatMap(([k, m]) => (m.items || []).filter(i => i.status === 'fail').map(i => ({ ...i, module: k })));
  const fallbacks = Object.entries(a.modules).filter(([, m]) => /fallback/.test(m.engine || '')).map(([k, m]) => `${k}: ${m.summary?.fallbackReason}`);
  console.log(`${secs}s, score ${a.summary.score}, ${a.summary.blockers} blockers, $${a.usage?.cost ?? 0}`);
  const pr = a.modules.photoReview?.summary || {};
  rows.push({ oid, client: snap.order.client, photos: a.modules.photoReview?.engine === 'openai' ? `${pr.photos}/${snap.photos.length}` : `0/${snap.photos.length}`, score: a.summary.score, blockers: a.summary.blockers, warnings: a.summary.warnings,
    advisories: a.summary.advisories, missed: a.summary.hazardsMissed, recsAdded: (a.modules.recommendations?.items || []).filter(i => i.kind === 'missing').length,
    renames: a.modules.captions?.items?.length || 0, cost: a.usage?.cost ?? 0, calls: a.usage?.calls ?? 0, secs, engine: a.engine, fallbacks });
  details.push({ oid, a, fails });
}

const md = [];
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
md.push(`# TIS SmartFill: evaluation on Boost AI sandbox orders`, '', `Run ${new Date().toISOString()} · engine **${health.engine}**${health.models ? ` (${health.models.photo} / ${health.models.reason})` : ''} · pipeline ${health.pipelineVersion} · rules v${health.rulesVersion}`, '');
md.push('| Order | Photos analysed | Score | Blockers | Warnings | Advisories | Missed hazards | Recs suggested | Renames | Time | OpenAI calls | Cost |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) md.push(`| ${r.oid} | ${r.photos} | ${r.score} | ${r.blockers} | ${r.warnings} | ${r.advisories} | ${r.missed} | ${r.recsAdded} | ${r.renames} | ${r.secs}s | ${r.calls} | $${r.cost.toFixed(3)} |`);
const total = rows.reduce((s, r) => s + r.cost, 0);
md.push('', `**Total cost: $${total.toFixed(3)}** · average $${(total / rows.length).toFixed(3)} per order.`, '');
if (rows.some(r => r.fallbacks.length)) md.push('## AI fallbacks', '', ...rows.filter(r => r.fallbacks.length).map(r => `- ${r.oid}: ${r.fallbacks.join('; ')}`), '');
for (const { oid, a, fails } of details) {
  md.push(`## Order ${oid}`, '');
  const order = ['blocker', 'warning', 'advisory'];
  for (const s of order) {
    const list = fails.filter(i => i.severity === s);
    if (!list.length) continue;
    md.push(`**${s} (${list.length})**`, '');
    for (const i of list.slice(0, 25)) md.push(`- _${i.module}_: ${i.title}${i.message && i.message !== i.title ? `. ${String(i.message).slice(0, 220)}` : ''}${i.after ? `\n  - suggested: “${String(i.after).slice(0, 220)}”` : ''}${i.evidence?.photos?.length ? ` (photos ${i.evidence.photos.join(', ')})` : ''}`);
    md.push('');
  }
  const n = a.modules.narrative?.items?.find(i => i.kind === 'rewrite');
  if (n) md.push('<details><summary>Narrative rewrite</summary>', '', n.after, '', '</details>', '');
}
mkdirSync(path.join(root, 'reports'), { recursive: true });
const file = path.join(root, 'reports', `eval-${stamp}.md`);
writeFileSync(file, md.join('\n'));
writeFileSync(file.replace(/\.md$/, '.json'), JSON.stringify({ health, rows, analyses: details.map(d => d.a) }, null, 1));
console.log(`\nTotal $${total.toFixed(3)}. Report: ${path.relative(process.cwd(), file)}`);
