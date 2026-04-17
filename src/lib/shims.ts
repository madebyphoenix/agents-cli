import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { confirm, select } from '@inquirer/prompts';
import type { AgentId } from './types.js';
import { getShimsDir, getVersionsDir, getBackupsDir, ensureAgentsDir } from './state.js';
export { getShimsDir };
import { AGENTS } from './agents.js';

/**
 * Files and directories to always skip during conflict detection and migration.
 * These are never user config that should be migrated.
 */
const MIGRATION_IGNORE_LIST = new Set([
  'node_modules',
  '.git',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.DS_Store',
  'Thumbs.db',
]);

/**
 * Check if a file/directory should be ignored during migration.
 */
function shouldIgnore(name: string): boolean {
  if (MIGRATION_IGNORE_LIST.has(name)) return true;
  if (name.endsWith('.backup')) return true;
  return false;
}

/**
 * Strategy for handling file conflicts during config migration.
 */
export type ConflictStrategy = 'keep-dest' | 'overwrite' | 'ask-per-file';

/**
 * Information about conflicts found during config migration.
 */
export interface ConflictInfo {
  agent: AgentId;
  version: string;
  conflicts: string[]; // filenames that exist in both src and dest
}

/**
 * Detect conflicting files between source and destination directories.
 * Returns list of filenames that exist in both locations (excluding symlinks in dest).
 */
