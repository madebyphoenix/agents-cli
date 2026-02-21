import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';

import {
  AGENTS,
  ALL_AGENT_IDS,
  getAllCliStates,
  getAccountEmail,
  resolveAgentName,
  formatAgentError,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { readManifest } from '../lib/manifest.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  getVersionHomePath,
  getVersionDir,
  resolveVersion,
} from '../lib/versions.js';
import {
  getShimsDir,
  isShimsInPath,
} from '../lib/shims.js';
import { getAgentResources } from '../lib/resources.js';
import { getAgentsDir } from '../lib/state.js';
import { isGitRepo, getGitSyncStatus } from '../lib/git.js';
import { getCentralMemoryFileName } from '../lib/memory.js';
import { formatPath } from './utils.js';

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

function getProjectVersionFromCwd(agent: AgentId): string | null {
  const manifestPath = path.join(process.cwd(), '.agents', 'agents.yaml');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = readManifest(process.cwd());
    return manifest?.agents?.[agent] || null;
  } catch {
    return null;
  }
}

type SyncState = 'synced' | 'new' | 'modified' | 'deleted';

interface ResourceWithSync {
  name: string;
  path?: string;
  ruleCount?: number;
  syncState?: SyncState;
}

/**
 * Show installed versions for one or all agents.
 * Called when: `agents view` or `agents view claude`
 */
