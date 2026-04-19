import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { resolveAgentsDir, type ModelOverrides, type AgentConfig, type ReadConfigResult, readConfig, getModelForAgent } from './persistence.js';
import { normalizeEvents, AgentType } from './parsers.js';
import { debug } from './debug.js';

/**
 * Compute the Lowest Common Ancestor (LCA) of multiple file paths.
 * Returns the deepest common directory shared by all paths.
 * Returns null if paths is empty or paths have no common ancestor (different roots).
 */
export function computePathLCA(paths: string[]): string | null {
  const validPaths = paths.filter(p => p && p.trim());
  if (validPaths.length === 0) return null;
  if (validPaths.length === 1) return validPaths[0];

  // Normalize and split all paths into segments
  const splitPaths = validPaths.map(p => {
    const normalized = path.resolve(p);
    // Split by path separator, filter empty segments
    return normalized.split(path.sep).filter(seg => seg);
  });

  // Find minimum length
  const minLen = Math.min(...splitPaths.map(p => p.length));

  // Find common prefix
  const commonSegments: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const segment = splitPaths[0][i];
    const allMatch = splitPaths.every(p => p[i] === segment);
    if (allMatch) {
      commonSegments.push(segment);
    } else {
      break;
    }
  }

  if (commonSegments.length === 0) return null;

  // Reconstruct path (add leading separator for absolute paths)
  const lca = path.sep + commonSegments.join(path.sep);
  return lca;
}

export enum AgentStatus {
  PENDING = 'pending',     // staged with unresolved --after deps
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  STOPPED = 'stopped',
}

/**
 * Walk the `after` chain from `startName` within the given map; returns true
 * if `targetName` appears anywhere in the transitive dependency closure.
 * Used to detect cycles before adding a new --after edge.
 */
function hasTransitiveDep(
  byName: Map<string, { after: string[] }>,
  startName: string,
  targetName: string,
  seen: Set<string> = new Set()
): boolean {
  if (seen.has(startName)) return false;
  seen.add(startName);
  const node = byName.get(startName);
  if (!node) return false;
  for (const dep of node.after) {
    if (dep === targetName) return true;
    if (hasTransitiveDep(byName, dep, targetName, seen)) return true;
  }
  return false;
}

export type { AgentType } from './parsers.js';

// Base commands for plan mode (read-only, may prompt for confirmation)
export const AGENT_COMMANDS: Record<AgentType, string[]> = {
  codex: ['codex', 'exec', '--sandbox', 'workspace-write', '{prompt}', '--json'],
  cursor: ['cursor-agent', '-p', '--output-format', 'stream-json', '{prompt}'],
  gemini: ['gemini', '{prompt}', '--output-format', 'stream-json', '--approval-mode', 'plan'],
  claude: ['claude', '-p', '--verbose', '{prompt}', '--output-format', 'stream-json', '--permission-mode', 'plan'],
  opencode: ['opencode', 'run', '--format', 'json', '{prompt}'],
};

// Effort level type
export type EffortLevel = 'fast' | 'default' | 'detailed';
export type EffortModelMap = Record<EffortLevel, Record<AgentType, string>>;

// Build effort model map from agent configs
export function resolveEffortModelMap(
  baseOrAgentConfigs: EffortModelMap | Record<AgentType, AgentConfig>,
  overrides?: Partial<Record<AgentType, Partial<Record<EffortLevel, string>>>>
): EffortModelMap {
  // Check if first arg is base EffortModelMap (old API) or agent configs (new API)
  const hasBaseOverrides = arguments.length > 1;

  if (hasBaseOverrides && overrides) {
    // Old API: resolveEffortModelMap(base, overrides)
    const base = baseOrAgentConfigs as EffortModelMap;
    const resolved: EffortModelMap = {
      fast: { ...base.fast },
      default: { ...base.default },
      detailed: { ...base.detailed }
    };

    for (const [agentType, effortOverrides] of Object.entries(overrides)) {
      if (!effortOverrides) continue;
      const typedAgent = agentType as AgentType;
      for (const level of ['fast', 'default', 'detailed'] as const) {
        const model = effortOverrides[level];
        if (typeof model === 'string') {
          const trimmed = model.trim();
          if (trimmed) {
            resolved[level][typedAgent] = trimmed;
          }
        }
      }
    }

    return resolved;
  } else {
    // New API: resolveEffortModelMap(agentConfigs)
    const agentConfigs = baseOrAgentConfigs as Record<AgentType, AgentConfig>;
    const resolved: EffortModelMap = {
      fast: {} as Record<AgentType, string>,
      default: {} as Record<AgentType, string>,
      detailed: {} as Record<AgentType, string>
    };

    for (const [agentType, agentConfig] of Object.entries(agentConfigs)) {
      resolved.fast[agentType as AgentType] = agentConfig.models.fast;
      resolved.default[agentType as AgentType] = agentConfig.models.default;
      resolved.detailed[agentType as AgentType] = agentConfig.models.detailed;
    }

    return resolved;
  }
}

