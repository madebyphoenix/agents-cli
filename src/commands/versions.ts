import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { select } from '@inquirer/prompts';

import {
  AGENTS,
  ALL_AGENT_IDS,
  getAllCliStates,
  getAccountEmail,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { readManifest, writeManifest, createDefaultManifest } from '../lib/manifest.js';
import {
  installVersion,
  removeVersion,
  removeAllVersions,
  listInstalledVersions,
  isVersionInstalled,
  getGlobalDefault,
  setGlobalDefault,
  getVersionHomePath,
  getVersionDir,
  syncResourcesToVersion,
  parseAgentSpec,
} from '../lib/versions.js';
import {
  createShim,
  removeShim,
  shimExists,
  getShimsDir,
  isShimsInPath,
  getPathSetupInstructions,
  switchConfigSymlink,
  getConfigSymlinkVersion,
  compareVersionResources,
  hasResourceDiff,
  copyResourcesToVersion,
} from '../lib/shims.js';
import { isPromptCancelled } from './utils.js';

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

/**
 * Helper to get actual installed version for an agent.
 * Returns the latest installed version, or throws if none installed.
 */
async function getInstalledVersionForAgent(agent: AgentId): Promise<string> {
  const versions = listInstalledVersions(agent);
  if (versions.length > 0) {
    return versions[versions.length - 1];
  }
  throw new Error(`No versions of ${agent} installed`);
}

/**
 * Helper to get project version from current working directory.
 */
function getProjectVersionFromCwd(agent: AgentId): string | null {
  const manifestPath = path.join(process.cwd(), '.agents', 'agents.yaml');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = readManifest(process.cwd());
    return manifest?.agents?.[agent] || null;
  } catch {
    return null;
  }
}