async function showInstalledVersions(filterAgentId?: AgentId): Promise<void> {
  const spinnerText = filterAgentId
    ? `Checking ${AGENTS[filterAgentId].name} agents...`
    : 'Checking installed agents...';
  const spinner = ora({ text: spinnerText, isSilent: !process.stdout.isTTY }).start();
  const cliStates = await getAllCliStates();
  spinner.stop();

  const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;
  const showPaths = !!filterAgentId;

  console.log(chalk.bold('Installed Agent CLIs\n'));

  // Pre-fetch emails for all versions in parallel
  const emailFetches: Promise<{ agentId: AgentId; version: string; email: string | null }>[] = [];
  const globalEmailFetches: Promise<{ agentId: AgentId; email: string | null }>[] = [];
  for (const agentId of agentsToShow) {
    const versions = listInstalledVersions(agentId);
    if (versions.length > 0) {
      for (const ver of versions) {
        emailFetches.push(
          getAccountEmail(agentId, getVersionHomePath(agentId, ver)).then((email) => ({
            agentId,
            version: ver,
            email,
          }))
        );
      }
    } else {
      globalEmailFetches.push(
        getAccountEmail(agentId).then((email) => ({ agentId, email }))
      );
    }
  }
  const emailResults = await Promise.all(emailFetches);
  const globalEmailResults = await Promise.all(globalEmailFetches);

  // Build lookup: agentId:version -> email
  const listEmailMap = new Map<string, string | null>();
  for (const { agentId, version, email } of emailResults) {
    listEmailMap.set(`${agentId}:${version}`, email);
  }
  const globalListEmailMap = new Map<string, string | null>();
  for (const { agentId, email } of globalEmailResults) {
    globalListEmailMap.set(agentId, email);
  }

  // Separate version-managed from globally-installed agents
  const versionManaged: AgentId[] = [];
  const globallyInstalled: AgentId[] = [];

  for (const agentId of agentsToShow) {
    const versions = listInstalledVersions(agentId);
    const cliState = cliStates[agentId];

    if (versions.length > 0) {
      versionManaged.push(agentId);
    } else if (cliState?.installed) {
      globallyInstalled.push(agentId);
    }
  }

  // Show version-managed agents
  if (versionManaged.length > 0) {
    // Calculate global max version label width across all agents
    let globalMaxVerLabel = 0;
    for (const agentId of versionManaged) {
      const versions = listInstalledVersions(agentId);
      const globalDefault = getGlobalDefault(agentId);
      for (const v of versions) {
        const label = v === globalDefault ? `${v} (default)` : v;
        globalMaxVerLabel = Math.max(globalMaxVerLabel, label.length);
      }
    }

    for (const agentId of versionManaged) {
      const agent = AGENTS[agentId];
      const versions = listInstalledVersions(agentId);
      const globalDefault = getGlobalDefault(agentId);

      const noDefaultLabel = !globalDefault ? chalk.yellow(' (no default)') : '';
      console.log(`  ${chalk.bold(agent.name)}${noDefaultLabel}`);

      // Sort versions with default first, then by semver descending
      const sortedVersions = [...versions].sort((a, b) => {
        if (a === globalDefault) return -1;
        if (b === globalDefault) return 1;
        return compareVersions(b, a);
      });

      for (const version of sortedVersions) {
        const isDefault = version === globalDefault;
        const base = isDefault ? `${version} (default)` : version;
        const padded = base.padEnd(globalMaxVerLabel);
        const label = isDefault ? `${version}${chalk.green(' (default)')}${' '.repeat(globalMaxVerLabel - base.length)}` : padded;
        const vEmail = listEmailMap.get(`${agentId}:${version}`);
        const vEmailStr = vEmail ? `  ${chalk.cyan(vEmail)}` : '';
        console.log(`    ${label}${vEmailStr}`);
        if (showPaths) {
          const versionDir = getVersionDir(agentId, version);
          console.log(chalk.gray(`      ${versionDir}`));
        }
      }

      // Check for project override
      const projectVersion = getProjectVersionFromCwd(agentId);
      if (projectVersion && projectVersion !== globalDefault) {
        console.log(chalk.cyan(`    -> ${projectVersion} (project)`));
      }

      console.log();
    }
  }

  // Show globally installed (not managed) agents
  if (globallyInstalled.length > 0) {
    console.log(chalk.bold('Not Managed by Agents CLI\n'));

    // Calculate max version label width for alignment
    const globalMaxVerLabel = Math.max(
      ...globallyInstalled.map((agentId) => {
        const cliState = cliStates[agentId];
        return `${cliState?.version || 'installed'} (global)`.length;
      })
    );

    for (const agentId of globallyInstalled) {
      const agent = AGENTS[agentId];
      const cliState = cliStates[agentId];

      console.log(`  ${chalk.bold(agent.name)}`);
      const gEmail = globalListEmailMap.get(agentId);
      const verLabel = `${cliState?.version || 'installed'} ${chalk.gray('(global)')}`;
      const verLabelLen = `${cliState?.version || 'installed'} (global)`.length;
      const padding = ' '.repeat(Math.max(0, globalMaxVerLabel - verLabelLen));
      const gEmailStr = gEmail ? `  ${chalk.cyan(gEmail)}` : '';
      console.log(`    ${verLabel}${padding}${gEmailStr}`);
      if (showPaths && cliState?.path) {
        console.log(chalk.gray(`      ${cliState.path}`));
      }
      console.log();
    }
  }

  // If filtering to a specific agent and not found
  if (filterAgentId && versionManaged.length === 0 && globallyInstalled.length === 0) {
    console.log(`  ${chalk.bold(AGENTS[filterAgentId].name)}: ${chalk.gray('not installed')}`);
    console.log();
  }

  // No agents installed at all
  if (versionManaged.length === 0 && globallyInstalled.length === 0 && !filterAgentId) {
    console.log(chalk.gray('  No agent CLIs installed.'));
    console.log(chalk.gray('  Run: agents add claude@latest'));
    console.log();
  }

  // Show shims path status at the end (only for full list with managed versions)
  if (versionManaged.length > 0 && !filterAgentId) {
    const shimsDir = getShimsDir();
    if (isShimsInPath()) {
      console.log(chalk.gray(`Shims: ${shimsDir} (in PATH)`));
    } else {
      console.log(chalk.yellow(`Shims: ${shimsDir} (not in PATH)`));
      console.log(chalk.gray('Add to PATH for automatic version switching'));
    }
  }
}

/**
 * Show detailed resources for a specific agent version.
 * Called when: `agents view claude@2.0.65` or `agents view claude@default`
 */
