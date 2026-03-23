import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { AGENTS, ALL_AGENT_IDS } from './agents.js';
import { getAgentsDir, getHooksDir as getCentralHooksDir } from './state.js';
import { getEffectiveHome } from './versions.js';
import type { AgentId, InstalledHook, ManifestHook } from './types.js';

export type HookEntry = { name: string; scriptPath: string; dataFile?: string };

const SCRIPT_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.ts',
  '.mjs',
  '.cjs',
  '.rb',
  '.pl',
  '.ps1',
  '.cmd',
  '.bat',
]);

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function getHooksDir(agentId: AgentId): string {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  return path.join(home, `.${agentId}`, agent.hooksDir);
}

function getProjectHooksDir(agentId: AgentId, cwd: string): string {
  const agent = AGENTS[agentId];
  return path.join(cwd, `.${agentId}`, agent.hooksDir);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function removeHookFiles(dir: string, name: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    if (base === name) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        fs.unlinkSync(fullPath);
      }
    }
  }
}

function listHookEntriesFromDir(dir: string): HookEntry[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files: {
    name: string;
    base: string;
    ext: string;
    fullPath: string;
    isExec: boolean;
  }[] = [];

  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    files.push({
      name: file,
      base,
      ext,
      fullPath,
      isExec: isExecutable(stat.mode),
    });
  }

  const grouped = new Map<string, typeof files>();
  for (const file of files) {
    const list = grouped.get(file.base) || [];
    list.push(file);
    grouped.set(file.base, list);
  }

  const entries: HookEntry[] = [];
  for (const [base, group] of grouped) {
    group.sort((a, b) => a.name.localeCompare(b.name));
    const script =
      group.find((f) => f.isExec) ||
      group.find((f) => SCRIPT_EXTENSIONS.has(f.ext.toLowerCase())) ||
      group[0];
    if (!script) continue;
    const data = group.find((f) => f !== script);
    entries.push({
      name: base,
      scriptPath: script.fullPath,
      dataFile: data ? data.fullPath : undefined,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function buildHookMap(entries: HookEntry[]): Map<string, HookEntry> {
  const map = new Map<string, HookEntry>();
  for (const entry of entries) {
    map.set(entry.name, entry);
  }
  return map;
}

function copyHook(entry: HookEntry, targetDir: string): void {
  ensureDir(targetDir);
  removeHookFiles(targetDir, entry.name);

  const scriptTarget = path.join(targetDir, path.basename(entry.scriptPath));
  fs.copyFileSync(entry.scriptPath, scriptTarget);
  const scriptStat = fs.statSync(entry.scriptPath);
  fs.chmodSync(scriptTarget, scriptStat.mode);

  if (entry.dataFile) {
    const dataTarget = path.join(targetDir, path.basename(entry.dataFile));
    fs.copyFileSync(entry.dataFile, dataTarget);
  }
}

/**
 * Check if a hook exists for an agent.
 */
export function hookExists(agentId: AgentId, hookName: string): boolean {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return false;
  }
  const hooksDir = getHooksDir(agentId);
  if (!fs.existsSync(hooksDir)) {
    return false;
  }
  const files = fs.readdirSync(hooksDir);
  return files.some((file) => {
    const ext = path.extname(file);
    const baseName = path.basename(file, ext);
    return baseName === hookName && SCRIPT_EXTENSIONS.has(ext);
  });
}

/**
 * Normalize content for comparison (trim, normalize line endings).
 */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/**
 * Get the installed hook entry for an agent.
 */
function getInstalledHookEntry(agentId: AgentId, hookName: string): HookEntry | null {
  const hooksDir = getHooksDir(agentId);
  const entries = listHookEntriesFromDir(hooksDir);
  return entries.find((e) => e.name === hookName) || null;
}

/**
 * Check if installed hook content matches source hook content.
 * Compares both script file and data file (if present).
 */
export function hookContentMatches(
  agentId: AgentId,
  hookName: string,
  sourceEntry: HookEntry
): boolean {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return false;
  }

  const installedEntry = getInstalledHookEntry(agentId, hookName);
  if (!installedEntry) {
    return false;
  }

  try {
    const installedScript = fs.readFileSync(installedEntry.scriptPath, 'utf-8');
    const sourceScript = fs.readFileSync(sourceEntry.scriptPath, 'utf-8');

    if (normalizeContent(installedScript) !== normalizeContent(sourceScript)) {
      return false;
    }

    const hasInstalledData = !!installedEntry.dataFile;
    const hasSourceData = !!sourceEntry.dataFile;

    if (hasInstalledData !== hasSourceData) {
      return false;
    }

    if (hasInstalledData && hasSourceData) {
      const installedData = fs.readFileSync(installedEntry.dataFile!, 'utf-8');
      const sourceData = fs.readFileSync(sourceEntry.dataFile!, 'utf-8');
      if (normalizeContent(installedData) !== normalizeContent(sourceData)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function listInstalledHooksWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledHook[] {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return [];
  }

  const results: InstalledHook[] = [];

  // User-scoped hooks (version-aware when home is provided)
  const home = options?.home || getEffectiveHome(agentId);
  const userDir = path.join(home, `.${agentId}`, agent.hooksDir);
  const userHooks = listHookEntriesFromDir(userDir);
  for (const hook of userHooks) {
    results.push({
      name: hook.name,
      path: hook.scriptPath,
      dataFile: hook.dataFile,
      scope: 'user',
      agent: agentId,
    });
  }

  const projectDir = getProjectHooksDir(agentId, cwd);
  const projectHooks = listHookEntriesFromDir(projectDir);
  for (const hook of projectHooks) {
    results.push({
      name: hook.name,
      path: hook.scriptPath,
      dataFile: hook.dataFile,
      scope: 'project',
      agent: agentId,
    });
  }

  return results;
}

export async function installHooks(
  source: string,
  agents: AgentId[],
  options: { scope?: 'user' | 'project' } = {}
): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = [];
  const errors: string[] = [];
  const scope = options.scope || 'user';
  const cwd = process.cwd();

  const hooksDir = path.join(source, 'hooks');
  const hooks = listHookEntriesFromDir(hooksDir);

  const uniqueAgents = Array.from(new Set(agents));
  for (const agentId of uniqueAgents) {
    const agent = AGENTS[agentId];
    if (!agent || !agent.supportsHooks) {
      errors.push(`${agentId}:Agent does not support hooks`);
      continue;
    }

    const targetDir =
      scope === 'project' ? getProjectHooksDir(agentId, cwd) : getHooksDir(agentId);

    for (const entry of hooks) {
      try {
        copyHook(entry, targetDir);
        installed.push(`${entry.name}:${agentId}`);
      } catch (err) {
        errors.push(`${entry.name}:${agentId}:${(err as Error).message}`);
      }
    }
  }

  return { installed, errors };
}

export async function removeHook(
  name: string,
  agents: AgentId[]
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];

  const uniqueAgents = Array.from(new Set(agents));
  for (const agentId of uniqueAgents) {
    const agent = AGENTS[agentId];
    if (!agent || !agent.supportsHooks) {
      errors.push(`${agentId}:Agent does not support hooks`);
      continue;
    }

    try {
      const dir = getHooksDir(agentId);
      const filesBefore = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      removeHookFiles(dir, name);
      const filesAfter = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      if (filesBefore.length !== filesAfter.length) {
        removed.push(`${name}:${agentId}`);
      }
    } catch (err) {
      errors.push(`${name}:${agentId}:${(err as Error).message}`);
    }
  }

  return { removed, errors };
}

/**
 * Get detailed info about a hook from central storage.
 */
export function getHookInfo(name: string): {
  name: string;
  path: string;
  content: string;
} | null {
  const centralDir = getCentralHooksDir();
  const hookPath = path.join(centralDir, name);

  if (!fs.existsSync(hookPath)) {
    return null;
  }

  // Read hook content - it could be a file or directory
  let content = '';
  const stat = fs.statSync(hookPath);
  if (stat.isFile()) {
    content = fs.readFileSync(hookPath, 'utf-8');
  } else if (stat.isDirectory()) {
    // For directory hooks, list the files
    const files = fs.readdirSync(hookPath);
    content = `Directory hook containing:\n${files.map((f) => `  - ${f}`).join('\n')}`;
  }

  return {
    name,
    path: hookPath,
    content,
  };
}

export function discoverHooksFromRepo(repoPath: string): string[] {
  const hooksDir = path.join(repoPath, 'hooks');
  return listHookEntriesFromDir(hooksDir).map((h) => h.name);
}

/**
 * Get the source hook entry from repo.
 */
export function getSourceHookEntry(
  repoPath: string,
  hookName: string
): HookEntry | null {
  const hooksDir = path.join(repoPath, 'hooks');
  const entries = listHookEntriesFromDir(hooksDir);
  return entries.find((e) => e.name === hookName) || null;
}

/**
 * Install hooks to central ~/.agents/hooks/ directory.
 * Shims will symlink this to per-agent directories for synced agents.
 */
export async function installHooksCentrally(
  source: string
): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = [];
  const errors: string[] = [];

  const centralDir = getCentralHooksDir();
  if (!fs.existsSync(centralDir)) {
    fs.mkdirSync(centralDir, { recursive: true });
  }

  // Collect all hooks from shared directory
  const sharedDir = path.join(source, 'hooks');
  const sharedHooks = listHookEntriesFromDir(sharedDir);

  for (const entry of sharedHooks) {
    try {
      copyHook(entry, centralDir);
      installed.push(entry.name);
    } catch (err) {
      errors.push(`${entry.name}: ${(err as Error).message}`);
    }
  }

  return { installed, errors };
}

/**
 * List hooks from central ~/.agents/hooks/ directory.
 */
export function listCentralHooks(): HookEntry[] {
  return listHookEntriesFromDir(getCentralHooksDir());
}

/**
 * Parse ~/.agents/hooks.yaml manifest.
 * Returns hook definitions with lifecycle event metadata.
 */
export function parseHookManifest(): Record<string, ManifestHook> {
  const manifestPath = path.join(getAgentsDir(), 'hooks.yaml');
  if (!fs.existsSync(manifestPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = yaml.parse(content) as Record<string, ManifestHook> | null;
    return parsed || {};
  } catch {
    return {};
  }
}

/**
 * Register hooks as lifecycle events in Claude's settings.json.
 * Reads hooks.yaml manifest, merges into settings.json hooks section.
 * Only manages hooks whose command paths are under ~/.agents/hooks/.
 * Does not remove user-added hooks.
 */
export function registerHooksToSettings(
  agentId: AgentId,
  versionHome: string,
  hookManifest?: Record<string, ManifestHook>
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  // Only Claude supports settings.json hooks registration
  if (agentId !== 'claude') {
    return { registered, errors };
  }

  const manifest = hookManifest || parseHookManifest();
  if (Object.keys(manifest).length === 0) {
    return { registered, errors };
  }

  const agentsDir = getAgentsDir();
  const configDir = path.join(versionHome, '.claude');
  const settingsPath = path.join(configDir, 'settings.json');

  // Read existing settings
  let config: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      errors.push('Failed to parse settings.json');
      return { registered, errors };
    }
  }

  // Ensure hooks object exists
  if (!config.hooks || typeof config.hooks !== 'object') {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown[]>;

  // Marker prefix for managed hooks — we only touch hooks with this path prefix
  const managedPrefix = path.join(agentsDir, 'hooks') + '/';

  for (const [name, hookDef] of Object.entries(manifest)) {
    // Skip if not for this agent
    if (hookDef.agents && !hookDef.agents.includes(agentId)) {
      continue;
    }

    if (!hookDef.events || hookDef.events.length === 0) {
      continue;
    }

    const commandPath = path.join(agentsDir, 'hooks', hookDef.script);
    if (!fs.existsSync(commandPath)) {
      errors.push(`${name}: script not found at ${commandPath}`);
      continue;
    }

    for (const event of hookDef.events) {
      // Ensure event array exists
      if (!hooks[event]) {
        hooks[event] = [];
      }

      const eventEntries = hooks[event] as Array<{
        matcher?: string;
        hooks?: Array<{ type: string; command: string; timeout?: number }>;
      }>;

      const matcher = hookDef.matcher || '';
      const timeout = hookDef.timeout || 600;

      // Find existing matcher group or create one
      let matcherGroup = eventEntries.find((e) => (e.matcher || '') === matcher);
      if (!matcherGroup) {
        matcherGroup = { matcher, hooks: [] };
        eventEntries.push(matcherGroup);
      }

      if (!matcherGroup.hooks) {
        matcherGroup.hooks = [];
      }

      // Check if this hook is already registered (by command path)
      const existingIdx = matcherGroup.hooks.findIndex(
        (h) => h.command === commandPath
      );

      const hookEntry = {
        type: 'command' as const,
        command: commandPath,
        timeout,
      };

      if (existingIdx >= 0) {
        // Update existing
        matcherGroup.hooks[existingIdx] = hookEntry;
      } else {
        // Add new
        matcherGroup.hooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  // Write back
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write settings.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}
