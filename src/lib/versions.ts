import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { checkbox, select, confirm } from '@inquirer/prompts';
import type { AgentId, VersionResources } from './types.js';
import { getVersionsDir, getShimsDir, ensureAgentsDir, readMeta, writeMeta, getCommandsDir, getSkillsDir, getHooksDir, getMemoryDir, getPermissionsDir, clearVersionResources, getVersionResources, recordVersionResources, getMcpDir } from './state.js';
import { AGENTS, getAccountEmail, MCP_CAPABLE_AGENTS } from './agents.js';
import { getDefaultPermissionSet, applyPermissionsToVersion as applyPermsToVersion, PERMISSIONS_CAPABLE_AGENTS, discoverPermissionGroups, getTotalPermissionRuleCount, buildPermissionsFromGroups } from './permissions.js';
import { applyMcpToVersion } from './mcp.js';
import { markdownToToml } from './convert.js';
import { createVersionedAlias, removeVersionedAlias, switchConfigSymlink, getConfigSymlinkVersion } from './shims.js';

const execAsync = promisify(exec);

/**
 * Resource selection for syncing to a version.
 * Each field can be:
 * - 'all' - sync all available resources of this type
 * - string[] - sync only these specific resources
 * - undefined - skip this resource type
 */
export interface ResourceSelection {
  commands?: string[] | 'all';
  skills?: string[] | 'all';
  hooks?: string[] | 'all';
  memory?: string[] | 'all';
  mcp?: string[] | 'all';
  permissions?: string[] | 'all';
}

/**
 * Available resources in ~/.agents/ for syncing.
 */
export interface AvailableResources {
  commands: string[];
  skills: string[];
  hooks: string[];
  memory: string[];
  mcp: string[];
  permissions: string[];
}

/**
 * Get all available resources from ~/.agents/.
 */
