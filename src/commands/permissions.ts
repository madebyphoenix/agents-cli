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
  formatAgentError,
  agentLabel,
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
  resolveAgentVersionTargets,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  parseCommaSeparatedList,
  printWithPager,
  requireInteractiveSelection,
} from './utils.js';

export function registerPermissionsCommands(program: Command): void {
  const permissionsCmd = program
    .command('permissions')
    .description('Manage agent permissions');

  permissionsCmd
    .command('list [agent]')
    .description('List permissions (central sets or agent-specific). Use agent@version for specific version, agent@default for default only.')
    .option('-s, --scope <scope>', 'Filter by scope: user, project', 'user')
    .action(async (agentArg, options) => {
      const cwd = process.cwd();

      // Helper to render permissions for a specific version
      const renderVersionPermissions = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string,
        scope: 'user' | 'project'
      ) => {
        const agent = AGENTS[agentId];
        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

        const perms = readAgentPermissions(agentId, scope, cwd, { home });
        if (!perms) {
          console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}: ${chalk.gray('none')}`);
          console.log();
          return;
        }

        console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}:`);

        if (agentId === 'claude') {
          const claudePerms = perms as { permissions: { allow: string[]; deny: string[] } };
          if (claudePerms.permissions.allow.length > 0) {
            console.log(chalk.green('    Allow:'));
            for (const p of claudePerms.permissions.allow) {
              console.log(`      ${chalk.cyan(p)}`);
            }
          }
          if (claudePerms.permissions.deny.length > 0) {
            console.log(chalk.red('    Deny:'));
            for (const p of claudePerms.permissions.deny) {
              console.log(`      ${chalk.yellow(p)}`);
            }
          }
        } else if (agentId === 'opencode') {
          const ocPerms = perms as { permission: { bash: Record<string, string> } };
          console.log(chalk.gray('    Bash commands:'));
          for (const [pattern, action] of Object.entries(ocPerms.permission.bash)) {
            const color = action === 'allow' ? chalk.green : action === 'deny' ? chalk.red : chalk.yellow;
            console.log(`      ${chalk.cyan(pattern)}: ${color(action)}`);
          }
        } else if (agentId === 'codex') {
          const codexPerms = perms as {
            approval_policy?: string;
            sandbox_mode?: string;
            sandbox_workspace_write?: { network_access?: boolean; writable_roots?: string[] };
          };
          if (codexPerms.approval_policy) {
            console.log(`    ${chalk.gray('approval_policy:')} ${chalk.cyan(codexPerms.approval_policy)}`);
          }
          if (codexPerms.sandbox_mode) {
            console.log(`    ${chalk.gray('sandbox_mode:')} ${chalk.cyan(codexPerms.sandbox_mode)}`);
          }
          if (codexPerms.sandbox_workspace_write) {
            const sw = codexPerms.sandbox_workspace_write;
            if (sw.network_access !== undefined) {
              console.log(`    ${chalk.gray('network_access:')} ${chalk.cyan(String(sw.network_access))}`);
            }
            if (sw.writable_roots && sw.writable_roots.length > 0) {
              console.log(`    ${chalk.gray('writable_roots:')}`);
              for (const r of sw.writable_roots) {
                console.log(`      ${chalk.cyan(r)}`);
              }
            }
          }
        }
        console.log();
      };

      if (agentArg) {
        // Parse agent@version syntax
        const parts = agentArg.split('@');
        const agentName = parts[0];
        const requestedVersion = parts[1] || null;

        const agentId = resolveAgentName(agentName);
        if (!agentId) {
          console.log(chalk.red(formatAgentError(agentName, PERMISSIONS_CAPABLE_AGENTS)));
          process.exit(1);
        }

        if (!PERMISSIONS_CAPABLE_AGENTS.includes(agentId)) {
          console.log(chalk.yellow(`${AGENTS[agentId].name} does not support fine-grained permissions`));
          return;
        }

        const agent = AGENTS[agentId];
        const installedVersions = listInstalledVersions(agentId);
        const defaultVer = getGlobalDefault(agentId);

        console.log(chalk.bold(`Installed Permissions for ${agentLabel(agent.id)} (${options.scope}):\n`));

        if (installedVersions.length === 0) {
          // Not version-managed - use default home
          const perms = readAgentPermissions(agentId, options.scope, cwd);
          if (!perms) {
            console.log(chalk.gray(`  No permissions configured`));
            return;
          }

          console.log(`  ${chalk.bold(agentLabel(agent.id))}:`);

          if (agentId === 'claude') {
            const claudePerms = perms as { permissions: { allow: string[]; deny: string[] } };
            if (claudePerms.permissions.allow.length > 0) {
              console.log(chalk.green('    Allow:'));
              for (const p of claudePerms.permissions.allow) {
                console.log(`      ${chalk.cyan(p)}`);
              }
            }
            if (claudePerms.permissions.deny.length > 0) {
              console.log(chalk.red('    Deny:'));
              for (const p of claudePerms.permissions.deny) {
                console.log(`      ${chalk.yellow(p)}`);
              }
            }
          }
          return;
        }

        // Version-managed: determine which versions to show
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
          // Show all versions, default first
          versionsToShow = [...installedVersions].sort((a, b) => {
            if (a === defaultVer) return -1;
            if (b === defaultVer) return 1;
            return 0;
          });
        }

        for (const version of versionsToShow) {
          const home = getVersionHomePath(agentId, version);
          renderVersionPermissions(agentId, version, version === defaultVer, home, options.scope);
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
    .option('-a, --agents <list>', 'Comma-separated agent or agent@version targets to apply to')
    .option('--names <list>', 'Comma-separated permission set names from ~/.agents/permissions/')
    .option('--all', 'Apply to all installed versions (not just default)')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(async (source: string | undefined, options) => {
      try {
        const skipPrompts = options.yes || !isInteractiveTerminal();

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

          const availableSetNames = installedSets.map((set) => set.name);
          const requestedNames = parseCommaSeparatedList(options.names);
          let selectedNames: string[];

          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !availableSetNames.includes(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown permission set(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${availableSetNames.join(', ')}`));
              process.exit(1);
            }
            selectedNames = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting permission sets from ~/.agents/permissions/', [
                'agents permissions add --names default --agents codex',
                'agents permissions add ./permissions/default.yml --agents codex',
              ]);
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

            selectedNames = selected.includes('__all__')
              ? availableSetNames
              : selected.filter((s) => s !== '__all__');
          }

          let selectedAgents: AgentId[];
          let versionSelections: Map<AgentId, string[]>;

          if (options.agents) {
            const result = resolveAgentVersionTargets(options.agents, PERMISSIONS_CAPABLE_AGENTS, {
              allVersions: options.all,
            });
            selectedAgents = result.selectedAgents;
            versionSelections = result.versionSelections;
          } else if (options.all) {
            selectedAgents = [...PERMISSIONS_CAPABLE_AGENTS];
            versionSelections = new Map();
            for (const agentId of selectedAgents) {
              const versions = listInstalledVersions(agentId);
              if (versions.length > 0) {
                versionSelections.set(agentId, [...versions]);
              }
            }
          } else {
            const result = await promptAgentVersionSelection(
              PERMISSIONS_CAPABLE_AGENTS,
              { skipPrompts }
            );
            selectedAgents = result.selectedAgents;
            versionSelections = result.versionSelections;
          }

          if (selectedAgents.length === 0) {
            console.log(chalk.yellow('\nNo agents selected.'));
            return;
          }

          // Apply selected permission sets
          let applied = 0;
          for (const setName of selectedNames) {
            const installed = installedSets.find((s) => s.name === setName);
            if (!installed) continue;

            for (const [agentId, versions] of versionSelections) {
              for (const version of versions) {
                const versionHome = getVersionHomePath(agentId, version);
                const applyResult = applyPermissionsToVersion(agentId, installed.set, versionHome, true);
                if (applyResult.success) {
                  console.log(chalk.green(`  Applied ${setName} to ${agentLabel(agentId)}@${version}`));
                  recordVersionResources(agentId, version, 'permissions', [setName]);
                  applied++;
                } else {
                  console.log(chalk.red(`  Failed: ${agentLabel(agentId)}@${version}: ${applyResult.error}`));
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
          if (!skipPrompts) {
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
            const result = resolveAgentVersionTargets(options.agents, PERMISSIONS_CAPABLE_AGENTS, {
              allVersions: options.all,
            });
            selectedAgents = result.selectedAgents;
            versionSelections = result.versionSelections;
          } else if (options.all) {
            selectedAgents = [...PERMISSIONS_CAPABLE_AGENTS];
            versionSelections = new Map();
            for (const agentId of selectedAgents) {
              const versions = listInstalledVersions(agentId);
              if (versions.length > 0) {
                versionSelections.set(agentId, [...versions]);
              }
            }
          } else if (!skipPrompts) {
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
                  console.log(chalk.green(`  Applied to ${agentLabel(agentId)}@${version}`));
                  recordVersionResources(agentId, version, 'permissions', [merged.name || 'default']);
                  applied++;
                } else {
                  console.log(chalk.red(`  Failed: ${agentLabel(agentId)}@${version}: ${applyResult.error}`));
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
          if (!skipPrompts) {
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
            const result = resolveAgentVersionTargets(options.agents, PERMISSIONS_CAPABLE_AGENTS, {
              allVersions: options.all,
            });
            selectedAgents = result.selectedAgents;
            versionSelections = result.versionSelections;
          } else if (options.all) {
            selectedAgents = [...PERMISSIONS_CAPABLE_AGENTS];
            versionSelections = new Map();
            for (const agentId of selectedAgents) {
              const versions = listInstalledVersions(agentId);
              if (versions.length > 0) {
                versionSelections.set(agentId, [...versions]);
              }
            }
          } else if (!skipPrompts) {
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
                    console.log(chalk.green(`  Applied ${perm.name} to ${agentLabel(agentId)}@${version}`));
                    recordVersionResources(agentId, version, 'permissions', [perm.name]);
                    applied++;
                  } else {
                    console.log(chalk.red(`  Failed: ${agentLabel(agentId)}@${version}: ${applyResult.error}`));
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

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting permission sets to remove', [
            'agents permissions remove default',
          ]);
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

  permissionsCmd
    .command('view [name]')
    .description('Show permission set details')
    .action(async (name?: string) => {
      const installedSets = listInstalledPermissions();
      if (installedSets.length === 0) {
        console.log(chalk.yellow('No permission sets installed'));
        return;
      }

      // If no name provided, show interactive select
      if (!name) {
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a permission set to view', [
            'agents permissions view default',
          ]);
        }
        try {
          const { select } = await import('@inquirer/prompts');
          name = await select({
            message: 'Select a permission set to view',
            choices: installedSets.map((perm) => ({
              value: perm.name,
              name: perm.set.description
                ? `${perm.name} - ${perm.set.description}`
                : perm.name,
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

      const perm = installedSets.find((p) => p.name === name);
      if (!perm) {
        console.log(chalk.yellow(`Permission set '${name}' not found`));
        return;
      }

      // Build output
      const lines: string[] = [];
      lines.push(chalk.bold(`\n${perm.name}\n`));
      if (perm.set.description) {
        lines.push(`  ${perm.set.description}`);
      }
      lines.push('');

      if (perm.set.allow.length > 0) {
        lines.push(chalk.green('  Allow rules:'));
        for (const rule of perm.set.allow) {
          lines.push(`    ${chalk.cyan(rule)}`);
        }
      }

      if (perm.set.deny && perm.set.deny.length > 0) {
        lines.push(chalk.red('\n  Deny rules:'));
        for (const rule of perm.set.deny) {
          lines.push(`    ${chalk.yellow(rule)}`);
        }
      }
      lines.push('');

      const output = lines.join('\n');
      printWithPager(output, lines.length);
    });

  // Deprecated alias handler for 'perms'
  // Note: This needs to be registered at the program level, not as a subcommand
  // The actual deprecation message is shown in index.ts
}
