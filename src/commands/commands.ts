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
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import { isPromptCancelled, formatPath } from './utils.js';

export function registerCommandsCommands(program: Command): void {
  const commandsCmd = program
    .command('commands')
    .description('Manage slash commands');

  commandsCmd
    .command('list [agent]')
    .description('List installed commands. Use agent@version for specific version, agent@default for default only.')
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
    .description('Install commands from a repo or local path')
    .option('-a, --agents <list>', 'Comma-separated agents to install to')
    .option('-y, --yes', 'Skip prompts and use defaults')
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

          const selectedNames = selected.includes('__all__')
            ? centralCommands
            : selected.filter((s) => s !== '__all__');

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
          selectedAgents = options.agents.split(',') as AgentId[];
          versionSelections = new Map();
          for (const agentId of selectedAgents) {
            const versions = listInstalledVersions(agentId);
            if (versions.length > 0) {
              const defaultVer = getGlobalDefault(agentId);
              versionSelections.set(agentId, defaultVer ? [defaultVer] : [versions[versions.length - 1]]);
            }
          }
        } else {
          const result = await promptAgentVersionSelection(ALL_AGENT_IDS, { skipPrompts: options.yes });
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
    .description('Remove a command')
    .option('-a, --agents <list>', 'Comma-separated agents to remove from')
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
    .description('Show command details')
    .action(async (name?: string) => {
      // If no name provided, show interactive select
      if (!name) {
        const centralCommands = listCentralCommands();
        if (centralCommands.length === 0) {
          console.log(chalk.yellow('No commands installed'));
          return;
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

        // Pipe through less for scrolling if content is large
        if (contentLines.length > 40) {
          const { spawnSync } = await import('child_process');
          const less = spawnSync('less', ['-R'], {
            input: rendered,
            stdio: ['pipe', 'inherit', 'inherit'],
          });

          // Fallback to direct output if less fails
          if (less.status !== 0) {
            console.log(rendered);
          }
        } else {
          console.log(rendered);
        }
      }
    });
}
