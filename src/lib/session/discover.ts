import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { execSync } from 'child_process';
import type { SessionAgentId, SessionMeta } from './types.js';
import type { AgentId } from '../types.js';
import { AGENTS, getCliVersion } from '../agents.js';
import { getConfigSymlinkVersion } from '../shims.js';
import { SESSION_AGENTS } from './types.js';
import { extractSessionTopic } from './prompt.js';
import {
  getDB,
  getScanStampByPath,
  getScanStampsForPaths,
  recordScans,
  syncLabels,
  upsertSessionsBatch,
  querySessions,
  ftsSearch,
  type ScanStamp,
} from './db.js';

const HOME = os.homedir();
const AGENTS_DIR = path.join(HOME, '.agents');

/** How long OpenClaw channel/cron snapshots stay valid before we re-shell-out. */
const OPENCLAW_TTL_MS = 60_000;

let cachedOpenClawWorkspaces: Map<string, string> | null = null;

export interface DiscoverOptions {
  agent?: SessionAgentId;
  project?: string;
  all?: boolean;
  cwd?: string;
  limit?: number;
  /** Filter sessions newer than this (ISO timestamp or "7d", "30d", "90d") */
  since?: string;
  /** Filter sessions older than this (ISO timestamp) */
  until?: string;
  /** Called as each agent makes parsing progress. Totals count only files that need re-parsing (cache misses). */
  onProgress?: (progress: ScanProgress) => void;
}

export interface ScanProgress {
  agent: SessionAgentId;
  parsed: number;
  total: number;
}

interface ClaudeSessionScan {
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  topic?: string;
  messageCount: number;
  tokenCount?: number;
  /** Concatenated user message text, ready to hand to FTS5. */
  contentText?: string;
}

interface CodexSessionScan {
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  topic?: string;
  messageCount: number;
  tokenCount?: number;
  contentText?: string;
}

const cachedAgentVersions = new Map<SessionAgentId, Promise<string | undefined>>();

interface ScanEntry {
  meta: SessionMeta;
  content: string;
  scan: ScanStamp;
}

/**
 * Discover sessions. Scans only files whose (mtime, size) have changed since
 * the last run; everything else is served from the SQLite cache.
 */
export async function discoverSessions(options?: DiscoverOptions): Promise<SessionMeta[]> {
  // Touch the DB so the schema is ready and connection is cached for this run.
  getDB();

  const agents = options?.agent ? [options.agent] : SESSION_AGENTS;
  const onProgress = options?.onProgress;

  // Incrementally re-scan changed files across all selected agents in parallel.
  await Promise.all(
    agents.map(agent => {
      switch (agent) {
        case 'claude': return scanClaudeIncremental(onProgress);
        case 'codex': return scanCodexIncremental(onProgress);
        case 'gemini': return scanGeminiIncremental(onProgress);
        case 'opencode': return scanOpenCodeIncremental();
        case 'openclaw': return scanOpenClawIncremental();
      }
    }),
  );

  const projectQuery = options?.project?.trim();
  const sinceMs = options?.since ? parseTimeFilter(options.since) : undefined;
  const untilMs = options?.until ? new Date(options.until).getTime() : undefined;

  // If no explicit --all or --project, we limit to the current cwd.
  let cwdFilter: string | undefined;
  if (!options?.all && !projectQuery) {
    cwdFilter = normalizeCwd(options?.cwd || process.cwd());
  }

  const sessions = querySessions({
    agent: options?.agent,
    agents: options?.agent ? undefined : agents,
    cwd: cwdFilter,
    project: projectQuery,
    sinceMs,
    untilMs: Number.isFinite(untilMs as number) ? untilMs : undefined,
    limit: options?.limit ?? 50,
  });

  return sessions;
}

function normalizeCwd(cwd?: string): string {
  if (!cwd) return '';
  const resolved = path.resolve(cwd);
  return safeRealpathSync(resolved) || resolved;
}

/**
 * Resolve a session by full or short ID. Accepts a pre-loaded session list
 * (fast path from discoverSessions) and falls back to a DB lookup for the
 * "I only know the id" case.
 */
export function resolveSessionById(sessions: SessionMeta[], idQuery: string): SessionMeta[] {
  const query = idQuery.toLowerCase();
  const exact = sessions.filter(s =>
    s.id.toLowerCase() === query || s.shortId.toLowerCase() === query,
  );
  if (exact.length > 0) return exact;
  return sessions.filter(s =>
    s.id.toLowerCase().startsWith(query) || s.shortId.toLowerCase().startsWith(query),
  );
}

