import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { buildFtsQuery } from '../db.js';

describe('buildFtsQuery', () => {
  it('returns empty expression for whitespace-only input', () => {
    expect(buildFtsQuery('').expr).toBe('');
    expect(buildFtsQuery('   ').expr).toBe('');
  });

  it('splits on non-alphanumerics, drops 1-char tokens, prefix-matches', () => {
    const { expr, terms } = buildFtsQuery('rush deploy-a2a a b 42');
    expect(terms).toEqual(['rush', 'deploy', 'a2a', '42']);
    expect(expr).toBe('rush* OR deploy* OR a2a* OR 42*');
  });

  it('lowercases tokens', () => {
    const { terms } = buildFtsQuery('RUSH Deploy');
    expect(terms).toEqual(['rush', 'deploy']);
  });
});

describe('FTS5 session_text schema (smoke test)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-fts-'));
    db = new Database(path.join(tmpDir, 'sessions.db'));
    db.exec(`
      CREATE VIRTUAL TABLE session_text USING fts5(
        session_id UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ranks rare terms higher than common ones (IDF)', () => {
    const insert = db.prepare('INSERT INTO session_text (session_id, content) VALUES (?, ?)');
    insert.run('a', 'session bug bug');
    insert.run('b', 'session notes');
    insert.run('c', 'session thoughts');
    insert.run('d', 'session plan');

    const rows = db.prepare(`
      SELECT session_id, bm25(session_text) AS r
      FROM session_text WHERE session_text MATCH ? ORDER BY r ASC
    `).all('bug') as { session_id: string; r: number }[];

    expect(rows[0].session_id).toBe('a');
  });

  it('supports prefix queries for partial typing', () => {
    const insert = db.prepare('INSERT INTO session_text (session_id, content) VALUES (?, ?)');
    insert.run('x', 'rush deploy yaml agent');
    insert.run('y', 'unrelated content');

    const rows = db.prepare(`
      SELECT session_id FROM session_text WHERE session_text MATCH ? ORDER BY bm25(session_text) ASC
    `).all('rush* OR dep*') as { session_id: string }[];

    expect(rows.map(r => r.session_id)).toContain('x');
    expect(rows.map(r => r.session_id)).not.toContain('y');
  });
});