// Load default agent configs from persistence
function loadDefaultAgentConfigs(): Record<AgentType, AgentConfig> {
  // Use hardcoded defaults for backward compatibility with synchronous initialization
  return {
    claude: {
      command: 'claude -p \'{prompt}\' --output-format stream-json --json',
      enabled: true,
      models: {
        fast: 'claude-haiku-4-5-20251001',
        default: 'claude-sonnet-4-5',
        detailed: 'claude-opus-4-5'
      },
      provider: 'anthropic'
    },
    codex: {
      command: 'codex exec --sandbox workspace-write \'{prompt}\' --json',
      enabled: true,
      models: {
        fast: 'gpt-4o-mini',
        default: 'gpt-5.2-codex',
        detailed: 'gpt-5.1-codex-max'
      },
      provider: 'openai'
    },
    gemini: {
      command: 'gemini \'{prompt}\' --output-format stream-json',
      enabled: true,
      models: {
        fast: 'gemini-3-flash-preview',
        default: 'gemini-3-flash-preview',
        detailed: 'gemini-3-pro-preview'
      },
      provider: 'google'
    },
    cursor: {
      command: 'cursor-agent -p --output-format stream-json \'{prompt}\'',
      enabled: true,
      models: {
        fast: 'composer-1',
        default: 'composer-1',
        detailed: 'composer-1'
      },
      provider: 'custom'
    },
    opencode: {
      command: 'opencode run --format json \'{prompt}\'',
      enabled: true,
      models: {
        fast: 'zai-coding-plan/glm-4.7-flash',
        default: 'zai-coding-plan/glm-4.7',
        detailed: 'zai-coding-plan/glm-4.7'
      },
      provider: 'custom'
    }
  };
}


// Default effort model map (for backward compatibility with tests)
export const EFFORT_MODEL_MAP: EffortModelMap = resolveEffortModelMap(loadDefaultAgentConfigs());

// Suffix appended to all prompts to ensure agents provide a summary
const PROMPT_SUFFIX = `

When you're done, provide a brief summary of:
1. What you did (1-2 sentences)
2. Key files modified and why
3. Any important classes, functions, or components you added/changed`;

// Prefix for Claude agents in plan mode - explains the headless plan mode restrictions
const CLAUDE_PLAN_MODE_PREFIX = `You are running in HEADLESS PLAN MODE. This mode works like normal plan mode with one exception: you cannot write to ~/.claude/plans/ directory. Instead of writing a plan file, output your complete plan/response as your final message.

`;

const VALID_MODES = ['plan', 'edit', 'ralph', 'cloud'] as const;
type Mode = typeof VALID_MODES[number];

function normalizeModeValue(modeValue: string | null | undefined): Mode | null {
  if (!modeValue) return null;
  const normalized = modeValue.trim().toLowerCase();
  if (VALID_MODES.includes(normalized as Mode)) {
    return normalized as Mode;
  }
  return null;
}

function defaultModeFromEnv(): Mode {
  for (const envVar of ['AGENTS_MCP_MODE', 'AGENTS_MCP_DEFAULT_MODE']) {
    const rawValue = process.env[envVar];
    const parsed = normalizeModeValue(rawValue);
    if (parsed) {
      return parsed;
    }
    if (rawValue) {
      console.warn(`Invalid ${envVar}='${rawValue}'. Use 'plan' or 'edit'. Falling back to plan mode.`);
    }
  }
  return 'plan';
}

function coerceDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date;
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function extractTimestamp(raw: any): Date | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidates = [
    raw.timestamp,
    raw.time,
    raw.created_at,
    raw.createdAt,
    raw.ts,
    raw.started_at,
    raw.startedAt,
  ];

  for (const candidate of candidates) {
    const date = coerceDate(candidate);
    if (date) return date;
  }

  return null;
}

export function resolveMode(
  requestedMode: string | null | undefined,
  defaultMode: Mode = 'plan'
): Mode {
  const normalizedDefault = normalizeModeValue(defaultMode);
  if (!normalizedDefault) {
    throw new Error(`Invalid default mode '${defaultMode}'. Use 'plan' or 'edit'.`);
  }

  if (requestedMode !== null && requestedMode !== undefined) {
    const normalizedMode = normalizeModeValue(requestedMode);
    if (!normalizedMode) {
      throw new Error(`Invalid mode '${requestedMode}'. Valid modes: 'plan' (read-only) or 'edit' (can write).`);
    }
    return normalizedMode;
  }

  return normalizedDefault;
}

export async function ensureGeminiPlanMode(): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
  try {
    let settings: Record<string, any> = {};
    try {
      const raw = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(raw);
    } catch {
      // No settings file or invalid JSON
    }

    if (settings.experimental?.plan === true) return;

    settings.experimental = { ...settings.experimental, plan: true };
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.error('[Swarm] Enabled Gemini experimental.plan in', settingsPath);
  } catch (err) {
    console.warn('[Swarm] Could not enable Gemini plan mode:', err);
  }
}

export function checkCliAvailable(agentType: AgentType): [boolean, string | null] {
  const cmdTemplate = AGENT_COMMANDS[agentType];
  if (!cmdTemplate) {
    return [false, `Unknown agent type: ${agentType}`];
  }

  const executable = cmdTemplate[0];
  try {
    const whichPath = execSync(`which ${executable}`, { encoding: 'utf-8' }).trim();
    return [true, whichPath];
  } catch {
    return [false, `CLI tool '${executable}' not found in PATH. Install it first.`];
  }
}