export function detectConflicts(src: string, dest: string, prefix = ''): string[] {
  const conflicts: string[] = [];

  if (!fs.existsSync(src) || !fs.existsSync(dest)) {
    return conflicts;
  }

  // Skip if dest is a symlink (managed resources)
  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      return conflicts;
    }
  } catch {
    /* dest not accessible, no conflicts to report */
    return conflicts;
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    // Skip files/directories that should never be migrated
    if (shouldIgnore(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    // Skip if dest entry is a symlink (managed resource)
    try {
      const entryDestStat = fs.lstatSync(destPath);
      if (entryDestStat.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        conflicts.push(...detectConflicts(srcPath, destPath, relativePath));
      } else {
        // File exists in both - it's a conflict
        conflicts.push(relativePath);
      }
    } catch {
      // dest entry doesn't exist, not a conflict
    }
  }

  return conflicts;
}

/**
 * Prompt user for conflict resolution strategy.
 */
export async function promptConflictStrategy(
  conflictInfos: ConflictInfo[]
): Promise<ConflictStrategy | null> {
  const totalConflicts = conflictInfos.reduce((sum, info) => sum + info.conflicts.length, 0);

  if (totalConflicts === 0) {
    return null; // No conflicts, no prompt needed
  }

  // Show what has conflicts with clear paths
  console.log('\nFile conflicts detected:');
  for (const info of conflictInfos) {
    const agentConfig = AGENTS[info.agent];
    const configDir = agentConfig.configDir; // e.g., ".opencode"
    console.log(`  ${info.conflicts.length} file(s) conflict between:`);
    console.log(`    ~/${configDir}/ (your config)`);
    console.log(`    ${agentConfig.name}@${info.version} (managed version)`);
  }
  console.log();

  // Build choice labels with agent info for clarity
  const firstInfo = conflictInfos[0];
  const firstAgent = AGENTS[firstInfo.agent];
  const versionLabel = conflictInfos.length === 1
    ? `${firstAgent.name}@${firstInfo.version}`
    : 'version';

  const strategy = await select<ConflictStrategy>({
    message: 'Which files should be kept?',
    choices: [
      {
        value: 'keep-dest' as ConflictStrategy,
        name: `Keep ${versionLabel} files (recommended)`,
      },
      {
        value: 'overwrite' as ConflictStrategy,
        name: conflictInfos.length === 1
          ? `Keep ~/${firstAgent.configDir}/ files`
          : 'Keep my config files',
      },
      {
        value: 'ask-per-file' as ConflictStrategy,
        name: `Decide per file (${totalConflicts} file${totalConflicts === 1 ? '' : 's'})`,
      },
    ],
    default: 'keep-dest',
  });

  return strategy;
}

/**
 * Generate the shim script content for an agent.
 *
 * The shim resolves the version in order:
 * 1. .agents-version in cwd (walk up to root)
 * 2. ~/.agents/agents.yaml default
 *
 * If version is specified but not installed, auto-installs it.
 *
 * Config isolation is handled via symlinks:
 * ~/.{agent} -> ~/.agents/versions/{agent}/{version}/home/.{agent}/
 */
export function generateShimScript(agent: AgentId): string {
  const agentConfig = AGENTS[agent];
  const cliCommand = agentConfig.cliCommand;

  return `#!/bin/bash
# Auto-generated by agents-cli - do not edit
# Shim for ${agentConfig.name}

AGENTS_DIR="$HOME/.agents"
AGENT="${agent}"
CLI_COMMAND="${cliCommand}"

# Find .agents-version walking up from cwd
find_project_version() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/.agents-version" ]; then
      # Parse YAML - handle both "agent: version" and "agent:\\n  - version"
      local version
      version=$(awk -v agent="$AGENT" '
        $0 ~ "^" agent ":" {
          # Check if value is on same line
          if (match($0, /:[[:space:]]+[0-9]/)) {
            gsub(/.*:[[:space:]]*["'"'"']?|["'"'"']?[[:space:]]*$/, "")
            print
            exit
          }
          # Value might be on next line (array format)
          getline
          if (/^[[:space:]]+-[[:space:]]/) {
            gsub(/^[[:space:]]+-[[:space:]]*["'"'"']?|["'"'"']?[[:space:]]*$/, "")
            print
            exit
          }
        }
      ' "$dir/.agents-version")
      if [ -n "$version" ]; then
        echo "$version"
        return 0
      fi
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

# Resolve version from agents.yaml (user default)
resolve_default_version() {
  local meta="$AGENTS_DIR/agents.yaml"
  if [ -f "$meta" ]; then
    awk -v agent="$AGENT" '
      /^agents:/ { in_agents=1; next }
      in_agents && /^[^ ]/ { in_agents=0 }
      in_agents && $0 ~ "^  " agent ":" { gsub(/.*:[[:space:]]*["'"'"']?|["'"'"']?[[:space:]]*$/, ""); print; exit }
    ' "$meta"
  fi
}

# Find project-scoped .agents directory (stop at .git or .agents-version)
find_project_agents_dir() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.agents" ]; then
      echo "$dir/.agents"
      return 0
    fi
    if [ -f "$dir/.agents-version" ] || [ -d "$dir/.git" ] || [ -f "$dir/.git" ]; then
      break
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

# Try project version first, then global default
VERSION=$(find_project_version)
VERSION_SOURCE="project"
if [ -z "$VERSION" ]; then
  VERSION=$(resolve_default_version)
  VERSION_SOURCE="default"
fi

if [ -z "$VERSION" ]; then
  echo "agents: no version of $AGENT configured" >&2
  echo "Run: agents add $AGENT@<version>" >&2
  exit 1
fi

VERSION_DIR="$AGENTS_DIR/versions/$AGENT/$VERSION"
BINARY="$VERSION_DIR/node_modules/.bin/$CLI_COMMAND"

# Auto-install if not present
if [ ! -x "$BINARY" ]; then
  if [ "$VERSION_SOURCE" = "project" ]; then
    echo "agents: $AGENT@$VERSION required by .agents-version but not installed" >&2

    # Spinner animation
    spin() {
      local pid=$1
      local chars="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
      local i=0
      while kill -0 "$pid" 2>/dev/null; do
        printf "\\r  %s Installing $AGENT@$VERSION..." "\${chars:i++%\${#chars}:1}" >&2
        sleep 0.1
      done
      printf "\\r" >&2
    }

    # Run install in background with spinner
    agents add "$AGENT@$VERSION" --yes >/dev/null 2>&1 &
    install_pid=$!
    spin $install_pid
    wait $install_pid
    install_status=$?

    if [ $install_status -eq 0 ]; then
      echo "  ✔ Installed $AGENT@$VERSION" >&2
    else
      echo "  ✗ Failed to install $AGENT@$VERSION" >&2
      exit 1
    fi
  else
    echo "agents: $AGENT@$VERSION not installed" >&2
    echo "Run: agents add $AGENT@$VERSION" >&2
    exit 1
  fi
fi

# Sync project-scoped resources into version home if a project .agents/ is present
PROJECT_AGENTS_DIR=$(find_project_agents_dir)
if [ -n "$PROJECT_AGENTS_DIR" ]; then
  agents sync --agent "$AGENT" --version "$VERSION" --project-dir "$PROJECT_AGENTS_DIR" --quiet >/dev/null 2>&1
fi

exec "$BINARY" "$@"
`;
}

/**
 * Create a shim for an agent.
 */
export function createShim(agent: AgentId): string {
  ensureAgentsDir();
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);

  const script = generateShimScript(agent);
  fs.writeFileSync(shimPath, script, { mode: 0o755 });

  return shimPath;
}

