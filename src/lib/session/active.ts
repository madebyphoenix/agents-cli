/**
 * Active-session detection across every context an agent can run in:
 *
 *   - `terminal` — agents launched from VS Code / Cursor / Codium via the
 *     swarmify extension. Published to `~/.agents/swarmify/live-terminals.json`
 *     with PID + session UUID per entry.
 *   - `teams`    — agents spawned by `agents teams add`, tracked in
 *     `~/.agents/teams/agents/<id>/meta.json` with a PID the manager polls.
 *   - `cloud`    — dispatched to Rush / Codex Cloud / Factory, tracked in
 *     the SQLite cache at `~/.agents/cloud/tasks.db`.
 *   - `headless` — bare `claude` / `codex` / `gemini` / `cursor-agent` /
 *     `opencode` processes that don't belong to any of the above. Detected
 *     by `ps` minus the PIDs we've already attributed.
 *
 * `running` vs `idle` is a secondary classification within the alive set:
 * the process is holding its session file, but the file's mtime is older
 * than ACTIVE_MTIME_WINDOW_MS, so it's probably waiting on the user.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { listActiveTasks } from '../cloud/store.js';
import { AgentManager } from '../teams/agents.js';

export type ActiveContext = 'terminal' | 'teams' | 'cloud' | 'headless';

export type ActiveStatus = 'running' | 'idle' | 'queued' | 'input_required';

export interface ActiveSession {
  context: ActiveContext;
  kind: string;
  /** Specific host app — 'code', 'cursor', 'codium', 'iterm', 'terminal', 'warp', 'tmux', etc. */
  host?: string;
  pid?: number;
  sessionId?: string;
  cwd?: string;
  label?: string;
  sessionFile?: string;
  startedAtMs?: number;
  status: ActiveStatus;
  teamName?: string;
  agentId?: string;
  cloudProvider?: string;
  cloudTaskId?: string;
  cloudStatus?: string;
}

export interface ActiveQueryOptions {
  /** Skip the `ps` scan for ad-hoc headless agents. */
  skipHeadless?: boolean;
}

const HOME = os.homedir();
const LIVE_TERMINALS_FILE = path.join(HOME, '.agents', 'swarmify', 'live-terminals.json');

/**
 * A process is classified `running` if its session file was touched in the
 * last 2 minutes. Every Claude/Codex tool-call appends an event, so a
 * healthy session writes several times a minute.
 */
const ACTIVE_MTIME_WINDOW_MS = 2 * 60_000;

/** Executables we recognize as agent CLIs when scanning the process table. */
const AGENT_CLI_NAMES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  'cursor-agent': 'cursor',
  opencode: 'opencode',
};

function isPidAlive(pid: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

interface LiveTerminalEntry {
  sessionId: string;
  pid: number;
  kind: string;
  label?: string | null;
  cwd?: string | null;
  startedAtMs: number;
}

/** Read swarmify's live-terminals registry, dedupe by sessionId, keep only pid-alive entries. */
function readLiveTerminals(): LiveTerminalEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(LIVE_TERMINALS_FILE, 'utf8');
  } catch {
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];

  const merged = new Map<string, LiveTerminalEntry>();
  for (const slice of Object.values(parsed) as any[]) {
    for (const e of (slice?.entries ?? []) as LiveTerminalEntry[]) {
      if (!e?.sessionId || !isPidAlive(e.pid)) continue;
      merged.set(e.sessionId, e);
    }
  }
  return Array.from(merged.values());
}

/** Convert an absolute cwd to the Claude-project folder name (slashes → dashes). */
function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Locate the active Claude session file for a process. If we know the session
 * UUID (from terminal env or team parent), prefer the exact match. Otherwise
 * fall back to the most-recent-mtime .jsonl in the project's folder.
 */
function findClaudeSessionFile(cwd: string, sessionId?: string): string | undefined {
  const projectDir = path.join(HOME, '.claude', 'projects', claudeProjectDirName(cwd));

  if (sessionId) {
    const specific = path.join(projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(specific)) return specific;
  }

  let files: string[];
  try {
    files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }

  let best: { path: string; mtime: number } | null = null;
  for (const f of files) {
    const p = path.join(projectDir, f);
    try {
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.mtime) best = { path: p, mtime: m };
    } catch { /* file vanished between readdir and stat */ }
  }
  return best?.path;
}

function classifyActivity(sessionFile: string | undefined): 'running' | 'idle' {
  if (!sessionFile) return 'running';
  try {
    const mtimeMs = fs.statSync(sessionFile).mtimeMs;
    return Date.now() - mtimeMs < ACTIVE_MTIME_WINDOW_MS ? 'running' : 'idle';
  } catch {
    return 'running';
  }
}

