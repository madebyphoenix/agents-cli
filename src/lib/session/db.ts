import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SessionAgentId, SessionMeta } from './types.js';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.agents', 'sessions');
const DB_PATH = path.join(SESSIONS_DIR, 'sessions.db');

const SCHEMA_VERSION = 4;

// BM25 column weights for session_text: label > topic > project > content.
// Higher weights make matches in that column rank higher.
const BM25_WEIGHTS = [5.0, 2.0, 1.5, 1.0] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  version TEXT,
  account TEXT,
  timestamp TEXT NOT NULL,
  project TEXT,
  cwd TEXT,
  git_branch TEXT,
  topic TEXT,
  label TEXT,
  message_count INTEGER,
  token_count INTEGER,
  file_path TEXT NOT NULL,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  scanned_at INTEGER,
  is_team_origin INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON sessions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_file_path ON sessions(file_path);

CREATE VIRTUAL TABLE IF NOT EXISTS session_text USING fts5(
  session_id UNINDEXED,
  label,
  topic,
  project,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Tracks every file we've stat'd during a scan, regardless of whether it
-- produced a session row. Decouples "did we already look at this?" from
-- "do we have a session from it?" — essential for files that don't parse
-- into a session (no id) or session rows whose file_path is synthetic.
CREATE TABLE IF NOT EXISTS scan_ledger (
  file_path TEXT PRIMARY KEY,
  file_mtime_ms INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL
);
`;

export interface SessionRow {
  id: string;
  short_id: string;
  agent: string;
  version: string | null;
  account: string | null;
  timestamp: string;
  project: string | null;
  cwd: string | null;
  git_branch: string | null;
  topic: string | null;
  label: string | null;
  message_count: number | null;
  token_count: number | null;
  file_path: string;
  file_mtime_ms: number | null;
  file_size: number | null;
  scanned_at: number | null;
  is_team_origin: number;
}

export interface ScanStamp {
  fileMtimeMs: number;
  fileSize: number;
}

export interface QueryOptions {
  agent?: SessionAgentId;
  agents?: SessionAgentId[];
  version?: string;
  cwd?: string;
  /** Match any session whose cwd equals this or is a descendant of it. */
  cwdPrefix?: string;
  project?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
  /** Drop rows flagged as team-origin before LIMIT is applied. */
  excludeTeamOrigin?: boolean;
  /** Keep only team-origin rows (for hidden-count queries). */
  onlyTeamOrigin?: boolean;
}

let dbInstance: Database.Database | null = null;

/**
 * Apply schema migrations from `fromVersion` → SCHEMA_VERSION. The new
 * `CREATE IF NOT EXISTS` at SCHEMA doesn't help when column sets or FTS
 * column definitions change — those need explicit migration here.
 */
function migrateSchema(db: Database.Database, fromVersion: number): void {
  if (fromVersion < 2) {
    // v1 → v2: add `label` column to sessions and switch session_text from
    // single `content` column to multi-column (label, topic, project, content).
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'label')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN label TEXT`);
    }
    // FTS5 virtual tables can't be ALTERed — drop and recreate. Scan ledger
    // is cleared so every file gets re-parsed on next run, repopulating FTS5.
    db.exec(`
      DROP TABLE IF EXISTS session_text;
      CREATE VIRTUAL TABLE session_text USING fts5(
        session_id UNINDEXED,
        label,
        topic,
        project,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      DELETE FROM scan_ledger;
    `);
  }
  if (fromVersion < 3) {
    // v2 → v3: topic extraction now strips team-spawn wrapper prompts
    // (HEADLESS PLAN MODE prefix + summary suffix). Force a rescan so cached
    // topics like "You are running in HEADLESS PLAN MODE..." get re-extracted.
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 4) {
    // v3 → v4: team-origin is now captured structurally from the JSONL
    // `entrypoint` field at scan time. Add the column and force a rescan so
    // every existing Claude session gets its flag populated.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'is_team_origin')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN is_team_origin INTEGER DEFAULT 0`);
    }
    db.exec(`DELETE FROM scan_ledger;`);
  }
}

