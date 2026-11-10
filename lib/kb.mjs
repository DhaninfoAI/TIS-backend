// Resolves the client QC knowledge base (Documentation/TIS_QC_Synchronized_Master.json)
// into a small, order-specific "rules pack". This is what goes into LLM prompts:
// never the whole 200 KB KB, only universal + attached forms + client overlays.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = process.env.KB_PATH || path.resolve(here, '../../Documentation/TIS_QC_Synchronized_Master.json');
const HAZARDS = JSON.parse(readFileSync(path.resolve(here, '../rules/hazard_taxonomy.json'), 'utf8'));

let kb = null;
export function loadKb() {
  if (kb) return kb;
  kb = existsSync(KB_PATH) ? JSON.parse(readFileSync(KB_PATH, 'utf8')) : { clients: {}, global_forms: {}, global_quality_control_standards: { requirements: [] } };
  return kb;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function findClient(name) {
  const k = loadKb();
  const keys = Object.keys(k.clients || {});
  return keys.find(c => c === name) || keys.find(c => norm(c) === norm(name))
    || keys.find(c => norm(c).startsWith(norm(name).slice(0, 18))) || null;
}

function flat(v, indent = '') {
  if (v == null) return '';
  if (typeof v === 'string') return indent + '- ' + v + '\n';
  if (Array.isArray(v)) return v.map(x => flat(x, indent)).join('');
  return Object.entries(v).map(([k, x]) => (typeof x === 'string' ? `${indent}- ${k}: ${x}\n` : `${indent}- ${k}:\n${flat(x, indent + '  ')}`)).join('');
}

// TIS-edited notes from the rules store (/rules page): { 'client/<name>': [{markdown,…}], 'form/<name>': […], 'universal/all': […] }
let docsProvider = () => ({});
export function setDocsProvider(fn) { docsProvider = fn; }
const latestDoc = key => (docsProvider()[key] || []).at(-1)?.markdown?.trim() || '';

/** Order-specific rules pack (markdown) + metadata. */
export function rulesPack(snap) {
  const pack = basePack(snap);
  const extra = [];
  const u = latestDoc('universal/all'); if (u) extra.push(`## TIS notes: all clients\n${u}`);
  for (const f of snap.forms || []) { const d = latestDoc(`form/${f.name}`); if (d) extra.push(`## TIS notes: form ${f.name}\n${d}`); }
  if (pack.clientKey) {
    const c = latestDoc(`client/${pack.clientKey}`); if (c) extra.push(`## TIS notes: client ${pack.clientKey}\n${c}`);
    for (const f of snap.forms || []) { const d = latestDoc(`clientForm/${pack.clientKey}|${f.name}`); if (d) extra.push(`## TIS notes: ${pack.clientKey} × ${f.name}\n${d}`); }
  }
  if (!extra.length) return pack;
  const text = pack.text + '\n\n# Rules added by TIS (take precedence over the stored KB when they conflict)\n' + extra.join('\n\n');
  return { ...pack, text, chars: text.length, approxTokens: Math.ceil(text.length / 4), tisNotes: extra.length };
}

function basePack(snap) {
  const k = loadKb();
  const clientKey = findClient(snap.order?.client);
  const client = clientKey ? k.clients[clientKey] : null;
  const parts = ['# Universal QC rules\n' + (k.global_quality_control_standards?.requirements || []).map(r => `- **${r.topic}**: ${r.instruction}`).join('\n')];
  const formsUsed = [];
  for (const f of snap.forms || []) {
    const g = k.global_forms?.[f.name];
    if (!g || f.qcRelevant === false) continue;
    formsUsed.push(f.name);
    parts.push(`# Form: ${f.name}\n` + flat(g.general_requirements) + (g.important_instructions ? flat({ important: g.important_instructions }) : '') + (g.common_issues ? flat({ common_issues: g.common_issues }) : ''));
  }
  if (client) {
    parts.push(`# Client: ${clientKey}${client.status === 'excluded' ? ' (TEST ACCOUNT: client rules excluded)' : ''}\n` + flat(client.general_notes) + flat(client.inherited_client_requirements || null));
    for (const f of snap.forms || []) {
      const cf = client.forms?.[f.name];
      if (cf?.client_specific_notes) parts.push(`## ${clientKey} × ${f.name}\n- ${cf.client_specific_notes}`);
    }
  }
  const text = parts.join('\n\n');
  return { text, clientKey, formsUsed, chars: text.length, approxTokens: Math.ceil(text.length / 4) };
}

/** Compact hazard taxonomy for the photo prompt (names + guidance). */
export function hazardPack({ withGuidance = true } = {}) {
  const text = HAZARDS.hazards.map(h => `- ${h.id}${h.parent ? ` (${h.parent})` : ''}: ${h.name}${withGuidance && h.guidance ? ' | ' + h.guidance.slice(0, 260) : ''}`).join('\n');
  return { text, count: HAZARDS.hazards.length, approxTokens: Math.ceil(text.length / 4) };
}

export const hazards = HAZARDS.hazards;
