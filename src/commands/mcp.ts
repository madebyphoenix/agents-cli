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
  formatAgentError,
  registerMcpToTargets,
  unregisterMcpFromTargets,
  listInstalledMcpsWithScope,
  agentLabel,
} from '../lib/agents.js';
import type { AgentId, McpServerConfig } from '../lib/types.js';
import { readManifest, writeManifest, createDefaultManifest } from '../lib/manifest.js';
import {
  getEffectiveHome,
  getGlobalDefault,
  listInstalledVersions,
  getVersionHomePath,
  resolveInstalledAgentTargets,
  resolveConfiguredAgentTargets,
} from '../lib/versions.js';
import { getAgentsDir } from '../lib/state.js';
import { isPromptCancelled, isInteractiveTerminal, requireInteractiveSelection } from './utils.js';

function parseMcpAgentTargets(value: string): {
  agents: AgentId[];
  agentVersions?: Partial<Record<AgentId, string[]>>;
} {
  const agents: AgentId[] = [];
  const agentVersions: Partial<Record<AgentId, string[]>> = {};
  const targets = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const target of targets) {
    const atIndex = target.indexOf('@');
    const agentToken = (atIndex === -1 ? target : target.slice(0, atIndex)).trim();
    const versionToken = atIndex === -1 ? null : target.slice(atIndex + 1).trim();

    if (!agentToken) {
      continue;
    }

    if (atIndex !== -1 && !versionToken) {
      throw new Error(`Missing version in --agents entry '${target}'. Use agent@x.y.z or agent@default.`);
    }

    const agentId = resolveAgentName(agentToken);
    if (!agentId || !MCP_CAPABLE_AGENTS.includes(agentId)) {
      throw new Error(formatAgentError(agentToken, MCP_CAPABLE_AGENTS));
    }

    if (!versionToken) {
      if (!agents.includes(agentId)) {
        agents.push(agentId);
      }
      continue;
    }

    if (versionToken === 'default') {
      if (!getGlobalDefault(agentId)) {
        throw new Error(`No default version set for ${AGENTS[agentId].name}. Run: agents use ${agentId}@<version>`);
      }
      if (!agents.includes(agentId)) {
        agents.push(agentId);
      }
      continue;
    }

    const installedVersions = listInstalledVersions(agentId);
    if (installedVersions.length === 0) {
      throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
    }

    if (!installedVersions.includes(versionToken)) {
      throw new Error(
        `Version ${versionToken} is not installed for ${AGENTS[agentId].name}. Installed versions: ${installedVersions.join(', ')}`
      );
    }

    const versions = agentVersions[agentId] || [];
    if (!versions.includes(versionToken)) {
      versions.push(versionToken);
      agentVersions[agentId] = versions;
    }
  }

  return {
    agents,
    ...(Object.keys(agentVersions).length > 0 ? { agentVersions } : {}),
  };
}

function formatTargetLabel(agentId: AgentId, version?: string): string {
  return version ? `${agentLabel(agentId)}@${version}` : agentLabel(agentId);
}

