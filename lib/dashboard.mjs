// Dashboard figures, computed from the store. Two views of the same data:
//   customer → their organisation's reviews, findings, decisions, inspectors, licence use (nothing technical)
//   admin    → everything above for every organisation, plus AI tokens, cost, models, fallbacks, users, licences
// The customer view is built without the technical fields (not hidden in the page), so they never leave the server.

import { DEFAULT_ORG } from './auth.mjs';
import { PLATFORMS } from './platforms.mjs';

const MOD_LABEL = { orderBrief: 'Order brief', checks: 'Logic checks', photoReview: 'Photo hazards', uwConcerns: 'Underwriter questions', recommendations: 'Recommendations',
  recPhotos: 'Rec photos', questions: 'Yes/No answers', captions: 'Photo names', narrative: 'Narrative', pricing: 'Pricing', priorReport: 'Prior report' };
const day = t => new Date(t).toISOString().slice(0, 10);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- one order in detail (the Orders tab drill-down)
const STEP = { ...MOD_LABEL, qcChecklist: 'QC checklist' };
const AI_STEP = { photo_review: 'Photo hazards', photo_source_check: 'Photo source check', uw_concerns: 'Underwriter questions', recommendations: 'Recommendations',
  rec_photos: 'Rec photos', questions: 'Yes/No answers', narrative: 'Narrative' };
const SEVERITY = { blocker: 'Must fix', warning: 'To check', advisory: 'Advisory', info: 'Note' };
const REASON = { not_a_hazard: 'Not a hazard', client_does_not_care: "Client doesn't need it", wrong_suggestion: 'Wrong suggestion', already_handled: 'Already handled', other: 'Other' };
const DECISION = { applied: 'Applied', dismissed: 'Dismissed', reverted: 'Undone', undone: 'Undone', 'not acted': 'Not acted on' };
// cards the panel never shows (forClient): the old narrative rewrite, comment findings
const shown = (k, i) => !(k === 'narrative' && i.kind === 'rewrite') && i.kind !== 'comment' && !String(i.id || '').startsWith('general.no_answer_needs_comment');

/** The latest review of one order with every finding and what the reviewer did with it. Customers: their own
 *  organisation's orders, nothing technical. Admins: any order, plus AI cost per step, models, fallbacks and every run.
 *  Returns null when the caller may not see a review of this order. */
