import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { execSync } from 'child_process';
import type { SessionAgentId, SessionMeta } from './types.js';
import { SESSION_AGENTS } from './types.js';
import { extractSessionTopic } from './prompt.js';

const HOME = os.homedir();
const AGENTS_DIR = path.join(HOME, '.agents');
const SESSIONS_DIR = path.join(AGENTS_DIR, 'sessions');
const INDEX_PATH = path.join(SESSIONS_DIR, 'index.jsonl');

export interface DiscoverOptions {
  agent?: SessionAgentId;
  project?: string;
  all?: boolean;
  cwd?: string;
  limit?: number;
}

interface ClaudeSessionScan {
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  topic?: string;
  messageCount: number;
  tokenCount?: number;
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
}

/**
 * Discover sessions across all installed agents, versions, and backups.
 * Merges with a persistent index so sessions survive version removal.
 * Returns SessionMeta[] sorted by timestamp descending (most recent first).
 */
export async function discoverSessions(options?: DiscoverOptions): Promise<SessionMeta[]> {
  const agents = options?.agent ? [options.agent] : SESSION_AGENTS;
  const limit = options?.limit ?? 50;

  const results = await Promise.all(
    agents.map(agent => {
      switch (agent) {
        case 'claude': return discoverClaudeSessions();
        case 'codex': return discoverCodexSessions();
        case 'gemini': return discoverGeminiSessions();
        case 'opencode': return discoverOpenCodeSessions();
        case 'openclaw': return discoverOpenClawSessions();
      }
    })
  );

  let sessions = results.flat();

  // Merge with persistent index (preserves sessions whose files were removed)
  const index = loadIndex();
  const liveIds = new Set(sessions.map(s => s.id));
  const agentFilter = new Set(agents);

  // Add matching index entries to display results
  index.forEach((entry, id) => {
    if (!liveIds.has(id) && agentFilter.has(entry.agent)) {
      sessions.push(entry);
    }
  });

  // Persist: merge live sessions into full index (don't drop unqueried agents)
  const toSave = new Map(index);
  for (const s of sessions) {
    toSave.set(s.id, s);
  }
  saveIndex([...toSave.values()]);

  const projectQuery = options?.project?.trim();

  // Filter by project (case-insensitive substring match)
  if (projectQuery) {
    const query = projectQuery.toLowerCase();
    sessions = sessions.filter(s => s.project?.toLowerCase().includes(query));
  }

  // An explicit project search should scan across directories instead of
  // intersecting with the default cwd-only scope.
  if (!options?.all && !projectQuery) {
    const currentDir = normalizeCwd(options?.cwd || process.cwd());
    sessions = sessions.filter(s => normalizeCwd(s.cwd) === currentDir);
  }

  // Sort by timestamp descending
  sessions.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime() || 0;
    const tb = new Date(b.timestamp).getTime() || 0;
    return tb - ta;
  });

  return sessions.slice(0, limit);
}

function normalizeCwd(cwd?: string): string {
  if (!cwd) return '';
  const resolved = path.resolve(cwd);
  return safeRealpathSync(resolved) || resolved;
}

/**
 * Resolve a session by full or short ID from the full index.
 */
export function resolveSessionById(sessions: SessionMeta[], idQuery: string): SessionMeta[] {
  const query = idQuery.toLowerCase();
  // Exact match first (full id or shortId)
  const exact = sessions.filter(s =>
    s.id.toLowerCase() === query || s.shortId.toLowerCase() === query
  );
  if (exact.length > 0) return exact;
  // Prefix match (against both id and shortId)
  return sessions.filter(s =>
    s.id.toLowerCase().startsWith(query) || s.shortId.toLowerCase().startsWith(query)
  );
}

// ---------------------------------------------------------------------------
// Persistent session index
// ---------------------------------------------------------------------------

function loadIndex(): Map<string, SessionMeta> {
  const map = new Map<string, SessionMeta>();
  if (!fs.existsSync(INDEX_PATH)) return map;

  try {
    const content = fs.readFileSync(INDEX_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as SessionMeta;
        if (entry.id) map.set(entry.id, entry);
      } catch { /* malformed index entry, skip */ }
    }
  } catch (err: any) {
    console.error(`Warning: Could not load session cache (${err.message}). Rebuilding...`);
  }

  return map;
}

