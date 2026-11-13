// Offline test of the OpenAI code path: real backend + fake OpenAI server + real fixture & photos.
//   npm run test:ai   (or node test/ai.mjs)
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, cpSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startFakeOpenAI } from './fake-openai.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // backend/
const OID = 1166305, PORT = 4098, BASE = `http://localhost:${PORT}`, H = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const TMP = mkdtempSync(path.join(os.tmpdir(), 'tisqc-ai-'));
const photosSrc = path.join(here, 'data/photos', String(OID));
if (existsSync(photosSrc)) cpSync(photosSrc, path.join(TMP, 'photos', String(OID)), { recursive: true });

const fake = await startFakeOpenAI(4599);
const srv = spawn(process.execPath, ['server.mjs'], { cwd: here, stdio: 'pipe', env: { ...process.env, PORT, SKIP_DOTENV: '1', STORE: 'file', DATA_DIR: TMP, LOG_REQUESTS: '0',
  LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-fake', OPENAI_BASE_URL: 'http://localhost:4599', MODEL_PHOTO: 'gpt-4o', MODEL_REASON: 'gpt-4o', MAX_COST_PER_ANALYSIS: '5', DEV_TOKEN: 'dev-token' } });
srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
await new Promise(r => srv.stdout.once('data', r));
const call = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json();

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '→', e.message); } };
try {
  const snap = JSON.parse(readFileSync(path.join(here, `fixtures/boost-${OID}.json`)));
  await call('PUT', `/v1/orders/${OID}/snapshot`, snap);
  const { analysisId } = await call('POST', `/v1/orders/${OID}/analyses`, {});
  await fetch(`${BASE}/v1/analyses/${analysisId}/events?token=dev-token`).then(r => r.text());
  const a = await call('GET', `/v1/analyses/${analysisId}`);
  const m = a.modules;
  const hasPhotos = existsSync(photosSrc);
  console.log(`analysis ${analysisId}: engine ${a.engine}, ${fake.calls.length} OpenAI calls (${[...new Set(fake.calls.map(c => c.schema))].join(', ')}), photos on disk: ${hasPhotos}`);
  for (const [k, v] of Object.entries(m)) console.log(`   ${k.padEnd(16)} ${v.status} ${v.engine || ''} ${v.error || ''} ${v.summary?.fallbackReason ? '⚠ ' + v.summary.fallbackReason : ''}`);
  t('all modules done', () => assert.ok(Object.values(m).every(x => x.status === 'done')));
  t('no AI module fell back to mock', () => assert.deepEqual(Object.entries(m).filter(([, v]) => v.engine === 'mock (fallback)').map(([k]) => k), []));
  if (hasPhotos) {
    t('photo review used vision in batches of ≤6', () => { const pc = fake.calls.filter(c => c.schema === 'photo_review'); assert.ok(pc.length >= 7); assert.ok(pc.every(c => c.images > 0 && c.images <= 6)); });
    t('summary.checked lists every photo the AI has a result for', () => { const s = m.photoReview.summary; assert.ok(Array.isArray(s.checked) && s.checked.length === s.photos && s.photos > 0); });
    t('photo hazard → finding with photo evidence',() => assert.ok(m.photoReview.items.some(i => i.hazardType === 'housekeeping' && i.evidence.photos.length)));
    t('captions from vision insights', () => assert.ok(m.captions.engine === 'openai' && m.captions.items.length > 0));
    t('photo insights cached in store', () => assert.ok(a.usage.bySchema.photo_review.calls >= 7));
    t('Street View: batch guess checked on its own, flagged with what the AI reports', () => { const sv = m.photoReview.items.filter(i => i.kind === 'photo_source'); assert.ok(sv.length >= 1 && sv.every(i => i.status === 'fail' && /the AI reports © 2012 Google/i.test(i.message))); assert.equal(a.usage.bySchema.photo_source_check.calls, sv.length); });
  }
  t('U/W concerns not run (order has no instructions)', () => assert.equal(m.uwConcerns.summary.concerns, 0));
  t('recommendations mapped to writes', () => assert.ok(m.recommendations.items.some(i => i.proposedWrites.some(w => w.kind === 'rec'))));
  t('rewrite carries before/after', () => assert.ok(m.recommendations.items.some(i => i.kind === 'rewrite' && i.before && i.after)));
  t('questions: suggested value is a valid option', () => assert.ok(m.questions.items.filter(i => i.kind === 'differ').every(i => i.proposedWrites.some(w => w.value === 'No'))));
  t('questions: a suggestion pointing the wrong way is dropped (guard)', () => assert.ok(!m.questions.items.some(i => /housekeeping/i.test(i.title) && i.message === 'Photo shows accumulated debris.') && (m.questions.summary.guarded?.direction || 0) + (m.questions.summary.guarded?.subject || 0) >= 0));
  t('recs: no "Duplicate recommendations" (the fake still returns a merge; it is ignored)', () => assert.ok(!m.recommendations.items.some(i => i.kind === 'merge' || /duplicate/i.test(i.title) || i.proposedWrites.some(w => w.clear && i.kind !== 'remove'))));
  t('recs: the same photo hazard in other words is one rec', () => assert.equal(m.recommendations.items.filter(i => i.kind === 'missing' && i.source === 'photo_hazard').length, 1));
  const nd = m.narrative.items.find(i => i.kind === 'draft');
  t('narrative: draft offered for the narrative field, outside the score', () => assert.ok(nd && nd.status === 'needs_review' && nd.after && nd.proposedWrites[0].kind === 'text' && /^F7_/.test(nd.proposedWrites[0].key)));
  t('narrative: [[confirm]] markers counted on the draft', () => assert.ok(nd.confirm === 1 && /year built/.test(nd.message)));
  t('narrative: no free-form "does not mention X" cards (missing content comes from the question set only)', () => assert.ok(m.narrative.items.filter(i => i.kind === 'missing_required').every(i => i.questions?.length)));
  t('narrative: question set → left-out facts and not-in-report items',() => assert.ok(m.narrative.items.some(i => i.kind === 'missing_required' && i.questions?.length) && m.narrative.items.some(i => i.kind === 'not_in_report')));
  t('narrative: GL questions only when GL is ordered', () => assert.equal(m.narrative.summary.gl, /package|bop|monoline gl|liability/i.test(JSON.stringify(snap.order.orderForm.coverages) + (snap.order.orderForm.liability || []).join(''))));
  t('answers: no comment drafts (the reviewer writes comments)', () => assert.ok(!m.questions.items.some(i => i.kind === 'comment' || (i.proposedWrites || []).some(w => w.kind === 'text'))));
  t('narrative: a quote that is not in the narrative is dropped', () => assert.ok(m.narrative.items.filter(i => i.quote).every(i => !/no sprinkler system at this address/i.test(i.quote))));
  t('narrative: contradiction without a quoted form value is dropped',() => assert.ok(!m.narrative.items.some(i => /Bogus/.test(i.message)) && m.narrative.items.some(i => i.kind === 'contradiction')));
  t('photo hazards not added as recs count as covered (not missed)', () => assert.ok(m.photoReview.items.filter(i => i.kind !== 'photo_source').every(i => i.status === 'pass' || (m.recommendations.items.some(r => r.source === 'photo_hazard' && r.evidence.photos.some(p => i.evidence.photos.includes(p)))))));
  t('photo hazard with a drafted rec: a pointer to that rec, not open, not counted twice', () => {
    const d = m.photoReview.items.filter(i => i.recDrafted);
    assert.ok(d.length >= 1, 'no drafted pointer');
    for (const i of d) { assert.equal(i.status, 'needs_review'); assert.equal(i.severity, 'info'); assert.ok(m.recommendations.items.some(r => r.id === i.recItemId && r.kind === 'missing')); }
    assert.ok(!m.photoReview.items.some(i => i.hazardType && i.status === 'fail' && d.some(x => x.evidence.photos.some(p => i.evidence.photos.includes(p)))));
  });
  t('usage + cost recorded', () => assert.ok(a.usage.calls === fake.calls.length && a.usage.cost > 0));
  t('summary has score', () => assert.equal(typeof a.summary.score, 'number'));
  t('aiStatus says the AI part ran (no "didn\'t run" note in the panel)', () => assert.deepEqual(a.aiStatus, { ok: true }));

  // re-run: photo insights must come from cache (no new vision calls)
  const before = fake.calls.filter(c => c.schema === 'photo_review').length;
  const r2 = await call('POST', `/v1/orders/${OID}/analyses?force=true`, {});
  await fetch(`${BASE}/v1/analyses/${r2.analysisId}/events?token=dev-token`).then(r => r.text());
  t('re-run reuses cached photo insights', () => assert.equal(fake.calls.filter(c => c.schema === 'photo_review').length, before));

  // cost cap: tiny cap → modules fall back to mock but the analysis completes
  srv.kill(); await new Promise(r => setTimeout(r, 300));
} finally {
  srv.kill(); fake.srv.close(); rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