export function buildOrderDetail(state, auth, orderId) {
  const admin = auth.role === 'admin', oid = String(orderId);
  const runs = Object.values(state.analyses).filter(a => String(a.orderId) === oid && a.status === 'done' && (admin || (a.orgId || DEFAULT_ORG) === auth.orgId))
    .sort((x, y) => (x.finishedAt || x.createdAt || '').localeCompare(y.finishedAt || y.createdAt || ''));
  const a = runs.at(-1); if (!a) return null;
  const snap = state.snapshots[oid]?.snapshot || {}, order = snap.order || {};
  const userName = id => id === 'dev' ? 'Developer' : state.users[id]?.name || '—';
  // what the reviewer did: the panel's events in order (the last one wins), then the saved QC outcome if there is one
  const did = {};
  for (const f of Object.values(state.feedback).filter(f => f.analysisId === a.analysisId).sort((x, y) => (x.receivedAt || '').localeCompare(y.receivedAt || '')))
    for (const i of f.items || []) did[i.itemId] = { decision: i.decision, reason: i.reason || null, at: f.receivedAt };
  for (const o of Object.values(state.outcomes || {}).filter(o => o.analysisId === a.analysisId).sort((x, y) => (x.at || '').localeCompare(y.at || '')))
    for (const i of o.items || []) if (i.decision !== 'not acted' || !did[i.itemId]) did[i.itemId] = { decision: i.decision, reason: i.reason || null, at: o.at };
  const findings = Object.entries(a.modules || {}).filter(([k]) => MOD_LABEL[k]).flatMap(([k, m]) => (m.items || [])
    .filter(i => i.status === 'fail' && shown(k, i)).map(i => {
      const d = did[i.id] || {};
      return { id: i.id, area: MOD_LABEL[k], severity: SEVERITY[i.severity] || i.severity, title: String(i.title || '').slice(0, 200), message: String(i.message || '').slice(0, 600),
        decision: DECISION[d.decision] || 'Not acted on', reason: d.reason ? REASON[d.reason] || d.reason : null, decidedAt: d.at || null, photos: (i.evidence?.photos || []).length };
    }))
    .sort((x, y) => ['Must fix', 'To check', 'Advisory', 'Note'].indexOf(x.severity) - ['Must fix', 'To check', 'Advisory', 'Note'].indexOf(y.severity));
  const pr = a.modules?.photoReview?.summary || {}, total = (snap.photos || []).length;
  const checked = Array.isArray(pr.checked) ? pr.checked.length : pr.vision ? pr.photos ?? null : 0;
  const count = d => findings.filter(f => f.decision === d).length;
  const took = a.finishedAt && a.createdAt ? Math.round((Date.parse(a.finishedAt) - Date.parse(a.createdAt)) / 1000) : null;
  const out = {
    orderId: Number(oid), insured: order.insured || '', location: order.location || '', client: order.client || '', inspector: order.inspector || '',
    request: order.orderForm?.requestType || '', coverage: [...(order.orderForm?.coverages || []), ...(order.orderForm?.liability || [])].join(', '),
    reviewedAt: a.finishedAt || a.createdAt, reviewer: userName(a.userId), seconds: took, reviews: runs.length,
    photos: { total, checkedByAi: checked },
    // a plain "the AI part didn't run" (the panel says the same); which engine, and why, is for admins below
    aiDidNotRun: Object.entries(a.modules || {}).filter(([, m]) => m.aiFailed).map(([k]) => MOD_LABEL[k] || k),
    counts: { findings: findings.length, mustFix: findings.filter(f => f.severity === 'Must fix').length, applied: count('Applied'), dismissed: count('Dismissed'), undone: count('Undone'), notActed: count('Not acted on') },
    findings,
  };
  if (!admin) return out;
  const u = a.usage || {};
  out.ai = { analysisId: a.analysisId, orgId: a.orgId || DEFAULT_ORG, cost: round(u.cost || 0, 4), calls: u.calls || 0, tokens: { input: u.input || 0, cached: u.cached || 0, output: u.output || 0 },
    models: a.models ? `${a.models.photo} / ${a.models.reason}` : '', photosLookedAt: pr.analysed ?? null, photosReused: pr.cached ?? null,
    byStep: Object.entries(u.bySchema || {}).map(([step, v]) => ({ step: AI_STEP[step] || step, calls: v.calls, cost: round(v.cost, 4) })).sort((x, y) => y.cost - x.cost),
    steps: Object.entries(a.modules || {}).map(([k, m]) => ({ step: STEP[k] || k, engine: m.engine || m.status, fallback: m.summary?.fallbackReason || m.error || null, aiFailed: m.aiFailed || null })),
    runs: runs.map(r => ({ analysisId: r.analysisId, at: r.finishedAt || r.createdAt, reviewer: userName(r.userId), cost: round(r.usage?.cost || 0, 4),
      seconds: r.finishedAt && r.createdAt ? Math.round((Date.parse(r.finishedAt) - Date.parse(r.createdAt)) / 1000) : null })).reverse() };
  return out;
}