export function getAvailableResources(): AvailableResources {
  const result: AvailableResources = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
    permissions: [],
  };

  // Commands (*.md files)
  const commandsDir = getCommandsDir();
  if (fs.existsSync(commandsDir)) {
    result.commands = fs.readdirSync(commandsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  }

  // Skills (directories, excluding hidden)
  const skillsDir = getSkillsDir();
  if (fs.existsSync(skillsDir)) {
    result.skills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
  }

  // Hooks (executable files)
  const hooksDir = getHooksDir();
  if (fs.existsSync(hooksDir)) {
    result.hooks = fs.readdirSync(hooksDir)
      .filter(f => !f.startsWith('.'));
  }

  // Memory (*.md files)
  const memoryDir = getMemoryDir();
  if (fs.existsSync(memoryDir)) {
    result.memory = fs.readdirSync(memoryDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  }

  // MCP servers (*.yaml files)
  const mcpDir = getMcpDir();
  if (fs.existsSync(mcpDir)) {
    result.mcp = fs.readdirSync(mcpDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => f.replace(/\.(yaml|yml)$/, ''));
  }

  // Permission groups (from permissions/groups/*.yaml)
  const permsGroupsDir = path.join(getPermissionsDir(), 'groups');
  if (fs.existsSync(permsGroupsDir)) {
    result.permissions = fs.readdirSync(permsGroupsDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => f.replace(/\.(yaml|yml)$/, ''));
  }

  return result;
}

/**
 * Prompt user to select which resources to sync from ~/.agents/.
 * Returns the selection, or null if user cancels.
 */
export async function promptResourceSelection(agent: AgentId): Promise<ResourceSelection | null> {
  const available = getAvailableResources();
  const agentConfig = AGENTS[agent];
  const selection: ResourceSelection = {};

  // Get permission group info for display
  const permissionGroups = discoverPermissionGroups();
  const totalPermissionRules = permissionGroups.reduce((sum, g) => sum + g.ruleCount, 0);

  // Build category choices based on what's available
  type CategoryKey = keyof AvailableResources;
  const categories: { key: CategoryKey; label: string; available: boolean; displayCount: string }[] = [
    { key: 'commands', label: 'Commands', available: available.commands.length > 0, displayCount: `${available.commands.length} available` },
    { key: 'skills', label: 'Skills', available: available.skills.length > 0, displayCount: `${available.skills.length} available` },
    { key: 'hooks', label: 'Hooks', available: agentConfig.supportsHooks && available.hooks.length > 0, displayCount: `${available.hooks.length} available` },
    { key: 'memory', label: 'Memory', available: available.memory.length > 0, displayCount: `${available.memory.length} available` },
    { key: 'mcp', label: 'MCPs', available: MCP_CAPABLE_AGENTS.includes(agent) && available.mcp.length > 0, displayCount: `${available.mcp.length} available` },
    { key: 'permissions', label: 'Permissions', available: PERMISSIONS_CAPABLE_AGENTS.includes(agent) && permissionGroups.length > 0, displayCount: `${permissionGroups.length} groups, ${totalPermissionRules} rules` },
  ];

  const availableCategories = categories.filter(c => c.available);

  if (availableCategories.length === 0) {
    console.log(chalk.gray('No resources available in ~/.agents/'));
    return {};
  }

  // Step 1: Select categories
  console.log();
  const selectedCategories = await checkbox<CategoryKey>({
    message: 'Which resources from ~/.agents/ would you like to sync?',
    choices: availableCategories.map(c => ({
      name: `${c.label} (${c.displayCount})`,
      value: c.key,
      checked: true, // Default all checked
    })),
  });

  if (selectedCategories.length === 0) {
    return {};
  }

  // Step 2: For each selected category, ask all/specific/skip
  for (const category of selectedCategories) {
    const categoryLabel = categories.find(c => c.key === category)!.label;

    // Special handling for permissions - show groups
    if (category === 'permissions') {
      const choice = await select<'all' | 'specific' | 'skip'>({
        message: `${categoryLabel}:`,
        choices: [
          { name: `Select all (${permissionGroups.length} groups)`, value: 'all' },
          { name: 'Select specific groups', value: 'specific' },
          { name: 'Skip', value: 'skip' },
        ],
        default: 'all',
      });

      if (choice === 'all') {
        selection.permissions = 'all';
      } else if (choice === 'specific') {
        const selected = await checkbox<string>({
          message: 'Select permission groups to sync:',
          choices: permissionGroups.map(g => ({
            name: `${g.name} (${g.ruleCount} rules)`,
            value: g.name,
            checked: true,
          })),
        });
        if (selected.length > 0) {
          selection.permissions = selected;
        }
      }
    } else {
      // Standard handling for other categories
      const items = available[category];

      const choice = await select<'all' | 'specific' | 'skip'>({
        message: `${categoryLabel}:`,
        choices: [
          { name: `Select all (${items.length})`, value: 'all' },
          { name: 'Select specific', value: 'specific' },
          { name: 'Skip', value: 'skip' },
        ],
        default: 'all',
      });

      if (choice === 'all') {
        selection[category] = 'all';
      } else if (choice === 'specific') {
        const selected = await checkbox<string>({
          message: `Select ${categoryLabel.toLowerCase()} to sync:`,
          choices: items.map(item => ({
            name: item,
            value: item,
            checked: true,
          })),
        });
        if (selected.length > 0) {
          selection[category] = selected;
        }
      }
    }
    // 'skip' means we don't set anything for this category
  }

  return selection;
}

export interface AgentSpec {
  agent: AgentId;
  version: string;
}

/**
 * Parse agent@version syntax.
 * Examples:
 *   "claude@1.5.0" -> { agent: "claude", version: "1.5.0" }
 *   "claude" -> { agent: "claude", version: "latest" }
 *   "codex@latest" -> { agent: "codex", version: "latest" }
 */
export function parseAgentSpec(spec: string): AgentSpec | null {
  const parts = spec.split('@');
  const agentName = parts[0].toLowerCase();
  const version = parts[1] || 'latest';

  if (!AGENTS[agentName as AgentId]) {
    return null;
  }

  return {
    agent: agentName as AgentId,
    version,
  };
}

/**
 * Get the directory where a specific version is installed.
 */
export function getVersionDir(agent: AgentId, version: string): string {
  return path.join(getVersionsDir(), agent, version);
}

/**
 * Get the binary path for a specific agent version.
 */
export function getBinaryPath(agent: AgentId, version: string): string {
  const versionDir = getVersionDir(agent, version);
  const agentConfig = AGENTS[agent];
  return path.join(versionDir, 'node_modules', '.bin', agentConfig.cliCommand);
}

/**
 * Get the isolated HOME directory for a specific agent version.
 * Each version has its own config isolation (like jobs sandbox).
 */
export function getVersionHomePath(agent: AgentId, version: string): string {
  return path.join(getVersionDir(agent, version), 'home');
}

/**
 * Check if a specific version is installed.
 */
export function isVersionInstalled(agent: AgentId, version: string): boolean {
  const binaryPath = getBinaryPath(agent, version);
  return fs.existsSync(binaryPath);
}

/**
 * Get the latest available version from npm for an agent.
 */
export async function getLatestNpmVersion(agent: AgentId): Promise<string | null> {
  const agentConfig = AGENTS[agent];
  if (!agentConfig.npmPackage) return null;

  try {
    const { stdout } = await execAsync(`npm view ${agentConfig.npmPackage} version`);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Check if 'latest' version is already installed (by resolving to actual version).
 */
export async function isLatestInstalled(agent: AgentId): Promise<{ installed: boolean; version: string | null }> {
  const latestVersion = await getLatestNpmVersion(agent);
  if (!latestVersion) {
    return { installed: false, version: null };
  }
  return { installed: isVersionInstalled(agent, latestVersion), version: latestVersion };
}

/**
 * List all installed versions for an agent.
 */
export function listInstalledVersions(agent: AgentId): string[] {
  const agentVersionsDir = path.join(getVersionsDir(), agent);
  if (!fs.existsSync(agentVersionsDir)) {
    return [];
  }

  const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  const versions: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const binaryPath = getBinaryPath(agent, entry.name);
      if (fs.existsSync(binaryPath)) {
        versions.push(entry.name);
      }
    }
  }

  return versions.sort(compareVersions);
}

/**
 * Get the global default version for an agent.
 */
export function getGlobalDefault(agent: AgentId): string | null {
  const meta = readMeta();
  return meta.agents?.[agent] || null;
}

/**
 * Set the global default version for an agent.
 */
export function setGlobalDefault(agent: AgentId, version: string): void {
  const meta = readMeta();
  if (!meta.agents) {
    meta.agents = {};
  }
  meta.agents[agent] = version;
  writeMeta(meta);
}

/**
 * Install a specific version of an agent.
 */
export async function installVersion(
  agent: AgentId,
  version: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; installedVersion: string; error?: string }> {
  const agentConfig = AGENTS[agent];

  if (!agentConfig.npmPackage) {
    return { success: false, installedVersion: version, error: 'Agent has no npm package' };
  }

  ensureAgentsDir();
  const versionDir = getVersionDir(agent, version);

  // Create version directory and isolated home
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });

  // Initialize package.json
  const packageJson = {
    name: `agents-${agent}-${version}`,
    version: '1.0.0',
    private: true,
  };
  fs.writeFileSync(path.join(versionDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  // Install the package
  const packageSpec = version === 'latest'
    ? agentConfig.npmPackage
    : `${agentConfig.npmPackage}@${version}`;

  try {
    onProgress?.(`Installing ${packageSpec}...`);
    const { stdout } = await execAsync(`npm install ${packageSpec}`, { cwd: versionDir });

    // Determine the actual installed version
    let installedVersion = version;
    if (version === 'latest') {
      const pkgJsonPath = path.join(versionDir, 'node_modules', agentConfig.npmPackage.replace(/^@/, '').split('/')[0], 'package.json');
      // Try to read the actual version from installed package
      try {
        const installedPkgPath = path.join(versionDir, 'node_modules', agentConfig.npmPackage, 'package.json');
        if (fs.existsSync(installedPkgPath)) {
          const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf-8'));
          installedVersion = installedPkg.version;

          // Rename the directory to the actual version
          if (installedVersion !== 'latest') {
            const actualVersionDir = getVersionDir(agent, installedVersion);
            if (!fs.existsSync(actualVersionDir)) {
              fs.renameSync(versionDir, actualVersionDir);
            } else {
              // Already exists, remove the 'latest' dir
              fs.rmSync(versionDir, { recursive: true, force: true });
            }
          }
        }
      } catch (e) {
        // Failed to determine version - this shouldn't happen
        throw new Error(`Failed to determine installed version: ${(e as Error).message}`);
      }
    }

    // Create versioned alias (e.g., claude@2.0.65)
    createVersionedAlias(agent, installedVersion);

    return { success: true, installedVersion };
  } catch (err) {
    // Clean up on failure
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    return { success: false, installedVersion: version, error: (err as Error).message };
  }
}

/**
 * Remove a specific version of an agent.
 */
export function removeVersion(agent: AgentId, version: string): boolean {
  const versionDir = getVersionDir(agent, version);

  if (!fs.existsSync(versionDir)) {
    return false;
  }

  fs.rmSync(versionDir, { recursive: true, force: true });

  // Remove versioned alias (e.g., claude@2.0.65)
  removeVersionedAlias(agent, version);

  // Clear resource tracking for this version
  clearVersionResources(agent, version);

  // Clear default if it was the removed version - user must explicitly pick a new one
  if (getGlobalDefault(agent) === version) {
    const meta = readMeta();
    if (meta.agents?.[agent]) {
      delete meta.agents[agent];
      writeMeta(meta);
    }
    const remaining = listInstalledVersions(agent);
    if (remaining.length > 0) {
      console.log(chalk.yellow(`Default version removed. Run: agents use ${agent}@<version> to set a new default`));
    }
  }

  // Clean up dangling config symlink if it pointed to the removed version
  const symlinkVersion = getConfigSymlinkVersion(agent);
  if (symlinkVersion === version) {
    const configPath = path.join(os.homedir(), `.${agent}`);
    try {
      fs.unlinkSync(configPath);
    } catch {
      // Ignore if already gone
    }
  }

  return true;
}

/**
 * Remove all versions of an agent.
 */
export function removeAllVersions(agent: AgentId): number {
  const versions = listInstalledVersions(agent);
  let removed = 0;

  for (const version of versions) {
    if (removeVersion(agent, version)) {
      removed++;
    }
  }

  // Clean up the agent directory
  const agentDir = path.join(getVersionsDir(), agent);
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }

  return removed;
}