/**
 * Remove the shim for an agent.
 */
export function removeShim(agent: AgentId): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);

  if (fs.existsSync(shimPath)) {
    fs.unlinkSync(shimPath);
    return true;
  }

  return false;
}

/**
 * Generate a versioned alias script that directly execs a specific version.
 * e.g., claude@2.0.65 -> directly runs that version's binary
 */
function generateVersionedAliasScript(agent: AgentId, version: string): string {
  const agentConfig = AGENTS[agent];

  return `#!/bin/bash
# Auto-generated by agents-cli - do not edit
# Direct alias for ${agentConfig.name}@${version}

BINARY="$HOME/.agents/versions/${agent}/${version}/node_modules/.bin/${agentConfig.cliCommand}"

if [ ! -x "$BINARY" ]; then
  echo "agents: ${agent}@${version} not installed" >&2
  exit 1
fi

exec "$BINARY" "$@"
`;
}

/**
 * Create a versioned alias for a specific agent version.
 * e.g., claude@2.0.65
 */
export function createVersionedAlias(agent: AgentId, version: string): string {
  ensureAgentsDir();
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const aliasPath = path.join(shimsDir, `${agentConfig.cliCommand}@${version}`);

  const script = generateVersionedAliasScript(agent, version);
  fs.writeFileSync(aliasPath, script, { mode: 0o755 });

  return aliasPath;
}

/**
 * Remove a versioned alias for a specific agent version.
 */
export function removeVersionedAlias(agent: AgentId, version: string): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const aliasPath = path.join(shimsDir, `${agentConfig.cliCommand}@${version}`);

  if (fs.existsSync(aliasPath)) {
    fs.unlinkSync(aliasPath);
    return true;
  }

  return false;
}

/**
 * Check if a versioned alias exists.
 */
export function versionedAliasExists(agent: AgentId, version: string): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const aliasPath = path.join(shimsDir, `${agentConfig.cliCommand}@${version}`);
  return fs.existsSync(aliasPath);
}

/**
 * Get the path to the agent's config directory in HOME.
 * e.g., ~/.claude for claude, ~/.codex for codex
 */
function getAgentConfigPath(agent: AgentId): string {
  const agentConfig = AGENTS[agent];
  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  return agentConfig.configDir.replace(os.homedir(), home);
}

/**
 * Get the path to the version's config directory.
 * e.g., ~/.agents/versions/claude/2.0.65/home/.claude/
 */
function getVersionConfigPath(agent: AgentId, version: string): string {
  const agentConfig = AGENTS[agent];
  const versionsDir = getVersionsDir();
  const configDirName = `.${agent}`; // .claude, .codex, etc.
  return path.join(versionsDir, agent, version, 'home', configDirName);
}

/**
 * Detect conflicts that would occur when switching config symlink for an agent/version.
 * This allows collecting conflicts upfront before prompting for a strategy.
 *
 * Returns null if no migration is needed (already symlink or doesn't exist),
 * or ConflictInfo with the list of conflicting files.
 */
export function detectMigrationConflicts(agent: AgentId, version: string): ConflictInfo | null {
  const configPath = getAgentConfigPath(agent);
  const versionConfigPath = getVersionConfigPath(agent, version);

  try {
    const stat = fs.lstatSync(configPath);

    if (stat.isSymbolicLink()) {
      // Already a symlink - no migration needed, no conflicts
      return null;
    } else if (stat.isDirectory()) {
      // Real directory exists - would need migration
      // Detect conflicts between user's current config and version home
      const conflicts = detectConflicts(configPath, versionConfigPath);
      return {
        agent,
        version,
        conflicts,
      };
    }
    // Not a directory or symlink - unusual, no conflicts to report
    return null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config path doesn't exist - no migration needed
      return null;
    }
    return null;
  }
}

