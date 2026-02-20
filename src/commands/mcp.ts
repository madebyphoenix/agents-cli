import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  MCP_CAPABLE_AGENTS,
  ALL_AGENT_IDS,
  getAllCliStates,
  resolveAgentName,
  registerMcp,
  unregisterMcp,
  promoteMcpToUser,
  listInstalledMcpsWithScope,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { readManifest, writeManifest, createDefaultManifest } from '../lib/manifest.js';
import { getEffectiveHome, getGlobalDefault } from '../lib/versions.js';
import { ensureSource, getRepoLocalPath } from './repo.js';
import { isPromptCancelled } from './utils.js';

export function registerMcpCommands(program: Command): void {
  const mcpCmd = program
    .command('mcp')
    .description('Manage MCP servers');

  mcpCmd
    .command('list [agent]')
    .description('List MCP servers and registration status')
    .option('-a, --agent <agent>', 'Filter by agent')
    .option('-s, --scope <scope>', 'Filter by scope: user, project, or all', 'all')
    .action(async (agentArg, options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
      const cwd = process.cwd();

      // Resolve agent filter - positional arg takes precedence over -a flag
      const agentInput = agentArg || options.agent;
      let agents: AgentId[];
      if (agentInput) {
        const resolved = resolveAgentName(agentInput);
        if (!resolved) {
          spinner.stop();
          console.log(chalk.red(`Unknown agent '${agentInput}'. Use ${ALL_AGENT_IDS.join(', ')}`));
          process.exit(1);
        }
        agents = [resolved];
      } else {
        agents = MCP_CAPABLE_AGENTS;
      }
      const showPaths = !!agentInput;

      // Collect all data while spinner is active
      const cliStates = await getAllCliStates();
      type McpData = {
        agent: typeof AGENTS[AgentId];
        mcps: ReturnType<typeof listInstalledMcpsWithScope> | null;
        notInstalled?: boolean;
      };
      const agentMcps: McpData[] = agents.map((agentId) => {
        const agent = AGENTS[agentId];
        if (!agent.capabilities.mcp) {
          return { agent, mcps: null };
        }
        if (!cliStates[agentId]?.installed) {
          return { agent, mcps: null, notInstalled: true };
        }
        return {
          agent,
          mcps: listInstalledMcpsWithScope(agentId, cwd, { home: getEffectiveHome(agentId) }).filter(
            (m) => options.scope === 'all' || m.scope === options.scope
          ),
        };
      });

      spinner.stop();
      console.log(chalk.bold('MCP Servers\n'));

      for (const { agent, mcps, notInstalled } of agentMcps) {
        const defaultVer = getGlobalDefault(agent.id);
        const versionStr = defaultVer ? chalk.gray(` (${defaultVer})`) : '';

        if (mcps === null && notInstalled) {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}: ${chalk.gray('CLI not installed')}`);
          continue;
        }
        if (mcps === null) {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}: ${chalk.gray('mcp not supported')}`);
          console.log();
          continue;
        }

        if (mcps.length === 0) {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}:`);

          const userMcps = mcps.filter((m) => m.scope === 'user');
          const projectMcps = mcps.filter((m) => m.scope === 'project');

          if (userMcps.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
            console.log(`    ${chalk.gray('User:')}`);
            for (const mcp of userMcps) {
              console.log(`      ${chalk.cyan(mcp.name)}`);
              if (showPaths && mcp.command) console.log(chalk.gray(`        ${mcp.command}`));
            }
          }

          if (projectMcps.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
            console.log(`    ${chalk.gray('Project:')}`);
            for (const mcp of projectMcps) {
              console.log(`      ${chalk.yellow(mcp.name)}`);
              if (showPaths && mcp.command) console.log(chalk.gray(`        ${mcp.command}`));
            }
          }
        }
        console.log();
      }
    });

  mcpCmd
    .command('add <name> [command_or_url...]')
    .description('Add an MCP server (stdio or HTTP)')
    .option('-a, --agents <list>', 'Comma-separated agents', MCP_CAPABLE_AGENTS.join(','))
    .option('-s, --scope <scope>', 'Scope: user or project', 'user')
    .option('-t, --transport <type>', 'Transport: stdio or http', 'stdio')
    .option('-H, --header <header>', 'HTTP header (name:value), can be repeated', (val, acc: string[]) => {
      acc.push(val);
      return acc;
    }, [])
    .action(async (name: string, commandOrUrl: string[], options) => {
      const transport = options.transport as 'stdio' | 'http';

      if (commandOrUrl.length === 0) {
        console.error(chalk.red('Error: Command or URL required'));
        console.log(chalk.gray('Stdio: agents mcp add <name> -- <command...>'));
        console.log(chalk.gray('HTTP:  agents mcp add <name> <url> --transport http'));
        process.exit(1);
      }

      const source = await ensureSource();
      const localPath = getRepoLocalPath(source);
      const manifest = readManifest(localPath) || createDefaultManifest();

      manifest.mcp = manifest.mcp || {};

      if (transport === 'http') {
        const url = commandOrUrl[0];
        const headers: Record<string, string> = {};

        if (options.header && options.header.length > 0) {
          for (const h of options.header) {
            const [key, ...valueParts] = h.split(':');
            if (key && valueParts.length > 0) {
              headers[key.trim()] = valueParts.join(':').trim();
            }
          }
        }

        manifest.mcp[name] = {
          url,
          transport: 'http',
          scope: options.scope as 'user' | 'project',
          agents: options.agents.split(',') as AgentId[],
          ...(Object.keys(headers).length > 0 && { headers }),
        };
      } else {
        const command = commandOrUrl.join(' ');
        manifest.mcp[name] = {
          command,
          transport: 'stdio',
          scope: options.scope as 'user' | 'project',
          agents: options.agents.split(',') as AgentId[],
        };
      }

      writeManifest(localPath, manifest);
      console.log(chalk.green(`Added MCP server '${name}' to manifest`));
      console.log(chalk.gray('Run: agents mcp register to apply'));
    });

  mcpCmd
    .command('remove [name]')
    .description('Remove an MCP server from agents')
    .option('-a, --agents <list>', 'Comma-separated agents')
    .action(async (name?: string, options?: { agents?: string }) => {
      const cwd = process.cwd();
      const cliStates = await getAllCliStates();

      let mcpsToRemove: string[];
      let targetAgents: AgentId[];

      if (name) {
        mcpsToRemove = [name];
        targetAgents = options?.agents
          ? (options.agents.split(',') as AgentId[])
          : MCP_CAPABLE_AGENTS;
      } else {
        // Interactive picker: collect all MCPs across all installed agents
        const installedAgents = MCP_CAPABLE_AGENTS.filter((agentId) => cliStates[agentId]?.installed);

        if (installedAgents.length === 0) {
          console.log(chalk.yellow('No MCP-capable agents installed.'));
          return;
        }

        // Gather all unique MCPs across agents (with agent info for display)
        const mcpMap = new Map<string, { name: string; agents: string[]; command?: string }>();
        for (const agentId of installedAgents) {
          const mcps = listInstalledMcpsWithScope(agentId, cwd, { home: getEffectiveHome(agentId) });
          for (const mcp of mcps) {
            const existing = mcpMap.get(mcp.name);
            if (existing) {
              existing.agents.push(AGENTS[agentId].name);
            } else {
              mcpMap.set(mcp.name, {
                name: mcp.name,
                agents: [AGENTS[agentId].name],
                command: mcp.command,
              });
            }
          }
        }

        if (mcpMap.size === 0) {
          console.log(chalk.yellow('No MCP servers configured.'));
          return;
        }

        try {
          const selected = await checkbox({
            message: 'Select MCP servers to remove',
            choices: Array.from(mcpMap.values()).map((mcp) => ({
              value: mcp.name,
              name: `${mcp.name} (${mcp.agents.join(', ')})`,
            })),
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No MCPs selected.'));
            return;
          }

          mcpsToRemove = selected;
          targetAgents = installedAgents;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      // Execute removals - try each MCP on each target agent
      let removed = 0;
      for (const mcpName of mcpsToRemove) {
        for (const agentId of targetAgents) {
          if (!cliStates[agentId]?.installed) continue;

          const result = await unregisterMcp(agentId, mcpName);
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${AGENTS[agentId].name}: ${mcpName}`);
            removed++;
          }
        }
      }

      if (removed === 0) {
        console.log(chalk.yellow('No MCP servers removed.'));
      } else {
        console.log(chalk.green(`\nRemoved ${removed} MCP server(s).`));
      }
    });

  mcpCmd
    .command('push <name>')
    .description('Promote a project MCP server to user scope')
    .option('-a, --agents <list>', 'Comma-separated agents to push for')
    .action(async (name: string, options) => {
      const cwd = process.cwd();
      const agents = options.agents
        ? (options.agents.split(',') as AgentId[])
        : MCP_CAPABLE_AGENTS;

      const cliStates = await getAllCliStates();
      let pushed = 0;
      for (const agentId of agents) {
        if (!cliStates[agentId]?.installed) continue;

        const result = await promoteMcpToUser(agentId, name, cwd, { home: getEffectiveHome(agentId) });
        if (result.success) {
          console.log(`  ${chalk.green('+')} ${AGENTS[agentId].name}`);
          pushed++;
        } else if (result.error && !result.error.includes('not found')) {
          console.log(`  ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
        }
      }

      if (pushed === 0) {
        console.log(chalk.yellow(`Project MCP '${name}' not found for any agent`));
      } else {
        console.log(chalk.green(`\nPushed to user scope for ${pushed} agents.`));
      }
    });

  mcpCmd
    .command('register [name]')
    .description('Register MCP server(s) with agent CLIs')
    .option('-a, --agents <list>', 'Comma-separated agents')
    .action(async (name: string | undefined, options) => {
      if (!name) {
        const source = await ensureSource();
        const localPath = getRepoLocalPath(source);
        const manifest = readManifest(localPath);

        if (!manifest?.mcp) {
          console.log(chalk.yellow('No MCP servers in manifest'));
          return;
        }

        const cliStates = await getAllCliStates();
        for (const [mcpName, config] of Object.entries(manifest.mcp)) {
          // Skip HTTP transport MCPs for now (need different registration)
          if (config.transport === 'http' || !config.command) {
            console.log(`\n  ${chalk.cyan(mcpName)}: ${chalk.yellow('HTTP transport not yet supported')}`);
            continue;
          }

          console.log(`\n  ${chalk.cyan(mcpName)}:`);
          const mcpTargetAgents = config.agents?.length ? config.agents : MCP_CAPABLE_AGENTS;
          for (const agentId of mcpTargetAgents) {
            if (!cliStates[agentId]?.installed) continue;

            const result = await registerMcp(agentId, mcpName, config.command, config.scope, config.transport || 'stdio');
            if (result.success) {
              console.log(`    ${chalk.green('+')} ${AGENTS[agentId].name}`);
            } else {
              console.log(`    ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
            }
          }
        }
        return;
      }

      console.log(chalk.yellow('Single MCP registration not yet implemented'));
    });
}
