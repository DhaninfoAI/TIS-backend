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