async function showAgentResources(agentId: AgentId, requestedVersion: string): Promise<void> {
  const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();

  const cwd = process.cwd();
  const agentsDir = getAgentsDir();
  const cliStates = await getAllCliStates();

  // Resolve 'default' to actual version
  let version: string | null = null;
  if (requestedVersion === 'default') {
    version = getGlobalDefault(agentId);
    if (!version) {
      spinner.stop();
      console.log(chalk.yellow(`No default version set for ${AGENTS[agentId].name}`));
      console.log(chalk.gray(`Run: agents use ${agentId}@<version>`));
      return;
    }
  } else {
    const versions = listInstalledVersions(agentId);
    if (versions.includes(requestedVersion)) {
      version = requestedVersion;
    } else {
      spinner.stop();
      console.log(chalk.red(`Version ${requestedVersion} not installed for ${AGENTS[agentId].name}`));
      console.log(chalk.gray(`Installed versions: ${versions.join(', ') || 'none'}`));
      return;
    }
  }

  // Get git sync status if ~/.agents/ is a git repo
  const hasGitRepo = isGitRepo(agentsDir);
  const commandsSync = hasGitRepo ? await getGitSyncStatus(agentsDir, 'commands') : null;
  const skillsSync = hasGitRepo ? await getGitSyncStatus(agentsDir, 'skills') : null;
  const hooksSync = hasGitRepo ? await getGitSyncStatus(agentsDir, 'hooks') : null;
  const memorySync = hasGitRepo ? await getGitSyncStatus(agentsDir, 'memory') : null;

  // Helper to determine sync state for a resource
  const getSyncState = (
    resourceName: string,
    resourceType: 'commands' | 'skills' | 'hooks' | 'memory',
    syncStatus: Awaited<ReturnType<typeof getGitSyncStatus>>
  ): SyncState | undefined => {
    if (!syncStatus) return undefined;

    let relativePath: string;
    if (resourceType === 'commands') {
      relativePath = `commands/${resourceName}.md`;
    } else if (resourceType === 'skills') {
      relativePath = `skills/${resourceName}`;
    } else if (resourceType === 'hooks') {
      relativePath = `hooks/${resourceName}`;
    } else {
      // Memory files: map agent-specific name (CLAUDE.md) back to canonical (AGENTS.md)
      const centralName = getCentralMemoryFileName(agentId);
      relativePath = `memory/${centralName}`;
    }

    const matchesPath = (f: string) => f === relativePath || f.startsWith(relativePath + '/');

    const isNew = syncStatus.new.some(matchesPath);
    const isStaged = syncStatus.staged.some(matchesPath);
    const isModified = syncStatus.modified.some(matchesPath);
    const isDeleted = syncStatus.deleted.some(matchesPath);
    const isSynced = syncStatus.synced.some(matchesPath);

    if (isNew || isStaged) {
      return 'new';
    }
    if (isModified) {
      return 'modified';
    }
    if (isDeleted) {
      return 'deleted';
    }
    if (isSynced) {
      return 'synced';
    }
    // Not in any array = local-only (untracked with no files)
    return 'new';
  };

  // Collect resources for the specific version
  interface SkillError {
    name: string;
    path: string;
    error: string;
  }

  interface AgentResourceDisplay {
    agentId: AgentId;
    agentName: string;
    version: string | null;
    commands: ResourceWithSync[];
    skills: ResourceWithSync[];
    skillErrors: SkillError[];
    mcp: ResourceWithSync[];
    memory: ResourceWithSync[];
    hooks: ResourceWithSync[];
  }

  const resources = getAgentResources(agentId, {
    cwd,
    scope: 'user',
    cliInstalled: cliStates[agentId]?.installed ?? false,
  });

  const agentData: AgentResourceDisplay = {
    agentId,
    agentName: AGENTS[agentId].name,
    version,
    commands: resources.commands.map(r => ({
      ...r,
      syncState: getSyncState(r.name, 'commands', commandsSync),
    })),
    skills: resources.skills.map(r => ({
      ...r,
      syncState: getSyncState(r.name, 'skills', skillsSync),
    })),
    skillErrors: resources.skillErrors,
    mcp: resources.mcp.map(r => ({ name: r.name, syncState: 'synced' as SyncState })),
    memory: resources.memory.map(r => ({
      ...r,
      syncState: getSyncState(r.name, 'memory', memorySync),
    })),
    hooks: resources.hooks.map(r => ({
      ...r,
      syncState: getSyncState(r.name, 'hooks', hooksSync),
    })),
  };

  spinner.stop();

  // Render helper for resources
  function renderSection(
    title: string,
    items: ResourceWithSync[]
  ): void {
    console.log(chalk.bold(`\n${title}\n`));

    if (items.length === 0) {
      console.log(`  ${chalk.gray('none')}`);
      return;
    }

    const versionStr = agentData.version ? ` (${agentData.version})` : '';
    console.log(`  ${chalk.bold(agentData.agentName)}${chalk.gray(versionStr)}:`);

    for (const r of items) {
      let nameColor = chalk.cyan;
      if (r.syncState === 'synced') nameColor = chalk.green;
      else if (r.syncState === 'new') nameColor = chalk.blue;
      else if (r.syncState === 'modified') nameColor = chalk.yellow;
      else if (r.syncState === 'deleted') nameColor = chalk.red;

      let display = nameColor(r.name);
      if (r.ruleCount !== undefined) display += chalk.gray(` (${r.ruleCount} rules)`);
      const pathStr = r.path ? chalk.gray(formatPath(r.path, cwd)) : '';
      console.log(`    ${display.padEnd(24)} ${pathStr}`);
    }
  }

  // 1. Agent CLI info
  console.log(chalk.bold('Agent CLIs\n'));
  const email = await getAccountEmail(agentId, getVersionHomePath(agentId, version));
  const emailStr = email ? chalk.cyan(`  ${email}`) : '';
  const cli = cliStates[agentId];
  const status = cli?.installed
    ? chalk.green(cli.version || 'installed')
    : chalk.gray('not installed');
  console.log(`  ${AGENTS[agentId].name.padEnd(14)} ${status}${emailStr}`);

  // 2. Resources
  renderSection('Commands', agentData.commands);
  renderSection('Skills', agentData.skills);

  // Show skill parse errors if any
  if (agentData.skillErrors.length > 0) {
    console.log(`\n  ${chalk.red('Skill Errors')}:`);
    for (const err of agentData.skillErrors) {
      console.log(`    ${chalk.red(err.name.padEnd(20))} ${chalk.gray(err.error)}`);
      console.log(`      ${chalk.gray(formatPath(err.path, cwd))}`);
    }
  }

  renderSection('MCP Servers', agentData.mcp);
  renderSection('Memory', agentData.memory);
  renderSection('Hooks', agentData.hooks);

  // Show legend at the end if git repo exists
  if (hasGitRepo) {
    console.log();
    console.log(chalk.gray('Legend:'), chalk.green('Tracked'), chalk.blue('Local-only'), chalk.yellow('Modified'), chalk.red('Deleted'));
  }

  console.log('');
}

/**
 * Main view action handler.
 * Exported for use by deprecated aliases.
 */
export async function viewAction(agentArg?: string): Promise<void> {
  if (!agentArg) {
    // No argument: show all installed versions
    await showInstalledVersions();
    return;
  }

  // Parse agent@version syntax
  const parts = agentArg.split('@');
  const agentName = parts[0];
  const requestedVersion = parts[1] || null;

  const agentId = resolveAgentName(agentName);
  if (!agentId) {
    console.log(chalk.red(formatAgentError(agentName)));
    process.exit(1);
  }

  if (requestedVersion) {
    // Specific version requested: show detailed resources
    await showAgentResources(agentId, requestedVersion);
  } else {
    // Just agent name: show versions for that agent
    await showInstalledVersions(agentId);
  }
}

export function registerViewCommand(program: Command): void {
  program
    .command('view [agent]')
    .description('View installed agent versions or resources. Use agent@version for detailed view.')
    .action(viewAction);
}
