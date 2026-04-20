import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as TOML from 'smol-toml';
import chalk from 'chalk';
import type { AgentConfig, AgentId } from './types.js';
import { walkForFiles } from './session/discover.js';
import { getVersionsDir, getShimsDir } from './state.js';
import { resolveVersion, getVersionHomePath, getBinaryPath } from './versions.js';
import { loadClaudeOauth } from './usage.js';

export interface CliState {
  installed: boolean;
  version: string | null;
  path: string | null;
}

const execAsync = promisify(exec);

const HOME = os.homedir();

export const CODEX_HOOKS_MIN_VERSION = '0.116.0';

const CLI_VERSION_CACHE_PATH = path.join(HOME, '.agents', '.cli-version-cache.json');

interface CliVersionCacheEntry {
  binaryPath: string;
  mtime: number;
  version: string | null;
}

let cliVersionCache: Record<string, CliVersionCacheEntry> | null = null;

function loadCliVersionCache(): Record<string, CliVersionCacheEntry> {
  if (cliVersionCache) return cliVersionCache;
  try {
    cliVersionCache = JSON.parse(fs.readFileSync(CLI_VERSION_CACHE_PATH, 'utf-8'));
  } catch {
    /* missing or corrupt cache, rebuild */
    cliVersionCache = {};
  }
  return cliVersionCache!;
}

function saveCliVersionCache(): void {
  if (!cliVersionCache) return;
  try {
    const dir = path.dirname(CLI_VERSION_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CLI_VERSION_CACHE_PATH, JSON.stringify(cliVersionCache));
  } catch {
    /* best-effort cache persist */
  }
}

/** Synchronous PATH search — no subprocess. Returns first matching binary path. */
function findInPath(command: string): string | null {
  const pathEnv = process.env.PATH || '';
  const pathExt = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of pathExt) {
      const full = path.join(dir, command + ext);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) return full;
      } catch {
        /* not in this dir */
      }
    }
  }
  return null;
}

