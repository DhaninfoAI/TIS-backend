// OpenAI client: structured outputs, usage + $ tracking, per-analysis cost cap, retries.
// Off (mock mode) unless LLM_PROVIDER=openai and OPENAI_API_KEY are set in backend/.env.

import { dollars, PRICES } from './pricing.mjs';

export const provider = () => (process.env.LLM_PROVIDER || 'mock').toLowerCase();
export const enabled = () => provider() === 'openai' && !!(process.env.OPENAI_API_KEY || '').trim();

export const MODELS = {
  photo: () => process.env.MODEL_PHOTO || 'gpt-4o',
  reason: () => process.env.MODEL_REASON || 'gpt-4o',
};

export class CostCapError extends Error {}

/** Budget shared by all calls of one analysis. */
export function budget() {
  const cap = Number(process.env.MAX_COST_PER_ANALYSIS || 2);
  return { cap, spent: 0, usage: [] };
}

/**
 * One structured-output call.
 *  context: shared system text (identical across modules → OpenAI prompt caching)
 *  system:  task instructions
 *  user:    task input; images: [{ dataUrl, detail }]
 */
export async function jsonCall({ model, context, system, user, images = [], schemaName, schema, temperature = 0.2, budget: b }) {
  if (!enabled()) throw new Error('LLM disabled (set LLM_PROVIDER=openai and OPENAI_API_KEY in backend/.env)');
  if (b && b.spent >= b.cap) throw new CostCapError(`Cost cap $${b.cap} reached for this analysis`);
  if (!PRICES[model]) console.warn(`[llm] no price for ${model}; cost will show $0`);
  const messages = [];
  if (context) messages.push({ role: 'system', content: context });
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: images.length
    ? [{ type: 'text', text: user }, ...images.map(i => ({ type: 'image_url', image_url: { url: i.dataUrl, detail: i.detail || 'high' } }))]
    : user });
  const body = { model, messages, response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } } };
  if (/^(gpt-5|o\d)/.test(model)) body.reasoning_effort = process.env.REASONING_EFFORT || 'low';
  else body.temperature = temperature;

  let json, res;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), Number(process.env.LLM_TIMEOUT_MS || 180000));
    try {
      res = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions', {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY.trim()}` },
        body: JSON.stringify(body),
      });
      json = await res.json();
    } catch (e) { json = { error: { message: e.name === 'AbortError' ? 'timeout' : e.message } }; res = { ok: false, status: 0 }; }
    finally { clearTimeout(timer); }
    if (res.ok) break;
    // a 429 for an empty account (no credits / quota) won't clear by retrying: only a real rate limit is retried
    const noCredits = res.status === 429 && /no credits|insufficient_quota|exceeded your current quota|billing/i.test(`${json?.error?.code || ''} ${json?.error?.message || ''}`);
    const retry = !noCredits && (res.status === 429 || res.status >= 500 || res.status === 0);
    if (!retry || attempt === 2) throw new Error(`OpenAI ${res.status}: ${json?.error?.message || 'error'}`);
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1) ** 2));
  }
  const u = json.usage || {};
  const usage = { model, schemaName, input: u.prompt_tokens || 0, cached: u.prompt_tokens_details?.cached_tokens || 0,
    output: u.completion_tokens || 0, reasoning: u.completion_tokens_details?.reasoning_tokens || 0 };
  usage.cost = PRICES[model] ? dollars(model, usage) : 0;
  if (b) { b.spent += usage.cost; b.usage.push(usage); }
  const choice = json.choices?.[0]?.message;
  if (choice?.refusal) throw new Error('Model refused: ' + choice.refusal);
  return { data: JSON.parse(choice.content), usage };
}

export function summarizeUsage(list = []) {
  const t = { calls: list.length, input: 0, cached: 0, output: 0, cost: 0, byModel: {}, bySchema: {} };
  for (const u of list) {
    t.input += u.input; t.cached += u.cached; t.output += u.output; t.cost += u.cost;
    const m = (t.byModel[u.model] ||= { calls: 0, input: 0, output: 0, cost: 0 });
    m.calls++; m.input += u.input; m.output += u.output; m.cost += u.cost;
    const s = (t.bySchema[u.schemaName || 'other'] ||= { calls: 0, cost: 0 });
    s.calls++; s.cost += u.cost;
  }
  t.cost = Math.round(t.cost * 10000) / 10000;
  for (const v of [...Object.values(t.byModel), ...Object.values(t.bySchema)]) v.cost = Math.round(v.cost * 10000) / 10000;
  return t;
}
