// How AI failures are named for the panel note (no credits = setup, rate limit = busy).  node test/ai-failure.mjs
import assert from 'node:assert/strict';
import { aiFailureKind } from '../lib/pipeline.mjs';

let fail = 0;
const t = (name, fn) => { try { fn(); console.log('✓', name); } catch (e) { fail++; console.log('✗', name, '-', e.message); } };
t('no credits → setup (tell the administrator), not busy', () => assert.equal(aiFailureKind('OpenAI 429: You have no credits remaining. Add credits to continue using the API'), 'setup'));
t('quota exceeded → setup', () => assert.equal(aiFailureKind('OpenAI 429: You exceeded your current quota, please check your plan and billing details.'), 'setup'));
t('rate limit → busy', () => assert.equal(aiFailureKind('OpenAI 429: Rate limit reached for gpt-4o on tokens per min'), 'busy'));
t('bad key → setup', () => assert.equal(aiFailureKind('OpenAI 401: Incorrect API key provided'), 'setup'));

console.log(fail ? `${fail} FAILED` : 'ALL PASS 4');
process.exit(fail ? 1 : 0);