export function buildDashboard(state, auth, { orgId, from, to, auth: A }) {
  const admin = auth.role === 'admin';
  const scopeOrg = admin ? (orgId || null) : auth.orgId;              // admin: all orgs unless one is picked
  const t0 = from ? Date.parse(from) : Date.now() - 30 * 864e5, t1 = to ? Date.parse(to) + 864e5 : Date.now() + 1;
  const inOrg = x => !scopeOrg || (x.orgId || DEFAULT_ORG) === scopeOrg;
  const done = Object.values(state.analyses).filter(a => a.status === 'done' && inOrg(a));
  const inRange = done.filter(a => { const t = Date.parse(a.finishedAt || a.createdAt); return t >= t0 && t < t1; });
  // the last review of each order is "the" review; earlier ones are re-runs
  const latest = new Map(); for (const a of inRange.sort((x, y) => (x.finishedAt || '').localeCompare(y.finishedAt || ''))) latest.set(String(a.orderId), a);
  const reviews = [...latest.values()];
  const fb = Object.values(state.feedback).filter(f => inOrg(f) || latest.get(String(f.orderId)));
  const decisions = id => { const out = { applied: 0, dismissed: 0, reverted: 0 }; for (const f of fb) if (f.analysisId === id) for (const i of f.items || []) if (out[i.decision] != null) out[i.decision]++; return out; };
  const open = i => i.status === 'fail' && i.severity !== 'info';
  const findings = a => Object.entries(a.modules || {}).filter(([k]) => MOD_LABEL[k] && k !== 'captions').flatMap(([k, m]) => (m.items || []).filter(open).map(i => ({ ...i, module: k })));
  const userName = id => id === 'dev' ? 'Developer' : state.users[id]?.name || '—';

  let mustFix = 0, toCheck = 0, advisory = 0, hazards = 0, applied = 0, dismissed = 0, secs = [];
  const byModule = {}, issues = {}, inspectors = {}, perDay = {};
  const orders = reviews.map(a => {
    const f = findings(a), d = decisions(a.analysisId), snap = state.snapshots[a.orderId]?.snapshot?.order || {};
    const s = { mustFix: f.filter(i => i.severity === 'blocker').length, toCheck: f.filter(i => i.severity === 'warning').length, advisory: f.filter(i => i.severity === 'advisory').length,
      hazards: (a.modules?.photoReview?.items || []).filter(i => i.hazardType && (open(i) || i.recDrafted)).length };
    mustFix += s.mustFix; toCheck += s.toCheck; advisory += s.advisory; hazards += s.hazards; applied += d.applied; dismissed += d.dismissed;
    const took = a.finishedAt && a.createdAt ? (Date.parse(a.finishedAt) - Date.parse(a.createdAt)) / 1000 : null; if (took != null) secs.push(took);
    for (const i of f) {
      const m = (byModule[i.module] ||= { module: MOD_LABEL[i.module], findings: 0, mustFix: 0 }); m.findings++; if (i.severity === 'blocker') m.mustFix++;
      const key = `${i.module}|${String(i.title || '').replace(/\s+/g, ' ').slice(0, 90)}`; (issues[key] ||= { area: MOD_LABEL[i.module], title: String(i.title || '').slice(0, 90), orders: new Set() }).orders.add(String(a.orderId));
    }
    const insp = snap.inspector || 'Unknown inspector';
    const ins = (inspectors[insp] ||= { inspector: insp, orders: 0, mustFix: 0, ratings: [] }); ins.orders++; ins.mustFix += s.mustFix; if (a.summary?.rating != null) ins.ratings.push(a.summary.rating);
    const dd = day(a.finishedAt || a.createdAt); (perDay[dd] ||= { date: dd, orders: 0, cost: 0 }).orders++;
    const row = { orderId: a.orderId, insured: snap.insured || '', location: snap.location || '', client: snap.client || '', reviewedAt: a.finishedAt, reviewer: userName(a.userId),
      ...s, applied: d.applied, dismissed: d.dismissed, seconds: took != null ? Math.round(took) : null, rating: a.summary?.rating ?? null };
    if (!scopeOrg && admin) row.orgId = a.orgId || DEFAULT_ORG;
    return row;
  }).sort((x, y) => (y.reviewedAt || '').localeCompare(x.reviewedAt || ''));

  const days = []; for (let t = t0; t < Math.min(t1, Date.now() + 1); t += 864e5) { const dd = day(t); days.push(perDay[dd] || { date: dd, orders: 0, cost: 0 }); }
  const decided = applied + dismissed;
  const out = {
    view: admin ? 'admin' : 'customer', period: { from: day(t0), to: day(Math.min(t1, Date.now()) - 1) },
    totals: { ordersReviewed: reviews.length, reviewsRun: inRange.length, mustFix, toCheck, advisory, hazardsFound: hazards, fixesApplied: applied, dismissed,
      acceptance: decided ? round(applied / decided * 100, 0) : null, avgReviewSeconds: secs.length ? Math.round(secs.reduce((x, y) => x + y, 0) / secs.length) : null,
      // photos the AI reviewed for the first time in the period (what the plan meters)
      photosReviewed: new Set(Object.values(state.photoInsights || {}).filter(i => inOrg(i) && (t => t >= t0 && t < t1)(Date.parse(i.firstAt || i.at))).map(i => `${i.orderId || ''}:${i.imageId}`)).size },
    byDay: days.map(d => ({ date: d.date, orders: d.orders })),
    byArea: Object.values(byModule).sort((x, y) => y.findings - x.findings),
    topIssues: Object.values(issues).map(i => ({ area: i.area, title: i.title, orders: i.orders.size })).sort((x, y) => y.orders - x.orders).slice(0, 10),
    inspectors: Object.values(inspectors).map(i => ({ inspector: i.inspector, orders: i.orders, mustFixPerOrder: round(i.mustFix / i.orders, 1), avgRating: i.ratings.length ? round(i.ratings.reduce((x, y) => x + y, 0) / i.ratings.length, 1) : null }))
      .sort((x, y) => y.orders - x.orders),
    orders,
  };
  const orgIds = scopeOrg ? [scopeOrg] : Object.keys(state.orgs);
  const users = Object.values(state.users).filter(u => orgIds.includes(u.orgId));
  if (!admin) {
    const o = A.org(auth.orgId);
    out.licence = o && { organisation: o.name, plan: A.planById(o.licence?.plan)?.name || o.licence?.plan, seats: o.licence?.seats, seatsUsed: A.seatsUsed(o.orgId),
      imagesPerMonth: o.licence?.imagesPerMonth || null, imagesThisMonth: A.imagesThisMonth(o.orgId), ordersThisMonth: A.ordersThisMonth(o.orgId), expiresAt: o.licence?.expiresAt || null, seatIdleHours: A.seatIdleHours };
    out.team = users.filter(u => u.role === 'customer').map(u => ({ name: u.name, email: u.email, status: u.status, lastLoginAt: u.lastLoginAt || null }));
    out.devices = A.devices(auth.orgId).map(({ orgId, orgName, ...d }) => d);   // computers using a seat; Sign out frees one
    return out;
  }

  // ---------------------------------------------------------------- admin only: AI usage and cost, every organisation
  const sum = list => list.reduce((t, a) => { const u = a.usage || {}; t.cost += u.cost || 0; t.input += u.input || 0; t.cached += u.cached || 0; t.output += u.output || 0; t.calls += u.calls || 0;
    for (const [m, v] of Object.entries(u.byModel || {})) { const x = (t.byModel[m] ||= { model: m, calls: 0, input: 0, output: 0, cost: 0 }); x.calls += v.calls; x.input += v.input; x.output += v.output; x.cost += v.cost; }
    for (const [s, v] of Object.entries(u.bySchema || {})) { const x = (t.byStep[s] ||= { step: s, calls: 0, cost: 0 }); x.calls += v.calls; x.cost += v.cost; }
    return t; }, { cost: 0, input: 0, cached: 0, output: 0, calls: 0, byModel: {}, byStep: {} });
  const all = sum(inRange);
  for (const a of inRange) { const dd = day(a.finishedAt || a.createdAt); const d = out.byDay.find(x => x.date === dd); if (d) d.cost = round((d.cost || 0) + (a.usage?.cost || 0), 4); }
  const fallbacks = inRange.flatMap(a => Object.entries(a.modules || {}).filter(([, m]) => /fallback/.test(m.engine || '') || m.status === 'error').map(([k, m]) => ({ orderId: a.orderId, step: k, engine: m.engine || m.status, note: m.summary?.fallbackReason || m.error || '' })));
  out.ai = { cost: round(all.cost, 4), costPerOrder: reviews.length ? round(all.cost / reviews.length, 4) : null, costPerReview: inRange.length ? round(all.cost / inRange.length, 4) : null,
    tokens: { input: all.input, cached: all.cached, output: all.output }, calls: all.calls,
    byModel: Object.values(all.byModel).map(m => ({ ...m, cost: round(m.cost, 4) })).sort((x, y) => y.cost - x.cost),
    byStep: Object.values(all.byStep).map(s => ({ ...s, cost: round(s.cost, 4) })).sort((x, y) => y.cost - x.cost),
    fallbacks: fallbacks.slice(0, 50), engines: [...new Set(inRange.map(a => a.engine))] };
  const costOf = id => latest.get(String(id))?.usage || {};
  for (const r of out.orders) { const u = costOf(r.orderId), a = latest.get(String(r.orderId));
    Object.assign(r, { cost: round(u.cost || 0, 4), tokensIn: u.input || 0, tokensOut: u.output || 0, calls: u.calls || 0, engine: a?.engine, models: a?.models ? `${a.models.photo} / ${a.models.reason}` : '', reruns: inRange.filter(x => String(x.orderId) === String(r.orderId)).length - 1 }); }
  out.orgs = Object.values(state.orgs).map(o => { const list = done.filter(a => (a.orgId || DEFAULT_ORG) === o.orgId); const mStart = new Date(); mStart.setUTCDate(1); mStart.setUTCHours(0, 0, 0, 0);
    return { ...A.publicOrg(o), costThisMonth: round(sum(list.filter(a => Date.parse(a.createdAt) >= mStart.getTime())).cost, 4), costInPeriod: round(sum(list.filter(a => inRange.includes(a))).cost, 4) }; });
  out.plans = A.plans(); out.platforms = Object.values(PLATFORMS);
  out.devices = A.devices(scopeOrg); out.seatIdleHours = A.seatIdleHours;
  out.users = Object.values(state.users).map(u => ({ ...A.publicUser(u), computers: out.devices.filter(d => d.user.email === u.email).length }));
  return out;
}