export function registerMcpCommands(program: Command): void {
  const mcpCmd = program
    .command('mcp')
    .description('Manage MCP servers');

  mcpCmd
    .command('list [agent]')
    .description('List MCP servers. Use agent@version for specific version, agent@default for default only.')
    .option('-a, --agent <agent>', 'Filter by agent')
    .option('-s, --scope <scope>', 'Filter by scope: user, project, or all', 'all')
    .action(async (agentArg, options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
      const cwd = process.cwd();

      // Parse agent input - handle agent@version syntax
      const agentInput = agentArg || options.agent;
      let agentId: AgentId | null = null;
      let requestedVersion: string | null = null;

      if (agentInput) {
        const parts = agentInput.split('@');
        const agentName = parts[0];
        requestedVersion = parts[1] || null;

        agentId = resolveAgentName(agentName);
        if (!agentId) {
          spinner.stop();
          console.log(chalk.red(formatAgentError(agentName)));
          process.exit(1);
        }
      }

      const showPaths = !!agentInput;
      const cliStates = await getAllCliStates();

      // Helper to render MCP servers for a specific version
      const renderVersionMcps = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string
      ) => {
        const agent = AGENTS[agentId];
        if (!agent.capabilities.mcp) {
          const defaultLabel = isDefault ? ' default' : '';
          console.log(`  ${chalk.bold(agentLabel(agent.id))} (${version}${defaultLabel}): ${chalk.gray('mcp not supported')}`);
          console.log();
          return;
        }

        const mcps = listInstalledMcpsWithScope(agentId, cwd, { home }).filter(
          (m) => options.scope === 'all' || m.scope === options.scope
        );

        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

        if (mcps.length === 0) {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}:`);

          const userMcps = mcps.filter((m) => m.scope === 'user');
          const projectMcps = mcps.filter((m) => m.scope === 'project');

          if (userMcps.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
            console.log(`    ${chalk.gray('User:')}`);
            for (const mcp of userMcps) {
              console.log(`      ${chalk.cyan(mcp.name.padEnd(20))}`);
              if (showPaths && mcp.command) console.log(chalk.gray(`        ${mcp.command}`));
            }
          }

          if (projectMcps.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
            console.log(`    ${chalk.gray('Project:')}`);
            for (const mcp of projectMcps) {
              console.log(`      ${chalk.yellow(mcp.name.padEnd(20))}`);
              if (showPaths && mcp.command) console.log(chalk.gray(`        ${mcp.command}`));
            }
          }
        }
        console.log();
      };

      spinner.stop();

      // Single agent specified - show versions based on requestedVersion
      if (agentId) {
        const agent = AGENTS[agentId];
        const installedVersions = listInstalledVersions(agentId);
        const defaultVer = getGlobalDefault(agentId);

        if (!agent.capabilities.mcp) {
          console.log(chalk.bold(`MCP Servers for ${agentLabel(agent.id)}\n`));
          console.log(`  ${chalk.gray('mcp not supported')}`);
          return;
        }

        if (installedVersions.length === 0) {
          // Not version-managed
          console.log(chalk.bold(`MCP Servers for ${agentLabel(agent.id)}\n`));
          if (!cliStates[agentId]?.installed) {
            console.log(`  ${chalk.bold(agentLabel(agent.id))}: ${chalk.gray('CLI not installed')}`);
          } else {
            const mcps = listInstalledMcpsWithScope(agentId, cwd, { home: getEffectiveHome(agentId) }).filter(
              (m) => options.scope === 'all' || m.scope === options.scope
            );
            if (mcps.length === 0) {
              console.log(`  ${chalk.bold(agentLabel(agent.id))}: ${chalk.gray('none')}`);
            } else {
              console.log(`  ${chalk.bold(agentLabel(agent.id))}:`);
              const userMcps = mcps.filter((m) => m.scope === 'user');
              if (userMcps.length > 0) {
                console.log(`    ${chalk.gray('User:')}`);
                for (const mcp of userMcps) {
                  console.log(`      ${chalk.cyan(mcp.name.padEnd(20))}`);
                  if (showPaths && mcp.command) console.log(chalk.gray(`        ${mcp.command}`));
                }
              }
            }
          }
          return;
        }

        console.log(chalk.bold(`MCP Servers for ${agentLabel(agent.id)}\n`));

        let versionsToShow: string[];
        if (requestedVersion === 'default') {
          if (!defaultVer) {
            console.log(chalk.yellow(`  No default version set for ${agent.name}. Run: agents use ${agentId}@<version>`));
            return;
          }
          versionsToShow = [defaultVer];
        } else if (requestedVersion) {
          if (!installedVersions.includes(requestedVersion)) {
            console.log(chalk.red(`  Version ${requestedVersion} not installed for ${agent.name}.`));
            console.log(chalk.gray(`  Installed versions: ${installedVersions.join(', ')}`));
            return;
          }
          versionsToShow = [requestedVersion];
        } else {
          versionsToShow = [...installedVersions].sort((a, b) => {
            if (a === defaultVer) return -1;
            if (b === defaultVer) return 1;
            return 0;
          });
        }

        for (const version of versionsToShow) {
          const home = getVersionHomePath(agentId, version);
          renderVersionMcps(agentId, version, version === defaultVer, home);
        }
        return;
      }

      // No agent specified - show default version for each MCP-capable agent
      console.log(chalk.bold('MCP Servers\n'));

      for (const aid of MCP_CAPABLE_AGENTS) {
        const agent = AGENTS[aid];
        const installedVersions = listInstalledVersions(aid);
        const defaultVer = getGlobalDefault(aid);

        if (installedVersions.length > 0 && defaultVer) {
          const home = getVersionHomePath(aid, defaultVer);
          renderVersionMcps(aid, defaultVer, true, home);
        } else {
          // Not version-managed or no default
          if (!cliStates[aid]?.installed) {
            console.log(`  ${chalk.bold(agentLabel(aid))}: ${chalk.gray('CLI not installed')}`);
          } else if (!agent.capabilities.mcp) {
            console.log(`  ${chalk.bold(agentLabel(aid))}: ${chalk.gray('mcp not supported')}`);
          } else {
            const mcps = listInstalledMcpsWithScope(aid, cwd, { home: getEffectiveHome(aid) }).filter(
              (m) => options.scope === 'all' || m.scope === options.scope
            );
            if (mcps.length === 0) {
              console.log(`  ${chalk.bold(agentLabel(aid))}: ${chalk.gray('none')}`);
            } else {
              console.log(`  ${chalk.bold(agentLabel(aid))}:`);
              const userMcps = mcps.filter((m) => m.scope === 'user');
              if (userMcps.length > 0) {
                console.log(`    ${chalk.gray('User:')}`);
                for (const mcp of userMcps) {
                  console.log(`      ${chalk.cyan(mcp.name)}`);
                }
              }
            }
          }
          console.log();
        }
      }
    });

  mcpCmd
    .command('add <name> [command_or_url...]')
    .description('Add an MCP server (stdio or HTTP)')
    .option('-a, --agents <list>', 'Comma-separated agent or agent@version targets', MCP_CAPABLE_AGENTS.join(','))
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

      const localPath = getAgentsDir();
      const manifest = readManifest(localPath) || createDefaultManifest();

      manifest.mcp = manifest.mcp || {};

      const targetConfig = parseMcpAgentTargets(options.agents);

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
          agents: targetConfig.agents,
          ...(targetConfig.agentVersions ? { agentVersions: targetConfig.agentVersions } : {}),
          ...(Object.keys(headers).length > 0 && { headers }),
        };
      } else {
        const command = commandOrUrl.join(' ');
        manifest.mcp[name] = {
          command,
          transport: 'stdio',
          scope: options.scope as 'user' | 'project',
          agents: targetConfig.agents,
          ...(targetConfig.agentVersions ? { agentVersions: targetConfig.agentVersions } : {}),
        };
      }

      writeManifest(localPath, manifest);
      console.log(chalk.green(`Added MCP server '${name}' to manifest`));
      console.log(chalk.gray('Run: agents mcp register to apply'));
    });

  mcpCmd
    .command('remove [name]')
    .description('Remove an MCP server from agents')
    .option('-a, --agents <list>', 'Comma-separated agent or agent@version targets')
    .action(async (name?: string, options?: { agents?: string }) => {
      const cwd = process.cwd();
      const cliStates = await getAllCliStates();

      let mcpsToRemove: string[];
      let targets:
        | ReturnType<typeof resolveInstalledAgentTargets>
        | ReturnType<typeof resolveConfiguredAgentTargets>;

      if (name) {
        mcpsToRemove = [name];
        const installedAgents = MCP_CAPABLE_AGENTS.filter(
          (agentId) => cliStates[agentId]?.installed || listInstalledVersions(agentId).length > 0
        );
        targets = options?.agents
          ? resolveInstalledAgentTargets(options.agents, MCP_CAPABLE_AGENTS)
          : resolveConfiguredAgentTargets(installedAgents, undefined, MCP_CAPABLE_AGENTS);
      } else {
        // Interactive picker: collect all MCPs across all installed agents
        const installedAgents = MCP_CAPABLE_AGENTS.filter((agentId) => cliStates[agentId]?.installed);

        if (installedAgents.length === 0) {
          console.log(chalk.yellow('No MCP-capable agents installed.'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting MCP servers to remove', [
            'agents mcp remove my-server',
            'agents mcp remove my-server --agents codex,claude',
          ]);
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
          targets = resolveConfiguredAgentTargets(installedAgents, undefined, MCP_CAPABLE_AGENTS);
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
        const results = await unregisterMcpFromTargets(targets, mcpName);
        for (const result of results) {
          if (result.success) {
            console.log(`  ${chalk.red('-')} ${formatTargetLabel(result.agentId, result.version)}: ${mcpName}`);
            removed++;
          } else if (result.error && !result.error.includes('CLI not installed')) {
            console.log(`  ${chalk.yellow('!')} ${formatTargetLabel(result.agentId, result.version)}: ${result.error}`);
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
    .command('view [name]')
    .description('Show MCP server details')
    .action(async (name?: string) => {
      const cwd = process.cwd();
      const cliStates = await getAllCliStates();

      // Gather all unique MCPs across agents
      const mcpMap = new Map<string, { name: string; agents: string[]; command?: string; scope: string }>();
      for (const agentId of MCP_CAPABLE_AGENTS) {
        if (!cliStates[agentId]?.installed) continue;
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
              scope: mcp.scope,
            });
          }
        }
      }

      if (mcpMap.size === 0) {
        console.log(chalk.yellow('No MCP servers configured'));
        return;
      }

      // If no name provided, show interactive select
      if (!name) {
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting an MCP server to view', [
            'agents mcp view my-server',
          ]);
        }
        try {
          const { select } = await import('@inquirer/prompts');
          name = await select({
            message: 'Select an MCP server to view',
            choices: Array.from(mcpMap.values()).map((mcp) => ({
              value: mcp.name,
              name: `${mcp.name} (${mcp.agents.join(', ')})`,
            })),
          });
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      const mcp = mcpMap.get(name);
      if (!mcp) {
        console.log(chalk.yellow(`MCP server '${name}' not found`));
        return;
      }

      console.log(chalk.bold(`\n${mcp.name}\n`));
      console.log(`  Scope: ${mcp.scope}`);
      console.log(`  Agents: ${mcp.agents.join(', ')}`);
      if (mcp.command) {
        console.log(`  Command: ${chalk.cyan(mcp.command)}`);
      }
      console.log();
    });

  mcpCmd
    .command('register [name]')
    .description('Register MCP server(s) with agent CLIs')
    .option('-a, --agents <list>', 'Comma-separated agent or agent@version targets')
    .action(async (name: string | undefined, options) => {
      const localPath = getAgentsDir();
      const manifest = readManifest(localPath);

      if (!manifest?.mcp) {
        console.log(chalk.yellow('No MCP servers in manifest'));
        return;
      }

      const entries = name
        ? (() => {
            const config = manifest.mcp?.[name];
            return config ? [[name, config] as [string, McpServerConfig]] : [];
          })()
        : Object.entries(manifest.mcp);

      if (entries.length === 0) {
        console.log(chalk.yellow(`MCP server '${name}' not found in manifest`));
        return;
      }

      for (const [mcpName, config] of entries) {
        if (config.transport === 'http' || !config.command) {
          console.log(`\n  ${chalk.cyan(mcpName)}: ${chalk.yellow('HTTP transport not yet supported')}`);
          continue;
        }

        console.log(`\n  ${chalk.cyan(mcpName)}:`);
        const targets = options.agents
          ? resolveInstalledAgentTargets(options.agents, MCP_CAPABLE_AGENTS)
          : resolveConfiguredAgentTargets(config.agents, config.agentVersions, MCP_CAPABLE_AGENTS);
        const results = await registerMcpToTargets(
          targets,
          mcpName,
          config.command,
          config.scope || 'user',
          config.transport || 'stdio'
        );

        for (const result of results) {
          if (result.success) {
            console.log(`    ${chalk.green('+')} ${formatTargetLabel(result.agentId, result.version)}`);
          } else {
            console.log(`    ${chalk.red('x')} ${formatTargetLabel(result.agentId, result.version)}: ${result.error}`);
          }
        }
      }
    });
}
