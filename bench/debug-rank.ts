import { getDB, buildFtsQuery } from '../src/lib/session/db.js';

const db = getDB();

// Dump both labeled rows
console.log('--- labeled rows in session_text ---');
const labeled = db.prepare(`
  SELECT session_id, label, topic, project, length(content) AS clen
  FROM session_text WHERE label != ''
`).all() as any[];
for (const r of labeled) {
  console.log(`  id=${r.session_id.slice(0, 8)}  label="${r.label}"  topic="${(r.topic || '').slice(0, 40)}"  proj="${r.project || ''}"  clen=${r.clen}`);
}

// Try exact matches
console.log('\n--- MATCH label:agents ---');
const a = db.prepare(`SELECT session_id, label FROM session_text WHERE session_text MATCH ?`).all('label:agents') as any[];
for (const r of a) console.log(`  ${r.session_id.slice(0, 8)}  "${r.label}"`);

console.log('\n--- MATCH label:sessions ---');
const b = db.prepare(`SELECT session_id, label FROM session_text WHERE session_text MATCH ?`).all('label:sessions') as any[];
for (const r of b) console.log(`  ${r.session_id.slice(0, 8)}  "${r.label}"`);

console.log('\n--- MATCH label:view ---');
const c = db.prepare(`SELECT session_id, label FROM session_text WHERE session_text MATCH ?`).all('label:view') as any[];
for (const r of c) console.log(`  ${r.session_id.slice(0, 8)}  "${r.label}"`);

console.log('\n--- MATCH "Agents Sessions" (exact) ---');
const d = db.prepare(`SELECT session_id, label FROM session_text WHERE session_text MATCH ? LIMIT 5`).all('"Agents Sessions"') as any[];
for (const r of d) console.log(`  ${r.session_id.slice(0, 8)}  "${r.label}"`);