/** Live teams teammates. Reuses AgentManager which already polls PIDs via `kill -0`. */
export async function listTeamsActive(): Promise<ActiveSession[]> {
  const mgr = new AgentManager();
  const running = await mgr.listRunning();
  return running.map((a): ActiveSession => {
    const sessionId = a.parentSessionId ?? a.remoteSessionId ?? undefined;
    const sessionFile =
      a.agentType === 'claude' && a.cwd
        ? findClaudeSessionFile(a.cwd, sessionId ?? undefined)
        : undefined;
    return {
      context: 'teams',
      kind: a.agentType,
      pid: a.pid ?? undefined,
      sessionId,
      cwd: a.cwd ?? undefined,
      label: a.name ?? undefined,
      sessionFile,
      startedAtMs: a.startedAt.getTime(),
      status: classifyActivity(sessionFile),
      teamName: a.taskName,
      agentId: a.agentId,
    };
  });
}

/** Live editor-terminal agents across every IDE window. */
export function listTerminalsActive(): ActiveSession[] {
  const entries = readLiveTerminals();
  if (entries.length === 0) return [];

  // Walk the shell PIDs through the process table once so we can name the host
  // (code / cursor / codium) per entry rather than a generic 'terminal'.
  const procByPid = new Map<number, ProcRow>();
  for (const r of readProcessTable()) procByPid.set(r.pid, r);

  return entries.map((t): ActiveSession => {
    const sessionFile =
      t.kind === 'claude' && t.cwd
        ? findClaudeSessionFile(t.cwd, t.sessionId)
        : undefined;
    return {
      context: 'terminal',
      kind: t.kind,
      host: detectHost(t.pid, procByPid),
      pid: t.pid,
      sessionId: t.sessionId,
      cwd: t.cwd ?? undefined,
      label: t.label ?? undefined,
      sessionFile,
      startedAtMs: t.startedAtMs,
      status: classifyActivity(sessionFile),
    };
  });
}

/** Cloud tasks still in a non-terminal state. `tasks.db` may not exist; that's fine. */
export function listCloudActive(): ActiveSession[] {
  let tasks;
  try {
    tasks = listActiveTasks();
  } catch {
    return [];
  }
  return tasks.map((t): ActiveSession => ({
    context: 'cloud',
    kind: t.agent || 'cloud',
    label: t.prompt.length > 60 ? t.prompt.slice(0, 57) + '...' : t.prompt,
    startedAtMs: Date.parse(t.createdAt) || undefined,
    status: t.status === 'running'
      ? 'running'
      : t.status === 'input_required'
        ? 'input_required'
        : 'queued',
    cloudProvider: t.provider,
    cloudTaskId: t.id,
    cloudStatus: t.status,
  }));
}

interface ProcRow { pid: number; ppid: number; comm: string; kind?: string; }

/**
 * Ordered ancestor-process matchers. First match wins (most specific to least),
 * so an IDE renderer is preferred over the terminal-app that launched the IDE,
 * and a terminal-app is preferred over the multiplexer inside it.
 */
const HOST_MATCHERS: Array<{ host: string; tokens: string[] }> = [
  // IDE renderers (Electron helper processes)
  { host: 'code',     tokens: ['Code Helper', 'Code - Insiders Helper'] },
  { host: 'cursor',   tokens: ['Cursor Helper'] },
  { host: 'codium',   tokens: ['VSCodium Helper'] },
  { host: 'windsurf', tokens: ['Windsurf Helper'] },
  // Native terminal apps
  { host: 'iterm',    tokens: ['iTerm2', 'iTermServer', 'iTerm'] },
  { host: 'terminal', tokens: ['Terminal.app', '/Applications/Utilities/Terminal.app'] },
  { host: 'warp',     tokens: ['Warp.app', 'stable_'] },
  { host: 'alacritty',tokens: ['alacritty', 'Alacritty'] },
  { host: 'kitty',    tokens: ['kitty'] },
  { host: 'hyper',    tokens: ['Hyper.app', 'Hyper Helper'] },
  { host: 'wezterm',  tokens: ['wezterm', 'WezTerm'] },
  { host: 'ghostty',  tokens: ['ghostty', 'Ghostty'] },
  // Multiplexers (fallback — only if no UI found above them)
  { host: 'tmux',     tokens: ['tmux'] },
  { host: 'screen',   tokens: ['screen'] },
];

/**
 * Snapshot the whole process table in one `ps` call. Includes ppid so we can
 * walk ancestry chains to attribute child processes to their terminal hosts.
 * `comm` may be an absolute path for shim-launched agents, so basename before
 * matching against AGENT_CLI_NAMES.
 */