export const AGENTS: Record<AgentId, AgentConfig> = {
  claude: {
    id: 'claude',
    name: 'Claude',
    color: 'magenta',
    cliCommand: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    configDir: path.join(HOME, '.claude'),
    homeFiles: ['.claude.json'],
    commandsDir: path.join(HOME, '.claude', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.claude', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'CLAUDE.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    capabilities: { hooks: true, mcp: true, allowlist: true, skills: true, commands: true, plugins: true, memoryImports: true },
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    color: 'green',
    cliCommand: 'codex',
    npmPackage: '@openai/codex',
    configDir: path.join(HOME, '.codex'),
    commandsDir: path.join(HOME, '.codex', 'prompts'),
    commandsSubdir: 'prompts',
    skillsDir: path.join(HOME, '.codex', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: true,
    capabilities: { hooks: true, mcp: true, allowlist: false, skills: true, commands: true, plugins: false },
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    color: 'blue',
    cliCommand: 'gemini',
    npmPackage: '@google/gemini-cli',
    configDir: path.join(HOME, '.gemini'),
    commandsDir: path.join(HOME, '.gemini', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.gemini', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'GEMINI.md',
    format: 'toml',
    variableSyntax: '{{args}}',
    supportsHooks: true,
    nativeAgentsSkillsDir: true,
    capabilities: { hooks: true, mcp: true, allowlist: false, skills: true, commands: true, plugins: false, memoryImports: true },
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    color: 'cyan',
    cliCommand: 'cursor-agent',
    npmPackage: '',
    installScript: 'curl https://cursor.com/install -fsS | bash && mv ~/.local/bin/agent ~/.local/bin/cursor-agent && grep -q "/.local/bin" ~/.zshrc || echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.zshrc',
    configDir: path.join(HOME, '.cursor'),
    commandsDir: path.join(HOME, '.cursor', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.cursor', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: '.cursorrules',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false },
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    color: 'yellowBright',
    cliCommand: 'opencode',
    npmPackage: 'opencode-ai',
    configDir: path.join(HOME, '.opencode'),
    commandsDir: path.join(HOME, '.opencode', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.opencode', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false },
  },
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    color: 'redBright',
    cliCommand: 'openclaw',
    npmPackage: 'openclaw',
    configDir: path.join(HOME, '.openclaw'),
    commandsDir: '', // OpenClaw uses Gateway-based slash commands, not file-based
    commandsSubdir: '',
    skillsDir: path.join(HOME, '.openclaw', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'workspace/AGENTS.md', // Primary memory file (also has SOUL.md, IDENTITY.md, etc.)
    format: 'markdown',
    variableSyntax: '{{ARGUMENTS}}',
    supportsHooks: true,
    capabilities: { hooks: true, mcp: true, allowlist: false, skills: true, commands: false, plugins: true },
  },
  copilot: {
    id: 'copilot',
    name: 'Copilot',
    color: 'whiteBright',
    cliCommand: 'copilot',
    npmPackage: '@github/copilot',
    configDir: path.join(HOME, '.copilot'),
    commandsDir: path.join(HOME, '.copilot', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.copilot', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false },
  },
  amp: {
    id: 'amp',
    name: 'Amp',
    color: 'blueBright',
    cliCommand: 'amp',
    npmPackage: '@sourcegraph/amp',
    configDir: path.join(HOME, '.config', 'amp'),
    commandsDir: path.join(HOME, '.config', 'amp', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.config', 'amp', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false },
  },
  kiro: {
    id: 'kiro',
    name: 'Kiro',
    color: 'greenBright',
    cliCommand: 'kiro-cli',
    npmPackage: '',
    installScript: 'brew install --cask kiro-cli',
    configDir: path.join(HOME, '.kiro'),
    commandsDir: path.join(HOME, '.kiro', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.kiro', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false },
  },
  goose: {
    id: 'goose',
    name: 'Goose',
    color: 'magentaBright',
    cliCommand: 'goose',
    npmPackage: '',
    installScript: 'brew install block-goose-cli',
    configDir: path.join(HOME, '.config', 'goose'),
    commandsDir: path.join(HOME, '.config', 'goose', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.config', 'goose', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: false, commands: false, plugins: false },
  },
  roo: {
    id: 'roo',
    name: 'Roo Code',
    color: 'cyanBright',
    cliCommand: 'roo',
    npmPackage: '',
    installScript: 'curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh | sh',
    configDir: path.join(HOME, '.roo'),
    commandsDir: path.join(HOME, '.roo', 'commands'),
    commandsSubdir: 'commands',
    skillsDir: path.join(HOME, '.roo', 'skills'),
    hooksDir: 'hooks',
    instructionsFile: 'AGENTS.md',
    format: 'markdown',
    variableSyntax: '$ARGUMENTS',
    supportsHooks: false,
    capabilities: { hooks: false, mcp: true, allowlist: false, skills: true, commands: true, plugins: false },
  },
};

export const ALL_AGENT_IDS: AgentId[] = Object.keys(AGENTS) as AgentId[];
export const MCP_CAPABLE_AGENTS: AgentId[] = ALL_AGENT_IDS.filter(
  (id) => AGENTS[id].capabilities.mcp
);
export const SKILLS_CAPABLE_AGENTS: AgentId[] = ALL_AGENT_IDS.filter(
  (id) => AGENTS[id].capabilities.skills
);
export const COMMANDS_CAPABLE_AGENTS: AgentId[] = ALL_AGENT_IDS.filter(
  (id) => AGENTS[id].capabilities.commands
);
export const HOOKS_CAPABLE_AGENTS = ['claude', 'codex', 'gemini', 'openclaw'] as const;
export const PLUGINS_CAPABLE_AGENTS: AgentId[] = ALL_AGENT_IDS.filter(
  (id) => AGENTS[id].capabilities.plugins
);

/** Get the chalk color function for an agent. Works for any AgentId or SessionAgentId. */
export function colorAgent(agentId: string): (s: string) => string {
  const agent = AGENTS[agentId as AgentId];
  if (!agent) return chalk.white;
  return chalk[agent.color];
}

/** Return the agent's display name, colored. */
export function agentLabel(agentId: string): string {
  const agent = AGENTS[agentId as AgentId];
  if (!agent) return agentId;
  return chalk[agent.color](agent.name);
}

export async function isCliInstalled(agentId: AgentId): Promise<boolean> {
  const agent = AGENTS[agentId];
  return findInPath(agent.cliCommand) !== null;
}

export async function getCliVersion(agentId: AgentId): Promise<string | null> {
  const agent = AGENTS[agentId];
  const binaryPath = findInPath(agent.cliCommand);
  if (!binaryPath) return null;
  return getCachedVersionForBinary(agentId, binaryPath);
}

export async function getCliPath(agentId: AgentId): Promise<string | null> {
  return findInPath(AGENTS[agentId].cliCommand);
}

/** Look up version from cache by (binary, mtime). On miss or stale, spawn `--version` and cache. */
async function getCachedVersionForBinary(agentId: AgentId, binaryPath: string): Promise<string | null> {
  let mtime = 0;
  try {
    mtime = fs.statSync(binaryPath).mtimeMs;
  } catch {
    /* binary vanished between findInPath and statSync */
    return null;
  }

  const cache = loadCliVersionCache();
  const cached = cache[agentId];
  if (cached && cached.binaryPath === binaryPath && cached.mtime === mtime) {
    return cached.version;
  }

  const agent = AGENTS[agentId];
  let version: string | null = null;
  try {
    const { stdout } = await execAsync(`${agent.cliCommand} --version`, { timeout: 3000 });
    if (agentId === 'openclaw') {
      const match = stdout.match(/openclaw\/(\d+\.\d+\.\d+)/);
      version = match ? match[1] : stdout.trim();
    } else {
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      version = match ? match[1] : stdout.trim();
    }
  } catch {
    /* version command failed */
    version = null;
  }

  cache[agentId] = { binaryPath, mtime, version };
  saveCliVersionCache();
  return version;
}

export async function getCliState(agentId: AgentId): Promise<CliState> {
  // Fast path: if version-managed, derive state from filesystem (no subprocesses)
  const agent = AGENTS[agentId];
  const agentVersionsDir = path.join(getVersionsDir(), agentId);
  if (fs.existsSync(agentVersionsDir)) {
    // Use resolved version (project manifest -> global default)
    const resolvedVer = resolveVersion(agentId, process.cwd());
    if (resolvedVer) {
      const binaryPath = path.join(agentVersionsDir, resolvedVer, 'node_modules', '.bin', agent.cliCommand);
      if (fs.existsSync(binaryPath)) {
        const shimPath = path.join(getShimsDir(), agent.cliCommand);
        return {
          installed: true,
          version: resolvedVer,
          path: fs.existsSync(shimPath) ? shimPath : binaryPath,
        };
      }
    }

    // Fallback: if no default set or resolved version not installed, return first available
    const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const binaryPath = path.join(agentVersionsDir, entry.name, 'node_modules', '.bin', agent.cliCommand);
        if (fs.existsSync(binaryPath)) {
          const shimPath = path.join(getShimsDir(), agent.cliCommand);
          return {
            installed: true,
            version: entry.name,
            path: fs.existsSync(shimPath) ? shimPath : binaryPath,
          };
        }
      }
    }
  }

  // Non-version-managed: single PATH lookup + cached version read
  const binaryPath = findInPath(agent.cliCommand);
  if (!binaryPath) {
    return { installed: false, version: null, path: null };
  }
  return {
    installed: true,
    version: await getCachedVersionForBinary(agentId, binaryPath),
    path: binaryPath,
  };
}

export async function getAllCliStates(): Promise<Partial<Record<AgentId, CliState>>> {
  const states: Partial<Record<AgentId, CliState>> = {};
  const results = await Promise.all(
    ALL_AGENT_IDS.map(async (agentId) => ({
      agentId,
      state: await getCliState(agentId),
    }))
  );
  for (const { agentId, state } of results) {
    states[agentId] = state;
  }
  return states;
}

export function isConfigured(agentId: AgentId): boolean {
  const agent = AGENTS[agentId];
  return fs.existsSync(agent.configDir);
}

export function ensureCommandsDir(agentId: AgentId): void {
  const agent = AGENTS[agentId];
  if (!fs.existsSync(agent.commandsDir)) {
    fs.mkdirSync(agent.commandsDir, { recursive: true });
  }
}

export function ensureSkillsDir(agentId: AgentId): void {
  const agent = AGENTS[agentId];
  if (!fs.existsSync(agent.skillsDir)) {
    fs.mkdirSync(agent.skillsDir, { recursive: true });
  }
}

export interface AccountInfo {
  accountKey: string | null;
  usageKey: string | null;
  accountId: string | null;
  organizationId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null;
  overageCredits: { amount: number; currency: string } | null;
  lastActive: Date | null;
}

export async function getAccountEmail(
  agentId: AgentId,
  home?: string
): Promise<string | null> {
  const info = await getAccountInfo(agentId, home);
  return info.email;
}

export async function getAccountInfo(
  agentId: AgentId,
  home?: string
): Promise<AccountInfo> {
  const base = home || os.homedir();
  const empty: AccountInfo = {
    accountKey: null,
    usageKey: null,
    accountId: null,
    organizationId: null,
    userId: null,
    email: null,
    plan: null,
    usageStatus: null,
    overageCredits: null,
    lastActive: null,
  };

  const configFiles: Partial<Record<AgentId, string>> = {
    claude: path.join(base, '.claude.json'),
    codex: path.join(base, '.codex', 'auth.json'),
    gemini: path.join(base, '.gemini', 'google_accounts.json'),
  };
  const lastActive = resolveLastActive(agentId, base, configFiles[agentId]);

  try {
    switch (agentId) {
      case 'claude': {
        // Claude reads/writes config at $CLAUDE_CONFIG_DIR/.claude.json when set,
        // falling back to $HOME/.claude.json. Our shim sets CLAUDE_CONFIG_DIR to
        // the per-version .claude dir, so prefer that file; fall back to home-level
        // for versions ever launched without the shim (IDE extension, direct binary).
        const configDirFile = path.join(base, '.claude', '.claude.json');
        const homeLevelFile = path.join(base, '.claude.json');
        const activeFile = fs.existsSync(configDirFile) ? configDirFile : homeLevelFile;
        const data = JSON.parse(await fs.promises.readFile(activeFile, 'utf-8'));
        const oa = data.oauthAccount;
        const accountId = normalizeIdentityPart(oa?.accountUuid);
        const organizationId = normalizeIdentityPart(oa?.organizationUuid);
        const email = oa?.emailAddress || null;
        const accountKey = buildIdentityKey(agentId, [
          ['account', accountId],
          ['org', organizationId],
        ]);
        const usageKey = buildIdentityKey(agentId, [['org', organizationId]]);

        let plan: string | null = null;
        const keychainOauth = await loadClaudeOauth(home);
        if (keychainOauth?.subscriptionType) {
          plan = keychainOauth.subscriptionType.charAt(0).toUpperCase()
            + keychainOauth.subscriptionType.slice(1);
        } else if (oa?.billingType === 'stripe_subscription') {
          plan = 'Pro';
        } else if (oa?.billingType) {
          plan = oa.billingType;
        }

        let usageStatus: AccountInfo['usageStatus'] = null;
        const reason = data.cachedExtraUsageDisabledReason;
        if (reason === 'out_of_credits') usageStatus = 'out_of_credits';
        else if (reason) usageStatus = 'rate_limited';
        else usageStatus = 'available';

        let overageCredits: AccountInfo['overageCredits'] = null;
        const orgId = oa?.organizationUuid;
        const creditCache = orgId && data.overageCreditGrantCache?.[orgId];
        if (creditCache?.info?.available && creditCache.info.amount_minor_units) {
          overageCredits = {
            amount: creditCache.info.amount_minor_units / 100,
            currency: creditCache.info.currency || 'USD',
          };
        }

        return {
          accountKey,
          usageKey,
          accountId,
          organizationId,
          userId: null,
          email,
          plan,
          usageStatus,
          overageCredits,
          lastActive,
        };
      }
      case 'codex': {
        const data = JSON.parse(await fs.promises.readFile(path.join(base, '.codex', 'auth.json'), 'utf-8'));
        const token = data.tokens?.id_token || data.tokens?.access_token;
        if (!token) return { ...empty, lastActive };
        const decoded = decodeJwtPayload(token);
        if (!decoded) return { ...empty, lastActive };
        const email = decoded.email || null;

        // Plan and subscription from OpenAI auth claim
        const authClaim = decoded['https://api.openai.com/auth'] || {};
        const accountId = normalizeIdentityPart(authClaim.chatgpt_account_id);
        const userId = normalizeIdentityPart(authClaim.chatgpt_user_id || authClaim.user_id);
        const organizationId = normalizeIdentityPart(getCodexDefaultOrgId(authClaim));
        const accountKey = buildIdentityKey(agentId, [
          ['account', accountId],
          ['user', userId],
          ['org', organizationId],
        ]);
        const rawPlan = authClaim.chatgpt_plan_type;
        const plan = rawPlan ? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1) : null;

        // Subscription status: expired = out_of_credits
        let usageStatus: AccountInfo['usageStatus'] = null;
        const activeUntil = authClaim.chatgpt_subscription_active_until;
        if (activeUntil) {
          const expired = new Date(activeUntil).getTime() < Date.now();
          usageStatus = expired ? 'out_of_credits' : 'available';
        }

        return {
          accountKey,
          usageKey: accountKey,
          accountId,
          organizationId,
          userId,
          email,
          plan,
          usageStatus,
          overageCredits: null,
          lastActive,
        };
      }
      case 'gemini': {
        const data = JSON.parse(await fs.promises.readFile(path.join(base, '.gemini', 'google_accounts.json'), 'utf-8'));
        return { ...empty, email: data.active || null, lastActive };
      }
      default:
        return { ...empty, lastActive };
    }
  } catch {
    /* auth/config file missing or unreadable */
    return { ...empty, lastActive };
  }
}

function resolveLastActive(
  agentId: AgentId,
  base: string,
  configPath?: string
): Date | null {
  const sessionDir = getSessionDir(agentId, base);
  const sessionExt = getSessionExtension(agentId);
  if (sessionDir && sessionExt) {
    const latestSession = getLatestFileMtime(sessionDir, sessionExt);
    if (latestSession) {
      return latestSession;
    }
  }

  if (!configPath) return null;
  try {
    return fs.statSync(configPath).mtime;
  } catch {
    return null;
  }
}

function getSessionDir(agentId: AgentId, base: string): string | null {
  switch (agentId) {
    case 'claude':
      return path.join(base, '.claude', 'projects');
    case 'codex':
      return path.join(base, '.codex', 'sessions');
    case 'gemini':
      return path.join(base, '.gemini', 'tmp');
    default:
      return null;
  }
}

function getSessionExtension(agentId: AgentId): string | null {
  switch (agentId) {
    case 'claude':
    case 'codex':
      return '.jsonl';
    case 'gemini':
      return '.json';
    default:
      return null;
  }
}

function getLatestFileMtime(dir: string, ext: string): Date | null {
  if (!fs.existsSync(dir)) return null;
  const [latest] = walkForFiles(dir, ext, 1);
  if (!latest) return null;
  try {
    return fs.statSync(latest).mtime;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

function getCodexDefaultOrgId(authClaim: any): string | null {
  const organizations = authClaim?.organizations;
  if (!Array.isArray(organizations)) return null;
  const first = organizations[0];
  return typeof first?.id === 'string' ? first.id : null;
}

function normalizeIdentityPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildIdentityKey(
  agentId: AgentId,
  parts: Array<[label: string, value: string | null]>
): string | null {
  const encoded = parts
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}=${value}`);
  if (encoded.length === 0) return null;
  return `${agentId}:${encoded.join(':')}`;
}

export async function isMcpRegistered(agentId: AgentId, mcpName: string): Promise<boolean> {
  const agent = AGENTS[agentId];
  if (!agent.capabilities.mcp || !(await isCliInstalled(agentId))) {
    return false;
  }
  try {
    const { stdout } = await execAsync(`${agent.cliCommand} mcp list`);
    return stdout.toLowerCase().includes(mcpName.toLowerCase());
  } catch {
    /* mcp list command failed */
    return false;
  }
}

export async function registerMcp(
  agentId: AgentId,
  name: string,
  command: string,
  scope: 'user' | 'project' = 'user',
  transport: string = 'stdio',
  options?: { home?: string; binary?: string }
): Promise<{ success: boolean; error?: string }> {
  const agent = AGENTS[agentId];
  if (!agent.capabilities.mcp) {
    return { success: false, error: 'Agent does not support MCP' };
  }
  if (!options?.binary && !(await isCliInstalled(agentId))) {
    return { success: false, error: 'CLI not installed' };
  }

  try {
    // Use explicit binary path when provided (bypasses shim for version-managed agents)
    const bin = options?.binary || agent.cliCommand;
    let cmd: string;
    if (agentId === 'claude') {
      cmd = `${bin} mcp add --transport ${transport} --scope ${scope} "${name}" -- ${command}`;
    } else {
      cmd = `${bin} mcp add "${name}" -- ${command}`;
    }
    // When home is specified, override HOME so MCP config writes to the version's config dir
    const env = options?.home ? { ...process.env, HOME: options.home } : undefined;
    await execAsync(cmd, env ? { env } : undefined);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function unregisterMcp(
  agentId: AgentId,
  name: string,
  options?: { home?: string; binary?: string }
): Promise<{ success: boolean; error?: string }> {
  const agent = AGENTS[agentId];
  if (!agent.capabilities.mcp) {
    return { success: false, error: 'Agent does not support MCP' };
  }
  if (!options?.binary && !(await isCliInstalled(agentId))) {
    return { success: false, error: 'CLI not installed' };
  }

  try {
    const bin = options?.binary || agent.cliCommand;
    const env = options?.home ? { ...process.env, HOME: options.home } : undefined;
    await execAsync(`${bin} mcp remove "${name}"`, env ? { env } : undefined);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export interface McpTargetOperationResult {
  agentId: AgentId;
  version?: string;
  success: boolean;
  error?: string;
}

export async function registerMcpToTargets(
  targets: { directAgents: AgentId[]; versionSelections: Map<AgentId, string[]> },
  name: string,
  command: string,
  scope: 'user' | 'project' = 'user',
  transport: string = 'stdio'
): Promise<McpTargetOperationResult[]> {
  const results: McpTargetOperationResult[] = [];

  for (const agentId of targets.directAgents) {
    const result = await registerMcp(agentId, name, command, scope, transport);
    results.push({ agentId, success: result.success, error: result.error });
  }

  for (const [agentId, versions] of targets.versionSelections) {
    for (const version of versions) {
      const result = await registerMcp(agentId, name, command, scope, transport, {
        home: getVersionHomePath(agentId, version),
        binary: getBinaryPath(agentId, version),
      });
      results.push({ agentId, version, success: result.success, error: result.error });
    }
  }

  return results;
}

export async function unregisterMcpFromTargets(
  targets: { directAgents: AgentId[]; versionSelections: Map<AgentId, string[]> },
  name: string
): Promise<McpTargetOperationResult[]> {
  const results: McpTargetOperationResult[] = [];

  for (const agentId of targets.directAgents) {
    const result = await unregisterMcp(agentId, name);
    results.push({ agentId, success: result.success, error: result.error });
  }

  for (const [agentId, versions] of targets.versionSelections) {
    for (const version of versions) {
      const result = await unregisterMcp(agentId, name, {
        home: getVersionHomePath(agentId, version),
        binary: getBinaryPath(agentId, version),
      });
      results.push({ agentId, version, success: result.success, error: result.error });
    }
  }

  return results;
}

export type McpScope = 'user' | 'project';

export interface InstalledMcp {
  name: string;
  scope: McpScope;
  command?: string;
  version?: string;
}

interface McpConfigEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

/**
 * Extract version from npm package specification.
 * Examples: @swarmify/agents-mcp@latest -> latest
 *           @swarmify/agents-mcp@1.2.3 -> 1.2.3
 *           some-package -> undefined
 */
function extractNpmVersion(args: string[]): string | undefined {
  // Find npm package argument (looks like @scope/package@version or package@version)
  for (const arg of args) {
    // Match @scope/package@version or package@version
    const match = arg.match(/@([^@]+)$|^([^@]+)@(.+)$/);
    if (match) {
      // @scope/package@version pattern
      const versionMatch = arg.match(/@([^@/]+)$/);
      if (versionMatch) {
        return versionMatch[1];
      }
    }
  }
  return undefined;
}

/**
 * Strip JSON comments for JSONC parsing.
 * Only removes comments outside of strings.
 */
function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let escape = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (escape) {
      result += char;
      escape = false;
      i++;
      continue;
    }

    if (char === '\\' && inString) {
      result += char;
      escape = true;
      i++;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      // Check for single-line comment
      if (char === '/' && next === '/') {
        // Skip until end of line
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
        continue;
      }
      // Check for multi-line comment
      if (char === '/' && next === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2; // Skip */
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Parse MCP servers from a JSON/JSONC config file.
 */
function parseMcpFromJsonConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    let content = fs.readFileSync(configPath, 'utf-8');
    // Handle JSONC (JSON with comments)
    if (configPath.endsWith('.jsonc')) {
      content = stripJsonComments(content);
    }
    const config = JSON.parse(content);

    // Claude uses mcpServers, others may use mcp_servers or mcp
    return config.mcpServers || config.mcp_servers || config.mcp || {};
  } catch {
    /* JSON config corrupt or unreadable */
    return {};
  }
}

/**
 * Parse MCP servers from a TOML config file (Codex).
 * Codex stores MCPs as [mcp_servers.ServerName] sections.
 */
function parseMcpFromTomlConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = TOML.parse(content) as Record<string, unknown>;

    // Codex uses mcp_servers as a table with server names as keys
    const mcpServers = config.mcp_servers as Record<string, McpConfigEntry> | undefined;
    return mcpServers || {};
  } catch {
    /* TOML config corrupt or unreadable */
    return {};
  }
}

/**
 * Parse MCP servers from OpenCode's JSONC config.
 * OpenCode stores MCPs in the "mcp" object with different structure.
 */
function parseMcpFromOpenCodeConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
    const config = JSON.parse(content);
    const mcpConfig = config.mcp as Record<string, {
      type?: string;
      command?: string[];
      url?: string;
      enabled?: boolean;
    }> | undefined;

    if (!mcpConfig) return {};

    // Convert OpenCode format to our McpConfigEntry format
    const result: Record<string, McpConfigEntry> = {};
    for (const [name, entry] of Object.entries(mcpConfig)) {
      if (entry.type === 'local' && entry.command) {
        // Local MCP: command is an array like ["npx", "-y", "@pkg@version"]
        result[name] = {
          command: entry.command[0],
          args: entry.command.slice(1),
        };
      } else if (entry.type === 'remote' && entry.url) {
        // Remote MCP: HTTP URL
        result[name] = {
          url: entry.url,
        };
      }
    }
    return result;
  } catch {
    /* OpenCode JSONC config corrupt or unreadable */
    return {};
  }
}

/**
 * Get user-scoped MCP config path for an agent.
 */
function getUserMcpConfigPath(agentId: AgentId): string {
  const agent = AGENTS[agentId];

  switch (agentId) {
    case 'claude':
      // Claude user-scoped MCPs are in ~/.claude.json (global user config)
      return path.join(HOME, '.claude.json');
    case 'codex':
      // Codex uses TOML config
      return path.join(agent.configDir, 'config.toml');
    case 'opencode':
      // OpenCode uses JSONC config
      return path.join(agent.configDir, 'opencode.jsonc');
    case 'cursor':
      // Cursor uses mcp.json
      return path.join(agent.configDir, 'mcp.json');
    case 'openclaw':
      // OpenClaw uses openclaw.json
      return path.join(agent.configDir, 'openclaw.json');
    default:
      // Gemini and others use settings.json
      return path.join(agent.configDir, 'settings.json');
  }
}

/**
 * Get MCP config path for a specific HOME directory (used for version-managed agents).
 */
export function getMcpConfigPathForHome(agentId: AgentId, home: string): string {
  switch (agentId) {
    case 'claude':
      return path.join(home, '.claude.json');
    case 'codex':
      return path.join(home, '.codex', 'config.toml');
    case 'opencode':
      return path.join(home, '.opencode', 'opencode.jsonc');
    case 'cursor':
      return path.join(home, '.cursor', 'mcp.json');
    case 'openclaw':
      return path.join(home, '.openclaw', 'openclaw.json');
    case 'copilot':
      return path.join(home, '.copilot', 'mcp-config.json');
    case 'amp':
      return path.join(home, '.config', 'amp', 'settings.json');
    case 'kiro':
      return path.join(home, '.kiro', 'settings', 'mcp.json');
    case 'goose':
      return path.join(home, '.config', 'goose', 'config.yaml');
    case 'roo':
      return path.join(home, '.roo', 'mcp.json');
    default:
      return path.join(home, `.${agentId}`, 'settings.json');
  }
}

/**
 * Get project-scoped MCP config path for an agent.
 */
function getProjectMcpConfigPath(agentId: AgentId, cwd: string = process.cwd()): string {
  switch (agentId) {
    case 'claude':
      // Claude uses .mcp.json at project root for project-scoped MCPs
      return path.join(cwd, '.mcp.json');
    case 'codex':
      return path.join(cwd, `.${agentId}`, 'config.toml');
    case 'opencode':
      return path.join(cwd, `.${agentId}`, 'opencode.jsonc');
    case 'cursor':
      return path.join(cwd, `.${agentId}`, 'mcp.json');
    case 'openclaw':
      return path.join(cwd, `.${agentId}`, 'openclaw.json');
    case 'gemini':
      return path.join(cwd, `.${agentId}`, 'settings.json');
    case 'copilot':
      return path.join(cwd, '.copilot', 'mcp-config.json');
    case 'amp':
      return path.join(cwd, '.amp', 'settings.json');
    case 'kiro':
      return path.join(cwd, '.kiro', 'settings', 'mcp.json');
    case 'goose':
      return path.join(cwd, '.goose', 'config.yaml');
    case 'roo':
      return path.join(cwd, '.roo', 'mcp.json');
    default:
      return path.join(cwd, `.${agentId}`, 'settings.json');
  }
}

/**
 * Parse MCP servers from OpenClaw's JSON config.
 * OpenClaw stores MCPs under mcp.servers with a similar structure to other agents.
 */
function parseMcpFromOpenClawConfig(configPath: string): Record<string, McpConfigEntry> {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    // OpenClaw uses mcp.servers for MCP configuration
    const mcpServers = config.mcp?.servers as Record<string, {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      transport?: string;
    }> | undefined;

    if (!mcpServers) return {};

    const result: Record<string, McpConfigEntry> = {};
    for (const [name, entry] of Object.entries(mcpServers)) {
      if (entry.command) {
        result[name] = {
          command: entry.command,
          args: entry.args,
          env: entry.env,
        };
      } else if (entry.url) {
        result[name] = {
          url: entry.url,
          type: entry.transport || 'sse',
        };
      }
    }
    return result;
  } catch {
    /* OpenClaw JSON config corrupt or unreadable */
    return {};
  }
}

/**
 * Parse MCP config based on agent type.
 */
export function parseMcpConfig(agentId: AgentId, configPath: string): Record<string, McpConfigEntry> {
  switch (agentId) {
    case 'codex':
      return parseMcpFromTomlConfig(configPath);
    case 'opencode':
      return parseMcpFromOpenCodeConfig(configPath);
    case 'openclaw':
      return parseMcpFromOpenClawConfig(configPath);
    default:
      return parseMcpFromJsonConfig(configPath);
  }
}

/**
 * List installed MCP servers with scope information.
 * Pass options.home to read from a version-managed agent's home directory.
 */
export function listInstalledMcpsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledMcp[] {
  const results: InstalledMcp[] = [];

  // Helper to build full command string
  const buildCommand = (config: McpConfigEntry): string | undefined => {
    if (config.command && config.args?.length) {
      return `${config.command} ${config.args.join(' ')}`;
    }
    return config.command || (config.args ? config.args.join(' ') : undefined);
  };

  // User-scoped MCPs (version-aware when home is provided)
  const userConfigPath = options?.home
    ? getMcpConfigPathForHome(agentId, options.home)
    : getUserMcpConfigPath(agentId);
  const userMcps = parseMcpConfig(agentId, userConfigPath);
  for (const [name, config] of Object.entries(userMcps)) {
    results.push({
      name,
      scope: 'user',
      command: buildCommand(config),
      version: config.args ? extractNpmVersion(config.args) : undefined,
    });
  }

  // Project-scoped MCPs
  const projectConfigPath = getProjectMcpConfigPath(agentId, cwd);
  const projectMcps = parseMcpConfig(agentId, projectConfigPath);
  for (const [name, config] of Object.entries(projectMcps)) {
    // Skip if already in user scope (project can override, but we show both)
    results.push({
      name,
      scope: 'project',
      command: buildCommand(config),
      version: config.args ? extractNpmVersion(config.args) : undefined,
    });
  }

  return results;
}

// Agent name aliases for flexible input
export const AGENT_NAME_ALIASES: Record<string, AgentId> = {
  claude: 'claude',
  'claude-code': 'claude',
  cc: 'claude',
  codex: 'codex',
  'openai-codex': 'codex',
  cx: 'codex',
  gemini: 'gemini',
  'gemini-cli': 'gemini',
  gx: 'gemini',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  cr: 'cursor',
  opencode: 'opencode',
  oc: 'opencode',
  openclaw: 'openclaw',
  claw: 'openclaw',
  ocl: 'openclaw',
  copilot: 'copilot',
  'copilot-cli': 'copilot',
  'github-copilot': 'copilot',
  gh: 'copilot',
  amp: 'amp',
  sourcegraph: 'amp',
  kiro: 'kiro',
  'kiro-cli': 'kiro',
  goose: 'goose',
  'block-goose': 'goose',
  roo: 'roo',
  'roo-code': 'roo',
  roocode: 'roo',
};

export function resolveAgentName(input: string): AgentId | null {
  return AGENT_NAME_ALIASES[input.toLowerCase()] || null;
}

export function isAgentName(input: string): boolean {
  return resolveAgentName(input) !== null;
}

export function formatAgentError(agentName: string, validAgents: AgentId[] = ALL_AGENT_IDS): string {
  return `Unknown agent '${agentName}'. Valid agents: ${validAgents.join(', ')}`;
}
