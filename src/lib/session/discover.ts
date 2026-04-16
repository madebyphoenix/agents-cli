import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { execSync } from 'child_process';
import type { SessionAgentId, SessionMeta } from './types.js';
import { SESSION_AGENTS } from './types.js';

const HOME = os.homedir();
const AGENTS_DIR = path.join(HOME, '.agents');
const SESSIONS_DIR = path.join(AGENTS_DIR, 'sessions');
const INDEX_PATH = path.join(SESSIONS_DIR, 'index.jsonl');

export interface DiscoverOptions {
  agent?: SessionAgentId;
  project?: string;
  limit?: number;
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
        case 'openclaw': return discoverOpenClawSessions();
      }
    })
  );

  let sessions = results.flat();

  // Merge with persistent index (preserves sessions whose files were removed)
  const index = loadIndex();
  const liveIds = new Set(sessions.map(s => s.id));
  index.forEach((entry, id) => {
    if (!liveIds.has(id)) {
      sessions.push(entry);
    }
  });

  // Persist updated index
  saveIndex(sessions);

  // Filter by project (case-insensitive substring match)
  if (options?.project) {
    const query = options.project.toLowerCase();
    sessions = sessions.filter(s => s.project?.toLowerCase().includes(query));
  }

  // Sort by timestamp descending
  sessions.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime() || 0;
    const tb = new Date(b.timestamp).getTime() || 0;
    return tb - ta;
  });

  return sessions.slice(0, limit);
}

/**
 * Resolve a session by full or short ID from the full index.
 */
export function resolveSessionById(sessions: SessionMeta[], idQuery: string): SessionMeta[] {
  const query = idQuery.toLowerCase();
  // Exact match first
  const exact = sessions.filter(s => s.id.toLowerCase() === query);
  if (exact.length > 0) return exact;
  // Prefix match
  return sessions.filter(s => s.id.toLowerCase().startsWith(query));
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
      } catch {}
    }
  } catch {}

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
      lines.push(JSON.stringify({
        id: s.id,
        shortId: s.shortId,
        agent: s.agent,
        timestamp: s.timestamp,
        project: s.project,
        cwd: s.cwd,
        filePath: s.filePath,
        gitBranch: s.gitBranch,
        version: s.version,
        account: s.account,
      }));
    }
    fs.writeFileSync(INDEX_PATH, lines.join('\n') + '\n', 'utf-8');
  } catch {}
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
function getAgentSessionDirs(agent: string, subdir: string): string[] {
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
    } catch {}
  }

  // 3. Backups (from before version management was enabled)
  const backupsBase = path.join(AGENTS_DIR, 'backups', agent);
  if (fs.existsSync(backupsBase)) {
    try {
      for (const ts of fs.readdirSync(backupsBase)) {
        addDir(path.join(backupsBase, ts, subdir));
      }
    } catch {}
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
    } catch {}
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
    } catch {}
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
        } catch {}
      }
    }
  }

  return sessions;
}

async function readClaudeMeta(filePath: string, sessionId: string, account?: string): Promise<SessionMeta | null> {
  const lines = await readFirstLines(filePath, 10);

  let topic: string | undefined;
  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract topic from first user message
    if (!topic && parsed.type === 'user' && parsed.message?.content) {
      const text = Array.isArray(parsed.message.content)
        ? parsed.message.content.find((b: any) => b.type === 'text')?.text
        : typeof parsed.message.content === 'string' ? parsed.message.content : undefined;
      if (text) topic = extractTopic(text);
    }

    // Look for first user or assistant line with timestamp/cwd
    if ((parsed.type === 'user' || parsed.type === 'assistant') && parsed.timestamp) {
      const cwd = parsed.cwd || '';
      return {
        id: sessionId,
        shortId: sessionId.slice(0, 8),
        agent: 'claude',
        timestamp: parsed.timestamp,
        project: cwd ? path.basename(cwd) : undefined,
        cwd,
        filePath,
        gitBranch: parsed.gitBranch || undefined,
        version: parsed.version || undefined,
        account,
        topic,
      };
    }
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
    } catch {}
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
    } catch {}
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

  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    const jsonlFiles = walkForFiles(sessionsDir, '.jsonl', 200);

    for (const filePath of jsonlFiles) {
      try {
        const meta = await readCodexMeta(filePath, account);
        if (meta && !seen.has(meta.id)) {
          seen.add(meta.id);
          sessions.push(meta);
        }
      } catch {}
    }
  }

  return sessions;
}

