import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { checkbox, confirm } from '@inquirer/prompts';

import {
  AGENTS,
  ALL_AGENT_IDS,
  MCP_CAPABLE_AGENTS,
  getAllCliStates,
  registerMcp,
  getAccountEmail,
  isAgentName,
  resolveAgentName,
} from '../lib/agents.js';
import {
  readManifest,
  MANIFEST_FILENAME,
} from '../lib/manifest.js';
import {
  getAgentsDir,
  ensureAgentsDir,
  readMeta,
  updateMeta,
} from '../lib/state.js';
import type { AgentId } from '../lib/types.js';
import { DEFAULT_SYSTEM_REPO } from '../lib/types.js';
import {
  isGitRepo,
  cloneIntoExisting,
  pullRepo,
  pullFromUpstream,
  parseSource,
  getGitHubUsername,
  checkGitHubRepoExists,
  hasUpstreamRemote,
} from '../lib/git.js';
import {
  installVersion,
  listInstalledVersions,
  getGlobalDefault,
  setGlobalDefault,
  getBinaryPath,
  getVersionHomePath,
  syncResourcesToVersion,
  getResourceDiff,
  type ResourceDiff,
} from '../lib/versions.js';
import {
  createShim,
  shimExists,
  isShimsInPath,
  addShimsToPath,
  getPathSetupInstructions,
  switchConfigSymlink,
} from '../lib/shims.js';
import { parseHookManifest, registerHooksToSettings } from '../lib/hooks.js';
import { select } from '@inquirer/prompts';
import { isPromptCancelled } from './utils.js';