export function checkAllClis(): Record<string, { installed: boolean; path: string | null; error: string | null }> {
  const results: Record<string, { installed: boolean; path: string | null; error: string | null }> = {};
  for (const agentType of Object.keys(AGENT_COMMANDS) as AgentType[]) {
    const [available, pathOrError] = checkCliAvailable(agentType);
    if (available) {
      results[agentType] = { installed: true, path: pathOrError, error: null };
    } else {
      results[agentType] = { installed: false, path: null, error: pathOrError };
    }
  }
  return results;
}

let AGENTS_DIR: string | null = null;

export async function getAgentsDir(): Promise<string> {
  if (!AGENTS_DIR) {
    AGENTS_DIR = await resolveAgentsDir();
  }
  return AGENTS_DIR;
}

export class AgentProcess {
  agentId: string;
  taskName: string;
  agentType: AgentType;
  prompt: string;
  cwd: string | null;
  workspaceDir: string | null;
  mode: Mode = 'plan';
  pid: number | null = null;
  status: AgentStatus = AgentStatus.RUNNING;
  startedAt: Date = new Date();
  completedAt: Date | null = null;
  parentSessionId: string | null = null;
  cloudSessionId: string | null = null;
  cloudProvider: string | null = null;
  prUrl: string | null = null;
  version: string | null = null;
  remoteSessionId: string | null = null;
  name: string | null = null;
  // Names of teammates in the same team that this teammate is waiting on.
  // Empty array = no deps = can run immediately. Populated by `teams add --after`.
  after: string[] = [];
  // Stashed so we can resolve the model at launch time when a pending teammate
  // is finally started (could be later than spawn time; model map may shift).
  effort: EffortLevel | null = null;
  private eventsCache: any[] = [];
  private lastReadPos: number = 0;
  private baseDir: string | null = null;

  constructor(
    agentId: string,
    taskName: string,
    agentType: AgentType,
    prompt: string,
    cwd: string | null = null,
    mode: Mode = 'plan',
    pid: number | null = null,
    status: AgentStatus = AgentStatus.RUNNING,
    startedAt: Date = new Date(),
    completedAt: Date | null = null,
    baseDir: string | null = null,
    parentSessionId: string | null = null,
    workspaceDir: string | null = null,
    cloudSessionId: string | null = null,
    cloudProvider: string | null = null,
    prUrl: string | null = null,
    version: string | null = null,
    remoteSessionId: string | null = null,
    name: string | null = null,
    after: string[] = [],
    effort: EffortLevel | null = null
  ) {
    this.agentId = agentId;
    this.remoteSessionId = remoteSessionId;
    this.name = name;
    this.after = after;
    this.effort = effort;
    this.taskName = taskName;
    this.agentType = agentType;
    this.prompt = prompt;
    this.cwd = cwd;
    this.workspaceDir = workspaceDir;
    this.mode = mode;
    this.pid = pid;
    this.status = status;
    this.startedAt = startedAt;
    this.completedAt = completedAt;
    this.baseDir = baseDir;
    this.parentSessionId = parentSessionId;
    this.cloudSessionId = cloudSessionId;
    this.cloudProvider = cloudProvider;
    this.prUrl = prUrl;
    this.version = version;
  }

  get isEditMode(): boolean {
    return this.mode === 'edit' || this.mode === 'cloud';
  }

  async getAgentDir(): Promise<string> {
    const base = this.baseDir || await getAgentsDir();
    return path.join(base, this.agentId);
  }

  async getStdoutPath(): Promise<string> {
    return path.join(await this.getAgentDir(), 'stdout.log');
  }

  async getMetaPath(): Promise<string> {
    return path.join(await this.getAgentDir(), 'meta.json');
  }

  toDict(): any {
    return {
      agent_id: this.agentId,
      task_name: this.taskName,
      agent_type: this.agentType,
      status: this.status,
      started_at: this.startedAt.toISOString(),
      completed_at: this.completedAt?.toISOString() || null,
      event_count: this.events.length,
      duration: this.duration(),
      mode: this.mode,
      parent_session_id: this.parentSessionId,
      workspace_dir: this.workspaceDir,
      cloud_session_id: this.cloudSessionId,
      cloud_provider: this.cloudProvider,
      pr_url: this.prUrl,
      version: this.version,
      remote_session_id: this.remoteSessionId,
      name: this.name,
      after: this.after,
      effort: this.effort,
    };
  }

  duration(): string | null {
    let seconds: number;
    if (this.completedAt) {
      seconds = (this.completedAt.getTime() - this.startedAt.getTime()) / 1000;
    } else if (this.status === AgentStatus.RUNNING) {
      seconds = (Date.now() - this.startedAt.getTime()) / 1000;
    } else {
      return null;
    }

    if (seconds < 60) {
      return `${Math.floor(seconds)} seconds`;
    } else {
      const minutes = seconds / 60;
      return `${minutes.toFixed(1)} minutes`;
    }
  }

  get events(): any[] {
    return this.eventsCache;
  }