// ---------------------------------------------------------------------------
// Content-index search (FTS5-backed)
// ---------------------------------------------------------------------------

/**
 * Run an FTS5 search over the DB and intersect with the given session list,
 * preserving the existing SessionMeta[] contract so sessions.ts is unchanged.
 */
export function searchContentIndex(
  sessions: SessionMeta[],
  query: string,
): Map<string, SessionMeta> {
  if (!query.trim()) return new Map();
  const hits = ftsSearch(query);
  if (hits.length === 0) return new Map();

  const byId = new Map(sessions.map(s => [s.id, s]));
  const result = new Map<string, SessionMeta>();
  for (const hit of hits) {
    const session = byId.get(hit.sessionId);
    if (!session) continue;
    result.set(hit.sessionId, {
      ...session,
      _matchedTerms: hit.matchedTerms,
      _bm25Score: hit.score,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Incremental scan orchestration
// ---------------------------------------------------------------------------

/**
 * For a list of files, stat each, compare to the DB ledger, and return only
 * the ones that need rescanning. One bulk DB query for the whole list.
 */
function filterChangedFiles(
  filePaths: string[],
): Array<{ filePath: string; scan: ScanStamp }> {
  const ledger = getScanStampsForPaths(filePaths);
  const out: Array<{ filePath: string; scan: ScanStamp }> = [];
  for (const filePath of filePaths) {
    const stat = safeStatSync(filePath);
    if (!stat) continue;
    const scan: ScanStamp = {
      fileMtimeMs: Math.floor(stat.mtimeMs),
      fileSize: stat.size,
    };
    const prev = ledger.get(filePath);
    if (prev && prev.fileMtimeMs === scan.fileMtimeMs && prev.fileSize === scan.fileSize) {
      continue;
    }
    out.push({ filePath, scan });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multi-version directory scanning
// ---------------------------------------------------------------------------

/**
 * Collect all directories to scan for an agent's sessions. Deduplicates by
 * realpath to avoid double-counting symlinked version homes.
 */
export function getAgentSessionDirs(agent: string, subdir: string): string[] {
  const resolved = new Set<string>();
  const dirs: string[] = [];

  function addDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const real = safeRealpathSync(dir);
    const key = real || dir;
    if (resolved.has(key)) return;
    resolved.add(key);
    dirs.push(dir);
  }

  addDir(path.join(HOME, `.${agent}`, subdir));

  const versionsBase = path.join(AGENTS_DIR, 'versions', agent);
  if (fs.existsSync(versionsBase)) {
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        addDir(path.join(versionsBase, version, 'home', `.${agent}`, subdir));
      }
    } catch { /* dir unreadable */ }
  }

  const backupsBase = path.join(AGENTS_DIR, 'backups', agent);
  if (fs.existsSync(backupsBase)) {
    try {
      for (const ts of fs.readdirSync(backupsBase)) {
        addDir(path.join(backupsBase, ts, subdir));
      }
    } catch { /* dir unreadable */ }
  }

  return dirs;
}

// ---------------------------------------------------------------------------
// Claude account info
// ---------------------------------------------------------------------------

let cachedClaudeAccount: string | undefined;

function getClaudeAccount(): string | undefined {
  if (cachedClaudeAccount !== undefined) return cachedClaudeAccount || undefined;

  // Claude's active config lives at $CLAUDE_CONFIG_DIR/.claude.json; for our shim
  // that's <version>/home/.claude/.claude.json. The home-level .claude.json is a
  // legacy path used when Claude runs without CLAUDE_CONFIG_DIR set.
  const candidates = [
    path.join(HOME, '.claude', '.claude.json'),
    path.join(HOME, '.claude.json'),
  ];

  const versionsBase = path.join(AGENTS_DIR, 'versions', 'claude');
  if (fs.existsSync(versionsBase)) {
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        candidates.push(path.join(versionsBase, version, 'home', '.claude', '.claude.json'));
        candidates.push(path.join(versionsBase, version, 'home', '.claude.json'));
      }
    } catch { /* versions dir unreadable */ }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      const name = data.oauthAccount?.emailAddress || data.oauthAccount?.displayName;
      if (name) {
        cachedClaudeAccount = name;
        return name;
      }
    } catch { /* auth file unreadable or malformed */ }
  }

  cachedClaudeAccount = '';
  return undefined;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/**
 * Build a map of Claude sessionId -> user-given label from ~/.claude/sessions/*.json.
 * Each JSON has shape { pid, sessionId, cwd, startedAt, name?, ... }. The
 * `name` field only exists if the user ran /rename in that session.
 * For sessionId collisions (re-resume of the same session), prefer the most
 * recent startedAt.
 */
function buildClaudeLabelMap(): Map<string, string | null> {
  const map = new Map<string, { label: string | null; startedAt: number }>();
  const dir = path.join(HOME, '.claude', 'sessions');
  if (!fs.existsSync(dir)) return new Map();

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return new Map();
  }

  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (typeof data.sessionId !== 'string') continue;
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
      const startedAt = typeof data.startedAt === 'number' ? data.startedAt : 0;
      const existing = map.get(data.sessionId);
      if (!existing || startedAt > existing.startedAt) {
        map.set(data.sessionId, { label: name, startedAt });
      }
    } catch { /* unreadable session metadata file */ }
  }

  const out = new Map<string, string | null>();
  for (const [sid, { label }] of map) out.set(sid, label);
  return out;
}

