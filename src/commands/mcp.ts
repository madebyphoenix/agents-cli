/**
 * MCP (Model Context Protocol) server management commands.
 *
 * Implements `agents mcp` -- list, add, remove, view, and register MCP
 * servers that give agents runtime access to databases, APIs, and external
 * services. Servers are declared in ~/.agents/mcp/ YAML files or the
 * agents.yaml manifest, then registered into each agent version's config.
 */
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
  parseMcpConfig,
  getMcpConfigPathForHome,
  agentLabel,
} from '../lib/agents.js';
import type { AgentId, McpServerConfig } from '../lib/types.js';
import { readManifest, writeManifest, createDefaultManifest } from '../lib/manifest.js';
import { listMcpServerConfigs, type InstalledMcpServer } from '../lib/mcp.js';
import { getMcpDir } from '../lib/state.js';
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
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';

/** Parse a comma-separated --agents string into validated agent IDs and optional version targets. */
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

/** Register the `agents mcp` command tree (list, add, remove, view, register). */
export function registerMcpCommands(program: Command): void {
  const mcpCmd = program
    .command('mcp')
    .description('Connect agents to external tools via Model Context Protocol servers')
    .addHelpText('after', `
MCP servers give agents runtime access to databases, APIs, filesystems, and services. Add a server once, invoke its tools from any agent session. Agents-cli handles registration and configuration across versions.

Examples:
  # List all registered MCP servers
  agents mcp list

  # Check what servers are available for a specific agent
  agents mcp list claude@2.1.112

  # Register a Node-based MCP server
  agents mcp add notion uvx notion-mcp --agents claude,codex

  # Register an HTTP MCP server
  agents mcp add my-api https://api.example.com --transport http --agents claude

  # Apply servers from manifest to specific agents
  agents mcp register --agents codex@0.116.0

When to use:
  - After install: 'agents mcp add <server>' to connect a new service
  - Version upgrade: 'agents mcp register' to sync servers to the new version
  - Team setup: commit mcp config to .agents and run 'agents mcp register'
`);

  mcpCmd
    .command('list [agent]')
    .description('Show which MCP servers are registered and which agent versions they are synced to')
    .option('-a, --agent <agent>', 'Filter to a specific agent (alternative to positional arg)')
    .action(async (agentArg, options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();

      const agentInput = agentArg || options.agent;
      let filterAgent: AgentId | undefined;
      let filterVersion: string | undefined;

      if (agentInput) {
        const parts = agentInput.split('@');
        const resolved = resolveAgentName(parts[0]);
        if (!resolved) {
          spinner.stop();
          console.log(chalk.red(formatAgentError(parts[0], MCP_CAPABLE_AGENTS)));
          process.exit(1);
        }
        filterAgent = resolved;
        filterVersion = parts[1] || undefined;
      }

      const rows = buildMcpRows({ filterAgent, filterVersion });

      spinner.stop();

      await showResourceList({
        resourcePlural: 'MCP servers',
        resourceSingular: 'MCP server',
        extraLabel: 'Source',
        rows,
        emptyMessage: filterAgent
          ? `No MCP servers registered for ${agentLabel(filterAgent)}.`
          : 'No MCP servers registered. Add one with: agents mcp add <name> -- <command>',
        centralPath: getMcpDir(),
        filterAgent,
        filterVersion,
      });
    });

  mcpCmd
    .command('add <name> [command_or_url...]')
    .description('Add an MCP server to the manifest (run "agents mcp register" afterward to apply)')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0', MCP_CAPABLE_AGENTS.join(','))
    .option('-s, --scope <scope>', 'user (global) or project (repo-specific)', 'user')
    .option('-t, --transport <type>', 'stdio (default) or http', 'stdio')
    .option('-H, --header <header>', 'HTTP header as name:value (repeatable)', (val, acc: string[]) => {
      acc.push(val);
      return acc;
    }, [])
    .addHelpText('after', `
Examples:
  # Add a stdio MCP server (Node-based)
  agents mcp add notion uvx notion-mcp --agents claude,codex

  # Add an HTTP MCP server with auth header
  agents mcp add my-api https://api.example.com --transport http --header "Authorization: Bearer token" --agents claude

  # Add to manifest only (register later)
  agents mcp add db-server -- uvx postgres-mcp
`)
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
    .description('Unregister an MCP server from agents (interactive picker if no name given)')
    .option('-a, --agents <list>', 'Limit removal to specific agents')
    .addHelpText('after', `
Examples:
  # Remove a server by name
  agents mcp remove notion

  # Remove from specific agents only
  agents mcp remove notion --agents codex,claude

  # Interactive picker
  agents mcp remove
`)
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
    .description('Show MCP server configuration (command, scope, registered agents)')
    .addHelpText('after', `
Examples:
  # View details for a specific server
  agents mcp view notion

  # Interactive picker
  agents mcp view
`)
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
    .description('Apply MCP servers from manifest to agent config files (stdio only for now)')
    .option('-a, --agents <list>', 'Override manifest targets: claude, codex@0.116.0')
    .addHelpText('after', `
Examples:
  # Register all servers from manifest
  agents mcp register

  # Register a specific server
  agents mcp register notion

  # Register to specific agents (overrides manifest config)
  agents mcp register --agents codex@0.116.0
`)
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

interface McpTargetPair {
  agent: AgentId;
  version: string;
  home: string;
}

/** Enumerate (agent, version) pairs that support MCP and have a version home. */
function iterMcpCapableVersions(filter?: { agent?: AgentId; version?: string }): McpTargetPair[] {
  const out: McpTargetPair[] = [];
  const agents = filter?.agent ? [filter.agent] : MCP_CAPABLE_AGENTS;
  for (const agent of agents) {
    if (!MCP_CAPABLE_AGENTS.includes(agent)) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      out.push({ agent, version, home: getVersionHomePath(agent, version) });
    }
  }
  return out;
}

