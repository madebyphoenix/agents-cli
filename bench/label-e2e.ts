import { performance } from 'perf_hooks';
import { discoverSessions, searchContentIndex } from '../src/lib/session/discover.js';
import { getDB } from '../src/lib/session/db.js';

function t<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const r = fn();
  console.log(`${(performance.now() - t0).toFixed(0)}ms  ${label}`);
  return r;
}
async function tAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  console.log(`${(performance.now() - t0).toFixed(0)}ms  ${label}`);
  return r;
}

// Full scan (cold) to repopulate schema v2 + labels
const sessions = await tAsync('cold full discover', () =>
  discoverSessions({ all: true, cwd: process.cwd(), limit: 5000 }),
);
console.log(`total sessions: ${sessions.length}`);

const withLabels = sessions.filter(s => s.label);
console.log(`sessions with labels: ${withLabels.length}`);
for (const s of withLabels.slice(0, 10)) {
  console.log(`  ${s.shortId}  agent=${s.agent}  label="${s.label}"  topic="${(s.topic || '').slice(0, 60)}"`);
}

console.log('\n--- FTS5 searches ---');
for (const query of ['Agents Sessions', 'Agents View', 'rush deploy', 'sqlite fts5', 'session search']) {
  const hits = t(`search "${query}"`, () => searchContentIndex(sessions, query));
  const top = [...hits.values()].slice(0, 3);
  for (const s of top) {
    console.log(`  [${(s._bm25Score ?? 0).toFixed(2)}]  ${s.shortId}  label="${s.label || ''}"  topic="${(s.topic || '').slice(0, 60)}"`);
  }
}

// Check DB directly
const db = getDB();
const labelCount = (db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE label IS NOT NULL`).get() as { c: number }).c;
console.log(`\nsessions.label populated: ${labelCount}`);
const ftsCount = (db.prepare(`SELECT COUNT(*) AS c FROM session_text WHERE label IS NOT NULL AND label <> ''`).get() as { c: number }).c;
console.log(`session_text.label populated: ${ftsCount}`);
