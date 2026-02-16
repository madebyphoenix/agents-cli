import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

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
import { formatPath } from './utils.js';

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
      const cliStates = await getAllCliStates();
      const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;

      // Collect per-agent resources
      interface AgentResourceDisplay {
        agentId: AgentId;
        agentName: string;
        version: string | null;
        commands: Array<{ name: string; path: string }>;
        skills: Array<{ name: string; path: string; ruleCount?: number }>;
        mcp: Array<{ name: string }>;
        memory: Array<{ name: string; path: string }>;
        hooks: Array<{ name: string; path: string }>;
      }

      const perAgentResources: AgentResourceDisplay[] = [];

      for (const agentId of agentsToShow) {
        const version = resolveVersion(agentId, cwd);
        const resources = getAgentResources(agentId, {
          cwd,
          scope: 'user',
          cliInstalled: cliStates[agentId]?.installed ?? false,
        });

        perAgentResources.push({
          agentId,
          agentName: AGENTS[agentId].name,
          version,
          commands: resources.commands,
          skills: resources.skills,
          mcp: resources.mcp,
          memory: resources.memory,
          hooks: resources.hooks,
        });
      }

      spinner.stop();

      // Render helper for per-agent resources
      function renderPerAgentSection(
        title: string,
        getResources: (data: AgentResourceDisplay) => Array<{ name: string; path?: string; ruleCount?: number }>
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
            let display = chalk.cyan(r.name);
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

      console.log('');
    });
}