/**
 * Get the resolved version for an agent in the current context.
 * Checks project manifest first, then global default.
 */
export function resolveVersion(agent: AgentId, projectPath?: string): string | null {
  // Check project manifest
  if (projectPath) {
    const version = getProjectVersion(agent, projectPath);
    if (version) {
      return version;
    }
  }

  // Fall back to global default
  return getGlobalDefault(agent);
}

/**
 * Get version specified in project manifest.
 */
export function getProjectVersion(agent: AgentId, startPath: string): string | null {
  let dir = path.resolve(startPath);

  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, '.agents', 'agents.yaml');
    if (fs.existsSync(manifestPath)) {
      try {
        const content = fs.readFileSync(manifestPath, 'utf-8');
        // Simple YAML parsing for agents section (flat format: claude: "1.5.0")
        const agentMatch = content.match(new RegExp(`^\\s+${agent}:\\s*['"]?([^'"\n]+)['"]?`, 'm'));
        if (agentMatch) {
          return agentMatch[1].trim();
        }
      } catch {
        // Ignore parsing errors
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Compare semver versions for sorting.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map((n) => parseInt(n, 10) || 0);
  const bParts = b.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal !== bVal) {
      return aVal - bVal;
    }
  }

  return 0;
}

/**
 * Get actual version from an installed 'latest' directory.
 */
