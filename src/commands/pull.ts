import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  AGENTS,
  ALL_AGENT_IDS,
  MCP_CAPABLE_AGENTS,
  getAllCliStates,
  registerMcpToTargets,
  getAccountEmail,
  isAgentName,
  resolveAgentName,
  agentLabel,
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
import { DEFAULT_SYSTEM_REPO, LEGACY_SYSTEM_REPO, systemRepoSlug } from '../lib/types.js';
import {
  isGitRepo,
  cloneIntoExisting,
  pullRepo,
  pullFromUpstream,
  parseSource,
  getGitHubUsername,
  checkGitHubRepoExists,
  hasUpstreamRemote,
  getUpstreamUrl,
} from '../lib/git.js';
import * as fs from 'fs';
import * as path from 'path';
import {
  installVersion,
  listInstalledVersions,
  getGlobalDefault,
  setGlobalDefault,
  getVersionHomePath,
  syncResourcesToVersion,
  getAvailableResources,
  getActuallySyncedResources,
  getNewResources,
  hasNewResources,
  promptNewResourceSelection,
  promptResourceSelection,
  resolveConfiguredAgentTargets,
  type ResourceSelection,
} from '../lib/versions.js';
import {
  ensureShimCurrent,
  isShimsInPath,
  addShimsToPath,
  getPathSetupInstructions,
  switchConfigSymlink,
  switchHomeFileSymlinks,
} from '../lib/shims.js';
import { parseHookManifest, registerHooksToSettings } from '../lib/hooks.js';
import { select } from '@inquirer/prompts';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

/**
 * Old repo layout stored promptcuts under claude/promptcuts.yaml (agent-scoped).
 * The new layout is ~/.agents/promptcuts.yaml at the repo root — the hook
 * reads from a fixed path so it survives version upgrades. If the root file
 * doesn't exist yet but an agent-scoped one does, hoist the first one found.
 */
function migratePromptcutsToRoot(agentsDir: string): void {
  const rootPath = path.join(agentsDir, 'promptcuts.yaml');
  if (fs.existsSync(rootPath)) return;

  const agentDirs = ['claude', 'codex', 'cursor', 'gemini', 'opencode'];
  for (const dir of agentDirs) {
    const legacyPath = path.join(agentsDir, dir, 'promptcuts.yaml');
    if (fs.existsSync(legacyPath)) {
      try {
        fs.renameSync(legacyPath, rootPath);
        console.log(chalk.gray(`Moved ${dir}/promptcuts.yaml → promptcuts.yaml (repo root)`));
        return;
      } catch {
        // Best-effort migration; hook still works if the user moves it manually.
      }
    }
  }
}