/**
 * Switch the agent's config symlink to point to a specific version.
 * e.g., ~/.claude -> ~/.agents/versions/claude/2.0.65/home/.claude/
 *
 * If a real directory exists at the config path, it will be backed up
 * to ~/.agents/backups/{agent}/{timestamp}/ and replaced with a symlink.
 *
 * @param agent - The agent ID
 * @param version - The version to switch to
 *
 * Returns: { success: boolean, backupPath?: string, error?: string }
 */
export async function switchConfigSymlink(
  agent: AgentId,
  version: string
): Promise<{ success: boolean; backupPath?: string; error?: string }> {
  const configPath = getAgentConfigPath(agent);
  const versionConfigPath = getVersionConfigPath(agent, version);

  // Ensure version config directory exists
  if (!fs.existsSync(versionConfigPath)) {
    fs.mkdirSync(versionConfigPath, { recursive: true });
  }

  try {
    const stat = fs.lstatSync(configPath);

    if (stat.isSymbolicLink()) {
      // Already a symlink - check if it points to the correct target
      const currentTarget = fs.readlinkSync(configPath);
      const resolvedCurrent = path.resolve(path.dirname(configPath), currentTarget);
      const resolvedTarget = path.resolve(versionConfigPath);
      if (resolvedCurrent === resolvedTarget) {
        // Already pointing to correct target, no-op
        return { success: true };
      }
      // Different target - update it
      fs.unlinkSync(configPath);
      fs.symlinkSync(versionConfigPath, configPath);
      return { success: true };
    } else if (stat.isDirectory()) {
      // Real directory exists - backup and replace with symlink
      const timestamp = Date.now();

      // Move to backup location
      const backupsDir = getBackupsDir();
      const agentBackupDir = path.join(backupsDir, agent);
      const finalBackupPath = path.join(agentBackupDir, String(timestamp));
      fs.mkdirSync(agentBackupDir, { recursive: true });
      fs.renameSync(configPath, finalBackupPath);

      // Create symlink
      fs.symlinkSync(versionConfigPath, configPath);

      return { success: true, backupPath: finalBackupPath };
    } else {
      return { success: false, error: `${configPath} exists but is not a directory or symlink` };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Config path doesn't exist - create symlink
      fs.symlinkSync(versionConfigPath, configPath);
      return { success: true };
    }
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Switch home-level files (outside the config dir) to per-version symlinks.
 * e.g., ~/.claude.json -> ~/.agents/versions/claude/2.0.65/home/.claude.json
 *
 * Uses atomic rename to avoid data loss if another session is running.
 * On first migration (real file -> symlink), merges global auth into
 * ALL installed versions so they inherit the current account.
 */
export function switchHomeFileSymlinks(
  agent: AgentId,
  version: string
): { switched: string[]; errors: string[] } {
  const agentConfig = AGENTS[agent];
  const homeFiles = agentConfig.homeFiles;
  if (!homeFiles || homeFiles.length === 0) return { switched: [], errors: [] };

  const home = process.env.AGENTS_REAL_HOME || os.homedir();
  const versionsDir = getVersionsDir();
  const switched: string[] = [];
  const errors: string[] = [];

  for (const fileName of homeFiles) {
    const globalPath = path.join(home, fileName);
    const versionFilePath = path.join(versionsDir, agent, version, 'home', fileName);

    try {
      // Ensure version home dir exists
      const versionFileDir = path.dirname(versionFilePath);
      if (!fs.existsSync(versionFileDir)) {
        fs.mkdirSync(versionFileDir, { recursive: true });
      }

      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(globalPath);
      } catch {
        // File doesn't exist at global path — just create symlink
        if (!fs.existsSync(versionFilePath)) {
          fs.writeFileSync(versionFilePath, '{}');
        }
        fs.symlinkSync(versionFilePath, globalPath);
        switched.push(fileName);
        continue;
      }

      if (stat.isSymbolicLink()) {
        // Already a symlink — retarget atomically
        const currentTarget = fs.readlinkSync(globalPath);
        const resolvedCurrent = path.resolve(path.dirname(globalPath), currentTarget);
        const resolvedTarget = path.resolve(versionFilePath);
        if (resolvedCurrent === resolvedTarget) {
          switched.push(fileName);
          continue; // Already correct
        }
        // Atomic retarget: create temp symlink, rename over existing
        if (!fs.existsSync(versionFilePath)) {
          fs.writeFileSync(versionFilePath, '{}');
        }
        const tmpPath = `${globalPath}.agents-tmp-${process.pid}`;
        fs.symlinkSync(versionFilePath, tmpPath);
        fs.renameSync(tmpPath, globalPath);
        switched.push(fileName);
      } else if (stat.isFile()) {
        // Real file — first-time migration
        // Read the global file content
        const globalContent = JSON.parse(fs.readFileSync(globalPath, 'utf-8'));

        // Merge auth into ALL installed version files for this agent
        const agentVersionsDir = path.join(versionsDir, agent);
        if (fs.existsSync(agentVersionsDir)) {
          for (const ver of fs.readdirSync(agentVersionsDir)) {
            const verFilePath = path.join(agentVersionsDir, ver, 'home', fileName);
            const verFileDir = path.dirname(verFilePath);
            if (!fs.existsSync(verFileDir)) {
              fs.mkdirSync(verFileDir, { recursive: true });
            }
            if (fs.existsSync(verFilePath)) {
              // Merge: version-specific fields + global auth fields
              try {
                const verContent = JSON.parse(fs.readFileSync(verFilePath, 'utf-8'));
                const merged = { ...globalContent, ...verContent };
                // Ensure auth from global always wins
                if (globalContent.oauthAccount) {
                  merged.oauthAccount = globalContent.oauthAccount;
                }
                fs.writeFileSync(verFilePath, JSON.stringify(merged, null, 2));
              } catch {
                // If version file is invalid JSON, overwrite with global
                fs.writeFileSync(verFilePath, JSON.stringify(globalContent, null, 2));
              }
            } else {
              // No version file — copy global wholesale
              fs.writeFileSync(verFilePath, JSON.stringify(globalContent, null, 2));
            }
          }
        }

        // Atomic swap: create temp symlink to target version, rename over real file
        const tmpPath = `${globalPath}.agents-tmp-${process.pid}`;
        fs.symlinkSync(versionFilePath, tmpPath);
        fs.renameSync(tmpPath, globalPath);
        switched.push(fileName);
      }
    } catch (err) {
      errors.push(`${fileName}: ${(err as Error).message}`);
    }
  }

  return { switched, errors };
}

/**
 * Get the current config symlink target version, if any.
 */
export function getConfigSymlinkVersion(agent: AgentId): string | null {
  const configPath = getAgentConfigPath(agent);

  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isSymbolicLink()) {
      return null;
    }

    const target = fs.readlinkSync(configPath);
    // Extract version from path like ~/.agents/versions/claude/2.0.65/home/.claude
    const match = target.match(/versions\/[^/]+\/([^/]+)\/home/);
    return match ? match[1] : null;
  } catch {
    /* config path not accessible or not a symlink */
    return null;
  }
}