export async function getInstalledVersion(agent: AgentId, version: string): Promise<string | null> {
  const binaryPath = getBinaryPath(agent, version);
  if (!fs.existsSync(binaryPath)) {
    return null;
  }

  try {
    const { stdout } = await execAsync(`${binaryPath} --version`);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : version;
  } catch {
    return version;
  }
}

export interface SyncResult {
  commands: boolean;
  skills: boolean;
  hooks: boolean;
  memory: string[];
  permissions: boolean;
  mcp: string[];
}

export interface ResourceDiff {
  commands: { added: string[]; dangling: string[] };
  skills: { added: string[]; dangling: string[] };
  hooks: { added: string[]; dangling: string[] };
  memory: { added: string[]; dangling: string[] };
  totalAdded: number;
  totalDangling: number;
}

/**
 * Get the diff between central resources (~/.agents/) and what's synced to a version.
 * Uses filesystem state - no tracking needed.
 */
export function getResourceDiff(agent: AgentId, version: string): ResourceDiff {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, `.${agent}`);

  const diff: ResourceDiff = {
    commands: { added: [], dangling: [] },
    skills: { added: [], dangling: [] },
    hooks: { added: [], dangling: [] },
    memory: { added: [], dangling: [] },
    totalAdded: 0,
    totalDangling: 0,
  };

  // Helper to check symlink status
  const getSymlinkStatus = (linkPath: string): 'valid' | 'dangling' | 'none' => {
    try {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) return 'none';
      // Check if target exists
      try {
        fs.statSync(linkPath);
        return 'valid';
      } catch {
        return 'dangling';
      }
    } catch {
      return 'none';
    }
  };

  // Commands: check directory symlink (or individual files for Gemini)
  const centralCommands = getCommandsDir();
  const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);

  if (agentConfig.format === 'toml') {
    // Gemini: compare .md files in central vs .toml files in version
    if (fs.existsSync(centralCommands)) {
      const centralFiles = fs.readdirSync(centralCommands).filter(f => f.endsWith('.md'));
      const versionFiles = fs.existsSync(commandsTarget)
        ? fs.readdirSync(commandsTarget).filter(f => f.endsWith('.toml'))
        : [];
      const versionNames = new Set(versionFiles.map(f => f.replace('.toml', '')));

      for (const file of centralFiles) {
        const name = file.replace('.md', '');
        if (!versionNames.has(name)) {
          diff.commands.added.push(file);
        }
      }
      // Check for dangling (toml exists but no md source)
      const centralNames = new Set(centralFiles.map(f => f.replace('.md', '')));
      for (const file of versionFiles) {
        const name = file.replace('.toml', '');
        if (!centralNames.has(name)) {
          diff.commands.dangling.push(file);
        }
      }
    }
  } else {
    // Other agents: check directory symlink
    const status = getSymlinkStatus(commandsTarget);
    if (status === 'none' && fs.existsSync(centralCommands)) {
      const files = fs.readdirSync(centralCommands).filter(f => f.endsWith('.md'));
      diff.commands.added = files;
    } else if (status === 'dangling') {
      diff.commands.dangling = ['commands/'];
    }
  }

  // Skills: check directory symlink
  const centralSkills = getSkillsDir();
  const skillsTarget = path.join(agentDir, 'skills');
  const skillsStatus = getSymlinkStatus(skillsTarget);
  if (skillsStatus === 'none' && fs.existsSync(centralSkills)) {
    const dirs = fs.readdirSync(centralSkills).filter(f => {
      const stat = fs.statSync(path.join(centralSkills, f));
      return stat.isDirectory() && !f.startsWith('.');
    });
    diff.skills.added = dirs;
  } else if (skillsStatus === 'dangling') {
    diff.skills.dangling = ['skills/'];
  }

  // Hooks: check directory symlink (if agent supports hooks)
  if (agentConfig.supportsHooks) {
    const centralHooks = getHooksDir();
    const hooksTarget = path.join(agentDir, 'hooks');
    const hooksStatus = getSymlinkStatus(hooksTarget);
    if (hooksStatus === 'none' && fs.existsSync(centralHooks)) {
      const files = fs.readdirSync(centralHooks).filter(f => !f.startsWith('.'));
      diff.hooks.added = files;
    } else if (hooksStatus === 'dangling') {
      diff.hooks.dangling = ['hooks/'];
    }
  }

  // Memory: check individual file symlinks
  const centralMemory = getMemoryDir();
  if (fs.existsSync(centralMemory)) {
    const memoryFiles = fs.readdirSync(centralMemory).filter(f => f.endsWith('.md'));
    for (const file of memoryFiles) {
      const targetName = file === 'AGENTS.md' ? agentConfig.instructionsFile : file;
      const targetPath = path.join(agentDir, targetName);
      const status = getSymlinkStatus(targetPath);
      if (status === 'none') {
        diff.memory.added.push(file);
      } else if (status === 'dangling') {
        diff.memory.dangling.push(targetName);
      }
    }
  }

  // Calculate totals
  diff.totalAdded = diff.commands.added.length + diff.skills.added.length +
    diff.hooks.added.length + diff.memory.added.length;
  diff.totalDangling = diff.commands.dangling.length + diff.skills.dangling.length +
    diff.hooks.dangling.length + diff.memory.dangling.length;

  return diff;
}