async function scanClaudeIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const account = getClaudeAccount();
  const labelMap = buildClaudeLabelMap();
  const filePaths: string[] = [];
  const seen = new Set<string>();

  for (const projectsDir of getAgentSessionDirs('claude', 'projects')) {
    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(projectsDir);
    } catch {
      continue;
    }

    for (const dirName of projectDirs) {
      const dirPath = path.join(projectsDir, dirName);
      const stat = safeStatSync(dirPath);
      if (!stat?.isDirectory()) continue;

      let files: string[];
      try {
        files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        filePaths.push(path.join(dirPath, file));
      }
    }
  }

  const changed = filterChangedFiles(filePaths);

  if (changed.length > 0) {
    onProgress?.({ agent: 'claude', parsed: 0, total: changed.length });

    const entries: ScanEntry[] = [];
    const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
    let parsed = 0;
    for (const { filePath, scan } of changed) {
      try {
        const sessionId = path.basename(filePath).replace('.jsonl', '');
        const label = labelMap.get(sessionId) ?? undefined;
        const result = await readClaudeMeta(filePath, sessionId, account, label);
        if (result) {
          entries.push({ meta: result.meta, content: result.content, scan });
        } else {
          touched.push({ filePath, scan });
        }
      } catch {
        touched.push({ filePath, scan });
      }
      parsed++;
      onProgress?.({ agent: 'claude', parsed, total: changed.length });
    }

    upsertSessionsBatch(entries);
    recordScans(touched);
  }

  // Pick up /rename changes on sessions whose JSONL didn't change.
  // Only bother for sessions we actually have a Claude row for.
  if (labelMap.size > 0) syncLabels(labelMap);
}

async function readClaudeMeta(
  filePath: string,
  sessionId: string,
  account?: string,
  label?: string,
): Promise<{ meta: SessionMeta; content: string } | null> {
  const scan = await scanClaudeSession(filePath);

  let meta: SessionMeta;
  if (scan.timestamp) {
    const cwd = normalizeCwd(scan.cwd || '');
    meta = {
      id: sessionId,
      shortId: sessionId.slice(0, 8),
      agent: 'claude',
      timestamp: scan.timestamp,
      project: cwd ? path.basename(cwd) : undefined,
      cwd,
      filePath,
      gitBranch: scan.gitBranch,
      version: scan.version,
      account,
      topic: scan.topic,
      label,
      messageCount: scan.messageCount,
      tokenCount: scan.tokenCount,
    };
  } else {
    const stat = safeStatSync(filePath);
    meta = {
      id: sessionId,
      shortId: sessionId.slice(0, 8),
      agent: 'claude',
      timestamp: stat ? stat.mtime.toISOString() : new Date().toISOString(),
      filePath,
      account,
      label,
      messageCount: scan.messageCount,
      tokenCount: scan.tokenCount,
      topic: scan.topic,
    };
  }

  return { meta, content: scan.contentText || '' };
}

// ---------------------------------------------------------------------------
// Codex account info
// ---------------------------------------------------------------------------

let cachedCodexAccount: string | undefined;

function getCodexAccount(): string | undefined {
  if (cachedCodexAccount !== undefined) return cachedCodexAccount || undefined;

  const candidates = [path.join(HOME, '.codex', 'auth.json')];

  const versionsBase = path.join(AGENTS_DIR, 'versions', 'codex');
  if (fs.existsSync(versionsBase)) {
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        candidates.push(path.join(versionsBase, version, 'home', '.codex', 'auth.json'));
      }
    } catch { /* versions dir unreadable */ }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      const idToken = data.tokens?.id_token;
      if (idToken) {
        const parts = idToken.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
          if (payload.email) {
            cachedCodexAccount = payload.email;
            return payload.email;
          }
        }
      }
    } catch { /* auth file or JWT malformed */ }
  }

  cachedCodexAccount = '';
  return undefined;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

