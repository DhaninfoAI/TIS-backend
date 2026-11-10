// Prompt templates live in backend/prompts/*.md so they can be improved without touching code.
// Re-read on every call (cheap), so edits apply to the next analysis without a restart.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts');

export function prompt(name, vars = {}) {
  const tpl = readFileSync(path.join(dir, name + '.md'), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}
