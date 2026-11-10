// OpenAI list prices per 1M tokens (standard tier, ≤272K context).
// Source: https://developers.openai.com/api/docs/pricing, read 2026-10-29.
// Batch/Flex ≈ 50% of standard. Re-check before quoting to the customer.

export const PRICES = {
  'gpt-5.5':      { in: 5.00, cached: 0.50,  out: 30.00, image: 'patch', mult: 1.2 },
  'gpt-5.4':      { in: 2.50, cached: 0.25,  out: 15.00, image: 'patch', mult: 1.2 },
  'gpt-5.4-mini': { in: 0.75, cached: 0.075, out: 4.50,  image: 'patch', mult: 1.2 },
  'gpt-5.4-nano': { in: 0.20, cached: 0.02,  out: 1.25,  image: 'patch', mult: 1.2 },
  'gpt-5':        { in: 1.25, cached: 0.125, out: 10.00, image: 'tile', base: 70, tile: 140 },
  'gpt-5-mini':   { in: 0.25, cached: 0.025, out: 2.00,  image: 'patch', mult: 1.2 },
  'gpt-4.1':      { in: 2.00, cached: 0.50,  out: 8.00,  image: 'tile', base: 85, tile: 170 },
  'gpt-4.1-mini': { in: 0.40, cached: 0.10,  out: 1.60,  image: 'patch', mult: 1.62 },
  'gpt-4o':       { in: 2.50, cached: 1.25,  out: 10.00, image: 'tile', base: 85, tile: 170 },
  'gpt-4o-mini':  { in: 0.15, cached: 0.075, out: 0.60,  image: 'tile', base: 2833, tile: 5667 },
};

/** Image input tokens (OpenAI vision rules), detail 'high' unless 'low'. */
export function imageTokens(model, w = 841, h = 630, detail = 'high') {
  const p = PRICES[model];
  if (!p) throw new Error('unknown model ' + model);
  if (p.image === 'tile') {
    if (detail === 'low') return p.base;
    let W = w, H = h;
    const s1 = Math.min(1, 2048 / Math.max(W, H)); W *= s1; H *= s1;
    const s2 = Math.min(1, 768 / Math.min(W, H)); W *= s2; H *= s2;
    return p.base + Math.ceil(W / 512) * Math.ceil(H / 512) * p.tile;
  }
  // patch-based: fit within 2048 px max side, 2,500-patch budget ('high')
  let W = w, H = h;
  const s = Math.min(1, 2048 / Math.max(W, H)); W *= s; H *= s;
  let patches = Math.ceil(W / 32) * Math.ceil(H / 32);
  if (detail === 'low') { const s3 = Math.min(1, 512 / Math.max(W, H)); patches = Math.ceil(W * s3 / 32) * Math.ceil(H * s3 / 32); }
  if (patches > 2500) { const r = Math.sqrt(2500 / patches); patches = Math.ceil(W * r / 32) * Math.ceil(H * r / 32); }
  return Math.ceil(patches * p.mult);
}

export function dollars(model, { input = 0, cached = 0, output = 0 }, { batch = false } = {}) {
  const p = PRICES[model];
  const f = batch ? 0.5 : 1;
  return ((input - cached) * p.in + cached * p.cached + output * p.out) / 1e6 * f;
}
