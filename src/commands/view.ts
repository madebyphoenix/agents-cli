import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';

import {
  AGENTS,
  ALL_AGENT_IDS,
  getAllCliStates,
  getAccountInfo,
  resolveAgentName,
  formatAgentError,
  agentLabel,
  colorAgent,
} from '../lib/agents.js';
import type { AccountInfo } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { formatUsageSection, formatUsageSummary, getUsageInfo } from '../lib/usage.js';
import type { UsageInfo } from '../lib/usage.js';
import { readManifest } from '../lib/manifest.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  getVersionHomePath,
  getVersionDir,
  resolveVersion,
  getAvailableResources,
  getActuallySyncedResources,
  getNewResources,
  hasNewResources,
  promptNewResourceSelection,
  syncResourcesToVersion,
} from '../lib/versions.js';
import {
  getShimsDir,
  isShimsInPath,
} from '../lib/shims.js';
import { getAgentResources } from '../lib/resources.js';
import { getAgentsDir } from '../lib/state.js';
import { isGitRepo, getGitSyncStatus } from '../lib/git.js';
import { getCentralMemoryFileName } from '../lib/memory.js';
import { formatPath, isPromptCancelled } from './utils.js';

function formatLastActive(date: Date | null): string {
  if (!date) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return chalk.green('just now');
  if (mins < 60) return chalk.green(`${mins}m ago`);
  if (hours < 24) return chalk.white(`${hours}h ago`);
  if (days < 7) return chalk.gray(`${days}d ago`);
  return chalk.gray(`${days}d ago`);
}

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
  scope?: 'user' | 'project';
}

function accountUsageKey(agentId: AgentId, email: string): string {
  return `${agentId}:${email}`;
}

/**
 * Show installed versions for one or all agents.
 * Called when: `agents view` or `agents view claude`
 */
