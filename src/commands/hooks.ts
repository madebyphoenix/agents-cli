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
  resolveAgentName,
  formatAgentError,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverHooksFromRepo,
  installHooksCentrally,
  listCentralHooks,
  listInstalledHooksWithScope,
  removeHook,
  getHookInfo,
} from '../lib/hooks.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  getVersionHomePath,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import { isPromptCancelled } from './utils.js';

export function registerHooksCommands(program: Command): void {
  const hooksCmd = program.command('hooks').description('Manage agent hooks');

  hooksCmd
    .command('list [agent]')
    .description('List installed hooks. Use agent@version for specific version, agent@default for default only.')
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
          console.log(chalk.red(formatAgentError(agentName, [...HOOKS_CAPABLE_AGENTS])));
          process.exit(1);
        }
      }

      // Helper to render hooks for a specific version
      const renderVersionHooks = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string
      ) => {
        const agent = AGENTS[agentId];
        if (!agent.supportsHooks) {
          const defaultLabel = isDefault ? ' default' : '';
          console.log(`  ${chalk.bold(agent.name)} (${version}${defaultLabel}): ${chalk.gray('hooks not supported')}`);
          console.log();
          return;
        }

        const hooks = listInstalledHooksWithScope(agentId, cwd, { home }).filter(
          (h) => options.scope === 'all' || h.scope === options.scope
        );

        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

        if (hooks.length === 0) {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}:`);

          const userHooks = hooks.filter((h) => h.scope === 'user');
          const projectHooks = hooks.filter((h) => h.scope === 'project');

          if (userHooks.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
            console.log(`    ${chalk.gray('User:')}`);
            for (const hook of userHooks) {
              console.log(`      ${chalk.cyan(hook.name.padEnd(20))}`);
            }
          }

          if (projectHooks.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
            console.log(`    ${chalk.gray('Project:')}`);
            for (const hook of projectHooks) {
              console.log(`      ${chalk.yellow(hook.name.padEnd(20))}`);
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
          // Not version-managed
          console.log(chalk.bold(`Installed Hooks for ${agent.name}\n`));
          if (!agent.supportsHooks) {
            console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('hooks not supported')}`);
          } else {
            const hooks = listInstalledHooksWithScope(agentId, cwd).filter(
              (h) => options.scope === 'all' || h.scope === options.scope
            );
            if (hooks.length === 0) {
              console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
            } else {
              console.log(`  ${chalk.bold(agent.name)}:`);
              const userHooks = hooks.filter((h) => h.scope === 'user');
              if (userHooks.length > 0) {
                console.log(`    ${chalk.gray('User:')}`);
                for (const hook of userHooks) {
                  console.log(`      ${chalk.cyan(hook.name.padEnd(20))}`);
                }
              }
            }
          }
          return;
        }

        console.log(chalk.bold(`Installed Hooks for ${agent.name}\n`));

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
          renderVersionHooks(agentId, version, version === defaultVer, home);
        }
        return;
      }

      // No agent specified - show default version for each hooks-capable agent
      console.log(chalk.bold('Installed Hooks\n'));

      for (const aid of HOOKS_CAPABLE_AGENTS) {
        const agent = AGENTS[aid];
        const installedVersions = listInstalledVersions(aid);
        const defaultVer = getGlobalDefault(aid);

        if (installedVersions.length > 0 && defaultVer) {
          const home = getVersionHomePath(aid, defaultVer);
          renderVersionHooks(aid, defaultVer, true, home);
        } else {
          // Not version-managed or no default
          if (!agent.supportsHooks) {
            console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('hooks not supported')}`);
          } else {
            const hooks = listInstalledHooksWithScope(aid, cwd).filter(
              (h) => options.scope === 'all' || h.scope === options.scope
            );
            if (hooks.length === 0) {
              console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
            } else {
              console.log(`  ${chalk.bold(agent.name)}:`);
              const userHooks = hooks.filter((h) => h.scope === 'user');
              if (userHooks.length > 0) {
                console.log(`    ${chalk.gray('User:')}`);
                for (const hook of userHooks) {
                  console.log(`      ${chalk.cyan(hook.name.padEnd(20))}`);
                }
              }
            }
          }
          console.log();
        }
      }
    });

  hooksCmd
    .command('add [source]')
    .description('Install hooks from a repo or local path')
    .option('-a, --agents <list>', 'Comma-separated agents to install to')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(async (source: string | undefined, options) => {
      try {
        let hooks: string[];

        if (!source) {
          // Interactive mode: pick from central storage
          const centralHooks = listCentralHooks();
          if (centralHooks.length === 0) {
            console.log(chalk.yellow('No hooks in ~/.agents/hooks/'));
            console.log(chalk.gray('\nTo add hooks from a repo:'));
            console.log(chalk.cyan('  agents hooks add gh:user/repo'));
            return;
          }

          const choices = centralHooks.map((hook) => ({
            value: hook.name,
            name: hook.name,
          }));

          const selected = await checkbox({
            message: 'Select hooks to install',
            choices: [
              { value: '__all__', name: chalk.bold('Select All') },
              ...choices,
            ],
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No hooks selected.'));
            return;
          }

          hooks = selected.includes('__all__')
            ? centralHooks.map((h) => h.name)
            : selected.filter((s) => s !== '__all__');
        } else {
          // Source provided: fetch from repo or local path
          const spinner = ora('Fetching hooks...').start();

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

          hooks = discoverHooksFromRepo(localPath);
          console.log(chalk.bold(`\nFound ${hooks.length} hook(s):`));

          if (hooks.length === 0) {
            console.log(chalk.yellow('No hooks found'));
            return;
          }

          for (const name of hooks) {
            console.log(`  ${chalk.cyan(name)}`);
          }

          // Install to central storage first
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
        console.error(chalk.red('Failed to add hooks'));
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
    .command('view [name]')
    .description('Show hook details')
    .action(async (name?: string) => {
      const centralHooks = listCentralHooks();
      if (centralHooks.length === 0) {
        console.log(chalk.yellow('No hooks installed'));
        return;
      }

      // If no name provided, show interactive select
      if (!name) {
        try {
          const { select } = await import('@inquirer/prompts');
          name = await select({
            message: 'Select a hook to view',
            choices: centralHooks.map((hook) => ({
              value: hook.name,
              name: hook.name,
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

      const hook = getHookInfo(name);
      if (!hook) {
        console.log(chalk.yellow(`Hook '${name}' not found`));
        return;
      }

      // Build header
      console.log(chalk.bold(`\n${hook.name}`));
      console.log(chalk.gray(`Path: ${hook.path}\n`));

      // Show content (hooks are usually shell scripts, not markdown - just show with syntax highlighting placeholder)
      if (hook.content) {
        const contentLines = hook.content.split('\n');

        // For shell scripts, just display with line numbers
        const output = contentLines.map((line, i) => `  ${chalk.gray(String(i + 1).padStart(3))}  ${line}`).join('\n');

        // Pipe through less for scrolling if content is large
        if (contentLines.length > 40) {
          const { spawnSync } = await import('child_process');
          const less = spawnSync('less', ['-R'], {
            input: output,
            stdio: ['pipe', 'inherit', 'inherit'],
          });

          // Fallback to direct output if less fails
          if (less.status !== 0) {
            console.log(output);
          }
        } else {
          console.log(output);
        }
      }
    });
}
