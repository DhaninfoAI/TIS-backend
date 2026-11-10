// Photos of orders opened but never reviewed are removed after 24 h; everything else stays (lib/photo-sweep.mjs).
//   node test/photo-sweep.mjs     (temp folders only)
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { sweepUnreviewedPhotos } from '../lib/photo-sweep.mjs';

const H = 3600e3, NOW = Date.parse('2026-11-09T12:00:00Z');
const root = mkdtempSync(path.join(os.tmpdir(), 'tisqc-sweep-'));
const order = (oid, hoursAgo, files = 3) => {
  const dir = path.join(root, oid); mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) {
    const f = path.join(dir, `1844${i}.jpg`); writeFileSync(f, Buffer.alloc(1000, 0xff));
    const t = new Date(NOW - hoursAgo * H); utimesSync(f, t, t);
  }
};
order('1000001', 30);            // opened 30 h ago, never reviewed → removed
order('1000002', 5);             // uploaded 5 h ago, not reviewed yet → kept
order('1000003', 200);           // old, but reviewed → kept
order('1000004', 40);            // photos 40 h old, but the order was opened again 2 h ago → kept
order('1000005', 25, 0);         // empty folder, old → removed
mkdirSync(path.join(root, 'not-an-order'));   // anything that isn't an order folder is never touched
writeFileSync(path.join(root, 'notes.txt'), 'x');

const reviewed = new Set(['1000003']);
const opened = { 1000004: NOW - 2 * H };
const r = sweepUnreviewedPhotos({ root, now: NOW, isReviewed: o => reviewed.has(o), lastOpened: o => opened[o] || null });

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '→', e.message); } };
const gone = oid => !existsSync(path.join(root, oid));
console.log('photo sweep');
t('opened 30 h ago and never reviewed → photos removed', () => assert.ok(gone('1000001')));
t('the report says which order, how many files and bytes', () => assert.deepEqual(r.deleted.find(d => d.orderId === '1000001'), { orderId: '1000001', files: 3, bytes: 3000 }));
t('uploaded 5 h ago, not reviewed yet → kept', () => assert.ok(!gone('1000002')));
t('reviewed order → kept, however old', () => assert.ok(!gone('1000003')));
t('opened again 2 h ago (old photos) → kept', () => assert.ok(!gone('1000004')));
t('empty old folder of an unreviewed order → removed', () => assert.ok(gone('1000005')));
t('other folders and files are never touched', () => { assert.ok(existsSync(path.join(root, 'not-an-order'))); assert.ok(existsSync(path.join(root, 'notes.txt'))); });
t('counts: 2 removed, 3 kept', () => { assert.equal(r.deleted.length, 2); assert.equal(r.kept, 3); });
t('a missing photos folder is not an error', () => assert.deepEqual(sweepUnreviewedPhotos({ root: path.join(root, 'nope'), isReviewed: () => false, lastOpened: () => null }), { deleted: [], kept: 0 }));
t('running again changes nothing', () => assert.equal(sweepUnreviewedPhotos({ root, now: NOW, isReviewed: o => reviewed.has(o), lastOpened: o => opened[o] || null }).deleted.length, 0));

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
