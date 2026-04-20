import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  ALL_AGENT_IDS,
  getAllCliStates,
  resolveAgentName,
  formatAgentError,
  agentLabel,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverCommands,
  resolveCommandSource,
  installCommandCentrally,
  uninstallCommand,
  listCentralCommands,
  listInstalledCommandsWithScope,
  getCommandInfo,
} from '../lib/commands.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  getVersionHomePath,
  resolveAgentVersionTargets,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import {
  isPromptCancelled,
  formatPath,
  isInteractiveTerminal,
  parseCommaSeparatedList,
  printWithPager,
  requireInteractiveSelection,
} from './utils.js';

export function registerCommandsCommands(program: Command): void {
  const commandsCmd = program
    .command('commands')
    .description('Extend agents with custom slash commands that ship behavior in markdown files')
    .addHelpText('after', `
Slash commands are markdown files that agents can invoke mid-session. They add capabilities without modifying the agent CLI itself — perfect for team workflows, project patterns, or personal shortcuts.

Examples:
  # See what commands are available
  agents commands list

  # Check commands installed for a specific version
  agents commands list claude@2.1.112

  # Install a command from GitHub to multiple agents
  agents commands add gh:anthropics/commands --agents claude,codex

  # Pick commands from ~/.agents/commands/ interactively
  agents commands add

  # Install specific commands by name
  agents commands add --names README,debug --agents codex@0.116.0

When to use:
  - Project setup: 'agents commands add gh:team/commands' to sync everyone's workflow
  - New version: 'agents commands add --agents claude@2.1.112' to carry commands forward
  - Custom tooling: write a command markdown file, test it, then share via 'agents commands add ~/my-cmd.md'
`);

  commandsCmd
    .command('list [agent]')
    .description('Show which slash commands are installed across agents or versions')
    .option('-a, --agent <agent>', 'Filter to a specific agent (alternative to positional arg)')
    .option('-s, --scope <scope>', 'user (global), project (repo), or all', 'all')
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

      // Helper to render commands for a specific version
      const renderVersionCommands = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string
      ) => {
        const agent = AGENTS[agentId];
        const commands = listInstalledCommandsWithScope(agentId, cwd, { home }).filter(
          (c) => options.scope === 'all' || c.scope === options.scope
        );

        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

        if (commands.length === 0) {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}:`);

          const userCommands = commands.filter((c) => c.scope === 'user');
          const projectCommands = commands.filter((c) => c.scope === 'project');

          if (userCommands.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
            console.log(`    ${chalk.gray('User:')}`);
            for (const cmd of userCommands) {
              console.log(`      ${chalk.cyan(cmd.name.padEnd(20))} ${chalk.gray(formatPath(cmd.path, cwd))}`);
            }
          }

          if (projectCommands.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
            console.log(`    ${chalk.gray('Project:')}`);
            for (const cmd of projectCommands) {
              console.log(`      ${chalk.yellow(cmd.name.padEnd(20))} ${chalk.gray(formatPath(cmd.path, cwd))}`);
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

        if (installedVersions.length === 0) {
          // Not version-managed, show from effective home
          console.log(chalk.bold(`Installed Commands for ${agentLabel(agent.id)}\n`));
          const commands = listInstalledCommandsWithScope(agentId, cwd).filter(
            (c) => options.scope === 'all' || c.scope === options.scope
          );
          if (commands.length === 0) {
            console.log(`  ${chalk.bold(agentLabel(agent.id))}: ${chalk.gray('none')}`);
          } else {
            console.log(`  ${chalk.bold(agentLabel(agent.id))}:`);
            const userCommands = commands.filter((c) => c.scope === 'user');
            if (userCommands.length > 0) {
              console.log(`    ${chalk.gray('User:')}`);
              for (const cmd of userCommands) {
                console.log(`      ${chalk.cyan(cmd.name.padEnd(20))} ${chalk.gray(formatPath(cmd.path, cwd))}`);
              }
            }
          }
          return;
        }

        console.log(chalk.bold(`Installed Commands for ${agentLabel(agent.id)}\n`));

        let versionsToShow: string[];
        if (requestedVersion === 'default') {
          if (!defaultVer) {
            console.log(chalk.yellow(`  No default version set for ${agentLabel(agent.id)}. Run: agents use ${agentId}@<version>`));
            return;
          }
          versionsToShow = [defaultVer];
        } else if (requestedVersion) {
          if (!installedVersions.includes(requestedVersion)) {
            console.log(chalk.red(`  Version ${requestedVersion} not installed for ${agentLabel(agent.id)}.`));
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
          renderVersionCommands(agentId, version, version === defaultVer, home);
        }
        return;
      }

      // No agent specified - show default version for each agent
      console.log(chalk.bold('Installed Commands\n'));

      for (const aid of ALL_AGENT_IDS) {
        const agent = AGENTS[aid];
        const installedVersions = listInstalledVersions(aid);
        const defaultVer = getGlobalDefault(aid);

        if (installedVersions.length > 0 && defaultVer) {
          const home = getVersionHomePath(aid, defaultVer);
          renderVersionCommands(aid, defaultVer, true, home);
        } else if (installedVersions.length > 0) {
          // Version managed but no default
          const commands = listInstalledCommandsWithScope(aid, cwd).filter(
            (c) => options.scope === 'all' || c.scope === options.scope
          );
          if (commands.length === 0) {
            console.log(`  ${chalk.bold(agentLabel(aid))}: ${chalk.gray('none')}`);
          } else {
            console.log(`  ${chalk.bold(agentLabel(aid))}:`);
            const userCommands = commands.filter((c) => c.scope === 'user');
            if (userCommands.length > 0) {
              console.log(`    ${chalk.gray('User:')}`);
              for (const cmd of userCommands) {
                console.log(`      ${chalk.cyan(cmd.name.padEnd(20))} ${chalk.gray(formatPath(cmd.path, cwd))}`);
              }
            }
          }
          console.log();
        }
      }
    });

  commandsCmd
    .command('add [source]')
    .description('Install commands from a source (GitHub, local) or pick from central storage')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0, or gemini@default')
    .option('--names <list>', 'Command names from ~/.agents/commands/ (comma-separated)')
    .option('-y, --yes', 'Skip all prompts')
    .addHelpText('after', `
Examples:
  # Interactive picker from ~/.agents/commands/
  agents commands add

  # Install specific commands to a single version
  agents commands add --names README,debug --agents codex@0.116.0

  # Pull commands from GitHub and sync to all installed agents
  agents commands add gh:user/repo --agents claude,codex,gemini

  # Add a local command directory
  agents commands add ~/my-commands --agents claude@default
`)
    .action(async (source: string | undefined, options) => {
      try {
        let commands: { name: string; description: string; sourcePath?: string }[];
        let fromCentral = false;

        if (!source) {
          // Interactive mode: pick from central storage
          const centralCommands = listCentralCommands();
          if (centralCommands.length === 0) {
            console.log(chalk.yellow('No commands in ~/.agents/commands/'));
            console.log(chalk.gray('\nTo add commands from a repo:'));
            console.log(chalk.cyan('  agents commands add gh:user/repo'));
            return;
          }

          const requestedNames = parseCommaSeparatedList(options.names);
          let selectedNames: string[];

          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !centralCommands.includes(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown command(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${centralCommands.join(', ')}`));
              process.exit(1);
            }
            selectedNames = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting commands from ~/.agents/commands/', [
                'agents commands add --names README,debug --agents codex',
                'agents commands add gh:user/repo --agents codex',
              ]);
            }

            // Build choices with descriptions
            const choices = centralCommands.map((name) => {
              const cmdPath = path.join(os.homedir(), '.agents', 'commands', `${name}.md`);
              let description = '';
              if (fs.existsSync(cmdPath)) {
                const content = fs.readFileSync(cmdPath, 'utf-8');
                const match = content.match(/description:\s*(.+)/i) || content.match(/description\s*=\s*"([^"]+)"/);
                if (match) description = match[1].trim();
              }
              return {
                value: name,
                name: description ? `${name}  ${chalk.gray(description.slice(0, 50))}` : name,
              };
            });

            const selected = await checkbox({
              message: 'Select commands to install',
              choices: [
                { value: '__all__', name: chalk.bold('Select All') },
                ...choices,
              ],
            });

            if (selected.length === 0) {
              console.log(chalk.gray('No commands selected.'));
              return;
            }

            selectedNames = selected.includes('__all__')
              ? centralCommands
              : selected.filter((s) => s !== '__all__');
          }

          commands = selectedNames.map((name) => ({ name, description: '' }));
          fromCentral = true;
        } else {
          // Source provided: fetch from repo or local path
          const spinner = ora('Fetching commands...').start();

          const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                            source.startsWith('ssh:') || source.startsWith('https://') ||
                            source.startsWith('http://');

          let localPath: string;
          if (isGitRepo) {
            const result = await cloneRepo(source);
            localPath = result.localPath;
            spinner.succeed('Repository cloned');
          } else {
            localPath = source.startsWith('~')
              ? path.join(os.homedir(), source.slice(1))
              : path.resolve(source);

            if (!fs.existsSync(localPath)) {
              spinner.fail(`Path not found: ${localPath}`);
              return;
            }
            spinner.succeed('Using local path');
          }

          const discovered = discoverCommands(localPath);
          console.log(chalk.bold(`\nFound ${discovered.length} command(s):`));

          if (discovered.length === 0) {
            console.log(chalk.yellow('No commands found'));
            return;
          }

          for (const command of discovered) {
            console.log(`\n  ${chalk.cyan(command.name)}: ${command.description}`);
          }

          commands = discovered;

          // Install to central storage first
          const installSpinner = ora('Installing commands to central storage...').start();
          let installed = 0;

          for (const command of discovered) {
            const sourcePath = resolveCommandSource(localPath, command.name);
            if (sourcePath) {
              const result = installCommandCentrally(sourcePath, command.name);
              if (result.error) {
                installSpinner.stop();
                console.log(chalk.yellow(`\n  Warning: ${command.name}: ${result.error}`));
                installSpinner.start();
              } else {
                installed++;
              }
            }
          }

          installSpinner.succeed(`Installed ${installed} commands to ~/.agents/commands/`);
        }

        // Get agent and version selection
        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        if (options.agents) {
          const result = resolveAgentVersionTargets(options.agents, ALL_AGENT_IDS);
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        } else {
          const result = await promptAgentVersionSelection(ALL_AGENT_IDS, {
            skipPrompts: options.yes || !isInteractiveTerminal(),
          });
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        }

        if (selectedAgents.length === 0) {
          console.log(chalk.yellow('\nNo agents selected.'));
          return;
        }

        // Sync to selected versions
        const syncSpinner = ora('Syncing to agent versions...').start();
        let synced = 0;
        const commandNames = commands.map((c) => c.name);

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'commands', commandNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nCommands installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add commands'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  commandsCmd
    .command('remove [name]')
    .description('Delete a command from agents (interactive picker if no name given)')
    .option('-a, --agents <list>', 'Limit removal to specific agents (e.g., claude,codex)')
    .addHelpText('after', `
Examples:
  # Remove a command by name
  agents commands remove README

  # Interactive: pick commands to remove
  agents commands remove
`)
    .action(async (name?: string, options?: { agents?: string }) => {
      let commandsToRemove: string[];

      if (name) {
        commandsToRemove = [name];
      } else {
        // Interactive picker
        const centralCommands = listCentralCommands();
        if (centralCommands.length === 0) {
          console.log(chalk.yellow('No commands installed.'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting commands to remove', [
            'agents commands remove README',
          ]);
        }

        try {
          const selected = await checkbox({
            message: 'Select commands to remove',
            choices: centralCommands.map((cmd) => ({
              value: cmd,
              name: cmd,
            })),
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No commands selected.'));
            return;
          }

          commandsToRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      const agents = options?.agents
        ? (options.agents.split(',') as AgentId[])
        : ALL_AGENT_IDS;

      for (const cmdName of commandsToRemove) {
        let removed = 0;
        for (const agentId of agents) {
          if (uninstallCommand(agentId, cmdName)) {
            console.log(`  ${chalk.red('-')} ${agentLabel(agentId)}: ${cmdName}`);
            removed++;
          }
        }

        if (removed === 0) {
          console.log(chalk.yellow(`Command '${cmdName}' not found for any agent`));
        }
      }
    });

  commandsCmd
    .command('view [name]')
    .description('Read the full content of a command file with markdown rendering')
    .addHelpText('after', `
Examples:
  # View a specific command
  agents commands view README

  # Interactive picker
  agents commands view
`)
    .action(async (name?: string) => {
      // If no name provided, show interactive select
      if (!name) {
        const centralCommands = listCentralCommands();
        if (centralCommands.length === 0) {
          console.log(chalk.yellow('No commands installed'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a command to view', [
            'agents commands view README',
          ]);
        }

        try {
          const { select } = await import('@inquirer/prompts');
          name = await select({
            message: 'Select a command to view',
            choices: centralCommands.map((cmd) => ({
              value: cmd,
              name: cmd,
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

      const command = getCommandInfo(name);
      if (!command) {
        console.log(chalk.yellow(`Command '${name}' not found`));
        return;
      }

      const { renderMarkdown } = await import('../lib/markdown.js');

      // Build header
      console.log(chalk.bold(`\n${command.name}`));
      if (command.description) {
        console.log(`${command.description}`);
      }
      console.log(chalk.gray(`Path: ${command.path}\n`));

      // Render markdown content
      if (command.content) {
        const rendered = renderMarkdown(command.content);
        const contentLines = command.content.split('\n');
        printWithPager(rendered, contentLines.length);
      }
    });
}