async function scanCodexIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const account = getCodexAccount();
  const currentVersion = await getCurrentAgentVersion('codex');

  const filePaths: string[] = [];
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    // High limit: we only stat files here, parsing is gated by ledger match.
    for (const fp of walkForFiles(sessionsDir, '.jsonl', 100_000)) {
      filePaths.push(fp);
    }
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'codex', parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = await readCodexMeta(filePath, account, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'codex', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

async function readCodexMeta(
  filePath: string,
  account?: string,
  currentVersion?: string,
): Promise<{ meta: SessionMeta; content: string } | null> {
  const scan = await scanCodexSession(filePath);
  const sessionId = scan.sessionId || '';
  if (!sessionId) return null;

  const cwd = normalizeCwd(scan.cwd || '');
  const meta: SessionMeta = {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'codex',
    timestamp: scan.timestamp || new Date().toISOString(),
    project: cwd ? path.basename(cwd) : undefined,
    cwd,
    filePath,
    gitBranch: scan.gitBranch,
    version: resolveSessionVersion('codex', filePath, scan.version, currentVersion),
    topic: scan.topic,
    messageCount: scan.messageCount,
    tokenCount: scan.tokenCount,
    account,
  };
  return { meta, content: scan.contentText || '' };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function scanGeminiIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('gemini');
  const projectMap = buildGeminiProjectMap();

  const filePaths: Array<{ filePath: string; hashDir: string }> = [];
  for (const tmpDir of getAgentSessionDirs('gemini', 'tmp')) {
    let hashDirs: string[];
    try {
      hashDirs = fs.readdirSync(tmpDir);
    } catch {
      continue;
    }

    for (const hashDir of hashDirs) {
      const chatsDir = path.join(tmpDir, hashDir, 'chats');
      if (!fs.existsSync(chatsDir)) continue;

      let chatFiles: string[];
      try {
        chatFiles = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of chatFiles) {
        filePaths.push({ filePath: path.join(chatsDir, file), hashDir });
      }
    }
  }

  const changedPaths = filterChangedFiles(filePaths.map(f => f.filePath));
  const changedByPath = new Map(changedPaths.map(c => [c.filePath, c.scan]));
  if (changedByPath.size === 0) return;

  onProgress?.({ agent: 'gemini', parsed: 0, total: changedByPath.size });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, hashDir } of filePaths) {
    const scan = changedByPath.get(filePath);
    if (!scan) continue;
    try {
      const result = readGeminiMeta(filePath, hashDir, projectMap, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        // Gemini file without a sessionId — record scan so we don't re-parse it next run.
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'gemini', parsed, total: changedByPath.size });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

function readGeminiMeta(
  filePath: string,
  hashDir: string,
  projectMap: Map<string, { name: string; path: string }>,
  currentVersion?: string,
): { meta: SessionMeta; content: string } | null {
  let session: any;
  try {
    session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
  const startTime = typeof session.startTime === 'string' ? session.startTime : '';
  const projectHash = typeof session.projectHash === 'string' ? session.projectHash : '';
  const embeddedVersion = typeof session.version === 'string'
    ? session.version
    : typeof session.cliVersion === 'string'
      ? session.cliVersion
      : undefined;
  if (!sessionId) return null;

  const projectInfo = projectMap.get(projectHash || hashDir);
  const project = projectInfo?.name || hashDir.slice(0, 12);
  const cwd = projectInfo?.path ? normalizeCwd(projectInfo.path) : undefined;

  const stat = safeStatSync(filePath);

  const messages = Array.isArray(session.messages) ? session.messages : [];
  let topic: string | undefined;
  let messageCount = 0;
  let tokenCount = 0;
  let sawTokenCount = false;
  const userTexts: string[] = [];

  for (const message of messages) {
    if (message.type === 'user') {
      const text = extractGeminiMessageText(message.content);
      if (text) {
        messageCount++;
        userTexts.push(text);
        if (!topic) topic = extractSessionTopic(text);
      }
    } else if (message.type === 'gemini') {
      if (extractGeminiMessageText(message.content)) {
        messageCount++;
      }
    }

    const total = getGeminiTokenCount(message.tokens);
    if (total !== null) {
      tokenCount += total;
      sawTokenCount = true;
    }
  }

  const meta: SessionMeta = {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'gemini',
    timestamp: startTime || (stat ? stat.mtime.toISOString() : new Date().toISOString()),
    project,
    cwd,
    filePath,
    version: resolveSessionVersion('gemini', filePath, embeddedVersion, currentVersion),
    topic,
    messageCount,
    tokenCount: sawTokenCount ? tokenCount : undefined,
  };
  return { meta, content: userTexts.join('\n') };
}

function buildGeminiProjectMap(): Map<string, { name: string; path: string }> {
  const map = new Map<string, { name: string; path: string }>();
  const projectsJsonPath = path.join(HOME, '.gemini', 'projects.json');

  if (fs.existsSync(projectsJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf-8'));
      const projects = data.projects;

      if (typeof projects === 'object' && projects !== null) {
        if (Array.isArray(projects)) {
          for (const p of projects) {
            if (typeof p === 'string') {
              const hash = sha256(p);
              map.set(hash, { name: path.basename(p), path: p });
              map.set(p, { name: path.basename(p), path: p });
            }
          }
        } else {
          for (const [p, name] of Object.entries(projects)) {
            const hash = sha256(p);
            map.set(hash, { name: String(name), path: p });
          }
        }
      }
    } catch { /* projects.json missing or malformed */ }
  }

  const historyDir = path.join(HOME, '.gemini', 'history');
  if (fs.existsSync(historyDir)) {
    try {
      for (const name of fs.readdirSync(historyDir)) {
        const rootFile = path.join(historyDir, name, '.project_root');
        if (fs.existsSync(rootFile)) {
          try {
            const projectPath = fs.readFileSync(rootFile, 'utf-8').trim();
            if (projectPath) {
              const hash = sha256(projectPath);
              map.set(hash, { name, path: projectPath });
            }
          } catch { /* history entry unreadable */ }
        }
      }
    } catch { /* history entry unreadable */ }
  }

  return map;
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');

let cachedOpenCodeAccount: string | undefined;

function getOpenCodeAccount(): string | undefined {
  if (cachedOpenCodeAccount !== undefined) return cachedOpenCodeAccount || undefined;

  try {
    if (fs.existsSync(OPENCODE_DB)) {
      const out = execSync(
        `sqlite3 "${OPENCODE_DB}" "SELECT email FROM control_account WHERE active=1 LIMIT 1;"`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (out) {
        cachedOpenCodeAccount = out;
        return out;
      }
    }
  } catch { /* sqlite3 unavailable or DB locked */ }

  cachedOpenCodeAccount = '';
  return undefined;
}

async function scanOpenCodeIncremental(): Promise<void> {
  if (!fs.existsSync(OPENCODE_DB)) return;

  const stat = safeStatSync(OPENCODE_DB);
  if (!stat) return;

  // OpenCode is one big DB; we use its mtime/size as the ledger for the
  // entire fleet of OpenCode sessions.
  const currentScan: ScanStamp = {
    fileMtimeMs: Math.floor(stat.mtimeMs),
    fileSize: stat.size,
  };
  const prev = getScanStampByPath(OPENCODE_DB);
  if (prev && prev.fileMtimeMs === currentScan.fileMtimeMs && prev.fileSize === currentScan.fileSize) {
    return;
  }

  const account = getOpenCodeAccount();
  const currentVersion = await getCurrentAgentVersion('opencode');

  try {
    const query = `
      SELECT
        s.id,
        s.title,
        s.directory,
        s.version,
        s.time_created,
        COALESCE(stats.message_count, 0),
        stats.token_count,
        COALESCE(stats.has_token_data, 0)
      FROM session s
      LEFT JOIN (
        SELECT
          session_id,
          COUNT(*) AS message_count,
          SUM(
            COALESCE(json_extract(data, '$.tokens.input'), 0) +
            COALESCE(json_extract(data, '$.tokens.output'), 0) +
            COALESCE(json_extract(data, '$.tokens.reasoning'), 0) +
            COALESCE(json_extract(data, '$.tokens.cache.read'), 0) +
            COALESCE(json_extract(data, '$.tokens.cache.write'), 0)
          ) AS token_count,
          MAX(CASE WHEN json_type(data, '$.tokens') IS NOT NULL THEN 1 ELSE 0 END) AS has_token_data
        FROM message
        GROUP BY session_id
      ) stats ON stats.session_id = s.id
      WHERE s.parent_id IS NULL
      ORDER BY time_created DESC
      LIMIT 1000;
    `.replace(/\n/g, ' ');

    const out = execSync(
      `sqlite3 -separator '|||' "${OPENCODE_DB}"`,
      { encoding: 'utf-8', input: query, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 },
    );

    const entries: ScanEntry[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [id, title, directory, version, timeCreatedStr, messageCountStr, tokenCountStr, hasTokenDataStr] = line.split('|||');
      if (!id) continue;

      const timeCreated = parseInt(timeCreatedStr, 10);
      const messageCount = parseInt(messageCountStr, 10);
      const tokenCount = parseInt(tokenCountStr, 10);
      const hasTokenData = hasTokenDataStr === '1';
      const timestamp = isNaN(timeCreated) ? new Date().toISOString() : new Date(timeCreated).toISOString();
      const topic = title || undefined;

      const meta: SessionMeta = {
        id,
        shortId: id.replace(/^ses_/, '').slice(0, 8),
        agent: 'opencode',
        timestamp,
        project: directory ? path.basename(directory) : undefined,
        cwd: directory ? normalizeCwd(directory) : undefined,
        filePath: `${OPENCODE_DB}#${id}`,
        version: resolveSessionVersion('opencode', OPENCODE_DB, version || undefined, currentVersion),
        account,
        topic,
        messageCount: Number.isNaN(messageCount) ? undefined : messageCount,
        tokenCount: hasTokenData && !Number.isNaN(tokenCount) ? tokenCount : undefined,
      };

      entries.push({ meta, content: topic || '', scan: currentScan });
    }

    upsertSessionsBatch(entries);
    // Stamp the OpenCode DB itself so we can short-circuit on the next run.
    recordScans([{ filePath: OPENCODE_DB, scan: currentScan }]);
  } catch (err: any) {
    if (process.stderr.isTTY) {
      console.error(`Warning: Could not query OpenCode sessions: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// OpenClaw
// ---------------------------------------------------------------------------

async function scanOpenClawIncremental(): Promise<void> {
  // Check if openclaw is installed — silently skip if not.
  try {
    execSync('which openclaw', { stdio: 'ignore' });
  } catch {
    return;
  }

  // TTL cache: skip subprocess calls if we scanned recently. Stored in the
  // meta table so we skip even when no channels/cron exist to produce rows.
  const db = getDB();
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'openclaw_last_scan_ms'`).get() as { value: string } | undefined;
  const lastScanMs = row ? parseInt(row.value, 10) : 0;
  if (lastScanMs && Date.now() - lastScanMs < OPENCLAW_TTL_MS) {
    return;
  }

  const currentVersion = await getCurrentAgentVersion('openclaw');
  const now = Date.now();
  const scan: ScanStamp = { fileMtimeMs: now, fileSize: 0 };
  const entries: ScanEntry[] = [];

  try {
    const output = execSync('openclaw channels status', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    for (const line of output.split('\n')) {
      const match = line.match(/^-\s+\w+\s+(\S+)\s+\((\w+)\):\s*(.+)/);
      if (!match) continue;
      const [, agentId, name, statusStr] = match;
      if (!statusStr.includes('running')) continue;

      entries.push({
        meta: {
          id: `openclaw-${agentId}`,
          shortId: agentId.slice(0, 8),
          agent: 'openclaw',
          timestamp: new Date().toISOString(),
          project: name,
          cwd: getOpenClawSessionCwd(agentId),
          version: currentVersion,
          filePath: '',
        },
        content: `${name} ${agentId}`,
        scan,
      });
    }
  } catch {
    /* channels command failed */
  }

  try {
    const output = execSync('openclaw cron list', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const lines = output.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const headMatch = line.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)/);
      if (!headMatch) continue;
      const jobId = headMatch[1];
      const jobName = headMatch[2];

      const rest = line.slice(headMatch[0].length).trim();
      const cols = rest.split(/\s{2,}/);
      const agentId = cols[4] || '';

      entries.push({
        meta: {
          id: `openclaw-cron-${jobId}`,
          shortId: jobId.slice(0, 8),
          agent: 'openclaw',
          timestamp: new Date().toISOString(),
          project: `${jobName} (${agentId || 'unknown'})`,
          cwd: getOpenClawSessionCwd(agentId),
          version: currentVersion,
          filePath: '',
        },
        content: `${jobName} ${agentId}`,
        scan,
      });
    }
  } catch {
    /* cron command failed */
  }

  upsertSessionsBatch(entries);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('openclaw_last_scan_ms', ?)`).run(String(Date.now()));
}

async function scanClaudeSession(filePath: string): Promise<ClaudeSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let timestamp: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let topic: string | undefined;
  let messageCount = 0;
  let tokenCount = 0;
  let sawTokenCount = false;
  const seenAssistantIds = new Set<string>();
  const userTexts: string[] = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (!timestamp && (parsed.type === 'user' || parsed.type === 'assistant') && parsed.timestamp) {
        timestamp = parsed.timestamp;
        cwd = parsed.cwd || '';
        gitBranch = parsed.gitBranch || undefined;
        version = parsed.version || undefined;
      }

      if (parsed.type === 'user') {
        const text = extractClaudeUserText(parsed);
        if (text) {
          messageCount++;
          userTexts.push(text);
          if (!topic) topic = extractSessionTopic(text);
        }
        continue;
      }

      if (parsed.type !== 'assistant') continue;

      const assistantId = typeof parsed.message?.id === 'string'
        ? parsed.message.id
        : typeof parsed.uuid === 'string'
          ? parsed.uuid
          : undefined;

      const logicalId = assistantId || `${parsed.timestamp || ''}:${seenAssistantIds.size}`;
      if (seenAssistantIds.has(logicalId)) continue;
      seenAssistantIds.add(logicalId);
      messageCount++;

      const usage = getClaudeUsageTotal(parsed.message?.usage || parsed.usage);
      if (usage !== null) {
        tokenCount += usage;
        sawTokenCount = true;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    timestamp,
    cwd,
    gitBranch,
    version,
    topic,
    messageCount,
    tokenCount: sawTokenCount ? tokenCount : undefined,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
  };
}

async function scanCodexSession(filePath: string): Promise<CodexSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | undefined;
  let timestamp: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let topic: string | undefined;
  let messageCount = 0;
  let tokenCount: number | undefined;
  const userTexts: string[] = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.type === 'session_meta') {
        const payload = parsed.payload || {};
        sessionId = payload.id || sessionId;
        timestamp = payload.timestamp || parsed.timestamp || timestamp;
        cwd = payload.cwd || cwd;
        gitBranch = payload.git?.branch || gitBranch;
        version = payload.cli_version || payload.version || version;
        continue;
      }

      if (parsed.type === 'response_item' && parsed.payload?.type === 'message') {
        const role = parsed.payload.role === 'user' || parsed.payload.role === 'developer'
          ? 'user'
          : 'assistant';
        const text = extractCodexMessageText(parsed.payload.content, role);
        if (!text) continue;
        messageCount++;
        if (role === 'user') {
          userTexts.push(text);
          if (!topic) topic = extractSessionTopic(text);
        }
        continue;
      }

      if (parsed.type === 'event_msg' && parsed.payload?.type === 'token_count') {
        const total = getCodexTokenCount(parsed.payload.info?.total_token_usage);
        if (total !== null) tokenCount = total;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    sessionId,
    timestamp,
    cwd,
    gitBranch,
    version,
    topic,
    messageCount,
    tokenCount,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
  };
}

function getOpenClawSessionCwd(agentId?: string): string {
  const workspace = agentId ? getOpenClawWorkspaceMap().get(agentId) : undefined;
  if (workspace) return workspace;

  const configDir = AGENTS.openclaw.configDir;
  return safeRealpathSync(configDir) || configDir;
}

function getOpenClawWorkspaceMap(): Map<string, string> {
  if (cachedOpenClawWorkspaces) return cachedOpenClawWorkspaces;

  const workspaces = new Map<string, string>();
  const configPath = path.join(AGENTS.openclaw.configDir, 'openclaw.json');
  if (!fs.existsSync(configPath)) {
    cachedOpenClawWorkspaces = workspaces;
    return workspaces;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      agents?: { list?: Array<{ id?: string; workspace?: string }> };
    };

    for (const agent of config.agents?.list || []) {
      if (!agent.id || !agent.workspace) continue;
      workspaces.set(agent.id, safeRealpathSync(agent.workspace) || agent.workspace);
    }
  } catch {
    // Ignore invalid OpenClaw config and fall back to ~/.openclaw.
  }

  cachedOpenClawWorkspaces = workspaces;
  return workspaces;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function readFirstLines(filePath: string, maxLines: number): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (line.trim()) {
        lines.push(line);
      }
      if (lines.length >= maxLines) {
        rl.close();
        stream.destroy();
      }
    });

    rl.on('close', () => resolve(lines));
    rl.on('error', () => resolve(lines));
  });
}

/**
 * Walk a directory recursively for files with a given extension.
 */
export function walkForFiles(dir: string, ext: string, limit: number): string[] {
  const results: { path: string; mtime: number }[] = [];

  function walk(d: string, depth: number) {
    if (depth > 5) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(d);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(d, entry);
      const stat = safeStatSync(full);
      if (!stat) continue;

      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.endsWith(ext)) {
        results.push({ path: full, mtime: stat.mtimeMs });
      }
    }
  }

  walk(dir, 0);

  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit).map(r => r.path);
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function safeStatSync(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function safeRealpathSync(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function extractClaudeUserText(parsed: any): string | undefined {
  if (parsed.isMeta === true) return undefined;

  const content = parsed.message?.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return isLocalCommandMessage(text) ? undefined : text || undefined;
  }

  if (!Array.isArray(content)) return undefined;

  const text = content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => String(block.text || '').trim())
    .find((value: string) => value && !value.startsWith('[Request interrupted'));

  if (!text || isLocalCommandMessage(text)) return undefined;
  return text;
}

function isLocalCommandMessage(text: string): boolean {
  return /<local-command-caveat>|<bash-(input|stdout|stderr)>/i.test(text);
}

function getClaudeUsageTotal(usage: any): number | null {
  if (!usage || typeof usage !== 'object') return null;
  return sumKnownNumbers([
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ]);
}

function extractCodexMessageText(contentBlocks: any, role: 'user' | 'assistant'): string | undefined {
  if (!Array.isArray(contentBlocks)) return undefined;

  const matches = role === 'user'
    ? contentBlocks.filter((block: any) => block.type === 'input_text')
    : contentBlocks.filter((block: any) => block.type === 'output_text');

  const text = matches
    .map((block: any) => String(block.text || '').trim())
    .find((value: string) => {
      if (!value) return false;
      if (role === 'user' && (value.length >= 2000 || value.includes('<permissions instructions>') || value.startsWith('# AGENTS.md instructions'))) {
        return false;
      }
      return true;
    });

  return text || undefined;
}

function normalizeVersion(version?: string | null): string | undefined {
  const trimmed = version?.trim();
  return trimmed ? trimmed : undefined;
}

function extractVersionFromManagedPath(agent: SessionAgentId, sourcePath?: string): string | undefined {
  if (!sourcePath) return undefined;

  const candidates = [sourcePath, safeRealpathSync(sourcePath) || ''];
  const marker = `/.agents/versions/${agent}/`;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.split(path.sep).join('/');
    const start = normalized.indexOf(marker);
    if (start === -1) continue;
    const version = normalized.slice(start + marker.length).split('/')[0];
    if (version) return version;
  }

  return undefined;
}

async function getCurrentAgentVersion(agent: SessionAgentId): Promise<string | undefined> {
  const cached = cachedAgentVersions.get(agent);
  if (cached) return cached;

  const promise = (async () => {
    const symlinkVersion = normalizeVersion(getConfigSymlinkVersion(agent as AgentId));
    if (symlinkVersion) return symlinkVersion;
    return normalizeVersion(await getCliVersion(agent as AgentId));
  })();

  cachedAgentVersions.set(agent, promise);
  return promise;
}

function resolveSessionVersion(
  agent: SessionAgentId,
  sourcePath: string | undefined,
  embeddedVersion?: string,
  currentVersion?: string,
): string | undefined {
  return normalizeVersion(embeddedVersion)
    || extractVersionFromManagedPath(agent, sourcePath)
    || normalizeVersion(currentVersion);
}

function getCodexTokenCount(totalTokenUsage: any): number | null {
  if (!totalTokenUsage || typeof totalTokenUsage !== 'object') return null;
  return sumKnownNumbers([
    totalTokenUsage.input_tokens,
    totalTokenUsage.cached_input_tokens,
    totalTokenUsage.output_tokens,
    totalTokenUsage.reasoning_output_tokens,
  ]);
}

function extractGeminiMessageText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

function getGeminiTokenCount(tokens: any): number | null {
  if (!tokens || typeof tokens !== 'object') return null;
  if (typeof tokens.total === 'number') return tokens.total;
  return sumKnownNumbers([
    tokens.input,
    tokens.output,
    tokens.cached,
    tokens.thoughts,
    tokens.tool,
  ]);
}

function sumKnownNumbers(values: unknown[]): number | null {
  let total = 0;
  let found = false;

  for (const value of values) {
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    total += value;
    found = true;
  }

  return found ? total : null;
}

// ---------------------------------------------------------------------------
// Time range parsing
// ---------------------------------------------------------------------------

export function parseTimeFilter(input: string): number {
  const relativeMatch = input.match(/^(\d+)([mhdw])$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    if (unit === 'm') return Date.now() - value * 60_000;
    if (unit === 'h') return Date.now() - value * 3_600_000;
    if (unit === 'd') return Date.now() - value * 86_400_000;
    if (unit === 'w') return Date.now() - value * 7 * 86_400_000;
  }
  const ts = new Date(input).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}