function readProcessTable(): ProcRow[] {
  let out: string;
  try {
    out = execSync('ps -A -o pid=,ppid=,comm=', { encoding: 'utf8' });
  } catch {
    return [];
  }
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const commRaw = m[3].trim();
    const kind = AGENT_CLI_NAMES[path.basename(commRaw)];
    rows.push({ pid, ppid, comm: commRaw, kind });
  }
  return rows;
}

/**
 * True when any ancestor in pid's parent chain is a known attributed PID.
 * VS Code / Cursor terminals store the *shell* PID in live-terminals.json,
 * while `ps` reports the *child* claude PID, so a direct set lookup misses.
 */
function hasAttributedAncestor(pid: number, ppidMap: Map<number, number>, attributed: Set<number>): boolean {
  let cur: number | undefined = ppidMap.get(pid);
  const seen = new Set<number>();
  while (cur && cur > 1 && !seen.has(cur)) {
    if (attributed.has(cur)) return true;
    seen.add(cur);
    cur = ppidMap.get(cur);
  }
  return false;
}

/**
 * Resolve a process's current working directory via `lsof`. The `-a` flag
 * ANDs the filters; without it macOS treats `-p` and `-d` as a union and
 * returns the cwd of every process on the system.
 */
function getCwdForPid(pid: number): string | undefined {
  let out: string;
  try {
    out = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, { encoding: 'utf8' });
  } catch {
    return undefined;
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1);
  }
  return undefined;
}

/**
 * Walk a pid's ancestor chain and return the most specific host app found.
 * Checks each HOST_MATCHERS entry against every ancestor, returns the first
 * host whose tokens match — so IDEs beat terminal apps, terminals beat
 * multiplexers. Returns undefined if nothing is recognised (true headless).
 */
function detectHost(pid: number, procByPid: Map<number, ProcRow>): string | undefined {
  const chain: string[] = [];
  let cur: number | undefined = procByPid.get(pid)?.ppid;
  const seen = new Set<number>();
  while (cur && cur > 1 && !seen.has(cur)) {
    const row = procByPid.get(cur);
    if (!row) break;
    chain.push(row.comm);
    seen.add(cur);
    cur = row.ppid;
  }

  for (const { host, tokens } of HOST_MATCHERS) {
    if (chain.some(c => tokens.some(t => c.includes(t)))) return host;
  }
  return undefined;
}

/** IDE / terminal / multiplexer hosts all count as UI-hosted. Absence = truly headless. */
const UI_HOSTS = new Set<string>([
  'code', 'cursor', 'codium', 'windsurf',
  'iterm', 'terminal', 'warp', 'alacritty', 'kitty', 'hyper', 'wezterm', 'ghostty',
  'tmux', 'screen',
]);

/**
 * Agent processes not attributed to a team or the swarmify registry.
 * Classified by walking the ppid chain: any recognised UI ancestor (IDE
 * helper, terminal-app, or multiplexer) means `terminal`; nothing of the
 * sort means `headless` (daemon, launchd-spawned, orphan).
 */
export function listUnattributedActive(attributed: Set<number>): ActiveSession[] {
  const table = readProcessTable();
  const procByPid = new Map<number, ProcRow>();
  const ppidMap = new Map<number, number>();
  for (const r of table) {
    procByPid.set(r.pid, r);
    ppidMap.set(r.pid, r.ppid);
  }

  const out: ActiveSession[] = [];
  for (const { pid, kind } of table) {
    if (!kind) continue;
    if (attributed.has(pid)) continue;
    if (hasAttributedAncestor(pid, ppidMap, attributed)) continue;

    const cwd = getCwdForPid(pid);
    const sessionFile = kind === 'claude' && cwd ? findClaudeSessionFile(cwd) : undefined;
    const host = detectHost(pid, procByPid);
    const context: ActiveContext = host && UI_HOSTS.has(host) ? 'terminal' : 'headless';
    out.push({
      context,
      kind,
      host,
      pid,
      cwd,
      sessionFile,
      status: classifyActivity(sessionFile),
    });
  }
  return out;
}

/**
 * Union of all four sources. Teams and terminals spawn actual CLI processes
 * that also show up in `ps`, so headless attribution runs last with the
 * already-attributed PIDs removed.
 */
export async function getActiveSessions(opts: ActiveQueryOptions = {}): Promise<ActiveSession[]> {
  const [teams, terminals, cloud] = await Promise.all([
    listTeamsActive().catch(() => [] as ActiveSession[]),
    Promise.resolve(listTerminalsActive()),
    Promise.resolve(listCloudActive()),
  ]);

  const knownPids = new Set<number>();
  for (const s of teams) if (s.pid) knownPids.add(s.pid);
  for (const s of terminals) if (s.pid) knownPids.add(s.pid);

  const unattributed = opts.skipHeadless ? [] : listUnattributedActive(knownPids);

  return [...teams, ...terminals, ...cloud, ...unattributed];
}
