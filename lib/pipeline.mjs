// Picks the engine per module: OpenAI when configured, else the mock heuristics.
// An AI module that fails (API error, cost cap) falls back to mock so the analysis always completes.
// A failure is recorded as `aiFailed` (a plain category the reviewer can act on) so the panel can say so.

import { MOCK } from './modules.mjs';
import { AI } from './ai-modules.mjs';
import { enabled } from './llm.mjs';

// Photos first so every later module sees the photo insights; narrative is last (TIS: "narrative last").
export const MODULE_ORDER = ['orderBrief', 'checks', 'photoReview', 'uwConcerns', 'recommendations', 'recPhotos', 'questions', 'captions', 'narrative', 'pricing', 'priorReport', 'qcChecklist'];

/** What kind of AI failure this was, without provider, model or key details:
 *  setup (key / account refused, no credits left), busy (rate limit), limit (the review's cost cap), unreachable (timeout,
 *  server or network error), other. */
export function aiFailureKind(msg = '') {
  const m = String(msg);
  if (/OpenAI 40[13]\b|api key|unauthori[sz]ed|LLM disabled/i.test(m)) return 'setup';
  // an empty account answers 429 too, but it won't clear by itself: an administrator must add credits (2026-11-10)
  if (/no credits|insufficient_quota|exceeded your current quota|billing/i.test(m)) return 'setup';
  if (/OpenAI 429\b|rate limit|quota/i.test(m)) return 'busy';
  if (/cost cap/i.test(m)) return 'limit';
  if (/timeout|OpenAI (0|5\d\d)\b|ECONN|ENOTFOUND|fetch failed|network|socket/i.test(m)) return 'unreachable';
  return 'other';
}

export const MODULES = Object.fromEntries(MODULE_ORDER.map(name => [name, async (snap, ctx) => {
  let fallback = null, failed = null;
  if (enabled() && AI[name]) {
    try {
      const r = await AI[name](snap, ctx);
      if (r) return r;
      fallback = ctx.note || null; ctx.note = null;   // the AI step chose not to run (e.g. no photos uploaded): not a failure
    } catch (e) {
      fallback = e.message; failed = aiFailureKind(e.message);
      console.error(`[ai] ${name} failed: ${e.message}`);
    }
  }
  const r = await MOCK[name](snap, ctx);
  if (fallback) { r.engine = 'mock (fallback)'; r.summary = { ...r.summary, fallbackReason: fallback }; }
  if (failed) r.aiFailed = failed;
  return r;
}]));