export function registerVersionsCommands(program: Command): void {
  program
    .command('add <specs...>')
    .description('Install agent CLI versions')
    .option('-p, --project', 'Pin version in project manifest (.agents/agents.yaml)')
    .action(async (specs: string[], options) => {
      const isProject = options.project;

      for (const spec of specs) {
        const parsed = parseAgentSpec(spec);
        if (!parsed) {
          console.log(chalk.red(`Invalid agent: ${spec}`));
          console.log(chalk.gray(`Format: <agent>[@version]. Available: ${ALL_AGENT_IDS.join(', ')}`));
          continue;
        }

        const { agent, version } = parsed;
        const agentConfig = AGENTS[agent];

        if (!agentConfig.npmPackage) {
          console.log(chalk.yellow(`${agentConfig.name} has no npm package. Install manually.`));
          continue;
        }

        // Check if already installed
        if (isVersionInstalled(agent, version)) {
          console.log(chalk.gray(`${agentConfig.name}@${version} already installed`));

          // Ensure shim exists (in case it was deleted or needs updating)
          createShim(agent);
        } else {
          const spinner = ora(`Installing ${agentConfig.name}@${version}...`).start();

          const result = await installVersion(agent, version, (msg) => {
            spinner.text = msg;
          });

          if (result.success) {
            spinner.succeed(`Installed ${agentConfig.name}@${result.installedVersion}`);

            // Create shim if first install
            if (!shimExists(agent)) {
              createShim(agent);
              console.log(chalk.gray(`  Created shim: ${getShimsDir()}/${agentConfig.cliCommand}`));
            }

            // Sync central resources to the new version
            const installedVersion = result.installedVersion || version;
            const syncResult = syncResourcesToVersion(agent, installedVersion);
            const synced: string[] = [];
            if (syncResult.commands) synced.push('commands');
            if (syncResult.skills) synced.push('skills');
            if (syncResult.hooks) synced.push('hooks');
            if (syncResult.memory.length > 0) synced.push('memory');
            if (syncResult.permissions) synced.push('permissions');

            if (synced.length > 0) {
              console.log(chalk.gray(`  Synced: ${synced.join(', ')}`));
            }

            // Hint if no default is set
            if (!getGlobalDefault(agent)) {
              console.log(chalk.yellow(`  No default set. Run: agents use ${agent}@${result.installedVersion}`));
            }

            // Check if shims in PATH
            if (!isShimsInPath()) {
              console.log();
              console.log(chalk.yellow('Shims directory not in PATH. Add it to use version switching:'));
              console.log(chalk.gray(getPathSetupInstructions()));
              console.log();
            }
          } else {
            spinner.fail(`Failed to install ${agentConfig.name}@${version}`);
            console.error(chalk.gray(result.error || 'Unknown error'));
            continue;
          }
        }

        // Update project manifest if -p flag
        if (isProject) {
          const projectManifestDir = path.join(process.cwd(), '.agents');
          const projectManifestPath = path.join(projectManifestDir, 'agents.yaml');

          if (!fs.existsSync(projectManifestDir)) {
            fs.mkdirSync(projectManifestDir, { recursive: true });
          }

          const manifest = fs.existsSync(projectManifestPath)
            ? readManifest(process.cwd()) || createDefaultManifest()
            : createDefaultManifest();

          manifest.agents = manifest.agents || {};
          manifest.agents[agent] = version === 'latest' ? (await getInstalledVersionForAgent(agent)) : version;

          writeManifest(process.cwd(), manifest);
          console.log(chalk.green(`  Pinned ${agentConfig.name}@${version} in .agents/agents.yaml`));
        }
      }
    });

  program
    .command('remove <specs...>')
    .description('Remove agent CLI versions')
    .option('-p, --project', 'Also remove from project manifest')
    .action(async (specs: string[], options) => {
      const isProject = options.project;

      for (const spec of specs) {
        const parsed = parseAgentSpec(spec);
        if (!parsed) {
          console.log(chalk.red(`Invalid agent: ${spec}`));
          console.log(chalk.gray(`Format: <agent>[@version]. Available: ${ALL_AGENT_IDS.join(', ')}`));
          continue;
        }

        const { agent, version } = parsed;
        const agentConfig = AGENTS[agent];

        if (version === 'latest' || !spec.includes('@')) {
          // Remove all versions
          const versions = listInstalledVersions(agent);
          if (versions.length === 0) {
            console.log(chalk.gray(`No versions of ${agentConfig.name} installed`));
          } else {
            const count = removeAllVersions(agent);
            removeShim(agent);
            console.log(chalk.green(`Removed ${count} version(s) of ${agentConfig.name}`));
          }
        } else {
          // Remove specific version
          if (!isVersionInstalled(agent, version)) {
            console.log(chalk.gray(`${agentConfig.name}@${version} not installed`));
          } else {
            removeVersion(agent, version);
            console.log(chalk.green(`Removed ${agentConfig.name}@${version}`));

            // Remove shim if no versions left
            const remaining = listInstalledVersions(agent);
            if (remaining.length === 0) {
              removeShim(agent);
            }
          }
        }

        // Update project manifest if -p flag
        if (isProject) {
          const projectManifestPath = path.join(process.cwd(), '.agents', 'agents.yaml');
          if (fs.existsSync(projectManifestPath)) {
            const manifest = readManifest(process.cwd());
            if (manifest?.agents?.[agent]) {
              delete manifest.agents[agent];
              writeManifest(process.cwd(), manifest);
              console.log(chalk.gray(`  Removed from .agents/agents.yaml`));
            }
          }
        }
      }
    });

  program
    .command('use <agent> [version]')
    .description('Set the default agent CLI version')
    .option('-p, --project', 'Set in project manifest instead of global default')
    .action(async (agentArg: string, versionArg: string | undefined, options) => {
      try {
        // Support both "claude 2.0.65" and "claude@2.0.65" formats
        let agent: string;
        let version: string | undefined;

        if (agentArg.includes('@')) {
          const parsed = parseAgentSpec(agentArg);
          if (!parsed) {
            console.log(chalk.red(`Invalid agent: ${agentArg}`));
            console.log(chalk.gray(`Format: <agent>[@version]. Available: ${ALL_AGENT_IDS.join(', ')}`));
            return;
          }
          agent = parsed.agent;
          version = parsed.version === 'latest' ? undefined : parsed.version;
        } else {
          const agentLower = agentArg.toLowerCase();
          if (!AGENTS[agentLower as AgentId]) {
            console.log(chalk.red(`Invalid agent: ${agentArg}`));
            console.log(chalk.gray(`Available: ${ALL_AGENT_IDS.join(', ')}`));
            return;
          }
          agent = agentLower;
          version = versionArg;
        }

        const agentId = agent as AgentId;
        const agentConfig = AGENTS[agentId];

        let selectedVersion = version;

        if (!version) {
          // Interactive version picker
          const versions = listInstalledVersions(agentId);
          if (versions.length === 0) {
            console.log(chalk.red(`No versions of ${agentConfig.name} installed`));
            console.log(chalk.gray(`Run: agents add ${agentId}@latest`));
            return;
          }

          const globalDefault = getGlobalDefault(agentId);

          // Pre-fetch emails for picker labels
          const pickerEmails = await Promise.all(
            versions.map((v) =>
              getAccountEmail(agentId, getVersionHomePath(agentId, v)).then((email) => ({ v, email }))
            )
          );
          const pickerEmailMap = new Map(pickerEmails.map((e) => [e.v, e.email]));

          const maxLabelLen = Math.max(...versions.map((v) => (v === globalDefault ? `${v} (default)` : v).length));
          selectedVersion = await select({
            message: `Select ${agentConfig.name} version:`,
            choices: versions.map((v) => {
              let label = v === globalDefault ? `${v}${chalk.green(' (default)')}` : v;
              const padLen = maxLabelLen - (v === globalDefault ? `${v} (default)` : v).length;
              if (padLen > 0) label += ' '.repeat(padLen);
              const email = pickerEmailMap.get(v);
              if (email) label += chalk.cyan(`  ${email}`);
              return { name: label, value: v };
            }),
          });
        }

        if (!selectedVersion || !isVersionInstalled(agentId, selectedVersion)) {
          console.log(chalk.red(`${agentConfig.name}@${selectedVersion ?? 'unknown'} not installed`));
          console.log(chalk.gray(`Run: agents add ${agentId}@${selectedVersion ?? 'latest'}`));
          return;
        }

        // selectedVersion is guaranteed to be defined after the check above
        const finalVersion = selectedVersion;

        if (options.project) {
          // Set in project manifest
          const projectManifestDir = path.join(process.cwd(), '.agents');
          const projectManifestPath = path.join(projectManifestDir, 'agents.yaml');

          if (!fs.existsSync(projectManifestDir)) {
            fs.mkdirSync(projectManifestDir, { recursive: true });
          }

          const manifest = fs.existsSync(projectManifestPath)
            ? readManifest(process.cwd()) || createDefaultManifest()
            : createDefaultManifest();

          manifest.agents = manifest.agents || {};
          manifest.agents[agentId] = finalVersion;

          writeManifest(process.cwd(), manifest);
          const projEmail = await getAccountEmail(agentId, getVersionHomePath(agentId, finalVersion));
          const projEmailStr = projEmail ? chalk.cyan(` (${projEmail})`) : '';
          console.log(chalk.green(`Set ${agentConfig.name}@${finalVersion} for this project`) + projEmailStr);
        } else {
          // Check if switching versions will lose access to resources
          const currentVersion = getConfigSymlinkVersion(agentId);

          if (currentVersion && currentVersion !== finalVersion) {
            const diff = compareVersionResources(agentId, currentVersion, finalVersion);

            if (hasResourceDiff(diff)) {
              console.log(chalk.yellow(`\nYou'll lose access to these resources (exist in ${currentVersion}, not in ${finalVersion}):`));

              if (diff.commands.length > 0) {
                console.log(`  Commands:  ${diff.commands.join(', ')}`);
              }
              if (diff.skills.length > 0) {
                console.log(`  Skills:    ${diff.skills.join(', ')}`);
              }
              if (diff.hooks.length > 0) {
                console.log(`  Hooks:     ${diff.hooks.join(', ')}`);
              }
              if (diff.memory.length > 0) {
                const memStr = diff.memory.map(m => `${m.file} (${m.currentLines} lines -> ${m.targetLines} lines)`).join(', ');
                console.log(`  Memory:    ${memStr}`);
              }
              if (diff.mcp.length > 0) {
                console.log(`  MCP:       ${diff.mcp.join(', ')}`);
              }

              console.log('');

              const action = await select({
                message: 'How do you want to proceed?',
                choices: [
                  { name: 'Copy to target version, then switch (recommended)', value: 'copy' },
                  { name: 'Switch without copying', value: 'switch' },
                  { name: 'Cancel', value: 'cancel' },
                ],
              });

              if (action === 'cancel') {
                console.log(chalk.gray('Cancelled'));
                return;
              }

              if (action === 'copy') {
                copyResourcesToVersion(agentId, currentVersion, finalVersion, diff);
                console.log(chalk.gray(`Copied resources from ${currentVersion} to ${finalVersion}`));
              }
            }
          }

          // Set global default
          setGlobalDefault(agentId, finalVersion);

          // Switch config symlink (e.g., ~/.claude -> version's config)
          const symlinkResult = switchConfigSymlink(agentId, finalVersion);
          if (!symlinkResult.success) {
            console.log(chalk.yellow(`Warning: Could not update config symlink: ${symlinkResult.error}`));
          } else if (symlinkResult.migrated) {
            console.log(chalk.gray(`Migrated existing ${agentConfig.configDir} to version ${finalVersion}`));
          }

          const useEmail = await getAccountEmail(agentId, getVersionHomePath(agentId, finalVersion));
          const useEmailStr = useEmail ? chalk.cyan(` (${useEmail})`) : '';
          console.log(chalk.green(`Set ${agentConfig.name}@${finalVersion} as global default`) + useEmailStr);
        }
      } catch (err) {
        if (isPromptCancelled(err)) return;
        throw err;
      }
    });

  program
    .command('list [agent]')
    .description('List installed agent CLI versions')
    .action(async (agentArg?: string) => {
      // Resolve agent filter before spinner so we can personalize the message
      let filterAgentId: AgentId | undefined;
      if (agentArg) {
        const agentMap: Record<string, AgentId> = {
          claude: 'claude',
          'claude-code': 'claude',
          codex: 'codex',
          gemini: 'gemini',
          cursor: 'cursor',
          opencode: 'opencode',
          openclaw: 'openclaw',
          claw: 'openclaw',
        };
        filterAgentId = agentMap[agentArg.toLowerCase()];
        if (!filterAgentId) {
          console.log(chalk.red(`Unknown agent: ${agentArg}`));
          console.log(chalk.gray(`Valid agents: claude, codex, gemini, cursor, opencode, openclaw`));
          process.exit(1);
        }
      }

      const spinnerText = filterAgentId
        ? `Checking ${AGENTS[filterAgentId].name} agents...`
        : 'Checking installed agents...';
      const spinner = ora(spinnerText).start();
      const cliStates = await getAllCliStates();
      spinner.stop();

      const agentsToShow = filterAgentId ? [filterAgentId] : ALL_AGENT_IDS;
      const showPaths = !!filterAgentId; // Show paths when filtering to single agent

      console.log(chalk.bold('Installed Agent CLIs\n'));

      // Pre-fetch emails for all versions in parallel
      const emailFetches: Promise<{ agentId: AgentId; version: string; email: string | null }>[] = [];
      const globalEmailFetches: Promise<{ agentId: AgentId; email: string | null }>[] = [];
      for (const agentId of agentsToShow) {
        const versions = listInstalledVersions(agentId);
        if (versions.length > 0) {
          for (const ver of versions) {
            emailFetches.push(
              getAccountEmail(agentId, getVersionHomePath(agentId, ver)).then((email) => ({
                agentId,
                version: ver,
                email,
              }))
            );
          }
        } else {
          globalEmailFetches.push(
            getAccountEmail(agentId).then((email) => ({ agentId, email }))
          );
        }
      }
      const emailResults = await Promise.all(emailFetches);
      const globalEmailResults = await Promise.all(globalEmailFetches);

      // Build lookup: agentId:version -> email
      const listEmailMap = new Map<string, string | null>();
      for (const { agentId, version, email } of emailResults) {
        listEmailMap.set(`${agentId}:${version}`, email);
      }
      const globalListEmailMap = new Map<string, string | null>();
      for (const { agentId, email } of globalEmailResults) {
        globalListEmailMap.set(agentId, email);
      }

      // Separate version-managed from globally-installed agents
      const versionManaged: AgentId[] = [];
      const globallyInstalled: AgentId[] = [];

      for (const agentId of agentsToShow) {
        const versions = listInstalledVersions(agentId);
        const cliState = cliStates[agentId];

        if (versions.length > 0) {
          versionManaged.push(agentId);
        } else if (cliState?.installed) {
          globallyInstalled.push(agentId);
        }
      }

      // Show version-managed agents
      if (versionManaged.length > 0) {
        for (const agentId of versionManaged) {
          const agent = AGENTS[agentId];
          const versions = listInstalledVersions(agentId);
          const globalDefault = getGlobalDefault(agentId);

          console.log(`  ${chalk.bold(agent.name)}`);

          // Sort versions with default first, then by semver descending
          const sortedVersions = [...versions].sort((a, b) => {
            if (a === globalDefault) return -1;
            if (b === globalDefault) return 1;
            return compareVersions(b, a); // descending for non-default
          });
          const maxVerLabel = Math.max(...sortedVersions.map((v) => (v === globalDefault ? `${v} (default)` : v).length));
          for (const version of sortedVersions) {
            const isDefault = version === globalDefault;
            const base = isDefault ? `${version} (default)` : version;
            const padded = base.padEnd(maxVerLabel);
            const label = isDefault ? `${version}${chalk.green(' (default)')}${' '.repeat(maxVerLabel - base.length)}` : padded;
            const vEmail = listEmailMap.get(`${agentId}:${version}`);
            const vEmailStr = vEmail ? `  ${chalk.cyan(vEmail)}` : '';
            console.log(`    ${label}${vEmailStr}`);
            if (showPaths) {
              const versionDir = getVersionDir(agentId, version);
              console.log(chalk.gray(`      ${versionDir}`));
            }
          }

          // Check for project override
          const projectVersion = getProjectVersionFromCwd(agentId);
          if (projectVersion && projectVersion !== globalDefault) {
            console.log(chalk.cyan(`    -> ${projectVersion} (project)`));
          }

          console.log();
        }
      }

      // Show globally installed (not managed) agents
      if (globallyInstalled.length > 0) {
        console.log(chalk.bold('Not Managed by Agents CLI\n'));

        for (const agentId of globallyInstalled) {
          const agent = AGENTS[agentId];
          const cliState = cliStates[agentId];

          console.log(`  ${chalk.bold(agent.name)}`);
          const gEmail = globalListEmailMap.get(agentId);
          const gEmailStr = gEmail ? `    ${chalk.cyan(gEmail)}` : '';
          console.log(`    ${cliState?.version || 'installed'} ${chalk.gray('(global)')}${gEmailStr}`);
          if (showPaths && cliState?.path) {
            console.log(chalk.gray(`      ${cliState.path}`));
          }
          console.log();
        }
      }

      // If filtering to a specific agent and not found
      if (filterAgentId && versionManaged.length === 0 && globallyInstalled.length === 0) {
        console.log(`  ${chalk.bold(AGENTS[filterAgentId].name)}: ${chalk.gray('not installed')}`);
        console.log();
      }

      // No agents installed at all
      if (versionManaged.length === 0 && globallyInstalled.length === 0 && !filterAgentId) {
        console.log(chalk.gray('  No agent CLIs installed.'));
        console.log(chalk.gray('  Run: agents add claude@latest'));
        console.log();
      }

      // Show shims path status at the end (only for full list with managed versions)
      if (versionManaged.length > 0 && !filterAgentId) {
        const shimsDir = getShimsDir();
        if (isShimsInPath()) {
          console.log(chalk.gray(`Shims: ${shimsDir} (in PATH)`));
        } else {
          console.log(chalk.yellow(`Shims: ${shimsDir} (not in PATH)`));
          console.log(chalk.gray('Add to PATH for automatic version switching'));
        }
      }
    });
}
