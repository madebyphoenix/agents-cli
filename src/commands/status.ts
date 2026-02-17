import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';

import {
  AGENTS,
  ALL_AGENT_IDS,
  getAllCliStates,
  getAccountEmail,
  resolveAgentName,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import {
  resolveVersion,
  getVersionHomePath,
} from '../lib/versions.js';
import { getAgentResources } from '../lib/resources.js';
import { getAgentsDir } from '../lib/state.js';
import { isGitRepo, getGitSyncStatus } from '../lib/git.js';
import { formatPath } from './utils.js';

type SyncState = 'synced' | 'new' | 'modified' | 'deleted';

interface ResourceWithSync {
  name: string;
  path?: string;
  ruleCount?: number;
  syncState?: SyncState;
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status [agent]')
    .description('Show installed agents and resources')
    .action(async (agentFilter?: string) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();

      // Resolve agent filter to AgentId
      let filterAgentId: AgentId | undefined;
      if (agentFilter) {
        const agentMap: Record<string, AgentId> = {
          claude: 'claude',
          'claude-code': 'claude',
          codex: 'codex',
          gemini: 'gemini',
          cursor: 'cursor',
          opencode: 'opencode',
        };
        filterAgentId = agentMap[agentFilter.toLowerCase()];
        if (!filterAgentId) {
          spinner.stop();
          console.log(chalk.red(`Unknown agent: ${agentFilter}`));
          console.log(chalk.gray(`Valid agents: claude, codex, gemini, cursor, opencode`));
          process.exit(1);
        }
      }

      const cwd = process.cwd();
      const agentsDir = getAgentsDir();
      const cliStates = await getAllCliStates();
      const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;

      // Get git sync status if ~/.agents/ is a git repo
      const hasGitRepo = isGitRepo(agentsDir);
      const commandsSync = hasGitRepo ? await getGitSyncStatus(agentsDir, 'commands') : null;
      const skillsSync = hasGitRepo ? await getGitSyncStatus(agentsDir, 'skills') : null;
      const hooksSync = hasGitRepo ? await getGitSyncStatus(agentsDir, 'hooks') : null;
      const memorySync = hasGitRepo ? await getGitSyncStatus(agentsDir, 'memory') : null;

      // Helper to determine sync state for a resource
      // resourcePath is in version home, we need to check central storage
      const getSyncState = (
        resourceName: string,
        resourceType: 'commands' | 'skills' | 'hooks' | 'memory',
        syncStatus: Awaited<ReturnType<typeof getGitSyncStatus>>
      ): SyncState | undefined => {
        if (!syncStatus) return undefined;

        // Build the relative path in central storage
        let relativePath: string;
        if (resourceType === 'commands') {
          relativePath = `commands/${resourceName}.md`;
        } else if (resourceType === 'skills') {
          relativePath = `skills/${resourceName}`;
        } else if (resourceType === 'hooks') {
          relativePath = `hooks/${resourceName}`;
        } else {
          relativePath = `memory/${resourceName}`;
        }

        // Check if file is new (untracked or staged but not committed)
        const isNew = syncStatus.new.some(f => f === relativePath || f.startsWith(relativePath + '/'));
        const isStaged = syncStatus.staged.some(f => f === relativePath || f.startsWith(relativePath + '/'));

        if (isNew || isStaged) {
          return 'new';
        }
        if (syncStatus.modified.some(f => f === relativePath || f.startsWith(relativePath + '/'))) {
          return 'modified';
        }
        if (syncStatus.deleted.some(f => f === relativePath || f.startsWith(relativePath + '/'))) {
          return 'deleted';
        }
        return 'synced';
      };

      // Collect per-agent resources
      interface AgentResourceDisplay {
        agentId: AgentId;
        agentName: string;
        version: string | null;
        commands: ResourceWithSync[];
        skills: ResourceWithSync[];
        mcp: ResourceWithSync[];
        memory: ResourceWithSync[];
        hooks: ResourceWithSync[];
      }

      const perAgentResources: AgentResourceDisplay[] = [];

      for (const agentId of agentsToShow) {
        const version = resolveVersion(agentId, cwd);
        // Only show agents that have a version installed via agents-cli
        if (!version) continue;

        const resources = getAgentResources(agentId, {
          cwd,
          scope: 'user',
          cliInstalled: cliStates[agentId]?.installed ?? false,
        });

        perAgentResources.push({
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
          mcp: resources.mcp.map(r => ({ name: r.name })),
          memory: resources.memory.map(r => ({
            ...r,
            syncState: getSyncState(r.name, 'memory', memorySync),
          })),
          hooks: resources.hooks.map(r => ({
            ...r,
            syncState: getSyncState(r.name, 'hooks', hooksSync),
          })),
        });
      }

      spinner.stop();

      // Render helper for per-agent resources
      function renderPerAgentSection(
        title: string,
        getResources: (data: AgentResourceDisplay) => ResourceWithSync[]
      ): void {
        console.log(chalk.bold(`\n${title}\n`));

        let hasAny = false;
        for (const data of perAgentResources) {
          const resources = getResources(data);
          if (resources.length === 0) continue;

          hasAny = true;
          const versionStr = data.version ? ` (${data.version})` : '';
          console.log(`  ${chalk.bold(data.agentName)}${chalk.gray(versionStr)}:`);

          for (const r of resources) {
            // Color based on sync state
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

        if (!hasAny) {
          console.log(`  ${chalk.gray('none')}`);
        }
      }

      // 1. Agent CLIs
      console.log(chalk.bold('Agent CLIs\n'));

      // Fetch emails in parallel for all agents
      const statusEmails = await Promise.all(
        agentsToShow.map(async (agentId) => {
          const resolvedVer = resolveVersion(agentId, process.cwd());
          const home = resolvedVer ? getVersionHomePath(agentId, resolvedVer) : undefined;
          return { agentId, email: await getAccountEmail(agentId, home) };
        })
      );
      const statusEmailMap = new Map(statusEmails.map((e) => [e.agentId, e.email]));

      for (const agentId of agentsToShow) {
        const agent = AGENTS[agentId];
        const cli = cliStates[agentId];
        const status = cli?.installed
          ? chalk.green(cli.version || 'installed')
          : chalk.gray('not installed');
        const email = statusEmailMap.get(agentId);
        const emailStr = email ? chalk.cyan(`  ${email}`) : '';
        console.log(`  ${agent.name.padEnd(14)} ${status}${emailStr}`);
      }

      // 2. Commands
      renderPerAgentSection('Commands', (d) => d.commands);

      // 3. Skills
      renderPerAgentSection('Skills', (d) => d.skills);

      // 4. MCP Servers
      renderPerAgentSection('MCP Servers', (d) => d.mcp);

      // 5. Memory
      renderPerAgentSection('Memory', (d) => d.memory);

      // 6. Hooks
      renderPerAgentSection('Hooks', (d) => d.hooks);

      // Show legend at the end if git repo exists
      if (hasGitRepo) {
        console.log();
        console.log(chalk.gray('Legend:'), chalk.green('Synced'), chalk.blue('New'), chalk.yellow('Modified'), chalk.red('Deleted'));
      }

      console.log('');
    });
}
