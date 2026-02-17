import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { checkbox } from '@inquirer/prompts';
import type { AgentId } from './types.js';
import { getVersionsDir, getShimsDir, ensureAgentsDir, readMeta, writeMeta, getCommandsDir, getSkillsDir, getHooksDir, getMemoryDir, getPermissionsDir, clearVersionResources } from './state.js';
import { AGENTS, getAccountEmail } from './agents.js';
import { getDefaultPermissionSet, applyPermissionsToVersion as applyPermsToVersion, PERMISSIONS_CAPABLE_AGENTS } from './permissions.js';
import { markdownToToml } from './convert.js';
import { createVersionedAlias, removeVersionedAlias, switchConfigSymlink } from './shims.js';

const execAsync = promisify(exec);

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
}

/**
 * Sync central resources (~/.agents/) into a specific version's config directory.
 * Creates symlinks from central storage into {versionHome}/.{agent}/.
 *
 * For Gemini: commands are converted from markdown to TOML and copied instead of symlinked.
 */
export function syncResourcesToVersion(agent: AgentId, version: string): SyncResult {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, `.${agent}`);
  fs.mkdirSync(agentDir, { recursive: true });

  const result: SyncResult = { commands: false, skills: false, hooks: false, memory: [], permissions: false };

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

  // Symlink commands
  const centralCommands = getCommandsDir();
  const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);
  if (fs.existsSync(centralCommands)) {
    removePath(commandsTarget);

    if (agentConfig.format === 'toml') {
      // Gemini: convert markdown commands to TOML and copy
      fs.mkdirSync(commandsTarget, { recursive: true });
      const files = fs.readdirSync(centralCommands).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const name = file.replace(/\.md$/, '');
        const content = fs.readFileSync(path.join(centralCommands, file), 'utf-8');
        const tomlContent = markdownToToml(name, content);
        fs.writeFileSync(path.join(commandsTarget, `${name}.toml`), tomlContent);
      }
      result.commands = files.length > 0;
    } else {
      // Other agents: symlink the entire directory
      try {
        fs.symlinkSync(centralCommands, commandsTarget);
        result.commands = true;
      } catch {}
    }
  }

  // Symlink skills
  const centralSkills = getSkillsDir();
  const skillsTarget = path.join(agentDir, 'skills');
  if (fs.existsSync(centralSkills)) {
    removePath(skillsTarget);
    try {
      fs.symlinkSync(centralSkills, skillsTarget);
      result.skills = true;
    } catch {}
  }

  // Symlink hooks (if agent supports them)
  if (agentConfig.supportsHooks) {
    const centralHooks = getHooksDir();
    const hooksTarget = path.join(agentDir, 'hooks');
    if (fs.existsSync(centralHooks)) {
      removePath(hooksTarget);
      try {
        fs.symlinkSync(centralHooks, hooksTarget);
        result.hooks = true;
      } catch {}
    }
  }

  // Symlink memory files
  const centralMemory = getMemoryDir();
  if (fs.existsSync(centralMemory)) {
    const memoryFiles = fs.readdirSync(centralMemory).filter((f) => f.endsWith('.md'));
    for (const file of memoryFiles) {
      const sourcePath = path.join(centralMemory, file);
      // AGENTS.md gets renamed to the agent's instructionsFile name
      const targetName = file === 'AGENTS.md' ? agentConfig.instructionsFile : file;
      const targetPath = path.join(agentDir, targetName);

      removePath(targetPath);
      try {
        fs.symlinkSync(sourcePath, targetPath);
        result.memory.push(targetName);
      } catch {}
    }
  }

  // Apply permissions (if agent supports them)
  if (PERMISSIONS_CAPABLE_AGENTS.includes(agent)) {
    const defaultPerms = getDefaultPermissionSet();
    if (defaultPerms.allow.length > 0 || (defaultPerms.deny && defaultPerms.deny.length > 0)) {
      const permResult = applyPermsToVersion(agent, defaultPerms, versionHome, true);
      result.permissions = permResult.success;
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
