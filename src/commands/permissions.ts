import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { confirm, checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  resolveAgentName,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  PERMISSIONS_CAPABLE_AGENTS,
  listInstalledPermissions,
  discoverPermissionsFromRepo,
  installPermissionSet,
  removePermissionSet,
  applyPermissionsToVersion,
  readAgentPermissions,
  exportPermissionsFromPath,
  getDefaultPermissionSet,
  computePermissionsDiff,
  mergePermissionSets,
  saveDefaultPermissionSet,
} from '../lib/permissions.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  getVersionHomePath,
  promptAgentVersionSelection,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import { isPromptCancelled } from './utils.js';

export function registerPermissionsCommands(program: Command): void {
  const permissionsCmd = program
    .command('permissions')
    .alias('perms')
    .description('Manage agent permissions');

  permissionsCmd
    .command('list [agent]')
    .description('List permissions (central sets or agent-specific)')
    .option('-s, --scope <scope>', 'Filter by scope: user, project', 'user')
    .action(async (agentArg, options) => {
      const cwd = process.cwd();

      if (agentArg) {
        // List permissions for a specific agent
        const agentId = resolveAgentName(agentArg);
        if (!agentId) {
          console.log(chalk.red(`Unknown agent '${agentArg}'. Use ${PERMISSIONS_CAPABLE_AGENTS.join(', ')}`));
          process.exit(1);
        }

        if (!PERMISSIONS_CAPABLE_AGENTS.includes(agentId)) {
          console.log(chalk.yellow(`${AGENTS[agentId].name} does not support fine-grained permissions`));
          return;
        }

        const perms = readAgentPermissions(agentId, options.scope, cwd);
        if (!perms) {
          console.log(chalk.gray(`No permissions configured for ${AGENTS[agentId].name} (${options.scope} scope)`));
          return;
        }

        const defaultVer = getGlobalDefault(agentId);
        const versionStr = defaultVer ? ` (${defaultVer})` : '';
        console.log(chalk.bold(`${AGENTS[agentId].name}${versionStr} Permissions (${options.scope}):\n`));

        if (agentId === 'claude') {
          const claudePerms = perms as { permissions: { allow: string[]; deny: string[] } };
          if (claudePerms.permissions.allow.length > 0) {
            console.log(chalk.green('  Allow:'));
            for (const p of claudePerms.permissions.allow) {
              console.log(`    ${chalk.cyan(p)}`);
            }
          }
          if (claudePerms.permissions.deny.length > 0) {
            console.log(chalk.red('  Deny:'));
            for (const p of claudePerms.permissions.deny) {
              console.log(`    ${chalk.yellow(p)}`);
            }
          }
        } else if (agentId === 'opencode') {
          const ocPerms = perms as { permission: { bash: Record<string, string> } };
          console.log(chalk.gray('  Bash commands:'));
          for (const [pattern, action] of Object.entries(ocPerms.permission.bash)) {
            const color = action === 'allow' ? chalk.green : action === 'deny' ? chalk.red : chalk.yellow;
            console.log(`    ${chalk.cyan(pattern)}: ${color(action)}`);
          }
        } else if (agentId === 'codex') {
          const codexPerms = perms as {
            approval_policy?: string;
            sandbox_mode?: string;
            sandbox_workspace_write?: { network_access?: boolean; writable_roots?: string[] };
          };
          if (codexPerms.approval_policy) {
            console.log(`  ${chalk.gray('approval_policy:')} ${chalk.cyan(codexPerms.approval_policy)}`);
          }
          if (codexPerms.sandbox_mode) {
            console.log(`  ${chalk.gray('sandbox_mode:')} ${chalk.cyan(codexPerms.sandbox_mode)}`);
          }
          if (codexPerms.sandbox_workspace_write) {
            const sw = codexPerms.sandbox_workspace_write;
            if (sw.network_access !== undefined) {
              console.log(`  ${chalk.gray('network_access:')} ${chalk.cyan(String(sw.network_access))}`);
            }
            if (sw.writable_roots && sw.writable_roots.length > 0) {
              console.log(`  ${chalk.gray('writable_roots:')}`);
              for (const r of sw.writable_roots) {
                console.log(`    ${chalk.cyan(r)}`);
              }
            }
          }
        }
      } else {
        // List central permission sets
        const sets = listInstalledPermissions();

        if (sets.length === 0) {
          console.log(chalk.gray('No permission sets installed.'));
          console.log(chalk.gray('Use `agents permissions add <source>` to add permission sets.'));
          return;
        }

        console.log(chalk.bold('Installed Permission Sets:\n'));
        for (const perm of sets) {
          const desc = perm.set.description ? ` - ${chalk.gray(perm.set.description)}` : '';
          console.log(`  ${chalk.cyan(perm.name)}${desc}`);
          console.log(`    ${chalk.gray(`${perm.set.allow.length} allow, ${perm.set.deny?.length || 0} deny rules`)}`);
        }
      }
    });

  permissionsCmd
    .command('add [source]')
    .description('Install permissions from a repo, YAML file, or agent config file')
    .option('-a, --agents <list>', 'Comma-separated agents to apply to')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(async (source: string | undefined, options) => {
      try {
        // Interactive mode: pick from central storage
        if (!source) {
          const installedSets = listInstalledPermissions();
          if (installedSets.length === 0) {
            console.log(chalk.yellow('No permission sets in ~/.agents/permissions/'));
            console.log(chalk.gray('\nTo add permissions from a file or repo:'));
            console.log(chalk.cyan('  agents permissions add ~/.claude/settings.json'));
            console.log(chalk.cyan('  agents permissions add gh:user/repo'));
            return;
          }

          const choices = installedSets.map((installed) => ({
            value: installed.name,
            name: installed.set.description
              ? `${installed.name}  ${chalk.gray(installed.set.description.slice(0, 40))}`
              : `${installed.name}  ${chalk.gray(`${installed.set.allow.length} allow, ${installed.set.deny?.length || 0} deny`)}`,
          }));

          const selected = await checkbox({
            message: 'Select permission sets to apply',
            choices: [
              { value: '__all__', name: chalk.bold('Select All') },
              ...choices,
            ],
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No permission sets selected.'));
            return;
          }

          const selectedNames = selected.includes('__all__')
            ? installedSets.map((s) => s.name)
            : selected.filter((s) => s !== '__all__');

          // Get agent and version selection
          const result = await promptAgentVersionSelection(
            PERMISSIONS_CAPABLE_AGENTS,
            { skipPrompts: options.yes }
          );

          if (result.selectedAgents.length === 0) {
            console.log(chalk.yellow('\nNo agents selected.'));
            return;
          }

          // Apply selected permission sets
          let applied = 0;
          for (const setName of selectedNames) {
            const installed = installedSets.find((s) => s.name === setName);
            if (!installed) continue;

            for (const [agentId, versions] of result.versionSelections) {
              for (const version of versions) {
                const versionHome = getVersionHomePath(agentId, version);
                const applyResult = applyPermissionsToVersion(agentId, installed.set, versionHome, true);
                if (applyResult.success) {
                  console.log(chalk.green(`  Applied ${setName} to ${AGENTS[agentId].name}@${version}`));
                  recordVersionResources(agentId, version, 'permissions', [setName]);
                  applied++;
                } else {
                  console.log(chalk.red(`  Failed: ${AGENTS[agentId].name}@${version}: ${applyResult.error}`));
                }
              }
            }
          }

          console.log(chalk.green(`\nApplied permissions to ${applied} version(s).`));
          return;
        }

        const spinner = ora('Fetching permissions...').start();

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

        // Check if this is an agent config file
        const isAgentConfig = localPath.endsWith('.json') || localPath.endsWith('.jsonc') || localPath.endsWith('.toml');
        const looksLikeAgentConfig = localPath.includes('.claude') || localPath.includes('.opencode') || localPath.includes('.codex');

        if (isAgentConfig && looksLikeAgentConfig) {
          // Handle agent config file - convert, diff, merge into default set
          const incoming = exportPermissionsFromPath(localPath);

          if (!incoming || (incoming.allow.length === 0 && (!incoming.deny || incoming.deny.length === 0))) {
            console.log(chalk.yellow(`\nNo permissions found in ${localPath}`));
            return;
          }

          // Get existing default permission set
          const existing = getDefaultPermissionSet();

          // Compute diff
          const diff = computePermissionsDiff(existing, incoming);
          const totalNew = diff.allow.added.length + diff.deny.added.length;
          const totalExisting = diff.allow.existing.length + diff.deny.existing.length;

          if (totalNew === 0) {
            console.log(chalk.gray('\nAll permissions already exist in central storage.'));
            return;
          }

          // Show diff
          console.log(chalk.bold('\nPermissions to add:\n'));

          if (diff.allow.added.length > 0) {
            console.log(chalk.green('  New allow rules:'));
            for (const rule of diff.allow.added.slice(0, 20)) {
              console.log(chalk.green(`    + ${rule}`));
            }
            if (diff.allow.added.length > 20) {
              console.log(chalk.green(`    ... and ${diff.allow.added.length - 20} more`));
            }
          }

          if (diff.deny.added.length > 0) {
            console.log(chalk.red('\n  New deny rules:'));
            for (const rule of diff.deny.added) {
              console.log(chalk.red(`    + ${rule}`));
            }
          }

          if (totalExisting > 0) {
            console.log(chalk.gray(`\n  (${totalExisting} rules already exist, will be skipped)`));
          }

          console.log();

          // Confirm
          if (!options.yes) {
            const proceed = await confirm({
              message: `Add ${totalNew} new permission rule${totalNew === 1 ? '' : 's'}?`,
              default: true,
            });
            if (!proceed) {
              console.log(chalk.gray('Cancelled.'));
              return;
            }
          }

          // Merge and save
          const merged = mergePermissionSets(existing, incoming);
          const result = saveDefaultPermissionSet(merged);

          if (!result.success) {
            console.log(chalk.red(`Failed to save: ${result.error}`));
            return;
          }

          console.log(chalk.green(`Added ${totalNew} permission${totalNew === 1 ? '' : 's'} to ~/.agents/permissions/default.yml`));

          // Apply to agent versions
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
          } else if (!options.yes) {
            const applyNow = await confirm({
              message: 'Apply permissions to agent versions now?',
              default: true,
            });

            if (applyNow) {
              const result = await promptAgentVersionSelection(
                PERMISSIONS_CAPABLE_AGENTS,
                { skipPrompts: false }
              );
              selectedAgents = result.selectedAgents;
              versionSelections = result.versionSelections;
            } else {
              selectedAgents = [];
              versionSelections = new Map();
            }
          } else {
            selectedAgents = [];
            versionSelections = new Map();
          }

          if (selectedAgents.length > 0) {
            let applied = 0;
            for (const [agentId, versions] of versionSelections) {
              for (const version of versions) {
                const versionHome = getVersionHomePath(agentId, version);
                const applyResult = applyPermissionsToVersion(agentId, merged, versionHome, true);
                if (applyResult.success) {
                  console.log(chalk.green(`  Applied to ${AGENTS[agentId].name}@${version}`));
                  recordVersionResources(agentId, version, 'permissions', [merged.name || 'default']);
                  applied++;
                } else {
                  console.log(chalk.red(`  Failed: ${AGENTS[agentId].name}@${version}: ${applyResult.error}`));
                }
              }
            }
            console.log(chalk.gray(`\nApplied permissions to ${applied} version(s).`));
          }
        } else {
          // Handle permission YAML files or repo
          let permissions: ReturnType<typeof discoverPermissionsFromRepo>;

          if (localPath.endsWith('.yml') || localPath.endsWith('.yaml')) {
            const { parsePermissionSet } = await import('../lib/permissions.js');
            const set = parsePermissionSet(localPath);
            if (set) {
              permissions = [{ name: set.name, path: localPath, set }];
            } else {
              console.log(chalk.red('Invalid permission file'));
              return;
            }
          } else {
            permissions = discoverPermissionsFromRepo(localPath);
          }

          if (permissions.length === 0) {
            console.log(chalk.yellow('\nNo permission sets found'));
            return;
          }

          console.log(chalk.bold(`\nFound ${permissions.length} permission set(s):`));
          for (const perm of permissions) {
            const desc = perm.set.description ? ` - ${perm.set.description}` : '';
            console.log(`  ${chalk.cyan(perm.name)}${desc}`);
            console.log(`    ${chalk.gray(`${perm.set.allow.length} allow, ${perm.set.deny?.length || 0} deny rules`)}`);
          }

          // Confirm installation
          if (!options.yes) {
            const proceed = await confirm({
              message: 'Install these permission sets?',
              default: true,
            });
            if (!proceed) {
              console.log(chalk.gray('Cancelled.'));
              return;
            }
          }

          const installSpinner = ora('Installing permission sets...').start();
          let installed = 0;

          for (const perm of permissions) {
            const result = installPermissionSet(perm.path, perm.name);
            if (result.success) {
              installed++;
            } else {
              installSpinner.stop();
              console.log(chalk.red(`  Failed to install ${perm.name}: ${result.error}`));
              installSpinner.start();
            }
          }

          installSpinner.succeed(`Installed ${installed} permission set(s) to ~/.agents/permissions/`);

          // Apply to agent versions
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
          } else if (!options.yes) {
            const applyNow = await confirm({
              message: 'Apply these permissions to agent versions now?',
              default: true,
            });

            if (applyNow) {
              const result = await promptAgentVersionSelection(
                PERMISSIONS_CAPABLE_AGENTS,
                { skipPrompts: false }
              );
              selectedAgents = result.selectedAgents;
              versionSelections = result.versionSelections;
            } else {
              selectedAgents = [];
              versionSelections = new Map();
            }
          } else {
            selectedAgents = [];
            versionSelections = new Map();
          }

          if (selectedAgents.length > 0) {
            let applied = 0;
            for (const perm of permissions) {
              for (const [agentId, versions] of versionSelections) {
                for (const version of versions) {
                  const versionHome = getVersionHomePath(agentId, version);
                  const applyResult = applyPermissionsToVersion(agentId, perm.set, versionHome, true);
                  if (applyResult.success) {
                    console.log(chalk.green(`  Applied ${perm.name} to ${AGENTS[agentId].name}@${version}`));
                    recordVersionResources(agentId, version, 'permissions', [perm.name]);
                    applied++;
                  } else {
                    console.log(chalk.red(`  Failed: ${AGENTS[agentId].name}@${version}: ${applyResult.error}`));
                  }
                }
              }
            }
            console.log(chalk.gray(`\nApplied permissions to ${applied} version(s).`));
          }
        }
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled.'));
          return;
        }
        console.error(chalk.red(`Error: ${(err as Error).message}`));
      }
    });

  permissionsCmd
    .command('remove [name]')
    .description('Remove a permission set from central storage')
    .action(async (name?: string) => {
      let setsToRemove: string[];

      if (name) {
        setsToRemove = [name];
      } else {
        // Interactive picker
        const installedSets = listInstalledPermissions();
        if (installedSets.length === 0) {
          console.log(chalk.yellow('No permission sets installed.'));
          return;
        }

        try {
          const selected = await checkbox({
            message: 'Select permission sets to remove',
            choices: installedSets.map((perm) => ({
              value: perm.name,
              name: perm.set.description
                ? `${perm.name} - ${perm.set.description}`
                : perm.name,
            })),
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No permission sets selected.'));
            return;
          }

          setsToRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      for (const setName of setsToRemove) {
        const result = removePermissionSet(setName);
        if (result.success) {
          console.log(chalk.green(`Removed permission set '${setName}'`));
        } else {
          console.log(chalk.red(result.error));
        }
      }
    });
}
