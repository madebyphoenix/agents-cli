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
  promoteCommandToUser,
} from '../lib/commands.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import { isPromptCancelled, formatPath } from './utils.js';

export function registerCommandsCommands(program: Command): void {
  const commandsCmd = program
    .command('commands')
    .description('Manage slash commands');

  commandsCmd
    .command('list [agent]')
    .description('List installed commands')
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
        agents = ALL_AGENT_IDS;
      }
      // Collect all data while spinner is active
      const agentCommands = agents.map((agentId) => ({
        agent: AGENTS[agentId],
        commands: listInstalledCommandsWithScope(agentId, cwd).filter(
          (c) => options.scope === 'all' || c.scope === options.scope
        ),
      }));

      spinner.stop();
      console.log(chalk.bold('Installed Commands\n'));

      for (const { agent, commands } of agentCommands) {
        if (commands.length === 0) {
          console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agent.name)}:`);

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
      }
    });

  commandsCmd
    .command('add <source>')
    .description('Install commands from a repo or local path')
    .option('-a, --agents <list>', 'Comma-separated agents to install to')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(async (source: string, options) => {
      const spinner = ora('Fetching commands...').start();

      try {
        // Detect if source is a git repo (gh:, git:, ssh:, https://, http://)
        const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                          source.startsWith('ssh:') || source.startsWith('https://') ||
                          source.startsWith('http://');

        let localPath: string;
        if (isGitRepo) {
          const result = await cloneRepo(source);
          localPath = result.localPath;
          spinner.succeed('Repository cloned');
        } else {
          // It's a local path - expand ~ to home directory
          localPath = source.startsWith('~')
            ? path.join(os.homedir(), source.slice(1))
            : path.resolve(source);

          if (!fs.existsSync(localPath)) {
            spinner.fail(`Path not found: ${localPath}`);
            return;
          }
          spinner.succeed('Using local path');
        }

        const commands = discoverCommands(localPath);
        console.log(chalk.bold(`\nFound ${commands.length} command(s):`));

        if (commands.length === 0) {
          console.log(chalk.yellow('No commands found'));
          return;
        }

        for (const command of commands) {
          console.log(`\n  ${chalk.cyan(command.name)}: ${command.description}`);
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

        // Install commands to central location
        const installSpinner = ora('Installing commands to central storage...').start();
        let installed = 0;

        for (const command of commands) {
          // Find source path
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
        spinner.fail('Failed to add commands');
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
            console.log(`  ${chalk.red('-')} ${AGENTS[agentId].name}: ${cmdName}`);
            removed++;
          }
        }

        if (removed === 0) {
          console.log(chalk.yellow(`Command '${cmdName}' not found for any agent`));
        }
      }
    });

  commandsCmd
    .command('push <name>')
    .description('Promote a project command to user scope')
    .option('-a, --agents <list>', 'Comma-separated agents to push for')
    .action(async (name: string, options) => {
      const cwd = process.cwd();
      const agents = options.agents
        ? (options.agents.split(',') as AgentId[])
        : ALL_AGENT_IDS;

      const cliStates = await getAllCliStates();
      let pushed = 0;
      for (const agentId of agents) {
        if (!cliStates[agentId]?.installed && agentId !== 'cursor') continue;

        const result = promoteCommandToUser(agentId, name, cwd);
        if (result.success) {
          console.log(`  ${chalk.green('+')} ${AGENTS[agentId].name}`);
          pushed++;
        } else if (result.error && !result.error.includes('not found')) {
          console.log(`  ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
        }
      }

      if (pushed === 0) {
        console.log(chalk.yellow(`Project command '${name}' not found for any agent`));
      } else {
        console.log(chalk.green(`\nPushed to user scope for ${pushed} agents.`));
      }
    });
}
