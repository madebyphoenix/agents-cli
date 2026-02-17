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
  ensureGitignore,
  readMeta,
  updateMeta,
} from '../lib/state.js';
import type { AgentId } from '../lib/types.js';
import { DEFAULT_SYSTEM_REPO } from '../lib/types.js';
import {
  isGitRepo,
  cloneIntoExisting,
  pullRepo,
  parseSource,
  getGitHubUsername,
  checkGitHubRepoExists,
} from '../lib/git.js';
import {
  installVersion,
  listInstalledVersions,
  getGlobalDefault,
  setGlobalDefault,
  getBinaryPath,
  getVersionHomePath,
  syncResourcesToVersion,
} from '../lib/versions.js';
import {
  createShim,
  shimExists,
  isShimsInPath,
  addShimsToPath,
  getPathSetupInstructions,
  switchConfigSymlink,
} from '../lib/shims.js';
import { select } from '@inquirer/prompts';
import { isPromptCancelled } from './utils.js';

export function registerPullCommand(program: Command): void {
  program
    .command('pull [source] [agent]')
    .description('Sync config from a .agents repo')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .option('--skip-clis', 'Do not sync CLI versions')
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
      ensureGitignore();

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
        console.log(chalk.bold('\nSyncing resources to versions...\n'));

        const cliStates = await getAllCliStates();
        const agentsToSync = agentFilter ? [agentFilter] : ALL_AGENT_IDS;
        let synced = 0;

        for (const agentId of agentsToSync) {
          if (!cliStates[agentId]?.installed && listInstalledVersions(agentId).length === 0) continue;

          const versions = listInstalledVersions(agentId);
          // Sync to ALL installed versions, not just default
          const targetVersions = versions;

          for (const ver of targetVersions) {
            syncResourcesToVersion(agentId, ver);
            console.log(`  ${chalk.cyan(AGENTS[agentId].name)}@${ver}`);
            synced++;
          }
        }

        if (synced === 0) {
          console.log(chalk.gray('  No versions to sync'));
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

              setGlobalDefault(agentId, selectedVersion);
              const symlinkResult = await switchConfigSymlink(agentId, selectedVersion);
              if (!symlinkResult.success) {
                console.log(chalk.yellow(`Warning: ${symlinkResult.error}`));
              }
              console.log(chalk.green(`Set ${agent.name}@${selectedVersion} as default`));
            }
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
