import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  HOOKS_CAPABLE_AGENTS,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverHooksFromRepo,
  installHooksCentrally,
  listCentralHooks,
  listInstalledHooksWithScope,
  promoteHookToUser,
  removeHook,
} from '../lib/hooks.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import { isPromptCancelled } from './utils.js';

export function registerHooksCommands(program: Command): void {
  const hooksCmd = program.command('hooks').description('Manage agent hooks');

  hooksCmd
    .command('list')
    .description('List installed hooks')
    .option('-a, --agent <agent>', 'Filter by agent')
    .option('-s, --scope <scope>', 'Filter by scope: user, project, or all', 'all')
    .action(async (options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
      const cwd = process.cwd();

      const agents = options.agent
        ? [options.agent as AgentId]
        : (Array.from(HOOKS_CAPABLE_AGENTS) as AgentId[]);

      // Collect all data while spinner is active
      const agentHooks = agents.map((agentId) => ({
        agent: AGENTS[agentId],
        hooks: AGENTS[agentId].supportsHooks
          ? listInstalledHooksWithScope(agentId, cwd).filter(
              (h) => options.scope === 'all' || h.scope === options.scope
            )
          : null,
      }));

      spinner.stop();
      console.log(chalk.bold('Installed Hooks\n'));

      for (const { agent, hooks } of agentHooks) {
        if (hooks === null) {
          console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('hooks not supported')}`);
          console.log();
          continue;
        }

        if (hooks.length === 0) {
          console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agent.name)}:`);

          const userHooks = hooks.filter((h) => h.scope === 'user');
          const projectHooks = hooks.filter((h) => h.scope === 'project');

          if (userHooks.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
            console.log(`    ${chalk.gray('User:')}`);
            for (const hook of userHooks) {
              console.log(`      ${chalk.cyan(hook.name)}`);
            }
          }

          if (projectHooks.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
            console.log(`    ${chalk.gray('Project:')}`);
            for (const hook of projectHooks) {
              console.log(`      ${chalk.yellow(hook.name)}`);
            }
          }
        }
        console.log();
      }
    });

  hooksCmd
    .command('add <source>')
    .description('Install hooks from a repo or local path')
    .option('-a, --agents <list>', 'Comma-separated agents to install to')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(async (source: string, options) => {
      const spinner = ora('Fetching hooks...').start();

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

        const hooks = discoverHooksFromRepo(localPath);
        console.log(chalk.bold(`\nFound ${hooks.length} hook(s):`));

        if (hooks.length === 0) {
          console.log(chalk.yellow('No hooks found'));
          return;
        }

        for (const name of hooks) {
          console.log(`  ${chalk.cyan(name)}`);
        }

        // Get agent and version selection
        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        const hooksCapableAgents = Array.from(HOOKS_CAPABLE_AGENTS) as AgentId[];

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
          const result = await promptAgentVersionSelection(hooksCapableAgents, { skipPrompts: options.yes });
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        }

        if (selectedAgents.length === 0) {
          console.log(chalk.yellow('\nNo agents selected.'));
          return;
        }

        // Install hooks to central location
        const installSpinner = ora('Installing hooks to central storage...').start();
        const centralResult = await installHooksCentrally(localPath);

        if (centralResult.installed.length > 0) {
          installSpinner.succeed(`Installed ${centralResult.installed.length} hooks to ~/.agents/hooks/`);
        } else {
          installSpinner.info('No hooks to install');
        }

        if (centralResult.errors.length > 0) {
          console.log(chalk.red('\nErrors:'));
          for (const error of centralResult.errors) {
            console.log(chalk.red(`  ${error}`));
          }
        }

        // Sync to selected versions
        const syncSpinner = ora('Syncing to agent versions...').start();
        let synced = 0;

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'hooks', hooks);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nHooks installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        spinner.fail('Failed to add hooks');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  hooksCmd
    .command('remove [name]')
    .description('Remove a hook')
    .option('-a, --agents <list>', 'Comma-separated agents to remove from')
    .action(async (name?: string, options?: { agents?: string }) => {
      let hooksToRemove: string[];

      if (name) {
        hooksToRemove = [name];
      } else {
        // Interactive picker
        const centralHooks = listCentralHooks();
        if (centralHooks.length === 0) {
          console.log(chalk.yellow('No hooks installed.'));
          return;
        }

        try {
          const selected = await checkbox({
            message: 'Select hooks to remove',
            choices: centralHooks.map((hook) => ({
              value: hook.name,
              name: hook.name,
            })),
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No hooks selected.'));
            return;
          }

          hooksToRemove = selected;
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
        : (Array.from(HOOKS_CAPABLE_AGENTS) as AgentId[]);

      for (const hookName of hooksToRemove) {
        const result = await removeHook(hookName, agents);
        let removed = 0;
        for (const item of result.removed) {
          const [, agentId] = item.split(':') as [string, AgentId];
          console.log(`  ${chalk.red('-')} ${AGENTS[agentId].name}: ${hookName}`);
          removed++;
        }

        if (result.errors.length > 0) {
          for (const error of result.errors) {
            console.log(chalk.red(`  ${error}`));
          }
        }

        if (removed === 0) {
          console.log(chalk.yellow(`Hook '${hookName}' not found for any agent`));
        }
      }
    });

  hooksCmd
    .command('push <name>')
    .description('Promote a project hook to user scope')
    .option('-a, --agents <list>', 'Comma-separated agents to push for')
    .action((name: string, options) => {
      const cwd = process.cwd();
      const agents = options.agents
        ? (options.agents.split(',') as AgentId[])
        : (Array.from(HOOKS_CAPABLE_AGENTS) as AgentId[]);

      let pushed = 0;
      for (const agentId of agents) {
        const result = promoteHookToUser(agentId, name, cwd);
        if (result.success) {
          console.log(`  ${AGENTS[agentId].name}`);
          pushed++;
        } else if (result.error && !result.error.includes('not found')) {
          console.log(`  ${AGENTS[agentId].name}: ${result.error}`);
        }
      }

      if (pushed === 0) {
        console.log(chalk.yellow(`Project hook '${name}' not found for any agent`));
      } else {
        console.log(chalk.green(`\nPushed to user scope for ${pushed} agents.`));
      }
    });
}