export function registerPullCommand(program: Command): void {
  program
    .command('pull [source] [agent]')
    .description('Sync config from a .agents repo')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .option('--skip-clis', 'Do not sync CLI versions')
    .option('--upstream', 'Pull from upstream (system repo) instead of origin')
    .action(async (arg1: string | undefined, arg2: string | undefined, options) => {
      // Parse source and agent filter from positional args
      let targetSource: string | undefined;
      let agentFilter: AgentId | undefined;

      if (arg1) {
        if (isAgentName(arg1)) {
          // agents pull claude
          agentFilter = resolveAgentName(arg1)!;
        } else {
          // agents pull gh:user/repo [agent]
          targetSource = arg1;
          if (arg2 && isAgentName(arg2)) {
            agentFilter = resolveAgentName(arg2)!;
          }
        }
      }

      const agentsDir = getAgentsDir();
      ensureAgentsDir();

      // Handle --upstream: pull from upstream remote
      if (options.upstream) {
        if (!isGitRepo(agentsDir)) {
          console.log(chalk.red('~/.agents/ is not a git repository.'));
          console.log(chalk.gray('\nInitialize first: agents pull'));
          return;
        }

        if (!await hasUpstreamRemote(agentsDir)) {
          console.log(chalk.red('No upstream remote configured.'));
          console.log(chalk.gray('\nIf you forked from the system repo, run: agents fork'));
          console.log(chalk.gray('This will set up the upstream remote automatically.'));
          return;
        }

        const spinner = ora('Pulling from upstream...').start();
        const result = await pullFromUpstream(agentsDir);
        if (!result.success) {
          spinner.fail(`Failed: ${result.error}`);
          return;
        }
        spinner.succeed(`Merged upstream changes (${result.commit})`);

        // Continue with the rest of the sync (CLI versions, MCP, resources)
        // Skip the source determination since we already pulled
        targetSource = 'existing';
      }

      // Determine source
      const meta = readMeta();
      if (!targetSource) {
        // Check if ~/.agents/ is already a git repo
        if (isGitRepo(agentsDir)) {
          targetSource = 'existing';
        } else {
          // Try to infer from GitHub username
          const spinner = ora('Checking GitHub...').start();
          const username = await getGitHubUsername();

          if (username) {
            const repoExists = await checkGitHubRepoExists(username, '.agents');
            if (repoExists) {
              targetSource = `gh:${username}/.agents`;
              spinner.succeed(`Found ${username}/.agents`);
            } else {
              spinner.info(`No .agents repo found for ${username}`);
              console.log(chalk.gray('\nTo create one:'));
              console.log(chalk.cyan('  gh repo create .agents --public'));
              console.log(chalk.gray('\nThen run: agents pull'));
              return;
            }
          } else {
            // Fall back to system default repo
            targetSource = DEFAULT_SYSTEM_REPO;
            spinner.info(`Using default: ${DEFAULT_SYSTEM_REPO}`);
          }
        }
      }

      const spinner = ora('Syncing...').start();

      try {
        let commit: string;

        if (targetSource === 'existing') {
          // Just pull updates
          spinner.text = 'Pulling updates...';
          const result = await pullRepo(agentsDir);
          if (!result.success) {
            spinner.fail(`Pull failed: ${result.error}`);
            return;
          }
          commit = result.commit;
          spinner.succeed(`Updated to ${commit}`);
        } else {
          // Clone or update
          const parsed = parseSource(targetSource);

          if (isGitRepo(agentsDir)) {
            // Already a repo, just pull
            spinner.text = 'Pulling updates...';
            const result = await pullRepo(agentsDir);
            if (!result.success) {
              spinner.fail(`Pull failed: ${result.error}`);
              return;
            }
            commit = result.commit;
            spinner.succeed(`Updated to ${commit}`);
          } else {
            // Clone into existing ~/.agents/
            spinner.text = `Cloning ${targetSource}...`;
            const result = await cloneIntoExisting(targetSource, agentsDir);
            if (!result.success) {
              spinner.fail(`Clone failed: ${result.error}`);
              return;
            }
            commit = result.commit;
            spinner.succeed(`Initialized from ${targetSource}`);
          }

          // Save source to meta
          updateMeta({
            source: parsed.url,
          });
        }

        // Read manifest for CLI versions and MCP config
        const manifest = readManifest(agentsDir);
        if (!manifest) {
          console.log(chalk.gray(`\nNo ${MANIFEST_FILENAME} found`));
        }

        // Install/upgrade CLI versions
        if (!options.skipClis && manifest?.agents) {
          console.log(chalk.bold('\nCLI Versions:\n'));

          const cliAgents = Object.keys(manifest.agents) as AgentId[];
          for (const agentId of cliAgents) {
            if (agentFilter && agentId !== agentFilter) continue;
            const agent = AGENTS[agentId];
            if (!agent) continue;

            const cliSpinner = ora(`Checking ${agent.name}...`).start();
            const versions = listInstalledVersions(agentId);
            const targetVersion = manifest.agents[agentId] || 'latest';

            const result = await installVersion(agentId, targetVersion, (msg) => { cliSpinner.text = msg; });
            if (result.success) {
              const isNew = versions.length === 0;
              if (isNew) {
                cliSpinner.succeed(`Installed ${agent.name}@${result.installedVersion}`);
              } else {
                cliSpinner.succeed(`${agent.name}@${result.installedVersion}`);
              }
              // Ensure shim exists (repair if deleted)
              if (!shimExists(agentId)) {
                createShim(agentId);
              }
            } else {
              cliSpinner.warn(`${agent.name}: ${result.error}`);
            }
          }
        }

        // Register MCP servers
        if (manifest?.mcp && Object.keys(manifest.mcp).length > 0) {
          console.log(chalk.bold('\nMCP Servers:\n'));

          const cliStates = await getAllCliStates();
          for (const [name, config] of Object.entries(manifest.mcp)) {
            if (!config.command || config.transport === 'http') continue;

            const mcpAgents = (config.agents || MCP_CAPABLE_AGENTS).filter(
              (id) => (!agentFilter || id === agentFilter) && cliStates[id]?.installed
            );

            for (const agentId of mcpAgents) {
              const versions = listInstalledVersions(agentId);
              const defaultVer = getGlobalDefault(agentId);
              const targetVersions = defaultVer ? [defaultVer] : versions.slice(-1);

              for (const ver of targetVersions) {
                const home = getVersionHomePath(agentId, ver);
                const binary = getBinaryPath(agentId, ver);
                const result = await registerMcp(
                  agentId, name, config.command, config.scope || 'user',
                  config.transport || 'stdio', { home, binary }
                );
                if (result.success) {
                  console.log(`  ${chalk.green('+')} ${name} -> ${AGENTS[agentId].name}@${ver}`);
                }
              }
            }
          }
        }

        // Sync resources to version homes
        const cliStates = await getAllCliStates();
        const agentsToSync = agentFilter ? [agentFilter] : ALL_AGENT_IDS;

        // Collect versions with their diffs
        const versionDiffs: {
          agentId: AgentId;
          version: string;
          label: string;
          diff: ResourceDiff;
        }[] = [];

        for (const agentId of agentsToSync) {
          if (!cliStates[agentId]?.installed && listInstalledVersions(agentId).length === 0) continue;
          const versions = listInstalledVersions(agentId);
          const defaultVer = getGlobalDefault(agentId);

          for (const ver of versions) {
            const isDefault = ver === defaultVer;
            const diff = getResourceDiff(agentId, ver);
            versionDiffs.push({
              agentId,
              version: ver,
              label: `${AGENTS[agentId].name}@${ver}${isDefault ? ' (default)' : ''}`,
              diff,
            });
          }
        }

        if (versionDiffs.length === 0) {
          console.log(chalk.gray('\nNo versions to sync'));
        } else {
          // Check if there are any changes
          const hasAnyChanges = versionDiffs.some(v => v.diff.totalAdded > 0 || v.diff.totalDangling > 0);

          if (!hasAnyChanges) {
            console.log(chalk.gray('\nNo resource changes to sync'));
          } else {
            // Show diffs per version
            console.log(chalk.bold('\nResource changes:\n'));

            for (const { label, diff } of versionDiffs) {
              if (diff.totalAdded === 0 && diff.totalDangling === 0) {
                console.log(`  ${chalk.gray(label)}: ${chalk.gray('(no changes)')}`);
                continue;
              }

              console.log(`  ${chalk.cyan(label)}:`);

              // Show added items
              const showAdded = (type: string, items: string[]) => {
                for (const item of items.slice(0, 5)) {
                  console.log(`    ${chalk.green('+')} ${type}/${item}`);
                }
                if (items.length > 5) {
                  console.log(chalk.gray(`    ... and ${items.length - 5} more`));
                }
              };

              if (diff.commands.added.length > 0) showAdded('commands', diff.commands.added);
              if (diff.skills.added.length > 0) showAdded('skills', diff.skills.added);
              if (diff.hooks.added.length > 0) showAdded('hooks', diff.hooks.added);
              if (diff.memory.added.length > 0) showAdded('memory', diff.memory.added);

              // Show dangling
              const showDangling = (items: string[]) => {
                for (const item of items) {
                  console.log(`    ${chalk.red('-')} ${item} ${chalk.gray('(dangling)')}`);
                }
              };

              if (diff.commands.dangling.length > 0) showDangling(diff.commands.dangling);
              if (diff.skills.dangling.length > 0) showDangling(diff.skills.dangling);
              if (diff.hooks.dangling.length > 0) showDangling(diff.hooks.dangling);
              if (diff.memory.dangling.length > 0) showDangling(diff.memory.dangling);

              console.log();
            }

            // Filter to versions with changes
            const versionsWithChanges = versionDiffs.filter(v => v.diff.totalAdded > 0 || v.diff.totalDangling > 0);
            let versionsToSync = versionsWithChanges;

            // Interactive version selection (unless -y flag)
            if (!options.yes && versionsWithChanges.length > 1) {
              const selected = await checkbox({
                message: 'Select versions to sync:',
                choices: versionsWithChanges.map((v) => ({
                  name: `${v.label} ${chalk.gray(`(${v.diff.totalAdded} new${v.diff.totalDangling > 0 ? `, ${v.diff.totalDangling} dangling` : ''})`)}`,
                  value: v,
                  checked: true,
                })),
              });
              versionsToSync = selected;
            }

            if (versionsToSync.length === 0) {
              console.log(chalk.yellow('No versions selected'));
            } else {
              console.log(chalk.bold('Syncing...\n'));
              for (const { agentId, version, label, diff } of versionsToSync) {
                syncResourcesToVersion(agentId, version);
                const summary = [];
                if (diff.totalAdded > 0) summary.push(`${diff.totalAdded} added`);
                if (diff.totalDangling > 0) summary.push(`${diff.totalDangling} removed`);
                console.log(`  ${chalk.green('✓')} ${label} ${chalk.gray(`(${summary.join(', ')})`)}`);
              }
            }
          }
        }

        // Register hooks as lifecycle events in settings.json
        const hookManifest = parseHookManifest();
        if (Object.keys(hookManifest).length > 0) {
          let hookRegistered = 0;
          for (const agentId of agentsToSync) {
            if (agentId !== 'claude') continue;
            const versions = listInstalledVersions(agentId);
            const defaultVer = getGlobalDefault(agentId);
            const targetVersions = defaultVer ? [defaultVer] : versions.slice(-1);

            for (const ver of targetVersions) {
              const home = getVersionHomePath(agentId, ver);
              const result = registerHooksToSettings(agentId, home, hookManifest);
              hookRegistered += result.registered.length;
              for (const error of result.errors) {
                console.log(chalk.yellow(`  Hook warning: ${error}`));
              }
            }
          }
          if (hookRegistered > 0) {
            console.log(chalk.green(`\nRegistered ${hookRegistered} hook lifecycle event(s)`));
          }
        }

        // Auto-add shims to PATH if not already there
        if (!isShimsInPath()) {
          const pathResult = addShimsToPath();
          if (pathResult.success && !pathResult.alreadyPresent) {
            console.log(chalk.green(`\nAdded shims to ~/${pathResult.rcFile}`));
            console.log(chalk.gray('Restart your shell or run: source ~/' + pathResult.rcFile));
          } else if (!pathResult.success) {
            console.log(chalk.yellow('\nCould not auto-add shims to PATH:'));
            console.log(chalk.gray(getPathSetupInstructions()));
          }
        }

        // Check for agents without a default version - offer to switch
        if (!options.yes) {
          const agentsNeedingDefault: AgentId[] = [];
          for (const agentId of agentsToSync) {
            const versions = listInstalledVersions(agentId);
            if (versions.length > 0 && !getGlobalDefault(agentId)) {
              agentsNeedingDefault.push(agentId);
            }
          }

          // Phase 1: Collect all version selections first
          const selectedVersions: Array<{ agentId: AgentId; version: string }> = [];

          for (const agentId of agentsNeedingDefault) {
            const versions = listInstalledVersions(agentId);
            const agent = AGENTS[agentId];

            const shouldSwitch = await select({
              message: `${agent.name} has no default version. Set one now?`,
              choices: [
                { name: 'Yes, pick a version', value: 'pick' },
                { name: 'Skip for now', value: 'skip' },
              ],
            });

            if (shouldSwitch === 'pick') {
              const selectedVersion = await select({
                message: `Select ${agent.name} version:`,
                choices: versions.map((v) => ({ name: v, value: v })),
              });

              selectedVersions.push({ agentId, version: selectedVersion });
            }
          }

          // Apply migrations for all selected versions
          for (const { agentId, version } of selectedVersions) {
            const agent = AGENTS[agentId];
            setGlobalDefault(agentId, version);
            const symlinkResult = await switchConfigSymlink(agentId, version);
            if (!symlinkResult.success) {
              console.log(chalk.yellow(`Warning: ${symlinkResult.error}`));
            } else if (symlinkResult.backupPath) {
              console.log(chalk.gray(`Backed up existing config to: ${symlinkResult.backupPath}`));
            }
            console.log(chalk.green(`Set ${agent.name}@${version} as default`));
          }
        }

        console.log(chalk.green('\nPull complete'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          spinner.stop();
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        spinner.fail('Failed to sync');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