export function registerPullCommand(program: Command): void {
  program
    .command('pull [source] [agent]')
    .description('Sync your config from a git repo. Clones on first run, pulls updates thereafter.')
    .option('-y, --yes', 'Auto-sync all resources without prompting')
    .option('--skip-clis', 'Pull config changes but do not install or upgrade agent CLIs')
    .option('--upstream', 'Pull from the upstream remote instead of origin (for forked repos)')
    .addHelpText('after', `
Examples:
  # First time: clone from your repo (also works if ~/.agents/ is empty)
  agents pull gh:yourname/.agents

  # Update your config from origin (GitHub)
  agents pull

  # Pull updates from the upstream default repo (after you've forked)
  agents pull --upstream

  # Sync only one agent's config
  agents pull claude

  # Non-interactive sync (for scripts / CI)
  agents pull -y

When to use:
  - Initial setup: clone your config repo to a new machine
  - Daily sync: pull changes you or teammates pushed to the repo
  - Upstream updates: get new skills, commands, or MCP servers from the default repo
  - Per-agent: sync just one agent's config without touching others

What it syncs:
  - CLI versions listed in agents.yaml
  - Commands, skills, hooks from the repo
  - MCP server configs
  - Memory/rules files
  - Permissions groups

Skip CLI installs with --skip-clis when you only want config updates, not version changes.
`)
    .action(async (arg1: string | undefined, arg2: string | undefined, options) => {
      const skipPrompts = options.yes || !isInteractiveTerminal();
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

        // Migration nudge: one-time notice if upstream still points at the legacy personal repo.
        const legacySlug = systemRepoSlug(LEGACY_SYSTEM_REPO).toLowerCase();
        const currentSlug = systemRepoSlug(DEFAULT_SYSTEM_REPO);
        const nudgeMarker = path.join(agentsDir, '.migration-nudge-shown');
        const upstreamUrl = await getUpstreamUrl(agentsDir);
        if (upstreamUrl && upstreamUrl.toLowerCase().includes(legacySlug) && !fs.existsSync(nudgeMarker)) {
          console.log(chalk.yellow(`\nYour upstream points at a personal repo (${legacySlug}).`));
          console.log(chalk.yellow(`The curated upstream is now ${currentSlug}.`));
          console.log(chalk.gray('To switch:'));
          console.log(chalk.cyan(`  cd ~/.agents && git remote set-url upstream git@github.com:${currentSlug}.git\n`));
          try { fs.writeFileSync(nudgeMarker, new Date().toISOString() + '\n'); } catch { /* best-effort */ }
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

        // One-time migration: promptcuts.yaml moved from agent-scoped
        // (e.g. claude/promptcuts.yaml) to repo root. We move it so the
        // hook at ~/.agents/hooks/ can always find it at a fixed path.
        migratePromptcutsToRoot(agentsDir);

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

            const cliSpinner = ora(`Checking ${agentLabel(agent.id)}...`).start();
            const versions = listInstalledVersions(agentId);
            const targetVersion = manifest.agents[agentId] || 'latest';

            const result = await installVersion(agentId, targetVersion, (msg) => { cliSpinner.text = msg; });
            if (result.success) {
              const isNew = versions.length === 0;
              if (isNew) {
                cliSpinner.succeed(`Installed ${agentLabel(agent.id)}@${result.installedVersion}`);
              } else {
                cliSpinner.succeed(`${agentLabel(agent.id)}@${result.installedVersion}`);
              }
              // Repair if deleted and regenerate if its schema is out of date.
              ensureShimCurrent(agentId);
            } else {
              cliSpinner.warn(`${agentLabel(agent.id)}: ${result.error}`);
            }
          }
        }

        // Register MCP servers
        if (manifest?.mcp && Object.keys(manifest.mcp).length > 0) {
          console.log(chalk.bold('\nMCP Servers:\n'));

          for (const [name, config] of Object.entries(manifest.mcp)) {
            if (!config.command || config.transport === 'http') continue;

            const scopedAgents = (config.agents ? [...config.agents] : [...MCP_CAPABLE_AGENTS]).filter(
              (id) => !agentFilter || id === agentFilter
            );
            const scopedVersions = config.agentVersions
              ? Object.fromEntries(
                  Object.entries(config.agentVersions).filter(([agentId]) => !agentFilter || agentId === agentFilter)
                ) as Partial<Record<AgentId, string[]>>
              : undefined;
            const targets = resolveConfiguredAgentTargets(
              scopedAgents,
              scopedVersions,
              MCP_CAPABLE_AGENTS
            );
            const results = await registerMcpToTargets(
              targets,
              name,
              config.command,
              config.scope || 'user',
              config.transport || 'stdio'
            );

            for (const result of results) {
              if (result.success) {
                const label = result.version
                  ? `${agentLabel(result.agentId)}@${result.version}`
                  : agentLabel(result.agentId);
                console.log(`  ${chalk.green('+')} ${name} -> ${label}`);
              }
            }
          }
        }

        // Sync resources to default version homes only
        const cliStates = await getAllCliStates();
        const agentsToSync = agentFilter ? [agentFilter] : ALL_AGENT_IDS;
        const available = getAvailableResources();

        for (const agentId of agentsToSync) {
          if (!cliStates[agentId]?.installed && listInstalledVersions(agentId).length === 0) continue;
          const defaultVer = getGlobalDefault(agentId);
          if (!defaultVer) continue;

          const actuallySynced = getActuallySyncedResources(agentId, defaultVer);
          const newResources = getNewResources(available, actuallySynced);

          const hasAnySynced = actuallySynced.commands.length > 0 ||
            actuallySynced.skills.length > 0 ||
            actuallySynced.hooks.length > 0 ||
            actuallySynced.memory.length > 0 ||
            actuallySynced.mcp.length > 0 ||
            actuallySynced.permissions.length > 0 ||
            actuallySynced.plugins.length > 0;

          try {
            let selection: ResourceSelection | undefined;

            if (skipPrompts) {
              // -y flag: sync all without prompting
              if (!hasAnySynced || hasNewResources(newResources, agentId)) {
                selection = {
                  commands: 'all', skills: 'all', hooks: 'all', memory: 'all',
                  mcp: 'all', permissions: 'all', subagents: 'all', plugins: 'all',
                };
              }
            } else if (!hasAnySynced) {
              // Nothing synced yet - prompt for ALL resources
              console.log(chalk.yellow(`\n${agentLabel(agentId)}@${defaultVer} has no synced resources.`));
              const userSelection = await promptResourceSelection(agentId);
              if (userSelection) selection = userSelection;
            } else if (hasNewResources(newResources, agentId)) {
              // Has synced before, but NEW items available
              console.log(chalk.cyan(`\n${agentLabel(agentId)}@${defaultVer}:`));
              const userSelection = await promptNewResourceSelection(agentId, newResources);
              if (userSelection) selection = userSelection;
            }

            if (selection && Object.keys(selection).length > 0) {
              const syncResult = syncResourcesToVersion(agentId, defaultVer, selection);
              const synced: string[] = [];
              if (syncResult.commands) synced.push('commands');
              if (syncResult.skills) synced.push('skills');
              if (syncResult.hooks) synced.push('hooks');
              if (syncResult.memory.length > 0) synced.push('memory');
              if (syncResult.permissions) synced.push('permissions');
              if (syncResult.mcp.length > 0) synced.push('mcp');
              if (syncResult.plugins.length > 0) synced.push('plugins');

              if (synced.length > 0) {
                console.log(chalk.green(`  Synced: ${synced.join(', ')}`));
              }
            }
          } catch (err) {
            if (isPromptCancelled(err)) {
              console.log(chalk.gray('Skipped resource selection'));
            } else {
              throw err;
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
        if (!skipPrompts) {
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
              message: `${agentLabel(agent.id)} has no default version. Set one now?`,
              choices: [
                { name: 'Yes, pick a version', value: 'pick' },
                { name: 'Skip for now', value: 'skip' },
              ],
            });

            if (shouldSwitch === 'pick') {
              const selectedVersion = await select({
                message: `Select ${agentLabel(agent.id)} version:`,
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
            switchHomeFileSymlinks(agentId, version);
            console.log(chalk.green(`Set ${agentLabel(agent.id)}@${version} as default`));
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