  /**
   * Return the latest timestamp we have seen in the agent's events.
   * Falls back to null when none are available.
   */
  private getLatestEventTime(): Date | null {
    let latest: Date | null = null;

    for (const event of this.eventsCache) {
      const ts = event?.timestamp;
      if (!ts) continue;
      const parsed = new Date(ts);
      if (!Number.isNaN(parsed.getTime())) {
        if (!latest || parsed > latest) {
          latest = parsed;
        }
      }
    }

    return latest;
  }

  async readNewEvents(): Promise<void> {
    const stdoutPath = await this.getStdoutPath();
    try {
      const stats = await fs.stat(stdoutPath).catch(() => null);
      if (!stats) return;
      const fallbackTimestamp = (stats.mtime || new Date()).toISOString();

      const fd = await fs.open(stdoutPath, 'r');
      const buffer = Buffer.alloc(1024 * 1024);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, this.lastReadPos);
      await fd.close();

      if (bytesRead === 0) return;

      const newContent = buffer.toString('utf-8', 0, bytesRead);
      this.lastReadPos += bytesRead;

      const lines = newContent.split('\n').map(l => l.trim()).filter(l => l);
      for (const line of lines) {
        try {
          const rawEvent = JSON.parse(line);
          const events = normalizeEvents(this.agentType, rawEvent);
          const resolvedTimestamp = extractTimestamp(rawEvent)?.toISOString() || fallbackTimestamp;
          for (const event of events) {
            event.timestamp = resolvedTimestamp;
            this.eventsCache.push(event);

            // Capture the agent's own session/thread id the first time we see
            // it. For Claude it's the same uuid we passed via --session-id;
            // for others (Codex thread_id, Gemini/Cursor/OpenCode sessionID)
            // it's their internal id, which lets us cross-reference with
            // `agents sessions view <id>`.
            if (!this.remoteSessionId && event.session_id) {
              this.remoteSessionId = event.session_id;
            }

            if (event.type === 'result' || event.type === 'turn.completed' || event.type === 'thread.completed') {
              if (event.status === 'success' || event.type === 'turn.completed') {
                this.status = AgentStatus.COMPLETED;
                this.completedAt = event.timestamp ? new Date(event.timestamp) : new Date();
              } else if (event.status === 'error') {
                this.status = AgentStatus.FAILED;
                this.completedAt = event.timestamp ? new Date(event.timestamp) : new Date();
              }
            }
          }
        } catch {
          this.eventsCache.push({
            type: 'raw',
            content: line,
            timestamp: fallbackTimestamp,
          });
        }
      }
    } catch (err) {
      console.error(`Error reading events for agent ${this.agentId}:`, err);
    }
  }

  async saveMeta(): Promise<void> {
    const agentDir = await this.getAgentDir();
    await fs.mkdir(agentDir, { recursive: true });
    const meta = {
      agent_id: this.agentId,
      task_name: this.taskName,
      agent_type: this.agentType,
      prompt: this.prompt,
      cwd: this.cwd,
      workspace_dir: this.workspaceDir,
      mode: this.mode,
      pid: this.pid,
      status: this.status,
      started_at: this.startedAt.toISOString(),
      completed_at: this.completedAt?.toISOString() || null,
      parent_session_id: this.parentSessionId,
      cloud_session_id: this.cloudSessionId,
      cloud_provider: this.cloudProvider,
      pr_url: this.prUrl,
      version: this.version,
      remote_session_id: this.remoteSessionId,
      name: this.name,
      after: this.after,
      effort: this.effort,
    };
    const metaPath = await this.getMetaPath();
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
  }

  static async loadFromDisk(agentId: string, baseDir: string | null = null): Promise<AgentProcess | null> {
    const base = baseDir || await getAgentsDir();
    const agentDir = path.join(base, agentId);
    const metaPath = path.join(agentDir, 'meta.json');

    try {
      await fs.access(metaPath);
    } catch {
      return null;
    }

    try {
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(metaContent);

      const modeMap: Record<string, Mode> = { edit: 'edit', ralph: 'ralph', cloud: 'cloud' };
      const resolvedMode: Mode = modeMap[meta.mode] || 'plan';

      const agent = new AgentProcess(
        meta.agent_id,
        meta.task_name || 'default',
        meta.agent_type,
        meta.prompt,
        meta.cwd || null,
        resolvedMode,
        meta.pid || null,
        AgentStatus[meta.status as keyof typeof AgentStatus] || AgentStatus.RUNNING,
        new Date(meta.started_at),
        meta.completed_at ? new Date(meta.completed_at) : null,
        baseDir,
        meta.parent_session_id || null,
        meta.workspace_dir || null,
        meta.cloud_session_id || null,
        meta.cloud_provider || null,
        meta.pr_url || null,
        meta.version || null,
        meta.remote_session_id || null,
        meta.name || null,
        Array.isArray(meta.after) ? meta.after : [],
        meta.effort || null
      );
      return agent;
    } catch {
      return null;
    }
  }

  isProcessAlive(): boolean {
    if (!this.pid) return false;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async updateStatusFromProcess(): Promise<void> {
    if (this.mode === 'cloud') {
      await this.readNewEvents();
      return;
    }

    if (!this.pid) return;

    if (this.isProcessAlive()) {
      await this.readNewEvents();
      return;
    }

    if (this.status === AgentStatus.RUNNING) {
      const exitCode = await this.reapProcess();
      await this.readNewEvents();

      if (this.status === AgentStatus.RUNNING) {
        const fallbackCompletion =
          this.getLatestEventTime() || this.startedAt || new Date();
        if (exitCode !== null && exitCode !== 0) {
          this.status = AgentStatus.FAILED;
        } else {
          this.status = AgentStatus.COMPLETED;
        }
        this.completedAt = fallbackCompletion;
      }
    } else if (!this.completedAt) {
      await this.readNewEvents();
      const fallbackCompletion =
        this.getLatestEventTime() || this.startedAt || new Date();
      this.completedAt = fallbackCompletion;
    }

    await this.saveMeta();
  }

  private async reapProcess(): Promise<number | null> {
    if (!this.pid) return null;
    try {
      process.kill(this.pid, 0);
      return null;
    } catch {
      return 1;
    }
  }
}

 export class AgentManager {
  private agents: Map<string, AgentProcess> = new Map();
  private maxAgents: number;
  private maxConcurrent: number;
  private agentsDir: string = '';
  private filterByCwd: string | null;
  private cleanupAgeDays: number;
  private defaultMode: Mode;
  private effortModelMap!: EffortModelMap;
  private agentConfigs!: Record<AgentType, AgentConfig>;
  private constructorAgentConfigs: Record<AgentType, AgentConfig> | null = null;
  private initPromise: Promise<void> | null = null;

  private constructorAgentsDir: string | null = null;

  constructor(
    maxAgents: number = 50,
    maxConcurrent: number = 10,
    agentsDir: string | null = null,
    defaultMode: Mode | null = null,
    filterByCwd: string | null = null,
    cleanupAgeDays: number = 7,
    agentConfigs: Record<AgentType, AgentConfig> | null = null
  ) {
    this.maxAgents = maxAgents;
    this.maxConcurrent = maxConcurrent;
    this.constructorAgentsDir = agentsDir;
    this.filterByCwd = filterByCwd;
    this.cleanupAgeDays = cleanupAgeDays;
    const resolvedDefaultMode = defaultMode ? normalizeModeValue(defaultMode) : defaultModeFromEnv();
    if (!resolvedDefaultMode) {
      throw new Error(`Invalid default_mode '${defaultMode}'. Use 'plan' or 'edit'.`);
    }
    this.defaultMode = resolvedDefaultMode;
    this.constructorAgentConfigs = agentConfigs;

    this.initPromise = this.doInitialize();
  }

  private async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.agentsDir = this.constructorAgentsDir || await getAgentsDir();
    await fs.mkdir(this.agentsDir, { recursive: true });

    // Set defaults if no config provided
    if (!this.constructorAgentConfigs) {
      this.agentConfigs = loadDefaultAgentConfigs();
      this.effortModelMap = resolveEffortModelMap(this.agentConfigs);
    } else {
      this.effortModelMap = resolveEffortModelMap(this.constructorAgentConfigs);
    }

    await this.loadExistingAgents();
  }

  getDefaultMode(): Mode {
    return this.defaultMode;
  }

  setModelOverrides(agentConfigs: Record<AgentType, AgentConfig>): void {
    this.agentConfigs = agentConfigs;
    this.effortModelMap = resolveEffortModelMap(agentConfigs);
  }

  registerAgent(agent: AgentProcess): void {
    this.agents.set(agent.agentId, agent);
  }

  private async loadExistingAgents(): Promise<void> {
    try {
      await fs.access(this.agentsDir);
    } catch {
      return;
    }

    const cutoffDate = new Date(Date.now() - this.cleanupAgeDays * 24 * 60 * 60 * 1000);
    let loadedCount = 0;
    let skippedCwd = 0;
    let cleanedOld = 0;

    const entries = await fs.readdir(this.agentsDir);
    for (const entry of entries) {
      const agentDir = path.join(this.agentsDir, entry);
      const stat = await fs.stat(agentDir).catch(() => null);
      if (!stat || !stat.isDirectory()) continue;

      const agentId = entry;
      const agent = await AgentProcess.loadFromDisk(agentId, this.agentsDir);
      if (!agent) continue;

      if (agent.completedAt && agent.completedAt < cutoffDate) {
        try {
          await fs.rm(agentDir, { recursive: true });
          cleanedOld++;
        } catch (err) {
          console.warn(`Failed to cleanup old agent ${agentId}:`, err);
        }
        continue;
      }

      if (this.filterByCwd !== null) {
        const agentCwd = agent.cwd;
        if (agentCwd !== this.filterByCwd) {
          skippedCwd++;
          continue;
        }
      }

      await agent.updateStatusFromProcess();
      this.agents.set(agentId, agent);
      loadedCount++;
    }

    if (cleanedOld > 0) {
      debug(`Cleaned up ${cleanedOld} old agents (older than ${this.cleanupAgeDays} days)`);
    }
    if (skippedCwd > 0) {
      debug(`Skipped ${skippedCwd} agents (different CWD)`);
    }
    debug(`Loaded ${loadedCount} agents from disk`);
  }

  async spawn(
    taskName: string,
    agentType: AgentType,
    prompt: string,
    cwd: string | null = null,
    mode: Mode | null = null,
    effort: EffortLevel = 'default',
    parentSessionId: string | null = null,
    workspaceDir: string | null = null,
    version: string | null = null,
    name: string | null = null,
    after: string[] = []
  ): Promise<AgentProcess> {
    await this.initialize();
    const resolvedMode = resolveMode(mode, this.defaultMode);

    // Enforce: teammate names are unique within a team.
    const siblings = await this.listByTask(taskName);
    if (name && siblings.some((a) => a.name === name)) {
      throw new Error(
        `Team '${taskName}' already has a teammate named '${name}'. Pick another name or leave --name off.`
      );
    }

    // --- dependency validation ---
    const cleanAfter = after.filter((s) => s && s.trim());
    if (cleanAfter.length > 0) {
      if (!name) {
        throw new Error(
          "Can't use --after without --name. Dependencies reference teammates by name."
        );
      }
      // Every --after entry must resolve to an existing teammate name.
      const siblingNames = new Set(siblings.map((a) => a.name).filter(Boolean) as string[]);
      const missing = cleanAfter.filter((dep) => !siblingNames.has(dep));
      if (missing.length > 0) {
        throw new Error(
          `Team '${taskName}' has no teammate named ${missing.map((m) => `'${m}'`).join(', ')} yet.\n` +
            `  Add them first, then add this one.`
        );
      }
      // Cycle check: walk the transitive deps of each --after entry; if the
      // new teammate's own name shows up, we'd create a cycle.
      const byName = new Map(siblings.filter((a) => a.name).map((a) => [a.name as string, a]));
      for (const dep of cleanAfter) {
        if (hasTransitiveDep(byName, dep, name)) {
          throw new Error(
            `Adding '${name}' after '${dep}' would create a cycle (${dep} already depends on ${name}).`
          );
        }
      }
    }

    // Resolve and validate cwd
    let resolvedCwd: string | null = null;
    if (cwd !== null) {
      resolvedCwd = path.resolve(cwd);
      const stat = await fs.stat(resolvedCwd).catch(() => null);
      if (!stat) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${cwd}`);
      }
    }

    const [available, pathOrError] = checkCliAvailable(agentType);
    if (!available) {
      throw new Error(pathOrError || 'CLI tool not available');
    }

    // Use a full UUIDv4 as the canonical agent_id. For Claude, we pass it via
    // --session-id so it's also Claude's session id (unified identity).
    const agentId = randomUUID();
    const isStaged = cleanAfter.length > 0;

    const agent = new AgentProcess(
      agentId,
      taskName,
      agentType,
      prompt,
      resolvedCwd,
      resolvedMode,
      null,
      isStaged ? AgentStatus.PENDING : AgentStatus.RUNNING,
      new Date(),
      null,
      this.agentsDir,
      parentSessionId,
      workspaceDir,
      null,
      null,
      null,
      version,
      null,
      name,
      cleanAfter,
      effort
    );

    const agentDir = await agent.getAgentDir();
    try {
      await fs.mkdir(agentDir, { recursive: true });
    } catch (err: any) {
      throw new Error(`Failed to create agent directory: ${err.message}`);
    }
    await agent.saveMeta();
    this.agents.set(agentId, agent);

    if (!isStaged) {
      await this.launchProcess(agent);
    } else {
      debug(`Staged ${agentType} teammate '${name}' in team '${taskName}' (after: ${cleanAfter.join(', ')})`);
    }

    await this.cleanupOldAgents();
    return agent;
  }

  /**
   * Actually spawn the OS process for a teammate. Extracted from spawn() so
   * staged teammates can be launched later by startReady().
   */
  private async launchProcess(agent: AgentProcess): Promise<void> {
    const running = await this.listRunning();
    if (running.length >= this.maxConcurrent) {
      throw new Error(
        `Maximum concurrent agents (${this.maxConcurrent}) reached. Wait for an agent to complete or stop one first.`
      );
    }

    const effort = agent.effort ?? 'default';
    const resolvedModel: string = this.effortModelMap[effort][agent.agentType];
    const cmd = this.buildCommand(
      agent.agentType,
      agent.prompt,
      agent.mode,
      resolvedModel,
      agent.cwd,
      agent.agentId
    );
    if (agent.version && cmd.length > 0) {
      cmd[0] = `${cmd[0]}@${agent.version}`;
    }

    debug(`Launching ${agent.agentType} agent ${agent.agentId} [${agent.mode}]: ${cmd.slice(0, 3).join(' ')}...`);

    try {
      const stdoutPath = await agent.getStdoutPath();
      const stdoutFile = await fs.open(stdoutPath, 'w');
      const stdoutFd = stdoutFile.fd;

      const childProcess = spawn(cmd[0], cmd.slice(1), {
        stdio: ['ignore', stdoutFd, stdoutFd],
        cwd: agent.cwd || undefined,
        detached: true,
      });

      childProcess.unref();
      stdoutFile.close().catch(() => {});

      agent.pid = childProcess.pid || null;
      agent.status = AgentStatus.RUNNING;
      agent.startedAt = new Date();
      await agent.saveMeta();
    } catch (err: any) {
      await this.cleanupPartialAgent(agent);
      console.error(`Failed to spawn agent ${agent.agentId}:`, err);
      throw new Error(`Failed to spawn agent: ${err.message}`);
    }

    debug(`Launched agent ${agent.agentId} with PID ${agent.pid}`);
  }

  /**
   * Fire any pending teammates in the given team whose `after` deps have all
   * completed. Returns the list of teammates just launched. Repeatable:
   * call it once per DAG wave. Safe to call on teams with no pending work
   * (returns empty list).
   */
  async startReady(taskName: string): Promise<AgentProcess[]> {
    await this.initialize();
    const teammates = await this.listByTask(taskName);
    const byName = new Map(
      teammates.filter((a) => a.name).map((a) => [a.name as string, a])
    );

    const launched: AgentProcess[] = [];
    for (const agent of teammates) {
      if (agent.status !== AgentStatus.PENDING) continue;
      const depsReady = agent.after.every((depName) => {
        const dep = byName.get(depName);
        return dep && dep.status === AgentStatus.COMPLETED;
      });
      if (!depsReady) continue;
      try {
        await this.launchProcess(agent);
        launched.push(agent);
      } catch (err) {
        console.error(`Could not launch ${agent.agentId}:`, err);
      }
    }
    return launched;
  }

  private buildCommand(
    agentType: AgentType,
    prompt: string,
    mode: Mode,
    model: string,
    cwd: string | null = null,
    sessionId: string | null = null
  ): string[] {
    const cmdTemplate = AGENT_COMMANDS[agentType];
    if (!cmdTemplate) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }

    const isEditMode = mode === 'edit';

    // Build the full prompt with prefix (for plan mode) and suffix
    let fullPrompt = prompt + PROMPT_SUFFIX;

    // For Claude in plan mode, add prefix explaining headless plan mode restrictions
    if (agentType === 'claude' && !isEditMode) {
      fullPrompt = CLAUDE_PLAN_MODE_PREFIX + fullPrompt;
    }

    let cmd = cmdTemplate.map(part => part.replace('{prompt}', fullPrompt));

    if (agentType === 'claude') {
      // Grant access to the working directory.
      if (cwd) {
        cmd.push('--add-dir', cwd);
      }

      // Pin Claude's session UUID to our agent_id so the session file lands
      // at ~/.claude/projects/.../<agent_id>.jsonl — unified identity.
      if (sessionId) {
        cmd.push('--session-id', sessionId);
      }
      // Note: we deliberately do NOT pass --settings here. The agents-cli
      // shim exports CLAUDE_CONFIG_DIR scoped to the version being spawned,
      // which makes Claude read settings.json, commands/, skills/, hooks/,
      // and MCP config from that version's home. Passing a fixed
      // ~/.claude/settings.json would override that and bind settings to the
      // *default* version rather than the one this teammate is running.
    }

    // Add model flag for each agent type
    if (agentType === 'codex') {
      const execIndex = cmd.indexOf('exec');
      const sandboxIndex = cmd.indexOf('--sandbox');
      const insertIndex = sandboxIndex !== -1 ? sandboxIndex : execIndex + 1;
      cmd.splice(insertIndex, 0, '--model', model);
    } else if (agentType === 'cursor') {
      cmd.push('--model', model);
    } else if (agentType === 'gemini' || agentType === 'claude') {
      cmd.push('--model', model);
    } else if (agentType === 'opencode') {
      const opencodeAgent = mode === 'edit' || mode === 'ralph' ? 'build' : 'plan';
      // Insert --agent flag after the prompt
      const promptIndex = cmd.indexOf(fullPrompt);
      if (promptIndex !== -1) {
        cmd.splice(promptIndex + 1, 0, '--agent', opencodeAgent);
      }
      cmd.push('--model', model);
    }

    if (mode === 'ralph') {
      cmd = this.applyRalphMode(agentType, cmd);
    } else if (isEditMode) {
      cmd = this.applyEditMode(agentType, cmd);
    }

    return cmd;
  }

  private applyEditMode(agentType: AgentType, cmd: string[]): string[] {
    const editCmd: string[] = [...cmd];

    switch (agentType) {
      case 'codex':
        editCmd.push('--full-auto');
        break;

      case 'cursor':
        editCmd.push('-f');
        break;

      case 'gemini': {
        const approvalIndex = editCmd.indexOf('--approval-mode');
        if (approvalIndex !== -1) {
          editCmd.splice(approvalIndex, 2);
        }
        editCmd.push('--yolo');
        break;
      }

      case 'claude':
        const permModeIndex = editCmd.indexOf('--permission-mode');
        if (permModeIndex !== -1 && permModeIndex + 1 < editCmd.length) {
          editCmd[permModeIndex + 1] = 'acceptEdits';
        }
        break;
    }

    return editCmd;
  }

  private applyRalphMode(agentType: AgentType, cmd: string[]): string[] {
    const ralphCmd: string[] = [...cmd];

    switch (agentType) {
      case 'codex':
        ralphCmd.push('--full-auto');
        break;

      case 'cursor':
        ralphCmd.push('-f');
        break;

      case 'gemini': {
        const approvalIndex = ralphCmd.indexOf('--approval-mode');
        if (approvalIndex !== -1) {
          ralphCmd.splice(approvalIndex, 2);
        }
        ralphCmd.push('--yolo');
        break;
      }

      case 'claude':
        // Replace --permission-mode plan with --dangerously-skip-permissions
        const permModeIndex = ralphCmd.indexOf('--permission-mode');
        if (permModeIndex !== -1) {
          ralphCmd.splice(permModeIndex, 2); // Remove --permission-mode and its value
        }
        ralphCmd.push('--dangerously-skip-permissions');
        break;
    }

    return ralphCmd;
  }

  async get(agentId: string): Promise<AgentProcess | null> {
    await this.initialize();
    let agent = this.agents.get(agentId) || null;
    if (agent) {
      await agent.readNewEvents();
      await agent.updateStatusFromProcess();
      return agent;
    }

    agent = await AgentProcess.loadFromDisk(agentId, this.agentsDir);
    if (agent) {
      await agent.readNewEvents();
      await agent.updateStatusFromProcess();
      this.agents.set(agentId, agent);
      return agent;
    }

    return null;
  }

  /**
   * Resolve a teammate reference to a single agent_id within a team.
   * Accepts (in priority order):
   *   1. exact teammate name                ("alice")
   *   2. exact UUID                         ("b2438499-dc25-4a5e-9e02-9916012580b8")
   *   3. UUID prefix, if unique             ("b2438499")
   *
   * Returns:
   *  - { kind: 'ok', agentId }       when exactly one teammate matches
   *  - { kind: 'none' }              when nothing matches
   *  - { kind: 'ambiguous', matches } when the prefix matches multiple ids
   */
  async resolveAgentIdInTask(
    taskName: string,
    ref: string
  ): Promise<
    | { kind: 'ok'; agentId: string }
    | { kind: 'none' }
    | { kind: 'ambiguous'; matches: string[] }
  > {
    const agents = await this.listByTask(taskName);
    const byName = agents.find((a) => a.name === ref);
    if (byName) return { kind: 'ok', agentId: byName.agentId };
    const exact = agents.find((a) => a.agentId === ref);
    if (exact) return { kind: 'ok', agentId: exact.agentId };
    const prefix = agents.filter((a) => a.agentId.startsWith(ref));
    if (prefix.length === 1) return { kind: 'ok', agentId: prefix[0].agentId };
    if (prefix.length === 0) return { kind: 'none' };
    return { kind: 'ambiguous', matches: prefix.map((a) => a.agentId) };
  }

  async listAll(): Promise<AgentProcess[]> {
    await this.initialize();
    const agents = Array.from(this.agents.values());
    for (const agent of agents) {
      await agent.readNewEvents();
      await agent.updateStatusFromProcess();
    }
    return agents;
  }

  async listRunning(): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.status === AgentStatus.RUNNING);
  }

  async listCompleted(): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.status !== AgentStatus.RUNNING);
  }

  async listByTask(taskName: string): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.taskName === taskName);
  }

  async listByParentSession(parentSessionId: string): Promise<AgentProcess[]> {
    const all = await this.listAll();
    return all.filter(a => a.parentSessionId === parentSessionId);
  }

  async stopByTask(taskName: string): Promise<{ stopped: string[]; alreadyStopped: string[] }> {
    const agents = await this.listByTask(taskName);
    const stopped: string[] = [];
    const alreadyStopped: string[] = [];

    for (const agent of agents) {
      if (agent.status === AgentStatus.RUNNING) {
        const success = await this.stop(agent.agentId);
        if (success) {
          stopped.push(agent.agentId);
        }
      } else {
        alreadyStopped.push(agent.agentId);
      }
    }

    return { stopped, alreadyStopped };
  }

  async stop(agentId: string): Promise<boolean> {
    await this.initialize();
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    if (agent.pid && agent.status === AgentStatus.RUNNING) {
      try {
        process.kill(-agent.pid, 'SIGTERM');
        debug(`Sent SIGTERM to agent ${agentId} (PID ${agent.pid})`);

        await new Promise(resolve => setTimeout(resolve, 2000));
        if (agent.isProcessAlive()) {
          process.kill(-agent.pid, 'SIGKILL');
          debug(`Sent SIGKILL to agent ${agentId}`);
        }
      } catch {
      }

      agent.status = AgentStatus.STOPPED;
      agent.completedAt = new Date();
      await agent.saveMeta();
      debug(`Stopped agent ${agentId}`);
      return true;
    }

    return false;
  }

  private async cleanupPartialAgent(agent: AgentProcess): Promise<void> {
    this.agents.delete(agent.agentId);
    try {
      const agentDir = await agent.getAgentDir();
      await fs.rm(agentDir, { recursive: true });
    } catch (err) {
      console.warn(`Failed to clean up agent directory:`, err);
    }
  }

  private async cleanupOldAgents(): Promise<void> {
    const completed = await this.listCompleted();
    if (completed.length > this.maxAgents) {
      completed.sort((a, b) => {
        const aTime = a.completedAt?.getTime() || 0;
        const bTime = b.completedAt?.getTime() || 0;
        return aTime - bTime;
      });
      for (const agent of completed.slice(0, completed.length - this.maxAgents)) {
        this.agents.delete(agent.agentId);
        try {
          const agentDir = await agent.getAgentDir();
          await fs.rm(agentDir, { recursive: true });
        } catch (err) {
          console.warn(`Failed to cleanup old agent ${agent.agentId}:`, err);
        }
      }
    }
  }
}