async function showInstalledVersions(filterAgentId?: AgentId): Promise<void> {
  const spinnerText = filterAgentId
    ? `Checking ${agentLabel(filterAgentId)} agents...`
    : 'Checking installed agents...';
  const spinner = ora({ text: spinnerText, isSilent: !process.stdout.isTTY }).start();
  const cliStates = await getAllCliStates();
  spinner.stop();

  const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;
  const showPaths = !!filterAgentId;

  console.log(chalk.bold('Installed Agent CLIs\n'));

  // Pre-fetch account info for all versions in parallel
  const infoFetches: Promise<{ agentId: AgentId; version: string; home: string; info: AccountInfo }>[] = [];
  const globalInfoFetches: Promise<{ agentId: AgentId; cliVersion: string | null; info: AccountInfo }>[] = [];
  for (const agentId of agentsToShow) {
    const versions = listInstalledVersions(agentId);
    if (versions.length > 0) {
      for (const ver of versions) {
        const home = getVersionHomePath(agentId, ver);
        infoFetches.push(
          getAccountInfo(agentId, home).then((info) => ({
            agentId,
            version: ver,
            home,
            info,
          }))
        );
      }
    } else {
      globalInfoFetches.push(
        getAccountInfo(agentId).then((info) => ({
          agentId,
          cliVersion: cliStates[agentId]?.version || null,
          info,
        }))
      );
    }
  }
  const infoResults = await Promise.all(infoFetches);
  const globalInfoResults = await Promise.all(globalInfoFetches);

  // Build lookup: agentId:version -> AccountInfo
  const infoMap = new Map<string, AccountInfo>();
  for (const { agentId, version, info } of infoResults) {
    infoMap.set(`${agentId}:${version}`, info);
  }
  const globalInfoMap = new Map<string, AccountInfo>();
  for (const { agentId, info } of globalInfoResults) {
    globalInfoMap.set(agentId, info);
  }

  // Usage status, plan, and overage credits belong to the account (email), not the
  // version. Different versions cache these in their own .claude.json, so older
  // versions show stale bars for the same email. Pick the freshest cache per
  // (agentId, email) and reuse it for every row with that email. lastActive stays
  // per-version — it reflects when that specific version was last used.
  const canonicalByEmail = new Map<string, AccountInfo>();
  const usageFetchInputs = new Map<string, { agentId: AgentId; home?: string; cliVersion: string | null }>();
  const chooseFresherAccount = (
    agentId: AgentId,
    info: AccountInfo,
    usageInput?: { home?: string; cliVersion: string | null }
  ) => {
    if (!info.email) return;
    const key = accountUsageKey(agentId, info.email);
    const existing = canonicalByEmail.get(key);
    const existingMs = existing?.lastActive?.getTime() ?? -1;
    const currentMs = info.lastActive?.getTime() ?? -1;
    if (!existing || currentMs > existingMs) {
      canonicalByEmail.set(key, info);
      usageFetchInputs.set(key, {
        agentId,
        home: usageInput?.home,
        cliVersion: usageInput?.cliVersion || null,
      });
    }
  };

  for (const { agentId, home, version, info } of infoResults) {
    chooseFresherAccount(agentId, info, { home, cliVersion: version });
  }
  for (const { agentId, cliVersion, info } of globalInfoResults) {
    chooseFresherAccount(agentId, info, { cliVersion });
  }

  const mergeCanonical = (agentId: AgentId, info: AccountInfo): AccountInfo => {
    if (!info.email) return info;
    const canon = canonicalByEmail.get(accountUsageKey(agentId, info.email));
    if (!canon) return info;
    return {
      ...info,
      plan: canon.plan,
      usageStatus: canon.usageStatus,
      overageCredits: canon.overageCredits,
    };
  };

  const usageResults = await Promise.all(
    [...usageFetchInputs.entries()].map(async ([key, input]) => ({
      key,
      usage: await getUsageInfo(input.agentId, {
        home: input.home,
        cliVersion: input.cliVersion,
      }),
    }))
  );
  const usageMap = new Map<string, UsageInfo>();
  for (const { key, usage } of usageResults) {
    usageMap.set(key, usage);
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
    // Calculate column widths across all agents for alignment
    let maxVerLabel = 0;
    let maxEmail = 0;
    let maxPlanWidth = 3;
    for (const agentId of versionManaged) {
      const versions = listInstalledVersions(agentId);
      const globalDefault = getGlobalDefault(agentId);
      for (const v of versions) {
        const label = v === globalDefault ? `${v} (default)` : v;
        maxVerLabel = Math.max(maxVerLabel, label.length);
        const rawInfo = infoMap.get(`${agentId}:${v}`);
        const info = rawInfo ? mergeCanonical(agentId, rawInfo) : undefined;
        if (info?.email) maxEmail = Math.max(maxEmail, info.email.length);
        if (info?.plan) maxPlanWidth = Math.max(maxPlanWidth, info.plan.length);
      }
    }

    for (const agentId of versionManaged) {
      const agent = AGENTS[agentId];
      const versions = listInstalledVersions(agentId);
      const globalDefault = getGlobalDefault(agentId);

      const noDefaultLabel = !globalDefault ? chalk.yellow(' (no default)') : '';
      console.log(`  ${chalk.bold(agentLabel(agentId))}${noDefaultLabel}`);

      // Sort versions with default first, then by semver descending
      const sortedVersions = [...versions].sort((a, b) => {
        if (a === globalDefault) return -1;
        if (b === globalDefault) return 1;
        return compareVersions(b, a);
      });

      for (const version of sortedVersions) {
        const isDefault = version === globalDefault;
        const base = isDefault ? `${version} (default)` : version;
        const padded = base.padEnd(maxVerLabel);
        const label = isDefault ? `${version}${chalk.green(' (default)')}${' '.repeat(maxVerLabel - base.length)}` : padded;
        const rawInfo = infoMap.get(`${agentId}:${version}`);
        const vInfo = rawInfo ? mergeCanonical(agentId, rawInfo) : undefined;
        const usageInfo = vInfo?.email ? usageMap.get(accountUsageKey(agentId, vInfo.email)) : undefined;

        // Build columns, trimming trailing whitespace when columns are empty
        const parts = [`    ${label}`];
        const hasEmail = !!vInfo?.email;
        const usageStr = formatUsageSummary(vInfo?.plan || null, usageInfo?.snapshot || null, maxPlanWidth);
        const activeStr = vInfo ? formatLastActive(vInfo.lastActive) : '';
        const hasUsage = usageStr.length > 0;
        const hasActive = activeStr.length > 0;

        if (hasEmail || hasUsage || hasActive) {
          const emailCol = (vInfo?.email || '').padEnd(maxEmail);
          parts.push(hasEmail ? chalk.cyan(emailCol) : ' '.repeat(maxEmail));
        }
        if (hasUsage || hasActive) parts.push(usageStr || ' '.repeat(10));
        if (hasActive) parts.push(activeStr);

        console.log(parts.join('  '));
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

      console.log(`  ${chalk.bold(agentLabel(agentId))}`);
      const gInfo = globalInfoMap.get(agentId);
      const verLabel = `${cliState?.version || 'installed'} ${chalk.gray('(global)')}`;
      const verLabelLen = `${cliState?.version || 'installed'} (global)`.length;
      const padding = ' '.repeat(Math.max(0, globalMaxVerLabel - verLabelLen));
      const parts = [`    ${verLabel}${padding}`];
      const gUsage = gInfo?.email ? usageMap.get(accountUsageKey(agentId, gInfo.email)) : undefined;
      const gUsageStr = formatUsageSummary(gInfo?.plan || null, gUsage?.snapshot || null);
      const gActiveStr = gInfo ? formatLastActive(gInfo.lastActive) : '';
      if (gInfo?.email || gUsageStr || gActiveStr) parts.push(gInfo?.email ? chalk.cyan(gInfo.email) : '');
      if (gUsageStr || gActiveStr) parts.push(gUsageStr);
      if (gActiveStr) parts.push(gActiveStr);
      console.log(parts.join('  '));
      if (showPaths && cliState?.path) {
        console.log(chalk.gray(`      ${cliState.path}`));
      }
      console.log();
    }
  }

  // If filtering to a specific agent and not found
  if (filterAgentId && versionManaged.length === 0 && globallyInstalled.length === 0) {
    console.log(`  ${chalk.bold(agentLabel(filterAgentId))}: ${chalk.gray('not installed')}`);
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

  // Check for new resources when viewing a specific agent
  if (filterAgentId && versionManaged.length > 0) {
    const defaultVersion = getGlobalDefault(filterAgentId);
    if (defaultVersion) {
      const available = getAvailableResources();
      const synced = getActuallySyncedResources(filterAgentId, defaultVersion);
      const newResources = getNewResources(available, synced);

      if (hasNewResources(newResources, filterAgentId)) {
        try {
          const selection = await promptNewResourceSelection(filterAgentId, newResources);
          if (selection && Object.keys(selection).length > 0) {
            const result = syncResourcesToVersion(filterAgentId, defaultVersion, selection);
            const synced: string[] = [];
            if (result.commands) synced.push('commands');
            if (result.skills) synced.push('skills');
            if (result.hooks) synced.push('hooks');
            if (result.memory.length > 0) synced.push('memory');
            if (result.permissions) synced.push('permissions');
            if (result.mcp.length > 0) synced.push('mcp');
            if (result.plugins.length > 0) synced.push('plugins');

            if (synced.length > 0) {
              console.log(chalk.green(`\nSynced to ${agentLabel(filterAgentId)}@${defaultVersion}: ${synced.join(', ')}`));
            }
          }
        } catch (err) {
          if (isPromptCancelled(err)) return;
          throw err;
        }
      }
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
      console.log(chalk.yellow(`No default version set for ${agentLabel(agentId)}`));
      console.log(chalk.gray(`Run: agents use ${agentId}@<version>`));
      return;
    }
  } else {
    const versions = listInstalledVersions(agentId);
    if (versions.includes(requestedVersion)) {
      version = requestedVersion;
    } else {
      spinner.stop();
      console.log(chalk.red(`Version ${requestedVersion} not installed for ${agentLabel(agentId)}`));
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
    scope: 'all',
    cliInstalled: cliStates[agentId]?.installed ?? false,
  });

  const agentData: AgentResourceDisplay = {
    agentId,
    agentName: agentLabel(agentId),
    version,
    commands: resources.commands.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : getSyncState(r.name, 'commands', commandsSync),
    })),
    skills: resources.skills.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : getSyncState(r.name, 'skills', skillsSync),
    })),
    skillErrors: resources.skillErrors,
    mcp: resources.mcp.map(r => ({ name: r.name, scope: r.scope, syncState: r.scope === 'project' ? undefined : 'synced' as SyncState })),
    memory: resources.memory.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : getSyncState(r.name, 'memory', memorySync),
    })),
    hooks: resources.hooks.map(r => ({
      ...r,
      syncState: r.scope === 'project' ? undefined : getSyncState(r.name, 'hooks', hooksSync),
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
      if (r.scope === 'project') {
        display += chalk.gray(' [project]');
      }
      const pathStr = r.path ? chalk.gray(formatPath(r.path, cwd)) : '';
      const syncStr = r.syncState ? chalk.gray(` [${r.syncState}]`) : '';
      console.log(`    ${display.padEnd(24)} ${pathStr}${syncStr}`);
    }
  }

  // 1. Agent CLI info
  console.log(chalk.bold('Agent CLIs\n'));
  const home = getVersionHomePath(agentId, version);
  const accountInfo = await getAccountInfo(agentId, home);
  const usageInfo = await getUsageInfo(agentId, { home, cliVersion: version });
  const emailStr = accountInfo.email ? chalk.cyan(`  ${accountInfo.email}`) : '';
  const cli = cliStates[agentId];
  const status = cli?.installed
    ? chalk.green(cli.version || 'installed')
    : chalk.gray('not installed');
  const usageStr = formatUsageSummary(accountInfo.plan, null);
  const usagePart = usageStr ? `  ${usageStr}` : '';
  console.log(`  ${colorAgent(agentId)(AGENTS[agentId].name.padEnd(14))} ${status}${emailStr}${usagePart}`);

  const usageLines = formatUsageSection(usageInfo);
  if (usageLines.length > 0) {
    console.log();
    for (const line of usageLines) {
      console.log(line);
    }
  }

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
  renderSection('Rules', agentData.memory);
  renderSection('Hooks', agentData.hooks);

  // Show legend at the end if git repo exists
  if (hasGitRepo) {
    console.log();
    console.log(chalk.gray('Legend:'), chalk.green('Tracked'), chalk.blue('Local-only'), chalk.yellow('Modified'), chalk.red('Deleted'));
  }
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