/**
 * Context for conflict resolution prompts.
 */
interface CopyContext {
  agent: AgentId;
  version: string;
}

/**
 * Copy directory contents with configurable conflict strategy.
 * Skips when dest is a symlink (managed resources that shouldn't be overwritten).
 *
 * @param src - Source directory
 * @param dest - Destination directory
 * @param strategy - How to handle conflicts: 'keep-dest', 'overwrite', or 'ask-per-file'
 * @param context - Agent/version context for prompts (only used when strategy is 'ask-per-file')
 */
async function copyDirContents(
  src: string,
  dest: string,
  strategy: ConflictStrategy = 'keep-dest',
  context?: CopyContext
): Promise<void> {
  // If dest is a symlink, skip - these are managed resources (skills, commands, etc.)
  // that link to central ~/.agents/ and shouldn't be overwritten with local copies
  try {
    const destStat = fs.lstatSync(dest);
    if (destStat.isSymbolicLink()) {
      return; // Skip - don't copy into symlinked directories
    }
  } catch {
    // dest doesn't exist, that's fine
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    // Skip files/directories that should never be migrated
    if (shouldIgnore(entry.name)) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip if dest entry is a symlink (managed resource)
    try {
      const entryDestStat = fs.lstatSync(destPath);
      if (entryDestStat.isSymbolicLink()) {
        continue; // Skip - managed resource
      }
    } catch {
      // dest entry doesn't exist, that's fine
    }

    if (entry.isDirectory()) {
      await copyDirContents(srcPath, destPath, strategy, context);
    } else if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(srcPath);
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      fs.symlinkSync(linkTarget, destPath);
    } else {
      // File - check for conflict
      if (fs.existsSync(destPath)) {
        // Handle based on strategy
        if (strategy === 'keep-dest') {
          // Keep existing file, skip copying
          continue;
        } else if (strategy === 'overwrite') {
          // Back up and overwrite
          fs.copyFileSync(destPath, `${destPath}.backup`);
        } else if (strategy === 'ask-per-file') {
          // Back up dest file
          fs.copyFileSync(destPath, `${destPath}.backup`);

          // Ask user with context - use clear path-based terminology
          const agentConfig = context ? AGENTS[context.agent] : null;
          const versionLabel = agentConfig
            ? `${agentConfig.name}@${context!.version}`
            : 'version';
          const useMyFile = await confirm({
            message: `${entry.name}: Use your config file instead of ${versionLabel}?`,
            default: false, // Default to keep version (safer)
          });

          if (!useMyFile) {
            continue; // Keep dest (version file), skip copying src
          }
        }
      }
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Check if shim exists for an agent.
 */
export function shimExists(agent: AgentId): boolean {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  const shimPath = path.join(shimsDir, agentConfig.cliCommand);
  return fs.existsSync(shimPath);
}

/**
 * Get the path to the shim for an agent.
 */
export function getShimPath(agent: AgentId): string {
  const shimsDir = getShimsDir();
  const agentConfig = AGENTS[agent];
  return path.join(shimsDir, agentConfig.cliCommand);
}

/**
 * Check if shims directory is in PATH.
 */
export function isShimsInPath(): boolean {
  const shimsDir = getShimsDir();
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  return pathDirs.some((dir) => path.resolve(dir) === path.resolve(shimsDir));
}

/**
 * Get the shell rc file path for the current shell.
 */
function getShellRcFile(): { rcFile: string; rcPath: string; shell: string } {
  const shell = process.env.SHELL || '/bin/bash';
  const shellName = path.basename(shell);

  let rcFile: string;
  switch (shellName) {
    case 'zsh':
      rcFile = '.zshrc';
      break;
    case 'fish':
      rcFile = '.config/fish/config.fish';
      break;
    case 'bash':
    default:
      rcFile = '.bashrc';
      break;
  }

  return {
    rcFile,
    rcPath: path.join(os.homedir(), rcFile),
    shell: shellName,
  };
}

/**
 * Get shell configuration instructions for adding shims to PATH.
 */
export function getPathSetupInstructions(): string {
  const shimsDir = getShimsDir();
  const { rcFile, shell } = getShellRcFile();

  if (shell === 'fish') {
    return `Add to ~/.config/fish/config.fish:
  fish_add_path ${shimsDir}`;
  }

  return `Add to ~/${rcFile} (BEFORE any nvm/node setup):
  export PATH="${shimsDir}:$PATH"

IMPORTANT: Shims must come FIRST in PATH to override global installs.

Then restart your shell or run:
  source ~/${rcFile}`;
}

/**
 * Add shims directory to shell PATH configuration.
 * Returns true if added, false if already present or failed.
 */
export function addShimsToPath(): { success: boolean; alreadyPresent?: boolean; rcFile?: string; error?: string } {
  const shimsDir = getShimsDir();
  const { rcFile, rcPath, shell } = getShellRcFile();

  // Read current rc file content
  let content = '';
  try {
    if (fs.existsSync(rcPath)) {
      content = fs.readFileSync(rcPath, 'utf-8');
    }
  } catch (err) {
    return { success: false, error: `Could not read ${rcFile}: ${(err as Error).message}` };
  }

  // Check if shims path already in file
  if (content.includes(shimsDir) || content.includes('$HOME/.agents/shims')) {
    return { success: true, alreadyPresent: true, rcFile };
  }

  // Generate the export line
  let exportLine: string;
  if (shell === 'fish') {
    exportLine = `\n# agents-cli: version-managed agent CLIs\nfish_add_path ${shimsDir}\n`;
  } else {
    exportLine = `\n# agents-cli: version-managed agent CLIs\nexport PATH="${shimsDir}:$PATH"\n`;
  }

  // Find insertion point - BEFORE nvm/node setup if possible
  // Look for common patterns that should come AFTER our shims
  const insertBeforePatterns = [
    /^export NVM_DIR=/m,
    /^source.*nvm/m,
    /^\[ -s.*nvm/m,
    /^eval.*fnm/m,
    /^export PATH.*node/m,
    /^export PATH.*npm/m,
  ];

  let insertIndex = -1;
  for (const pattern of insertBeforePatterns) {
    const match = content.match(pattern);
    if (match && match.index !== undefined) {
      // Find start of this line
      let lineStart = match.index;
      while (lineStart > 0 && content[lineStart - 1] !== '\n') {
        lineStart--;
      }
      if (insertIndex === -1 || lineStart < insertIndex) {
        insertIndex = lineStart;
      }
    }
  }

  // Write the updated content
  try {
    // Ensure parent directories exist (especially for fish: ~/.config/fish/)
    const rcDir = path.dirname(rcPath);
    if (!fs.existsSync(rcDir)) {
      fs.mkdirSync(rcDir, { recursive: true });
    }

    let newContent: string;
    if (insertIndex >= 0) {
      // Insert before nvm/node setup (handles index 0 correctly)
      newContent = content.slice(0, insertIndex) + exportLine + content.slice(insertIndex);
    } else {
      // Append to end
      newContent = content + exportLine;
    }
    fs.writeFileSync(rcPath, newContent, 'utf-8');
    return { success: true, rcFile };
  } catch (err) {
    return { success: false, error: `Could not write ${rcFile}: ${(err as Error).message}` };
  }
}

/**
 * Create shims for all installed agents.
 */
export function ensureAllShims(): void {
  const versionsDir = getVersionsDir();
  if (!fs.existsSync(versionsDir)) {
    return;
  }

  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && AGENTS[entry.name as AgentId]) {
      const agent = entry.name as AgentId;
      const agentVersionsDir = path.join(versionsDir, agent);
      const versions = fs.readdirSync(agentVersionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());

      if (versions.length > 0 && !shimExists(agent)) {
        createShim(agent);
      }
    }
  }
}

/**
 * Resource diff between two versions.
 */
export interface ResourceDiff {
  commands: string[];  // names in current but not in target
  skills: string[];
  hooks: string[];
  memory: { file: string; currentLines: number; targetLines: number }[];
  mcp: string[];  // server names in current but not in target
}

/**
 * Compare resources between two versions.
 * Returns resources that exist in currentVersion but not in targetVersion.
 */
export function compareVersionResources(
  agent: AgentId,
  currentVersion: string,
  targetVersion: string
): ResourceDiff {
  const agentConfig = AGENTS[agent];
  const currentPath = getVersionConfigPath(agent, currentVersion);
  const targetPath = getVersionConfigPath(agent, targetVersion);

  const diff: ResourceDiff = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
  };

  // Helper to list directory contents (names only)
  const listDir = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir).filter(f => !f.startsWith('.'));
    } catch {
      /* directory not readable */
      return [];
    }
  };

  // Helper to count lines in a file
  const countLines = (filePath: string): number => {
    if (!fs.existsSync(filePath)) return 0;
    try {
      return fs.readFileSync(filePath, 'utf-8').split('\n').length;
    } catch {
      /* file not readable */
      return 0;
    }
  };

  // Compare commands
  const currentCommands = listDir(path.join(currentPath, agentConfig.commandsSubdir));
  const targetCommands = new Set(listDir(path.join(targetPath, agentConfig.commandsSubdir)));
  diff.commands = currentCommands.filter(c => !targetCommands.has(c)).map(c => c.replace(/\.(md|toml)$/, ''));

  // Compare skills
  const currentSkills = listDir(path.join(currentPath, 'skills'));
  const targetSkills = new Set(listDir(path.join(targetPath, 'skills')));
  diff.skills = currentSkills.filter(s => !targetSkills.has(s));

  // Compare hooks
  const currentHooks = listDir(path.join(currentPath, 'hooks'));
  const targetHooks = new Set(listDir(path.join(targetPath, 'hooks')));
  diff.hooks = currentHooks.filter(h => !targetHooks.has(h));

  // Compare memory files (instructionsFile like CLAUDE.md)
  const memoryFile = agentConfig.instructionsFile;
  const currentMemoryPath = path.join(currentPath, memoryFile);
  const targetMemoryPath = path.join(targetPath, memoryFile);
  const currentLines = countLines(currentMemoryPath);
  const targetLines = countLines(targetMemoryPath);
  if (currentLines > 0 && currentLines !== targetLines) {
    diff.memory.push({ file: memoryFile, currentLines, targetLines });
  }

  // Compare MCP servers (from settings.json)
  const readMcpServers = (configPath: string): string[] => {
    const settingsPath = path.join(configPath, 'settings.json');
    if (!fs.existsSync(settingsPath)) return [];
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return Object.keys(settings.mcpServers || {});
    } catch {
      /* settings.json corrupt or unreadable */
      return [];
    }
  };

  const currentMcp = readMcpServers(currentPath);
  const targetMcp = new Set(readMcpServers(targetPath));
  diff.mcp = currentMcp.filter(m => !targetMcp.has(m));

  return diff;
}