/**
 * Sync central resources (~/.agents/) into a specific version's config directory.
 * Copies selected resources from central storage into {versionHome}/.{agent}/.
 *
 * @param agent - The agent ID
 * @param version - The version string
 * @param selection - Optional resource selection. If not provided, syncs all resources.
 *
 * For Gemini: commands are converted from markdown to TOML.
 */
export function syncResourcesToVersion(agent: AgentId, version: string, selection?: ResourceSelection): SyncResult {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, `.${agent}`);
  fs.mkdirSync(agentDir, { recursive: true });

  const result: SyncResult = { commands: false, skills: false, hooks: false, memory: [], permissions: false, mcp: [] };
  const available = getAvailableResources();

  // Helper: remove a path (symlink or real) if it exists
  const removePath = (p: string) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(p);
      } else if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  };

  // Helper: copy a directory recursively
  const copyDir = (src: string, dest: string) => {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };

  // Helper: resolve selection to list of items
  const resolveSelection = (sel: string[] | 'all' | undefined, available: string[]): string[] => {
    if (sel === 'all') return available;
    if (Array.isArray(sel)) return sel;
    return [];
  };

  // Sync commands
  const commandsToSync = selection
    ? resolveSelection(selection.commands, available.commands)
    : available.commands; // No selection = sync all

  if (commandsToSync.length > 0) {
    const centralCommands = getCommandsDir();
    const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);
    removePath(commandsTarget);
    fs.mkdirSync(commandsTarget, { recursive: true });

    const syncedCommands: string[] = [];
    for (const cmd of commandsToSync) {
      const srcFile = path.join(centralCommands, `${cmd}.md`);
      if (!fs.existsSync(srcFile)) continue;

      if (agentConfig.format === 'toml') {
        // Gemini: convert markdown to TOML
        const content = fs.readFileSync(srcFile, 'utf-8');
        const tomlContent = markdownToToml(cmd, content);
        fs.writeFileSync(path.join(commandsTarget, `${cmd}.toml`), tomlContent);
      } else {
        // Copy markdown file
        fs.copyFileSync(srcFile, path.join(commandsTarget, `${cmd}.md`));
      }
      syncedCommands.push(cmd);
    }
    result.commands = syncedCommands.length > 0;
    if (syncedCommands.length > 0) {
      recordVersionResources(agent, version, 'commands', syncedCommands);
    }
  }

  // Sync skills
  const skillsToSync = selection
    ? resolveSelection(selection.skills, available.skills)
    : available.skills;

  if (skillsToSync.length > 0) {
    const centralSkills = getSkillsDir();
    const skillsTarget = path.join(agentDir, 'skills');
    removePath(skillsTarget);
    fs.mkdirSync(skillsTarget, { recursive: true });

    const syncedSkills: string[] = [];
    for (const skill of skillsToSync) {
      const srcDir = path.join(centralSkills, skill);
      if (!fs.existsSync(srcDir)) continue;

      const destDir = path.join(skillsTarget, skill);
      copyDir(srcDir, destDir);
      syncedSkills.push(skill);
    }
    result.skills = syncedSkills.length > 0;
    if (syncedSkills.length > 0) {
      recordVersionResources(agent, version, 'skills', syncedSkills);
    }
  }

  // Sync hooks (if agent supports them)
  if (agentConfig.supportsHooks) {
    const hooksToSync = selection
      ? resolveSelection(selection.hooks, available.hooks)
      : available.hooks;

    if (hooksToSync.length > 0) {
      const centralHooks = getHooksDir();
      const hooksTarget = path.join(agentDir, 'hooks');
      removePath(hooksTarget);
      fs.mkdirSync(hooksTarget, { recursive: true });

      const syncedHooks: string[] = [];
      for (const hook of hooksToSync) {
        const srcFile = path.join(centralHooks, hook);
        if (!fs.existsSync(srcFile)) continue;

        const destFile = path.join(hooksTarget, hook);
        fs.copyFileSync(srcFile, destFile);
        // Preserve executable permission
        fs.chmodSync(destFile, 0o755);
        syncedHooks.push(hook);
      }
      result.hooks = syncedHooks.length > 0;
      if (syncedHooks.length > 0) {
        recordVersionResources(agent, version, 'hooks', syncedHooks);
      }
    }
  }

  // Sync memory files
  const memoryToSync = selection
    ? resolveSelection(selection.memory, available.memory)
    : available.memory;

  if (memoryToSync.length > 0) {
    const centralMemory = getMemoryDir();
    const syncedMemory: string[] = [];

    for (const mem of memoryToSync) {
      const srcFile = path.join(centralMemory, `${mem}.md`);
      if (!fs.existsSync(srcFile)) continue;

      // AGENTS.md gets renamed to the agent's instructionsFile name
      const targetName = mem === 'AGENTS' ? agentConfig.instructionsFile : `${mem}.md`;
      const destFile = path.join(agentDir, targetName);

      removePath(destFile);
      fs.copyFileSync(srcFile, destFile);
      result.memory.push(targetName);
      syncedMemory.push(mem);
    }
    if (syncedMemory.length > 0) {
      recordVersionResources(agent, version, 'memory', syncedMemory);
    }
  }

  // Apply permissions (if agent supports them)
  // Permissions are now stored as groups in ~/.agents/permissions/groups/
  const permissionGroups = discoverPermissionGroups();
  const allGroupNames = permissionGroups.map(g => g.name);
  const permsToSync = selection
    ? resolveSelection(selection.permissions, allGroupNames)
    : (PERMISSIONS_CAPABLE_AGENTS.includes(agent) ? allGroupNames : []);

  if (permsToSync.length > 0 && PERMISSIONS_CAPABLE_AGENTS.includes(agent)) {
    // Build permissions from selected groups
    const builtPerms = buildPermissionsFromGroups(permsToSync);
    if (builtPerms.allow.length > 0 || (builtPerms.deny && builtPerms.deny.length > 0)) {
      const permResult = applyPermsToVersion(agent, builtPerms, versionHome, true);
      result.permissions = permResult.success;
      if (permResult.success) {
        recordVersionResources(agent, version, 'permissions', permsToSync);
      }
    }
  }

  // Apply MCP servers (if agent supports them)
  const mcpToSync = selection
    ? resolveSelection(selection.mcp, available.mcp)
    : (MCP_CAPABLE_AGENTS.includes(agent) ? available.mcp : []);

  if (mcpToSync.length > 0 && MCP_CAPABLE_AGENTS.includes(agent)) {
    const mcpResult = applyMcpToVersion(agent, versionHome, true, mcpToSync);
    result.mcp = mcpResult.applied;
    if (mcpResult.applied.length > 0) {
      recordVersionResources(agent, version, 'mcp', mcpResult.applied);
    }
  }

  return result;
}

