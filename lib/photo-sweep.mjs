// Photos of orders that were opened but never reviewed (decided 2026-11-09).
// Opening an order uploads its photos so Run AI review starts quickly; if nobody presses Run, those files would stay
// on the server for good. This removes an order's photo folder when the order has no review at all and nobody has
// opened it for `maxAgeMs` (default 24 h). Reviewed orders keep their photos. If the order is opened again later,
// its photos are simply uploaded again.

import { readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * root:        the photos folder (one sub-folder per order number)
 * isReviewed:  orderId → true when the order has any review (finished, running or queued)
 * lastOpened:  orderId → time in ms the order was last read from EZ (its snapshot), or null
 * Returns { deleted: [{ orderId, files, bytes }], kept }.
 */
export function sweepUnreviewedPhotos({ root, isReviewed, lastOpened, maxAgeMs = 24 * 3600e3, now = Date.now() }) {
  const out = { deleted: [], kept: 0 };
  let orders = [];
  try { orders = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d+$/.test(d.name)).map(d => d.name); } catch { return out; }
  for (const oid of orders) {
    if (isReviewed(oid)) { out.kept++; continue; }
    const dir = path.join(root, oid);
    let files = [];
    try { files = readdirSync(dir).map(f => statSync(path.join(dir, f))).filter(s => s.isFile()); } catch { continue; }
    // the latest sign of use: the last photo uploaded, or the last time the order was opened
    const last = Math.max(0, ...files.map(s => s.mtimeMs), lastOpened(oid) || 0);
    if (now - last < maxAgeMs) { out.kept++; continue; }
    try {
      rmSync(dir, { recursive: true, force: true });
      out.deleted.push({ orderId: oid, files: files.length, bytes: files.reduce((a, s) => a + s.size, 0) });
    } catch { out.kept++; }
  }
  return out;
}