export function getDB(): Database.Database {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.exec(SCHEMA);

  const current = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  const currentVersion = current ? parseInt(current.value, 10) : 0;

  if (!current) {
    db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  } else if (currentVersion < SCHEMA_VERSION) {
    migrateSchema(db, currentVersion);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  }

  // One-shot cleanup of the pre-SQLite JSONL indexes. Safe — nothing reads
  // them anymore. Guarded by a meta flag so we only try once.
  const cleaned = db.prepare(`SELECT value FROM meta WHERE key = 'legacy_indexes_removed'`).get() as { value: string } | undefined;
  if (!cleaned) {
    for (const p of [
      path.join(SESSIONS_DIR, 'index.jsonl'),
      path.join(SESSIONS_DIR, 'content_index.jsonl'),
      path.join(SESSIONS_DIR, 'index.jsonl.bak'),
    ]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    }
    db.prepare(`INSERT INTO meta(key, value) VALUES ('legacy_indexes_removed', '1')`).run();
  }

  dbInstance = db;
  return db;
}

export function closeDB(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function getDBPath(): string {
  return DB_PATH;
}

/**
 * Look up the file stat stamp we stored the last time we scanned a given file path.
 * Callers compare this to the current fs.stat to decide whether to rescan.
 */
export function getScanStampByPath(filePath: string): ScanStamp | null {
  const db = getDB();
  const row = db
    .prepare(`SELECT file_mtime_ms, file_size FROM scan_ledger WHERE file_path = ? LIMIT 1`)
    .get(filePath) as { file_mtime_ms: number; file_size: number } | undefined;
  return row ? { fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size } : null;
}

/**
 * Bulk-load the stamp ledger for a set of file paths in a single SQL query.
 * This is the fast path used by the incremental scanner — avoids N+1 queries.
 */
export function getScanStampsForPaths(filePaths: string[]): Map<string, ScanStamp> {
  const result = new Map<string, ScanStamp>();
  if (filePaths.length === 0) return result;
  const db = getDB();

  // SQLite parameter limit is typically 999 / 32766 — chunk defensively.
  const CHUNK = 500;
  for (let i = 0; i < filePaths.length; i += CHUNK) {
    const chunk = filePaths.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT file_path, file_mtime_ms, file_size
        FROM scan_ledger
        WHERE file_path IN (${placeholders})
      `)
      .all(...chunk) as Array<{ file_path: string; file_mtime_ms: number; file_size: number }>;

    for (const row of rows) {
      result.set(row.file_path, { fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size });
    }
  }
  return result;
}

/**
 * Record scan stamps for files we've looked at. Covers both files that produced
 * a session and files we looked at but chose not to index (e.g. malformed).
 */
export function recordScans(entries: Array<{ filePath: string; scan: ScanStamp }>): void {
  if (entries.length === 0) return;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      scanned_at = excluded.scanned_at
  `);
  const now = Date.now();
  const txn = db.transaction((items: typeof entries) => {
    for (const { filePath, scan } of items) {
      stmt.run(filePath, scan.fileMtimeMs, scan.fileSize, now);
    }
  });
  txn(entries);
}

const upsertSessionStmt = (db: Database.Database) => db.prepare(`
  INSERT INTO sessions (
    id, short_id, agent, version, account, timestamp,
    project, cwd, git_branch, topic, label, message_count, token_count,
    file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
  ) VALUES (
    @id, @short_id, @agent, @version, @account, @timestamp,
    @project, @cwd, @git_branch, @topic, @label, @message_count, @token_count,
    @file_path, @file_mtime_ms, @file_size, @scanned_at, @is_team_origin
  )
  ON CONFLICT(id) DO UPDATE SET
    short_id = excluded.short_id,
    agent = excluded.agent,
    version = excluded.version,
    account = excluded.account,
    timestamp = excluded.timestamp,
    project = excluded.project,
    cwd = excluded.cwd,
    git_branch = excluded.git_branch,
    topic = excluded.topic,
    label = excluded.label,
    message_count = excluded.message_count,
    token_count = excluded.token_count,
    file_path = excluded.file_path,
    file_mtime_ms = excluded.file_mtime_ms,
    file_size = excluded.file_size,
    scanned_at = excluded.scanned_at,
    is_team_origin = excluded.is_team_origin
`);

const deleteTextStmt = (db: Database.Database) =>
  db.prepare(`DELETE FROM session_text WHERE session_id = ?`);
const insertTextStmt = (db: Database.Database) =>
  db.prepare(`INSERT INTO session_text (session_id, label, topic, project, content) VALUES (?, ?, ?, ?, ?)`);

let cachedStmts: {
  upsert?: Database.Statement<SessionRow>;
  delText?: Database.Statement<unknown[]>;
  insText?: Database.Statement<unknown[]>;
} = {};

function stmts(db: Database.Database) {
  if (!cachedStmts.upsert) {
    cachedStmts = {
      upsert: upsertSessionStmt(db) as Database.Statement<SessionRow>,
      delText: deleteTextStmt(db),
      insText: insertTextStmt(db),
    };
  }
  return cachedStmts as Required<typeof cachedStmts>;
}

/**
 * Upsert a session row and replace its FTS5 content in a single transaction.
 * `content` is the tokenizable user-prompt text; pass '' to leave the row unsearchable.
 */
export function upsertSession(meta: SessionMeta, content: string, scan?: ScanStamp): void {
  const db = getDB();
  const { upsert, delText, insText } = stmts(db);
  const row: SessionRow = {
    id: meta.id,
    short_id: meta.shortId,
    agent: meta.agent,
    version: meta.version ?? null,
    account: meta.account ?? null,
    timestamp: meta.timestamp,
    project: meta.project ?? null,
    cwd: meta.cwd ?? null,
    git_branch: meta.gitBranch ?? null,
    topic: meta.topic ?? null,
    label: meta.label ?? null,
    message_count: meta.messageCount ?? null,
    token_count: meta.tokenCount ?? null,
    file_path: meta.filePath,
    file_mtime_ms: scan?.fileMtimeMs ?? null,
    file_size: scan?.fileSize ?? null,
    scanned_at: Date.now(),
    is_team_origin: meta.isTeamOrigin ? 1 : 0,
  };

  const txn = db.transaction(() => {
    upsert.run(row);
    delText.run(meta.id);
    insText.run(
      meta.id,
      meta.label ?? '',
      meta.topic ?? '',
      meta.project ?? '',
      content ?? '',
    );
  });
  txn();
}

export function upsertSessionsBatch(
  entries: Array<{ meta: SessionMeta; content: string; scan?: ScanStamp }>,
): void {
  if (entries.length === 0) return;
  const db = getDB();
  const { upsert, delText, insText } = stmts(db);
  const now = Date.now();
  const ledger = db.prepare(`
    INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      scanned_at = excluded.scanned_at
  `);

  const txn = db.transaction((items: typeof entries) => {
    for (const { meta, content, scan } of items) {
      upsert.run({
        id: meta.id,
        short_id: meta.shortId,
        agent: meta.agent,
        version: meta.version ?? null,
        account: meta.account ?? null,
        timestamp: meta.timestamp,
        project: meta.project ?? null,
        cwd: meta.cwd ?? null,
        git_branch: meta.gitBranch ?? null,
        topic: meta.topic ?? null,
        label: meta.label ?? null,
        message_count: meta.messageCount ?? null,
        token_count: meta.tokenCount ?? null,
        file_path: meta.filePath,
        file_mtime_ms: scan?.fileMtimeMs ?? null,
        file_size: scan?.fileSize ?? null,
        scanned_at: now,
        is_team_origin: meta.isTeamOrigin ? 1 : 0,
      });
      delText.run(meta.id);
      insText.run(
        meta.id,
        meta.label ?? '',
        meta.topic ?? '',
        meta.project ?? '',
        content ?? '',
      );
      if (scan && meta.filePath) {
        ledger.run(meta.filePath, scan.fileMtimeMs, scan.fileSize, now);
      }
    }
  });
  txn(entries);
}

/**
 * Sync labels for a set of sessions. For each id in the map, if the stored
 * label differs, update both `sessions.label` and the FTS5 label column.
 * Leaves FTS5 content/topic/project untouched — cheap to call every run.
 */
export function syncLabels(labelMap: Map<string, string | null>): number {
  if (labelMap.size === 0) return 0;
  const db = getDB();
  const ids = [...labelMap.keys()];
  const CHUNK = 500;
  const updates: Array<{ id: string; label: string | null }> = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, label FROM sessions WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: string; label: string | null }>;
    for (const row of rows) {
      const live = labelMap.get(row.id) ?? null;
      if ((live ?? '') !== (row.label ?? '')) {
        updates.push({ id: row.id, label: live });
      }
    }
  }
  if (updates.length === 0) return 0;

  const updSessions = db.prepare(`UPDATE sessions SET label = ? WHERE id = ?`);
  const updFts = db.prepare(`UPDATE session_text SET label = ? WHERE session_id = ?`);

  const txn = db.transaction((items: typeof updates) => {
    for (const { id, label } of items) {
      updSessions.run(label, id);
      updFts.run(label ?? '', id);
    }
  });
  txn(updates);
  return updates.length;
}

function rowToMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    shortId: row.short_id,
    agent: row.agent as SessionAgentId,
    timestamp: row.timestamp,
    project: row.project ?? undefined,
    cwd: row.cwd ?? undefined,
    filePath: row.file_path,
    gitBranch: row.git_branch ?? undefined,
    messageCount: row.message_count ?? undefined,
    tokenCount: row.token_count ?? undefined,
    version: row.version ?? undefined,
    account: row.account ?? undefined,
    topic: row.topic ?? undefined,
    label: row.label ?? undefined,
    isTeamOrigin: row.is_team_origin === 1,
  };
}

export function querySessions(options: QueryOptions = {}): SessionMeta[] {
  const db = getDB();
  const where: string[] = [];
  const params: any[] = [];

  if (options.agent) {
    where.push('agent = ?');
    params.push(options.agent);
  } else if (options.agents && options.agents.length > 0) {
    where.push(`agent IN (${options.agents.map(() => '?').join(',')})`);
    params.push(...options.agents);
  }

  if (options.version) {
    where.push('version = ?');
    params.push(options.version);
  }

  if (options.cwd) {
    where.push('cwd = ?');
    params.push(options.cwd);
  }

  if (options.project) {
    where.push('LOWER(IFNULL(project, \'\')) LIKE ?');
    params.push(`%${options.project.toLowerCase()}%`);
  }

  if (typeof options.sinceMs === 'number') {
    // Compare as strings; ISO 8601 timestamps sort lexicographically.
    where.push('timestamp >= ?');
    params.push(new Date(options.sinceMs).toISOString());
  }

  if (typeof options.untilMs === 'number') {
    where.push('timestamp <= ?');
    params.push(new Date(options.untilMs).toISOString());
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limitClause = options.limit ? `LIMIT ${Math.max(1, Math.floor(options.limit))}` : '';
  const sql = `SELECT * FROM sessions ${whereClause} ORDER BY timestamp DESC ${limitClause}`;
  const rows = db.prepare(sql).all(...params) as SessionRow[];
  return rows.map(rowToMeta);
}

export function getAllFilePaths(): Set<string> {
  const db = getDB();
  const rows = db.prepare(`SELECT file_path FROM sessions`).all() as { file_path: string }[];
  return new Set(rows.map(r => r.file_path));
}

export function getSessionsByFilePaths(paths: string[]): Map<string, SessionMeta> {
  if (paths.length === 0) return new Map();
  const db = getDB();
  const placeholders = paths.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE file_path IN (${placeholders})`)
    .all(...paths) as SessionRow[];
  const result = new Map<string, SessionMeta>();
  for (const row of rows) result.set(row.file_path, rowToMeta(row));
  return result;
}

export function getSessionById(id: string): SessionMeta | null {
  const db = getDB();
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  return row ? rowToMeta(row) : null;
}

export interface FtsHit {
  sessionId: string;
  score: number;
  matchedTerms: string[];
}

/**
 * Escape a raw user query into a safe FTS5 MATCH expression.
 * Splits on non-word characters, keeps tokens >= 2 chars, and OR-joins
 * them with a prefix wildcard so partial typing ('rush dep') matches.
 */
export function buildFtsQuery(input: string): { expr: string; terms: string[] } {
  const terms = input.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  if (terms.length === 0) return { expr: '', terms: [] };
  const expr = terms.map(t => `${t}*`).join(' OR ');
  return { expr, terms };
}

/**
 * Label-first search. Sessions whose custom label substring-matches the query
 * always rank ahead of FTS5 hits — this gives predictable behavior when a user
 * types the exact name they gave a session via /rename.
 *
 * Tiers (highest → lowest):
 *   1. Exact label match (case-insensitive): score 1_000_000
 *   2. Label prefix match:                   score   900_000
 *   3. Label contains query:                 score   800_000
 *   4. FTS5 BM25 hits:                       score   1..1000 (scaled)
 *
 * Note: FTS5's bm25() returns negative numbers; we flip the sign for tier 4
 * so "higher = better" is consistent across all tiers.
 */
export function ftsSearch(input: string, limit = 200): FtsHit[] {
  const db = getDB();
  const trimmed = input.trim();
  if (!trimmed) return [];

  const { expr, terms } = buildFtsQuery(input);
  const lower = trimmed.toLowerCase();
  const seen = new Set<string>();
  const hits: FtsHit[] = [];

  // Tier 1-3: label-based matches, ordered by exactness.
  const labelRows = db.prepare(`
    SELECT id, label FROM sessions
    WHERE label IS NOT NULL AND LOWER(label) LIKE ?
  `).all(`%${lower}%`) as Array<{ id: string; label: string }>;

  let hasExactLabelMatch = false;
  for (const row of labelRows) {
    const labelLower = row.label.toLowerCase();
    let score: number;
    if (labelLower === lower) {
      score = 1_000_000;
      hasExactLabelMatch = true;
    } else if (labelLower.startsWith(lower)) {
      score = 900_000;
    } else {
      score = 800_000;
    }
    // matchedTerms is empty for label hits — the picker can render the label
    // itself as the highlight, no badge needed.
    hits.push({ sessionId: row.id, score, matchedTerms: [] });
    seen.add(row.id);
  }

  // If the query exactly names a labeled session, don't dilute the result
  // with FTS5 content hits — the user typed a specific thing, show just it.
  if (hasExactLabelMatch) {
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  // Tier 4: FTS5 content match, skipping anything already surfaced via label.
  if (expr) {
    try {
      const rows = db
        .prepare(`
          SELECT session_id, bm25(session_text, ${BM25_WEIGHTS.join(', ')}) AS rank
          FROM session_text
          WHERE session_text MATCH ?
          ORDER BY rank ASC
          LIMIT ?
        `)
        .all(expr, limit) as { session_id: string; rank: number }[];

      for (const r of rows) {
        if (seen.has(r.session_id)) continue;
        hits.push({ sessionId: r.session_id, score: -r.rank, matchedTerms: terms });
        seen.add(r.session_id);
      }
    } catch {
      /* invalid MATCH expression — tier 4 just yields nothing */
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export function getRowCount(): { sessions: number; textRows: number } {
  const db = getDB();
  const sessions = (db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c;
  const textRows = (db.prepare(`SELECT COUNT(*) AS c FROM session_text`).get() as { c: number }).c;
  return { sessions, textRows };
}