/**
 * Get the effective HOME directory for an agent.
 * If version-managed with a resolved version, returns the version's home directory.
 * Otherwise returns the real HOME.
 */
export function getEffectiveHome(agentId: AgentId): string {
  const resolved = resolveVersion(agentId, process.cwd());
  if (resolved && isVersionInstalled(agentId, resolved)) {
    return getVersionHomePath(agentId, resolved);
  }
  return os.homedir();
}

export interface VersionSelectionResult {
  selectedAgents: AgentId[];
  versionSelections: Map<AgentId, string[]>;
}

/**
 * Prompt user to select agents and versions for resource installation.
 * Returns selected agents and their version selections.
 */
export async function promptAgentVersionSelection(
  availableAgents: AgentId[],
  options: { skipPrompts?: boolean } = {}
): Promise<VersionSelectionResult> {
  const versionSelections = new Map<AgentId, string[]>();

  // Filter to installed agents (only those with versions managed by agents CLI)
  const installedAgents = availableAgents.filter((id) => {
    const versions = listInstalledVersions(id);
    return versions.length > 0;
  });

  if (installedAgents.length === 0) {
    return { selectedAgents: [], versionSelections };
  }

  const formatAgentLabel = (agentId: AgentId): string => {
    const versions = listInstalledVersions(agentId);
    const defaultVer = getGlobalDefault(agentId);
    if (versions.length === 0) return `${AGENTS[agentId].name}  ${chalk.gray('(not installed)')}`;
    if (defaultVer) return `${AGENTS[agentId].name}  ${chalk.gray(`(active: ${defaultVer})`)}`;
    return `${AGENTS[agentId].name}  ${chalk.gray(`(${versions[0]})`)}`;
  };

  let selectedAgents: AgentId[];

  if (options.skipPrompts) {
    // Auto-select all installed agents with default versions
    selectedAgents = [...installedAgents];
    for (const agentId of selectedAgents) {
      const versions = listInstalledVersions(agentId);
      if (versions.length > 0) {
        const defaultVer = getGlobalDefault(agentId);
        versionSelections.set(agentId, defaultVer ? [defaultVer] : [versions[versions.length - 1]]);
      }
    }
  } else {
    // Prompt for agent selection
    const checkboxResult = await checkbox<string>({
      message: 'Which agents should receive these resources?',
      choices: [
        { name: chalk.bold('All'), value: 'all', checked: true },
        ...installedAgents.map((id) => ({
          name: `  ${formatAgentLabel(id)}`,
          value: id,
          checked: false,
        })),
      ],
    });

    if (checkboxResult.includes('all')) {
      selectedAgents = [...installedAgents];
    } else {
      selectedAgents = checkboxResult as AgentId[];
    }

    // Version selection per agent
    for (const agentId of selectedAgents) {
      const versions = listInstalledVersions(agentId);
      if (versions.length === 0) continue;
      if (versions.length === 1) {
        versionSelections.set(agentId, [versions[0]]);
        continue;
      }

      const defaultVer = getGlobalDefault(agentId);
      const versionEmails = await Promise.all(
        versions.map((v) =>
          getAccountEmail(agentId, getVersionHomePath(agentId, v)).then((email) => ({ v, email }))
        )
      );
      const versionEmailMap = new Map(versionEmails.map((e) => [e.v, e.email]));

      const maxLabelLen = Math.max(...versions.map((v) => (v === defaultVer ? `${v} (default)` : v).length));
      const versionResult = await checkbox<string>({
        message: `Which versions of ${AGENTS[agentId].name} should receive these resources?`,
        choices: [
          { name: chalk.bold('All versions'), value: 'all', checked: false },
          ...versions.map((v) => {
            const base = v === defaultVer ? `${v} (default)` : v;
            let label = base.padEnd(maxLabelLen);
            const email = versionEmailMap.get(v);
            if (email) label += chalk.cyan(`  ${email}`);
            return { name: label, value: v, checked: v === defaultVer };
          }),
        ],
      });

      if (versionResult.includes('all')) {
        versionSelections.set(agentId, [...versions]);
      } else {
        versionSelections.set(agentId, versionResult);
      }
    }
  }

  return { selectedAgents, versionSelections };
}
