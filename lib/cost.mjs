// Token + dollar estimate for running the full AI pipeline on one order.
// Mirrors the call plan used by lib/modules.mjs in OpenAI mode.

import { PRICES, imageTokens, dollars } from './pricing.mjs';
import { rulesPack, hazardPack } from './kb.mjs';

const tok = s => Math.ceil(String(s || '').length / 4);   // ~4 chars/token for English (o200k)

/** Compact text form of the order that LLM modules receive (answered + required-blank fields only). */
export function compactSnapshot(snap) {
  const L = [];
  const o = snap.order || {}, of = o.orderForm || {};
  L.push(`ORDER ${o.orderId} | client: ${o.client} | ${o.location} | request: ${of.requestType || '-'} | coverage: ${(of.coverages || []).join(', ')} | liability: ${(of.liability || []).join(', ') || 'none'} | photos required: ${of.photosRequired} | diagram required: ${of.diagramRequired} | NOB: ${of.natureOfBusiness || '-'}`);
  if (of.additionalInstructions) L.push(`UNDERWRITER INSTRUCTIONS: ${of.additionalInstructions}`);
  for (const f of snap.forms || []) {
    L.push(`\n## FORM ${f.name}`);
    for (const s of f.sections || []) {
      if (s.omitted) { L.push(`### ${s.title} [OMITTED]`); continue; }
      L.push(`### ${s.title}${s.internal ? ' [internal]' : ''}`);
      for (const x of s.fields || []) {
        const v = String(x.value ?? '').trim(), c = String(x.comment?.value ?? '').trim(), r = String(x.rec?.text ?? '').trim();
        if (!v && !c && !r && !x.required) continue;
        L.push(`- [${x.key}] ${x.label}${x.options ? ` {${x.options.join('/')}}` : ''} = ${v || '(blank)'}${c ? ` | comment: ${c}` : ''}${r ? ` | REC: ${r}` : ''}`);
      }
    }
  }
  if ((snap.recommendations || []).length) {
    L.push('\n## RECOMMENDATIONS');
    for (const r of snap.recommendations) L.push(`- [${r.key}] ${r.number || ''} ${r.text} | photo: ${r.imageOptionValue || 'none'}`);
  }
  if ((snap.photos || []).length) {
    L.push('\n## PHOTOS');
    for (const p of snap.photos) L.push(`- ${p.imageId}: ${p.caption}${p.markedHazard ? ' [marked hazard]' : ''}`);
  }
  return L.join('\n');
}

export const PLAN = {
  photosPerCall: 6, photoSystemTokens: 700, photoOutputPerPhoto: 180, insightTokensPerPhoto: 110,
  reasonSystemTokens: 900,
  modules: { uwConcerns: 700, recommendations: 2200, questions: 2500, captions: 25 /* per photo */, narrative: 1400, qcChecklist: 1100 },
  reasoningFactor: { 'gpt-5.5': 1.0, 'gpt-5.4': 1.0, 'gpt-5.4-mini': 1.0, 'gpt-5.4-nano': 1.0, 'gpt-5': 1.0, 'gpt-5-mini': 1.0 },  // extra hidden reasoning tokens per output token (effort=low)
};

export function estimate(snap, { photoModel = 'gpt-4o', reasonModel = 'gpt-4o', batch = false, photoCount, detail = 'high', snapshotTokens } = {}) {
  for (const m of [photoModel, reasonModel]) if (!PRICES[m]) throw new Error('unknown model ' + m);
  const nPhotos = photoCount ?? Math.max((snap.photos || []).length, snap.order?.counts?.photos || 0);
  const hz = hazardPack(), rp = rulesPack(snap), compact = compactSnapshot(snap);
  const caching = m => m !== 'gpt-4o-mini' || true;   // OpenAI caches identical prefixes ≥1024 tokens automatically

  // 1) per-photo vision pass
  const calls = Math.ceil(nPhotos / PLAN.photosPerCall);
  const prefix = PLAN.photoSystemTokens + hz.approxTokens + 300;     // + client sensitivity
  const imgTok = imageTokens(photoModel, 841, 630, detail);
  const pIn = calls * prefix + nPhotos * (imgTok + 40);
  const pCached = caching(photoModel) && calls > 1 ? (calls - 1) * prefix : 0;
  const pOutVisible = nPhotos * PLAN.photoOutputPerPhoto;
  const pOut = Math.round(pOutVisible * (1 + (PLAN.reasoningFactor[photoModel] || 0)));
  const photo = { model: photoModel, calls, imageTokensEach: imgTok, input: pIn, cached: pCached, output: pOut };
  photo.cost = dollars(photoModel, photo, { batch });

  // 2) order-level reasoning modules sharing one cached prefix
  const snapTok = snapshotTokens ?? tok(compact);
  const shared = PLAN.reasonSystemTokens + rp.approxTokens + snapTok + nPhotos * PLAN.insightTokensPerPhoto;
  const mods = Object.entries(PLAN.modules).map(([name, out]) => [name, name === 'captions' ? out * nPhotos : out]);
  const rIn = mods.length * (shared + 400);
  const rCached = caching(reasonModel) ? (mods.length - 1) * shared : 0;
  const rOutVisible = mods.reduce((a, [, o]) => a + o, 0);
  const rOut = Math.round(rOutVisible * (1 + (PLAN.reasoningFactor[reasonModel] || 0)));
  const reason = { model: reasonModel, calls: mods.length, input: rIn, cached: rCached, output: rOut, modules: Object.fromEntries(mods) };
  reason.cost = dollars(reasonModel, reason, { batch });

  const total = photo.cost + reason.cost;
  return {
    orderId: snap.order?.orderId, photos: nPhotos, batch,
    context: { rulesPackTokens: rp.approxTokens, hazardPackTokens: hz.approxTokens, snapshotTokens: snapTok, client: rp.clientKey, formsWithRules: rp.formsUsed },
    photo, reason,
    total: Math.round(total * 10000) / 10000,
    perPhoto: nPhotos ? Math.round(photo.cost / nPhotos * 100000) / 100000 : 0,
    assumptions: 'chars/4 token estimate; prompt caching on shared prefixes; reasoning models at low effort (hidden reasoning ≈ visible output). Validate with real usage (LLM_PROVIDER=openai) before quoting.',
  };
}