function saveIndex(sessions: SessionMeta[]): void {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    // Deduplicate by id, keeping the first occurrence (live sessions take priority)
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const s of sessions) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      lines.push(JSON.stringify(s));
    }
    fs.writeFileSync(INDEX_PATH, lines.join('\n') + '\n', 'utf-8');
  } catch (err: any) {
    console.error(`Warning: Could not save session cache: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Multi-version directory scanning
// ---------------------------------------------------------------------------

/**
 * Collect all directories to scan for an agent's sessions.
 * Scans: active config dir, all installed version homes, and backups.
 * Deduplicates by realpath to avoid double-counting the active symlink.
 *
 * @param agent - Agent name (claude, codex, gemini)
 * @param subdir - Subdirectory within the agent's config dir where sessions live
 *                 (e.g., 'projects' for Claude, 'sessions' for Codex, 'tmp' for Gemini)
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

  // 1. Active config (may be a symlink to the current version's home)
  addDir(path.join(HOME, `.${agent}`, subdir));

  // 2. All installed version homes
  const versionsBase = path.join(AGENTS_DIR, 'versions', agent);
  if (fs.existsSync(versionsBase)) {
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        addDir(path.join(versionsBase, version, 'home', `.${agent}`, subdir));
      }
    } catch { /* dir unreadable or missing */ }
  }

  // 3. Backups (from before version management was enabled)
  const backupsBase = path.join(AGENTS_DIR, 'backups', agent);
  if (fs.existsSync(backupsBase)) {
    try {
      for (const ts of fs.readdirSync(backupsBase)) {
        addDir(path.join(backupsBase, ts, subdir));
      }
    } catch { /* dir unreadable or missing */ }
  }

  return dirs;
}

// ---------------------------------------------------------------------------
// Claude account info
// ---------------------------------------------------------------------------

let cachedClaudeAccount: string | undefined;

function getClaudeAccount(): string | undefined {
  if (cachedClaudeAccount !== undefined) return cachedClaudeAccount || undefined;

  // Check all possible locations for .claude.json
  const candidates = [
    path.join(HOME, '.claude.json'),
  ];

  // Also check version homes (auth files are symlinked there)
  const versionsBase = path.join(AGENTS_DIR, 'versions', 'claude');
  if (fs.existsSync(versionsBase)) {
    try {
      for (const version of fs.readdirSync(versionsBase)) {
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

async function discoverClaudeSessions(): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = [];
  const seen = new Set<string>();
  const account = getClaudeAccount();
  let skipped = 0;

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

        const filePath = path.join(dirPath, file);
        try {
          const meta = await readClaudeMeta(filePath, sessionId, account);
          if (meta) sessions.push(meta);
        } catch { skipped++; }
      }
    }
  }

  if (skipped > 0 && process.env.AGENTS_DEBUG) {
    console.error(`[debug] Skipped ${skipped} unreadable Claude session(s)`);
  }

  return sessions;
}

async function readClaudeMeta(filePath: string, sessionId: string, account?: string): Promise<SessionMeta | null> {
  const scan = await scanClaudeSession(filePath);

  if (scan.timestamp) {
    const cwd = scan.cwd || '';
    return {
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
      messageCount: scan.messageCount,
      tokenCount: scan.tokenCount,
    };
  }

  // Fallback: use file mtime
  const stat = safeStatSync(filePath);
  return {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'claude',
    timestamp: stat ? stat.mtime.toISOString() : new Date().toISOString(),
    filePath,
    account,
    messageCount: scan.messageCount,
    tokenCount: scan.tokenCount,
    topic: scan.topic,
  };
}

// ---------------------------------------------------------------------------
// Codex account info
// ---------------------------------------------------------------------------

let cachedCodexAccount: string | undefined;

function getCodexAccount(): string | undefined {
  if (cachedCodexAccount !== undefined) return cachedCodexAccount || undefined;

  const candidates = [
    path.join(HOME, '.codex', 'auth.json'),
  ];

  // Also check version homes
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
      // Extract email from JWT id_token payload
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

async function discoverCodexSessions(): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = [];
  const seen = new Set<string>();
  const account = getCodexAccount();
  let skipped = 0;

  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    const jsonlFiles = walkForFiles(sessionsDir, '.jsonl', 200);

    for (const filePath of jsonlFiles) {
      try {
        const meta = await readCodexMeta(filePath, account);
        if (meta && !seen.has(meta.id)) {
          seen.add(meta.id);
          sessions.push(meta);
        }
      } catch { skipped++; }
    }
  }

  if (skipped > 0 && process.env.AGENTS_DEBUG) {
    console.error(`[debug] Skipped ${skipped} unreadable Codex session(s)`);
  }

  return sessions;
}

async function readCodexMeta(filePath: string, account?: string): Promise<SessionMeta | null> {
  const scan = await scanCodexSession(filePath);
  const sessionId = scan.sessionId || '';
  if (!sessionId) return null;

  const cwd = scan.cwd || '';
  return {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'codex',
    timestamp: scan.timestamp || new Date().toISOString(),
    project: cwd ? path.basename(cwd) : undefined,
    cwd,
    filePath,
    gitBranch: scan.gitBranch,
    version: scan.version,
    topic: scan.topic,
    messageCount: scan.messageCount,
    tokenCount: scan.tokenCount,
    account,
  };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function discoverGeminiSessions(): Promise<SessionMeta[]> {
  const projectMap = buildGeminiProjectMap();
  const sessions: SessionMeta[] = [];
  const seen = new Set<string>();
  let skipped = 0;

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
        const filePath = path.join(chatsDir, file);
        try {
          const meta = readGeminiMeta(filePath, hashDir, projectMap);
          if (meta && !seen.has(meta.id)) {
            seen.add(meta.id);
            sessions.push(meta);
          }
        } catch { skipped++; }
      }
    }
  }

  if (skipped > 0 && process.env.AGENTS_DEBUG) {
    console.error(`[debug] Skipped ${skipped} unreadable Gemini session(s)`);
  }

  return sessions;
}

function readGeminiMeta(
  filePath: string,
  hashDir: string,
  projectMap: Map<string, { name: string; path: string }>
): SessionMeta | null {
  let session: any;
  try {
    session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
  const startTime = typeof session.startTime === 'string' ? session.startTime : '';
  const projectHash = typeof session.projectHash === 'string' ? session.projectHash : '';
  if (!sessionId) return null;

  // Resolve project name from hash
  const projectInfo = projectMap.get(projectHash || hashDir);
  const project = projectInfo?.name || hashDir.slice(0, 12);
  const cwd = projectInfo?.path;

  const stat = safeStatSync(filePath);

  const messages = Array.isArray(session.messages) ? session.messages : [];
  let topic: string | undefined;
  let messageCount = 0;
  let tokenCount = 0;
  let sawTokenCount = false;

  for (const message of messages) {
    if (message.type === 'user') {
      const text = extractGeminiMessageText(message.content);
      if (text) {
        messageCount++;
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

  return {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'gemini',
    timestamp: startTime || (stat ? stat.mtime.toISOString() : new Date().toISOString()),
    project,
    cwd,
    filePath,
    topic,
    messageCount,
    tokenCount: sawTokenCount ? tokenCount : undefined,
  };
}

function buildGeminiProjectMap(): Map<string, { name: string; path: string }> {
  const map = new Map<string, { name: string; path: string }>();
  const projectsJsonPath = path.join(HOME, '.gemini', 'projects.json');

  if (!fs.existsSync(projectsJsonPath)) return map;

  try {
    const data = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf-8'));
    const projects = data.projects;

    if (typeof projects === 'object' && projects !== null) {
      if (Array.isArray(projects)) {
        // Array format: ["path1", "path2"]
        for (const p of projects) {
          if (typeof p === 'string') {
            const hash = sha256(p);
            map.set(hash, { name: path.basename(p), path: p });
            // Also try the raw directory name
            map.set(p, { name: path.basename(p), path: p });
          }
        }
      } else {
        // Object format: {path: name}
        for (const [p, name] of Object.entries(projects)) {
          const hash = sha256(p);
          map.set(hash, { name: String(name), path: p });
        }
      }
    }
  } catch { /* projects.json missing or malformed */ }

  // Also check ~/.gemini/history/*/.project_root for additional mappings
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

  // Try control_account table in the DB
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

async function discoverOpenCodeSessions(): Promise<SessionMeta[]> {
  if (!fs.existsSync(OPENCODE_DB)) return [];

  const account = getOpenCodeAccount();

  try {
    // Query sessions. time_created is millisecond epoch. Limit to 200 most recent.
    // Use session.title as topic (OpenCode auto-generates good titles).
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
      LIMIT 200;
    `.replace(/\n/g, ' ');

    const out = execSync(
      `sqlite3 -separator '|||' "${OPENCODE_DB}"`,
      { encoding: 'utf-8', input: query, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 },
    );

    const sessions: SessionMeta[] = [];

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

      sessions.push({
        id,
        shortId: id.replace(/^ses_/, '').slice(0, 8),
        agent: 'opencode',
        timestamp,
        project: directory ? path.basename(directory) : undefined,
        cwd: directory || undefined,
        filePath: `${OPENCODE_DB}#${id}`,
        version: version || undefined,
        account,
        topic,
        messageCount: Number.isNaN(messageCount) ? undefined : messageCount,
        tokenCount: hasTokenData && !Number.isNaN(tokenCount) ? tokenCount : undefined,
      });
    }

    return sessions;
  } catch (err: any) {
    if (process.stderr.isTTY) {
      console.error(`Warning: Could not query OpenCode sessions: ${err.message}`);
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// OpenClaw
// ---------------------------------------------------------------------------

async function discoverOpenClawSessions(): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = [];

  // Check if openclaw is installed
  try {
    execSync('which openclaw', { stdio: 'ignore' });
  } catch {
    return sessions;
  }

  // Discover active channels
  // Format: "- Telegram default (Jeff): enabled, configured, running, out:2h ago, mode:polling, token:config"
  try {
    const output = execSync('openclaw channels status', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    for (const line of output.split('\n')) {
      // Match: "- Telegram <agentId> (<Name>): ..., running, ..."
      const match = line.match(/^-\s+\w+\s+(\S+)\s+\((\w+)\):\s*(.+)/);
      if (!match) continue;
      const [, agentId, name, statusStr] = match;
      const isRunning = statusStr.includes('running');
      if (!isRunning) continue;

      sessions.push({
        id: `openclaw-${agentId}`,
        shortId: agentId.slice(0, 8),
        agent: 'openclaw',
        timestamp: new Date().toISOString(),
        project: name,
        filePath: '',
      });
    }
  } catch {
    // Command failed or not available
  }

  // Discover cron jobs
  // Output format (fixed-width columns, 1 space between UUID and name):
  //   6ec2cffe-39f8-480b-821f-0b20a2062550 paul-hourly  cron */30 ...  in 7h  48m ago  ok  isolated  paul  -
  // UUID is always 36 chars. Extract it first, then parse the rest.
  try {
    const output = execSync('openclaw cron list', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const lines = output.split('\n');
    // Skip header row
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Extract UUID (36 chars) and name from start of line
      const headMatch = line.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)/);
      if (!headMatch) continue;
      const jobId = headMatch[1];
      const jobName = headMatch[2];

      // Parse remaining columns (2+ whitespace separated)
      // Schedule+Next merge (cron expressions have internal spaces), so cols are:
      //   [schedule+next, last, status, target, agentId, model]
      const rest = line.slice(headMatch[0].length).trim();
      const cols = rest.split(/\s{2,}/);
      const status = cols[2] || '';
      const agentId = cols[4] || '';

      sessions.push({
        id: `openclaw-cron-${jobId}`,
        shortId: jobId.slice(0, 8),
        agent: 'openclaw',
        timestamp: new Date().toISOString(),
        project: `${jobName} (${agentId || 'unknown'})`,
        cwd: status,
        filePath: '',
      });
    }
  } catch {
    // Command failed or not available
  }

  return sessions;
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
        version = payload.version || version;
        continue;
      }

      if (parsed.type === 'response_item' && parsed.payload?.type === 'message') {
        const role = parsed.payload.role === 'user' || parsed.payload.role === 'developer'
          ? 'user'
          : 'assistant';
        const text = extractCodexMessageText(parsed.payload.content, role);
        if (!text) continue;
        messageCount++;
        if (role === 'user' && !topic) topic = extractSessionTopic(text);
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
  };
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
 * Returns at most `limit` files, sorted by mtime descending.
 */
export function walkForFiles(dir: string, ext: string, limit: number): string[] {
  const results: { path: string; mtime: number }[] = [];

  function walk(d: string, depth: number) {
    if (depth > 5) return; // Prevent deep recursion
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

  // Sort by mtime descending and limit
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