async function readCodexMeta(filePath: string, account?: string): Promise<SessionMeta | null> {
  const lines = await readFirstLines(filePath, 5);
  if (lines.length === 0) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    return null;
  }

  if (parsed.type !== 'session_meta') return null;

  const payload = parsed.payload || {};
  const sessionId = payload.id || '';
  if (!sessionId) return null;

  // Extract topic from first user message in subsequent lines
  let topic: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.type === 'message' && ev.role === 'user' && ev.content) {
        const text = typeof ev.content === 'string' ? ev.content
          : Array.isArray(ev.content) ? ev.content.find((b: any) => b.type === 'input_text')?.text : undefined;
        if (text) { topic = extractTopic(text); break; }
      }
    } catch {}
  }

  const cwd = payload.cwd || '';
  return {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'codex',
    timestamp: payload.timestamp || parsed.timestamp || new Date().toISOString(),
    project: cwd ? path.basename(cwd) : undefined,
    cwd,
    filePath,
    gitBranch: payload.git?.branch || undefined,
    version: payload.version || undefined,
    topic,
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
        } catch {}
      }
    }
  }

  return sessions;
}

function readGeminiMeta(
  filePath: string,
  hashDir: string,
  projectMap: Map<string, { name: string; path: string }>
): SessionMeta | null {
  // Read the first ~2KB to get top-level fields without parsing entire messages array
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(2048);
  const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
  fs.closeSync(fd);

  const header = buf.toString('utf-8', 0, bytesRead);

  // Extract fields via regex (avoids parsing potentially huge messages array)
  const sessionId = extractJsonField(header, 'sessionId');
  const startTime = extractJsonField(header, 'startTime');
  const projectHash = extractJsonField(header, 'projectHash');

  if (!sessionId) return null;

  // Resolve project name from hash
  const projectInfo = projectMap.get(projectHash || hashDir);
  const project = projectInfo?.name || hashDir.slice(0, 12);
  const cwd = projectInfo?.path;

  const stat = safeStatSync(filePath);

  // Try to extract first user message from the header bytes
  let topic: string | undefined;
  const userMsgMatch = header.match(/"role"\s*:\s*"user"[\s\S]*?"text"\s*:\s*"([^"]{1,200})"/);
  if (userMsgMatch) topic = extractTopic(userMsgMatch[1]);

  return {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'gemini',
    timestamp: startTime || (stat ? stat.mtime.toISOString() : new Date().toISOString()),
    project,
    cwd,
    filePath,
    topic,
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
  } catch {
    // Ignore parse errors
  }

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
          } catch {
            // Skip
          }
        }
      }
    } catch {
      // Skip
    }
  }

  return map;
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

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function readFirstLines(filePath: string, maxLines: number): Promise<string[]> {
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
function walkForFiles(dir: string, ext: string, limit: number): string[] {
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

function extractJsonField(text: string, field: string): string {
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, 'i');
  const match = text.match(re);
  return match ? match[1] : '';
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

function extractTopic(text: string): string {
  // Strip leading whitespace, slash commands, and system tags
  let clean = text.replace(/^[\s\n]+/, '').replace(/<[^>]+>/g, '').trim();
  // Take first line only
  const firstLine = clean.split('\n')[0].trim();
  return firstLine;
}
