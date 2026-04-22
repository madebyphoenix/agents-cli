/**
 * Factory configuration: per-user defaults for the Software Factory.
 *
 * Lives at ~/.agents/factory/config.json. The settings panel writes to this
 * file; the CLI reads from it. Schema is small by design — the Factory
 * orchestrates via `agents teams add` under the hood so most knobs still
 * live on the teams side.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

/** Dispatch backends in order of preference. First available wins. */
export type DispatchProvider = 'rush' | 'codex' | 'factory' | 'local';

export interface FactoryConfig {
  /**
   * Ordered list of dispatch backends to try. First entry is the default.
   * `'local'` means run the teammate CLI on this machine.
   */
  cloud_priority: DispatchProvider[];

  /**
   * When true and the dispatch is `rush`, `factory start` auto-detects the
   * repo from `git remote get-url origin` and forwards it as --repo.
   */
  auto_detect_repo: boolean;

  /**
   * Default agent type used for the Planner teammate. Workers can override.
   */
  default_planner_agent: 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';

  /**
   * Seconds between supervisor waves when running `factory run` or the
   * auto-launched supervisor from `factory start`.
   */
  supervisor_interval_seconds: number;
}

const DEFAULT_CONFIG: FactoryConfig = {
  cloud_priority: ['rush', 'codex', 'local'],
  auto_detect_repo: true,
  default_planner_agent: 'codex',
  supervisor_interval_seconds: 8,
};

export function factoryConfigPath(): string {
  return path.join(homedir(), '.agents', 'factory', 'config.json');
}

/**
 * Read the factory config, merging on-disk values with defaults. Missing
 * file or invalid JSON silently returns defaults.
 */
export async function readFactoryConfig(): Promise<FactoryConfig> {
  const p = factoryConfigPath();
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FactoryConfig>;
    return {
      cloud_priority: validatePriority(parsed.cloud_priority) ?? DEFAULT_CONFIG.cloud_priority,
      auto_detect_repo: typeof parsed.auto_detect_repo === 'boolean'
        ? parsed.auto_detect_repo
        : DEFAULT_CONFIG.auto_detect_repo,
      default_planner_agent: validateAgent(parsed.default_planner_agent) ?? DEFAULT_CONFIG.default_planner_agent,
      supervisor_interval_seconds:
        typeof parsed.supervisor_interval_seconds === 'number' && parsed.supervisor_interval_seconds >= 1
          ? parsed.supervisor_interval_seconds
          : DEFAULT_CONFIG.supervisor_interval_seconds,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeFactoryConfig(config: Partial<FactoryConfig>): Promise<FactoryConfig> {
  const current = await readFactoryConfig();
  const merged: FactoryConfig = {
    cloud_priority: validatePriority(config.cloud_priority) ?? current.cloud_priority,
    auto_detect_repo: typeof config.auto_detect_repo === 'boolean'
      ? config.auto_detect_repo
      : current.auto_detect_repo,
    default_planner_agent: validateAgent(config.default_planner_agent) ?? current.default_planner_agent,
    supervisor_interval_seconds:
      typeof config.supervisor_interval_seconds === 'number' && config.supervisor_interval_seconds >= 1
        ? config.supervisor_interval_seconds
        : current.supervisor_interval_seconds,
  };
  const p = factoryConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(merged, null, 2));
  return merged;
}

function validatePriority(value: unknown): DispatchProvider[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const valid: DispatchProvider[] = [];
  for (const entry of value) {
    if (entry === 'rush' || entry === 'codex' || entry === 'factory' || entry === 'local') {
      if (!valid.includes(entry)) valid.push(entry);
    }
  }
  return valid.length > 0 ? valid : null;
}

function validateAgent(value: unknown): FactoryConfig['default_planner_agent'] | null {
  if (value === 'claude' || value === 'codex' || value === 'gemini' || value === 'cursor' || value === 'opencode') {
    return value;
  }
  return null;
}

/**
 * Try to read `git remote get-url origin` in cwd and parse it into
 * `<owner>/<repo>`. Returns null if not a git repo, no origin, or an
 * unparseable URL.
 */
export function detectGitHubRepo(cwd: string): string | null {
  try {
    const url = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // https://github.com/owner/repo.git  or  git@github.com:owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    const sshMatch = url.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    return httpsMatch?.[1] ?? sshMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the dispatch decision for a factory operation given CLI overrides
 * and config priority. Returns the first viable provider, auto-detected
 * repo (if applicable), and a diagnostic list of providers that were
 * considered.
 */
export interface ResolvedDispatch {
  provider: DispatchProvider;
  repo?: string;
  considered: DispatchProvider[];
}

export async function resolveDispatch(
  cwd: string,
  cliCloud: string | undefined,
  cliLocal: boolean | undefined,
  cliRepo: string | undefined
): Promise<ResolvedDispatch> {
  if (cliLocal) {
    return { provider: 'local', considered: ['local'] };
  }

  const cfg = await readFactoryConfig();
  const considered: DispatchProvider[] = [];

  if (cliCloud) {
    considered.push(cliCloud as DispatchProvider);
    const repo = cliRepo ?? (cliCloud === 'rush' && cfg.auto_detect_repo ? detectGitHubRepo(cwd) ?? undefined : undefined);
    return { provider: cliCloud as DispatchProvider, repo, considered };
  }

  for (const provider of cfg.cloud_priority) {
    considered.push(provider);
    if (provider === 'local') return { provider, considered };
    if (provider === 'rush') {
      const repo = cliRepo ?? (cfg.auto_detect_repo ? detectGitHubRepo(cwd) : null) ?? null;
      if (!repo) continue;  // rush needs a repo; skip to next priority
      return { provider, repo: repo, considered };
    }
    return { provider, considered };
  }

  return { provider: 'local', considered: [...considered, 'local'] };
}
