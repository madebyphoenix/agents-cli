import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkbox, confirm } from '@inquirer/prompts';

import {
  AGENTS,
  HOOKS_CAPABLE_AGENTS,
  CODEX_HOOKS_MIN_VERSION,
  resolveAgentName,
  formatAgentError,
  agentLabel,
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
  parseHookManifest,
  diffVersionHooks,
  installHookToVersion,
  removeHookFromVersion,
  iterHooksCapableVersions,
} from '../lib/hooks.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  getVersionHomePath,
  resolveAgentVersionTargets,
  compareVersions,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  parseCommaSeparatedList,
  printWithPager,
  requireInteractiveSelection,
} from './utils.js';

export function registerHooksCommands(program: Command): void {
  const hooksCmd = program.command('hooks')
    .description('Automate workflows by running shell scripts in response to agent events')
    .addHelpText('after', `
Hooks are shell scripts that fire on agent events: when a session starts, when files are edited, when a task completes. Use them to trigger builds, sync logs, notify Slack, or integrate agents into existing tooling.

Examples:
  # List registered hooks
  agents hooks list

  # Check hooks for a specific agent
  agents hooks list claude@2.1.112

  # Install hooks from GitHub
  agents hooks add gh:team/hooks --agents claude,codex

  # Interactive: pick from ~/.agents/hooks/
  agents hooks add

  # Install a specific hook by name
  agents hooks add --names post-edit --agents claude

When to use:
  - CI integration: hook into pre-commit events to block unsafe operations
  - Logging: capture session transcripts with a post-session hook
  - Notifications: ping Slack when agents complete long tasks
  - Team workflows: sync hooks via 'agents hooks add gh:team/hooks'
`);

  hooksCmd
    .command('list [agent]')
    .description('Show which hooks are installed and which events they respond to')
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
          console.log(chalk.red(formatAgentError(agentName, [...HOOKS_CAPABLE_AGENTS])));
          process.exit(1);
        }
      }

      // Load hook manifest for event display
      const hookManifest = parseHookManifest();

      // Helper: get events for a hook name from manifest
      const getHookEvents = (hookName: string): string[] => {
        // Try exact match, then try without extension
        for (const [, def] of Object.entries(hookManifest)) {
          const scriptBase = def.script.replace(/\.[^.]+$/, '');
          if (def.script === hookName || scriptBase === hookName || hookName.replace(/\.[^.]+$/, '') === scriptBase) {
            return def.events || [];
          }
        }
        return [];
      };

      // Helper to render hooks for a specific version
      const renderVersionHooks = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string
      ) => {
        const agent = AGENTS[agentId];
        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

        if (!agent.supportsHooks) {
          console.log(`  ${chalk.bold(agentLabel(agent.id))} (${version}${defaultLabel}): ${chalk.gray('hooks not supported')}`);
          console.log();
          return;
        }

        // Version gate for Codex hooks
        if (agentId === 'codex' && compareVersions(version, CODEX_HOOKS_MIN_VERSION) < 0) {
          console.log(`  ${chalk.bold(agentLabel(agentId))}${versionStr}: ${chalk.gray(`unsupported (codex@${version} < ${CODEX_HOOKS_MIN_VERSION})`)}`);
          console.log();
          return;
        }

        const hooks = listInstalledHooksWithScope(agentId, cwd, { home }).filter(
          (h) => options.scope === 'all' || h.scope === options.scope
        );

        if (hooks.length === 0) {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}:`);

          const userHooks = hooks.filter((h) => h.scope === 'user');
          const projectHooks = hooks.filter((h) => h.scope === 'project');

          if (userHooks.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
            console.log(`    ${chalk.gray('User:')}`);
            for (const hook of userHooks) {
              const events = getHookEvents(hook.name);
              const eventStr = events.length > 0
                ? chalk.gray(` [${events.join(', ')}]`)
                : '';
              console.log(`      ${chalk.cyan(hook.name.padEnd(28))}${eventStr}`);
            }
          }

          if (projectHooks.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
            console.log(`    ${chalk.gray('Project:')}`);
            for (const hook of projectHooks) {
              const events = getHookEvents(hook.name);
              const eventStr = events.length > 0
                ? chalk.gray(` [${events.join(', ')}]`)
                : '';
              console.log(`      ${chalk.yellow(hook.name.padEnd(28))}${eventStr}`);
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
          console.log(chalk.bold(`Installed Hooks for ${agentLabel(agent.id)}\n`));
          if (!agent.supportsHooks) {
            console.log(`  ${chalk.bold(agentLabel(agent.id))}: ${chalk.gray('hooks not supported')}`);
          } else {
            const hooks = listInstalledHooksWithScope(agentId, cwd).filter(
              (h) => options.scope === 'all' || h.scope === options.scope
            );
            if (hooks.length === 0) {
              console.log(`  ${chalk.bold(agentLabel(agent.id))}: ${chalk.gray('none')}`);
            } else {
              console.log(`  ${chalk.bold(agentLabel(agent.id))}:`);
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

        console.log(chalk.bold(`Installed Hooks for ${agentLabel(agent.id)}\n`));

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
            console.log(`  ${chalk.bold(agentLabel(aid))}: ${chalk.gray('hooks not supported')}`);
          } else {
            const hooks = listInstalledHooksWithScope(aid, cwd).filter(
              (h) => options.scope === 'all' || h.scope === options.scope
            );
            if (hooks.length === 0) {
              console.log(`  ${chalk.bold(agentLabel(aid))}: ${chalk.gray('none')}`);
            } else {
              console.log(`  ${chalk.bold(agentLabel(aid))}:`);
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
    .description('Install hooks from a source (GitHub, local) or pick from central storage')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0, or gemini@default')
    .option('--names <list>', 'Hook names from ~/.agents/hooks/ (comma-separated)')
    .option('-y, --yes', 'Skip all prompts')
    .addHelpText('after', `
Examples:
  # Interactive picker from ~/.agents/hooks/
  agents hooks add

  # Install specific hooks by name
  agents hooks add --names post-edit --agents claude@2.1.112

  # Clone and install from GitHub
  agents hooks add gh:user/repo --agents claude,codex

  # Add from local directory
  agents hooks add ~/my-hooks --agents claude@default
`)
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

          const availableHooks = centralHooks.map((hook) => hook.name);
          const requestedNames = parseCommaSeparatedList(options.names);
          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !availableHooks.includes(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown hook(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${availableHooks.join(', ')}`));
              process.exit(1);
            }
            hooks = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting hooks from ~/.agents/hooks/', [
                'agents hooks add --names post-edit --agents claude',
                'agents hooks add gh:user/repo --agents claude',
              ]);
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
              ? availableHooks
              : selected.filter((s) => s !== '__all__');
          }
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
          const result = resolveAgentVersionTargets(options.agents, hooksCapableAgents);
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        } else {
          const result = await promptAgentVersionSelection(hooksCapableAgents, {
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
    .description('Delete a hook from agents (interactive picker if no name given)')
    .option('-a, --agents <list>', 'Limit removal to specific agents')
    .addHelpText('after', `
Examples:
  # Remove a hook by name
  agents hooks remove post-edit

  # Interactive picker
  agents hooks remove
`)
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

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting hooks to remove', [
            'agents hooks remove post-edit',
          ]);
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
          console.log(`  ${chalk.red('-')} ${agentLabel(agentId)}: ${hookName}`);
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
    .command('sync')
    .description('Reconcile version-home hook scripts against central ~/.agents/hooks/ (add + update, never delete)')
    .option('-a, --agent <agent>', 'Scope to a specific agent or agent@version')
    .addHelpText('after', `
Examples:
  # Sync every installed hooks-capable version
  agents hooks sync

  # Scope to one agent or version
  agents hooks sync --agent claude
  agents hooks sync --agent claude@2.1.113

Sync reconciles the hook script files in each version home against the central
source of truth in ~/.agents/hooks/. It does NOT touch settings.json
registrations — those point at central paths and are managed on install.

Sync is additive: to remove orphan scripts, use 'agents hooks prune'.
`)
    .action(async (options) => {
      let filter: { agent?: AgentId; version?: string } | undefined;
      if (options.agent) {
        const [name, version] = String(options.agent).split('@');
        const agentId = resolveAgentName(name);
        if (!agentId) {
          console.log(chalk.red(formatAgentError(name, HOOKS_CAPABLE_AGENTS as unknown as AgentId[])));
          process.exit(1);
        }
        filter = { agent: agentId, version: version || undefined };
      }

      const pairs = iterHooksCapableVersions(filter);
      if (pairs.length === 0) {
        console.log(chalk.gray('No matching installed versions.'));
        return;
      }

      const diffs = pairs.map(({ agent, version }) => diffVersionHooks(agent, version));
      const plan = diffs.filter((d) => d.toAdd.length > 0 || d.toUpdate.length > 0);

      if (plan.length === 0) {
        console.log(chalk.green('All version homes are up to date with central.'));
        if (diffs.some((d) => d.orphans.length > 0)) {
          console.log(chalk.gray('Orphan hooks present. Run \'agents hooks prune --dry-run\' to review.'));
        }
        return;
      }

      console.log(chalk.bold('Syncing hooks\n'));
      let adds = 0, updates = 0, failures = 0;
      for (const diff of plan) {
        const label = `${diff.agent}@${diff.version}`;
        if (diff.toAdd.length > 0) {
          console.log(`  ${chalk.cyan(label)} ${chalk.gray('add:')} ${diff.toAdd.join(', ')}`);
          for (const name of diff.toAdd) {
            const r = installHookToVersion(diff.agent, diff.version, name);
            if (r.success) adds++;
            else { failures++; console.log(chalk.red(`    ! ${name}: ${r.error}`)); }
          }
        }
        if (diff.toUpdate.length > 0) {
          console.log(`  ${chalk.cyan(label)} ${chalk.gray('update:')} ${diff.toUpdate.join(', ')}`);
          for (const name of diff.toUpdate) {
            const r = installHookToVersion(diff.agent, diff.version, name);
            if (r.success) updates++;
            else { failures++; console.log(chalk.red(`    ! ${name}: ${r.error}`)); }
          }
        }
      }

      console.log();
      console.log(chalk.green(`Synced: ${adds} added, ${updates} updated${failures > 0 ? chalk.red(`, ${failures} failed`) : ''}.`));

      const totalOrphans = diffs.reduce((n, d) => n + d.orphans.length, 0);
      if (totalOrphans > 0) {
        console.log(chalk.gray(`${totalOrphans} orphan(s) remain. Run 'agents hooks prune --dry-run' to review.`));
      }
    });

  hooksCmd
    .command('prune')
    .description('Remove orphan hook scripts from version homes (scripts present locally but not in central)')
    .option('-a, --agent <agent>', 'Scope to a specific agent or agent@version')
    .option('--dry-run', 'Show orphans without deleting')
    .option('-y, --yes', 'Skip confirmation prompt')
    .addHelpText('after', `
Examples:
  # See what would be pruned
  agents hooks prune --dry-run

  # Prune across every installed version (prompts for confirmation)
  agents hooks prune

  # Scope to one agent or version
  agents hooks prune --agent claude@2.1.80

  # Skip confirmation (for scripts)
  agents hooks prune -y

Prune removes hook SCRIPT FILES from version homes. It does not edit
settings.json registrations — those are keyed off central paths and remain
consistent as long as central ~/.agents/hooks/ and ~/.agents/hooks.yaml are
the source of truth.
`)
    .action(async (options) => {
      let filter: { agent?: AgentId; version?: string } | undefined;
      if (options.agent) {
        const [name, version] = String(options.agent).split('@');
        const agentId = resolveAgentName(name);
        if (!agentId) {
          console.log(chalk.red(formatAgentError(name, HOOKS_CAPABLE_AGENTS as unknown as AgentId[])));
          process.exit(1);
        }
        filter = { agent: agentId, version: version || undefined };
      }

      const pairs = iterHooksCapableVersions(filter);
      const diffs = pairs
        .map(({ agent, version }) => diffVersionHooks(agent, version))
        .filter((d) => d.orphans.length > 0);

      if (diffs.length === 0) {
        console.log(chalk.green('No orphan hooks.'));
        return;
      }

      const total = diffs.reduce((n, d) => n + d.orphans.length, 0);
      console.log(chalk.bold(`Orphans (in version home, not in central)\n`));
      for (const d of diffs) {
        console.log(`  ${chalk.cyan(`${d.agent}@${d.version}`)}  ${d.orphans.join(', ')}`);
      }
      console.log();

      if (options.dryRun) {
        console.log(chalk.gray(`${total} orphan(s). Run without --dry-run to delete.`));
        return;
      }

      if (!options.yes) {
        if (!isInteractiveTerminal()) {
          console.log(chalk.yellow('Non-interactive shell: pass -y to confirm, or --dry-run to preview.'));
          process.exit(1);
        }
        let ok = false;
        try {
          ok = await confirm({
            message: `Delete ${total} orphan hook${total === 1 ? '' : 's'}?`,
            default: false,
          });
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
        if (!ok) {
          console.log(chalk.gray('Cancelled'));
          return;
        }
      }

      let removed = 0, failures = 0;
      for (const d of diffs) {
        for (const name of d.orphans) {
          const r = removeHookFromVersion(d.agent, d.version, name);
          if (r.success) removed++;
          else { failures++; console.log(chalk.red(`  ! ${d.agent}@${d.version} ${name}: ${r.error}`)); }
        }
      }

      console.log(chalk.green(`Pruned ${removed} orphan(s)${failures > 0 ? chalk.red(`, ${failures} failed`) : ''}.`));
    });

  hooksCmd
    .command('view [name]')
    .description('Read the shell script content for a hook')
    .addHelpText('after', `
Examples:
  # View a specific hook
  agents hooks view post-edit

  # Interactive picker
  agents hooks view
`)
    .action(async (name?: string) => {
      const centralHooks = listCentralHooks();
      if (centralHooks.length === 0) {
        console.log(chalk.yellow('No hooks installed'));
        return;
      }

      // If no name provided, show interactive select
      if (!name) {
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a hook to view', [
            'agents hooks view post-edit',
          ]);
        }
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
        printWithPager(output, contentLines.length);
      }
    });
}
