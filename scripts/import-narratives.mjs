// Imports TIS's example narratives (GPT_Narrative_Training.md in the TIS folder) into rules/narrative-examples.json.
// The narrative step shows the AI the two examples closest to the order being reviewed, as a style guide.
//   node scripts/import-narratives.mjs [path/to/GPT_Narrative_Training.md]
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2] || new URL('../../GPT_Narrative_Training.md', import.meta.url);
const md = readFileSync(src, 'utf8');
const recs = [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
const STOP = new Set('the and with are for that this has have from was were which there their been also into each other they building risk located approximately feet'.split(' '));
const examples = recs.map((r, i) => {
  const text = r.completion.trim().replace(/[ \t]+/g, ' ').replace(/ \./g, '.');
  const words = text.toLowerCase().match(/[a-z]{4,}/g) || [];
  const freq = {};
  for (const w of words) if (!STOP.has(w)) freq[w] = (freq[w] || 0) + 1;
  return { id: i + 1, words: text.split(/\s+/).length, keywords: Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 60), text };
});
const out = new URL('../rules/narrative-examples.json', import.meta.url);
writeFileSync(out, JSON.stringify({ source: 'GPT_Narrative_Training.md', importedAt: new Date().toISOString().slice(0, 10), count: examples.length, examples }, null, 1));
console.log(`Imported ${examples.length} example narratives (${Math.min(...examples.map(e => e.words))}–${Math.max(...examples.map(e => e.words))} words) → rules/narrative-examples.json`);