/**
 * Check if a ResourceDiff has any differences.
 */
export function hasResourceDiff(diff: ResourceDiff): boolean {
  return (
    diff.commands.length > 0 ||
    diff.skills.length > 0 ||
    diff.hooks.length > 0 ||
    diff.memory.length > 0 ||
    diff.mcp.length > 0
  );
}

/**
 * Copy resources from one version to another.
 * Only copies resources listed in the diff (i.e., ones missing in target).
 */
export function copyResourcesToVersion(
  agent: AgentId,
  fromVersion: string,
  toVersion: string,
  diff: ResourceDiff
): void {
  const agentConfig = AGENTS[agent];
  const fromPath = getVersionConfigPath(agent, fromVersion);
  const toPath = getVersionConfigPath(agent, toVersion);

  // Helper to copy a file or directory
  const copyItem = (srcDir: string, destDir: string, name: string): void => {
    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name);
    if (!fs.existsSync(srcPath)) return;

    fs.mkdirSync(destDir, { recursive: true });

    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  };

  // Copy missing commands
  const commandsSubdir = agentConfig.commandsSubdir;
  const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
  for (const cmd of diff.commands) {
    copyItem(
      path.join(fromPath, commandsSubdir),
      path.join(toPath, commandsSubdir),
      `${cmd}${ext}`
    );
  }

  // Copy missing skills
  for (const skill of diff.skills) {
    copyItem(path.join(fromPath, 'skills'), path.join(toPath, 'skills'), skill);
  }

  // Copy missing hooks
  for (const hook of diff.hooks) {
    copyItem(path.join(fromPath, 'hooks'), path.join(toPath, 'hooks'), hook);
  }

  // Copy memory file if different
  for (const mem of diff.memory) {
    const srcPath = path.join(fromPath, mem.file);
    const destPath = path.join(toPath, mem.file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  // Merge MCP servers into target settings.json
  if (diff.mcp.length > 0) {
    const fromSettingsPath = path.join(fromPath, 'settings.json');
    const toSettingsPath = path.join(toPath, 'settings.json');

    if (fs.existsSync(fromSettingsPath)) {
      try {
        const fromSettings = JSON.parse(fs.readFileSync(fromSettingsPath, 'utf-8'));
        let toSettings: Record<string, unknown> = {};

        if (fs.existsSync(toSettingsPath)) {
          toSettings = JSON.parse(fs.readFileSync(toSettingsPath, 'utf-8'));
        }

        if (!toSettings.mcpServers) {
          toSettings.mcpServers = {};
        }

        for (const serverName of diff.mcp) {
          if (fromSettings.mcpServers?.[serverName]) {
            (toSettings.mcpServers as Record<string, unknown>)[serverName] = fromSettings.mcpServers[serverName];
          }
        }

        fs.writeFileSync(toSettingsPath, JSON.stringify(toSettings, null, 2));
      } catch {
        /* settings.json parse error, skip MCP merge */
      }
    }
  }
}