type McpSource = 'central' | 'manifest' | 'unmanaged';

/**
 * Build the row data for `agents mcp list`. Rows come from three sources,
 * in priority order:
 *   1. central  — ~/.agents/mcp/*.yaml (primary source of truth)
 *   2. manifest — agents.yaml#mcp (legacy/alternate declaration)
 *   3. unmanaged — found only in an agent's own config file
 *
 * Sync targets reflect the physical state: whether the server is actually
 * registered in each (agent, version) config.
 */
function buildMcpRows(opts: {
  filterAgent?: AgentId;
  filterVersion?: string;
}): ResourceRow[] {
  const centralServers = new Map<string, InstalledMcpServer>();
  for (const s of listMcpServerConfigs()) centralServers.set(s.name, s);

  const manifest = readManifest(getAgentsDir());
  const manifestEntries = manifest?.mcp || {};

  const targetPairs = iterMcpCapableVersions({
    agent: opts.filterAgent,
    version: opts.filterVersion,
  });

  // Read each target's config once.
  const installedByTarget = new Map<string, Record<string, { command?: string; url?: string }>>();
  for (const { agent, version, home } of targetPairs) {
    const configPath = getMcpConfigPathForHome(agent, home);
    const parsed = parseMcpConfig(agent, configPath);
    const normalized: Record<string, { command?: string; url?: string }> = {};
    for (const [name, entry] of Object.entries(parsed)) {
      const command = entry.command && entry.args?.length
        ? `${entry.command} ${entry.args.join(' ')}`
        : entry.command || (entry.args ? entry.args.join(' ') : undefined);
      normalized[name] = { command, url: (entry as any).url };
    }
    installedByTarget.set(`${agent}@${version}`, normalized);
  }

  // Union: central + manifest + anything found in a target config.
  const allNames = new Set<string>();
  for (const name of centralServers.keys()) allNames.add(name);
  for (const name of Object.keys(manifestEntries)) allNames.add(name);
  for (const entries of installedByTarget.values()) {
    for (const name of Object.keys(entries)) allNames.add(name);
  }

  if (allNames.size === 0) return [];

  const defaultByAgent = new Map<AgentId, string | null>();
  for (const { agent } of targetPairs) {
    if (!defaultByAgent.has(agent)) defaultByAgent.set(agent, getGlobalDefault(agent));
  }

  const rows: ResourceRow[] = [];
  for (const name of allNames) {
    const centralConfig = centralServers.get(name);
    const manifestConfig = manifestEntries[name];
    const source: McpSource = centralConfig ? 'central' : manifestConfig ? 'manifest' : 'unmanaged';

    const targets: SyncTarget[] = [];
    let firstCommand: string | undefined;
    for (const { agent, version } of targetPairs) {
      const installed = installedByTarget.get(`${agent}@${version}`)![name];
      const status: SyncTarget['status'] = installed ? 'synced' : 'missing';
      if (installed && !firstCommand) firstCommand = installed.command || installed.url;
      targets.push({
        agent,
        version,
        isDefault: defaultByAgent.get(agent) === version,
        status,
      });
    }

    // Prefer the declared command/url from central or manifest over whatever
    // happened to land in some version's config.
    const declaredCommand = centralConfig
      ? formatCentralCommand(centralConfig)
      : manifestConfig?.command || manifestConfig?.url;
    const displayCommand = declaredCommand || firstCommand;

    rows.push({
      name,
      description: displayCommand ? truncateString(displayCommand, 60) : '',
      extra: source,
      targets,
      buildDetail: () => formatMcpDetail(name, source, centralConfig, manifestConfig, displayCommand, targets),
    });
  }

  rows.sort((a, b) => {
    const aSynced = a.targets.filter((t) => t.status === 'synced').length;
    const bSynced = b.targets.filter((t) => t.status === 'synced').length;
    if (aSynced !== bSynced) return bSynced - aSynced;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function formatCentralCommand(server: InstalledMcpServer): string {
  if (server.config.transport === 'http') return server.config.url || '';
  const cmd = server.config.command || '';
  const args = server.config.args?.join(' ') || '';
  return args ? `${cmd} ${args}` : cmd;
}

function formatMcpDetail(
  name: string,
  source: McpSource,
  centralConfig: InstalledMcpServer | undefined,
  manifestConfig: McpServerConfig | undefined,
  command: string | undefined,
  targets: SyncTarget[]
): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan(name));

  const tag =
    source === 'central' ? chalk.green('declared in ~/.agents/mcp/') :
    source === 'manifest' ? chalk.gray('declared in agents.yaml') :
    chalk.yellow('unmanaged (not in central or manifest)');
  lines.push('  ' + tag);
  lines.push('');

  if (centralConfig) {
    lines.push(`  transport: ${chalk.white(centralConfig.config.transport)}`);
    lines.push('  ' + chalk.gray(centralConfig.path));
  } else if (manifestConfig) {
    const transport = manifestConfig.transport || 'stdio';
    const scope = manifestConfig.scope || 'user';
    lines.push(`  transport: ${chalk.white(transport)}   scope: ${chalk.white(scope)}`);
  }

  if (command) {
    lines.push(`  ${chalk.gray('command:')} ${chalk.white(command)}`);
  }

  lines.push('');
  lines.push(chalk.bold('  Synced to'));
  lines.push(buildTargetsSection(targets));

  return lines.join('\n');
}

function truncateString(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
