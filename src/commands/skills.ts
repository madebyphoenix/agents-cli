/**
 * Skill management commands for adding domain-specific capabilities to agents.
 *
 * Implements `agents skills` -- list, add, remove, sync, prune, and view
 * packaged SKILL.md bundles (with optional rules/ directories). Central
 * storage lives in ~/.agents/skills/ and skills are synced to individual
 * version homes via copy or symlink.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { select, checkbox, confirm } from '@inquirer/prompts';

import {
  AGENTS,
  SKILLS_CAPABLE_AGENTS,
  resolveAgentName,
  getAllCliStates,
  formatAgentError,
  agentLabel,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverSkillsFromRepo,
  installSkillCentrally,
  uninstallSkill,
  listInstalledSkills,
  listInstalledSkillsWithScope,
  getSkillInfo,
  getSkillRules,
  getSkillsDir,
  countSkillFiles,
  tryParseSkillMetadata,
  diffVersionSkills,
  installSkillToVersion,
  removeSkillFromVersion,
  iterSkillsCapableVersions,
  type SkillParseError,
  type VersionSkillDiff,
} from '../lib/skills.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  getVersionHomePath,
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
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';

/** Register the `agents skills` command tree (list, add, remove, sync, prune, view). */
export function registerSkillsCommands(program: Command): void {
  const skillsCmd = program
    .command('skills')
    .description('Add domain-specific capabilities to agents via packaged SKILL.md files')
    .addHelpText('after', `
Skills are structured bundles (SKILL.md + rules/) that teach agents specialized domains: API conventions, testing patterns, code review checklists. Each skill can ship with its own rules that only apply when the skill is invoked.

Examples:
  # See what skills are installed
  agents skills list

  # Check skills for a specific agent version
  agents skills list claude@2.1.112

  # Install a skill from GitHub
  agents skills add gh:anthropics/skills --agents codex,claude

  # Interactive: pick from ~/.agents/skills/
  agents skills add

  # Install a specific skill by name
  agents skills add --names api-testing --agents codex@0.116.0

When to use:
  - Onboarding: 'agents skills add gh:team/skills' to share expertise across the team
  - Specialization: install domain skills (rush-product-knowledge, rdev) per project
  - Version isolation: install different skills to different versions for experimentation
`);

  skillsCmd
    .command('list [agent]')
    .description('Show which skills are installed and which agent versions they are synced to')
    .option('-a, --agent <agent>', 'Filter to a specific agent (alternative to positional arg)')
    .action(async (agentArg, options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();

      const agentInput = agentArg || options.agent;
      let filterAgent: AgentId | undefined;
      let filterVersion: string | undefined;

      if (agentInput) {
        const parts = agentInput.split('@');
        const resolved = resolveAgentName(parts[0]);
        if (!resolved) {
          spinner.stop();
          console.log(chalk.red(formatAgentError(parts[0], SKILLS_CAPABLE_AGENTS)));
          process.exit(1);
        }
        filterAgent = resolved;
        filterVersion = parts[1] || undefined;
      }

      const rows = await buildSkillRows({ filterAgent, filterVersion });

      spinner.stop();

      await showResourceList({
        resourcePlural: 'skills',
        resourceSingular: 'skill',
        extraLabel: 'Files',
        rows,
        emptyMessage: filterAgent
          ? `No skills in central storage for ${agentLabel(filterAgent)}.`
          : 'No skills in ~/.agents/skills/. Add one with: agents skills add gh:user/repo',
        centralPath: getSkillsDir(),
        filterAgent,
        filterVersion,
      });
    });

  skillsCmd
    .command('add [source]')
    .description('Install skills from a source (GitHub, local) or pick from central storage')
    .option('-a, --agents <list>', 'Targets: claude, codex@0.116.0, or gemini@default')
    .option('--names <list>', 'Skill names from ~/.agents/skills/ (comma-separated)')
    .option('-y, --yes', 'Skip all prompts')
    .addHelpText('after', `
Examples:
  # Interactive picker from ~/.agents/skills/
  agents skills add

  # Install a specific skill to one version
  agents skills add --names api-testing --agents codex@0.116.0

  # Clone and install skills from GitHub
  agents skills add gh:anthropics/skills --agents claude,codex

  # Add a local skill directory (must contain SKILL.md)
  agents skills add ~/my-skill --agents claude@default
`)
    .action(async (source: string | undefined, options) => {
      try {
        let skills: { name: string; path?: string; metadata: { description?: string }; ruleCount?: number }[];

        if (!source) {
          // Interactive mode: pick from central storage
          const installedSkills = listInstalledSkills();
          if (installedSkills.size === 0) {
            console.log(chalk.yellow('No skills in ~/.agents/skills/'));
            console.log(chalk.gray('\nTo add skills from a repo:'));
            console.log(chalk.cyan('  agents skills add gh:user/repo'));
            return;
          }

          const availableSkills = Array.from(installedSkills.keys());
          const requestedNames = parseCommaSeparatedList(options.names);
          let selectedNames: string[];

          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !installedSkills.has(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown skill(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${availableSkills.join(', ')}`));
              process.exit(1);
            }
            selectedNames = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting skills from ~/.agents/skills/', [
                'agents skills add --names agents-cli --agents codex',
                'agents skills add gh:user/repo --agents codex',
              ]);
            }

            const choices = Array.from(installedSkills.entries()).map(([name, skill]) => ({
              value: name,
              name: skill.metadata.description
                ? `${name}  ${chalk.gray(skill.metadata.description.slice(0, 50))}`
                : name,
            }));

            const selected = await checkbox({
              message: 'Select skills to install',
              choices: [
                { value: '__all__', name: chalk.bold('Select All') },
                ...choices,
              ],
            });

            if (selected.length === 0) {
              console.log(chalk.gray('No skills selected.'));
              return;
            }

            selectedNames = selected.includes('__all__')
              ? availableSkills
              : selected.filter((s) => s !== '__all__');
          }

          skills = selectedNames.map((name) => {
            const skill = installedSkills.get(name);
            return { name, metadata: skill?.metadata || {} };
          });
        } else {
          // Source provided: fetch from repo or local path
          const spinner = ora('Fetching skills...').start();

          const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                            source.startsWith('ssh:') || source.startsWith('https://') ||
                            source.startsWith('http://');

          let localPath: string;
          let discoveredSkills: ReturnType<typeof discoverSkillsFromRepo>;

          if (isGitRepo) {
            const result = await cloneRepo(source);
            localPath = result.localPath;
            discoveredSkills = discoverSkillsFromRepo(localPath);
            spinner.succeed('Repository cloned');
          } else {
            localPath = source.startsWith('~')
              ? path.join(os.homedir(), source.slice(1))
              : path.resolve(source);

            if (!fs.existsSync(localPath)) {
              spinner.fail(`Path not found: ${localPath}`);
              return;
            }

            const skillMdPath = path.join(localPath, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
              const skillName = path.basename(localPath);
              const { validateSkillMetadata, countSkillRules } = await import('../lib/skills.js');
              const parseResult = tryParseSkillMetadata(localPath);
              const validation = validateSkillMetadata(parseResult.metadata, skillName);

              // Warn if YAML is invalid
              if (parseResult.error) {
                spinner.warn(`Skill '${skillName}' has invalid SKILL.md`);
                console.log(chalk.yellow(`  ${parseResult.error}`));
                console.log(chalk.gray('  The skill will be installed but may not appear in listings.\n'));
              } else {
                spinner.succeed('Using skill directory');
              }

              discoveredSkills = [{
                name: skillName,
                path: localPath,
                metadata: parseResult.metadata || { name: skillName, description: '' },
                ruleCount: countSkillRules(localPath),
                validation,
              }];
            } else {
              discoveredSkills = discoverSkillsFromRepo(localPath);
              spinner.succeed('Using local path');
            }
          }

          console.log(chalk.bold(`\nFound ${discoveredSkills.length} skill(s):`));

          if (discoveredSkills.length === 0) {
            console.log(chalk.yellow('No skills found (looking for SKILL.md files)'));
            return;
          }

          for (const skill of discoveredSkills) {
            const nameColor = skill.parseError ? chalk.yellow : chalk.cyan;
            console.log(`\n  ${nameColor(skill.name)}: ${skill.metadata.description || 'no description'}`);
            if (skill.ruleCount > 0) {
              console.log(`    ${chalk.gray(`${skill.ruleCount} rules`)}`);
            }
            if (skill.parseError) {
              console.log(`    ${chalk.yellow('Warning:')} ${chalk.gray(skill.parseError)}`);
            }
          }

          // Install to central storage first
          const installSpinner = ora('Installing skills to central storage...').start();
          let installed = 0;

          for (const skill of discoveredSkills) {
            const result = installSkillCentrally(skill.path, skill.name);
            if (result.success) {
              installed++;
            } else {
              installSpinner.stop();
              console.log(chalk.red(`\n  Failed to install ${skill.name}: ${result.error}`));
              installSpinner.start();
            }
          }

          installSpinner.succeed(`Installed ${installed} skills to ~/.agents/skills/`);
          skills = discoveredSkills;
        }

        // Get agent and version selection
        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        if (options.agents) {
          const result = resolveAgentVersionTargets(options.agents, SKILLS_CAPABLE_AGENTS);
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        } else {
          const result = await promptAgentVersionSelection(SKILLS_CAPABLE_AGENTS, {
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
        const skillNames = skills.map((s) => s.name);

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'skills', skillNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nSkills installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add skills'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  skillsCmd
    .command('remove [name]')
    .description('Delete a skill from central storage (interactive picker if no name given)')
    .addHelpText('after', `
Examples:
  # Remove a skill by name
  agents skills remove api-testing

  # Interactive: pick skills to remove
  agents skills remove
`)
    .action(async (name?: string) => {
      let skillsToRemove: string[];

      if (name) {
        skillsToRemove = [name];
      } else {
        // Interactive picker
        const installedSkills = listInstalledSkills();
        if (installedSkills.size === 0) {
          console.log(chalk.yellow('No skills installed.'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting skills to remove', [
            'agents skills remove agents-cli',
          ]);
        }

        try {
          const choices = Array.from(installedSkills.entries()).map(([skillName, skill]) => ({
            value: skillName,
            name: skill.metadata.description
              ? `${skillName} - ${skill.metadata.description}`
              : skillName,
          }));

          const selected = await checkbox({
            message: 'Select skills to remove',
            choices,
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No skills selected.'));
            return;
          }

          skillsToRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      for (const skillName of skillsToRemove) {
        const result = uninstallSkill(skillName);
        if (result.success) {
          console.log(chalk.green(`Removed skill '${skillName}'`));
        } else {
          console.log(chalk.red(result.error || `Failed to remove skill '${skillName}'`));
        }
      }
    });

  skillsCmd
    .command('sync')
    .description('Reconcile version-home skills against central ~/.agents/skills/ (add + update, never delete)')
    .option('-a, --agent <agent>', 'Scope to a specific agent or agent@version')
    .option('-m, --method <method>', 'Install method: copy (default) or symlink', 'copy')
    .addHelpText('after', `
Examples:
  # Sync every installed version of every skills-capable agent
  agents skills sync

  # Scope to one agent
  agents skills sync --agent claude

  # Scope to one version
  agents skills sync --agent claude@2.1.113

  # Symlink into version homes (central updates propagate automatically)
  agents skills sync --method symlink

Sync is additive: it installs missing skills and refreshes changed ones. To
remove orphans (skills in a version home but not in central), use 'agents
skills prune'.
`)
    .action(async (options) => {
      const method = (options.method === 'symlink' ? 'symlink' : 'copy') as 'symlink' | 'copy';

      let filter: { agent?: AgentId; version?: string } | undefined;
      if (options.agent) {
        const [name, version] = String(options.agent).split('@');
        const agentId = resolveAgentName(name);
        if (!agentId) {
          console.log(chalk.red(formatAgentError(name, SKILLS_CAPABLE_AGENTS)));
          process.exit(1);
        }
        filter = { agent: agentId, version: version || undefined };
      }

      const pairs = iterSkillsCapableVersions(filter);
      if (pairs.length === 0) {
        console.log(chalk.gray('No matching installed versions.'));
        return;
      }

      const diffs = pairs.map(({ agent, version }) => diffVersionSkills(agent, version));
      const plan = diffs.filter((d) => d.toAdd.length > 0 || d.toUpdate.length > 0);

      if (plan.length === 0) {
        console.log(chalk.green('All version homes are up to date with central.'));
        if (diffs.some((d) => d.orphans.length > 0)) {
          console.log(chalk.gray('Orphan skills present. Run \'agents skills prune --dry-run\' to review.'));
        }
        return;
      }

      console.log(chalk.bold(`Syncing skills (method: ${method})\n`));
      let adds = 0, updates = 0, failures = 0;
      for (const diff of plan) {
        const label = `${diff.agent}@${diff.version}`;
        if (diff.toAdd.length > 0) {
          console.log(`  ${chalk.cyan(label)} ${chalk.gray('add:')} ${diff.toAdd.join(', ')}`);
          for (const name of diff.toAdd) {
            const r = installSkillToVersion(diff.agent, diff.version, name, method);
            if (r.success) adds++;
            else { failures++; console.log(chalk.red(`    ! ${name}: ${r.error}`)); }
          }
        }
        if (diff.toUpdate.length > 0) {
          console.log(`  ${chalk.cyan(label)} ${chalk.gray('update:')} ${diff.toUpdate.join(', ')}`);
          for (const name of diff.toUpdate) {
            const r = installSkillToVersion(diff.agent, diff.version, name, method);
            if (r.success) updates++;
            else { failures++; console.log(chalk.red(`    ! ${name}: ${r.error}`)); }
          }
        }
      }

      console.log();
      console.log(chalk.green(`Synced: ${adds} added, ${updates} updated${failures > 0 ? chalk.red(`, ${failures} failed`) : ''}.`));

      const totalOrphans = diffs.reduce((n, d) => n + d.orphans.length, 0);
      if (totalOrphans > 0) {
        console.log(chalk.gray(`${totalOrphans} orphan(s) remain. Run 'agents skills prune --dry-run' to review.`));
      }
    });

  skillsCmd
    .command('prune')
    .description('Remove orphan skills from version homes (skills present locally but not in central)')
    .option('-a, --agent <agent>', 'Scope to a specific agent or agent@version')
    .option('--dry-run', 'Show orphans without deleting')
    .option('-y, --yes', 'Skip confirmation prompt')
    .addHelpText('after', `
Examples:
  # See what would be pruned
  agents skills prune --dry-run

  # Prune across every installed version (prompts for confirmation)
  agents skills prune

  # Scope to one agent or version
  agents skills prune --agent claude@2.0.65

  # Skip confirmation (for scripts)
  agents skills prune -y

Orphans are skills that exist inside a version home but are missing from the
central ~/.agents/skills/ source of truth. Usually they are leftovers from a
skill that was deleted centrally but never removed from the version install.
`)
    .action(async (options) => {
      let filter: { agent?: AgentId; version?: string } | undefined;
      if (options.agent) {
        const [name, version] = String(options.agent).split('@');
        const agentId = resolveAgentName(name);
        if (!agentId) {
          console.log(chalk.red(formatAgentError(name, SKILLS_CAPABLE_AGENTS)));
          process.exit(1);
        }
        filter = { agent: agentId, version: version || undefined };
      }

      const pairs = iterSkillsCapableVersions(filter);
      const diffs = pairs
        .map(({ agent, version }) => diffVersionSkills(agent, version))
        .filter((d) => d.orphans.length > 0);

      if (diffs.length === 0) {
        console.log(chalk.green('No orphan skills.'));
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
            message: `Delete ${total} orphan skill director${total === 1 ? 'y' : 'ies'}?`,
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
          const r = removeSkillFromVersion(d.agent, d.version, name);
          if (r.success) removed++;
          else { failures++; console.log(chalk.red(`  ! ${d.agent}@${d.version} ${name}: ${r.error}`)); }
        }
      }

      console.log(chalk.green(`Pruned ${removed} orphan(s)${failures > 0 ? chalk.red(`, ${failures} failed`) : ''}.`));
    });

  skillsCmd
    .command('view [name]')
    .description('Read skill metadata (name, description, rules count)')
    .addHelpText('after', `
Examples:
  # View details for a specific skill
  agents skills view api-testing

  # Interactive picker
  agents skills view
`)
    .action(async (name?: string) => {
      // If no name provided, show interactive select
      if (!name) {
        const cwd = process.cwd();
        const allSkills: Array<{ name: string; description: string }> = [];
        const seenNames = new Set<string>();

        for (const agentId of SKILLS_CAPABLE_AGENTS) {
          const skills = listInstalledSkillsWithScope(agentId, cwd);
          for (const skill of skills) {
            if (!seenNames.has(skill.name)) {
              seenNames.add(skill.name);
              allSkills.push({
                name: skill.name,
                description: skill.metadata.description || '',
              });
            }
          }
        }

        if (allSkills.length === 0) {
          console.log(chalk.yellow('No skills installed'));
          return;
        }

        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting a skill to view', [
            'agents skills view agents-cli',
          ]);
        }

        try {
          name = await select({
            message: 'Select a skill to view',
            choices: allSkills.map((s) => {
              const maxDescLen = Math.max(0, 70 - s.name.length);
              const desc = s.description.length > maxDescLen
                ? s.description.slice(0, maxDescLen - 3) + '...'
                : s.description;
              return {
                value: s.name,
                name: desc ? `${s.name} - ${desc}` : s.name,
              };
            }),
          });
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      const skill = getSkillInfo(name);
      if (!skill) {
        console.log(chalk.yellow(`Skill '${name}' not found`));
        return;
      }

      // Build output
      const lines: string[] = [];
      lines.push(chalk.bold(`\n${skill.metadata.name}\n`));
      if (skill.metadata.description) {
        lines.push(`  ${skill.metadata.description}`);
      }
      lines.push('');
      if (skill.metadata.author) {
        lines.push(`  Author: ${skill.metadata.author}`);
      }
      if (skill.metadata.version) {
        lines.push(`  Version: ${skill.metadata.version}`);
      }
      if (skill.metadata.license) {
        lines.push(`  License: ${skill.metadata.license}`);
      }
      lines.push(`  Path: ${skill.path}`);

      const rules = getSkillRules(name);
      if (rules.length > 0) {
        lines.push(chalk.bold(`\n  Rules (${rules.length}):\n`));
        for (const rule of rules) {
          lines.push(`    ${chalk.cyan(rule)}`);
        }
      }
      lines.push('');

      const output = lines.join('\n');
      printWithPager(output, lines.length);
    });

  // Deprecated alias for 'view'
  skillsCmd
    .command('info [name]', { hidden: true })
    .action(async (name?: string) => {
      console.log(chalk.yellow('Deprecated: Use "agents skills view" instead of "agents skills info"\n'));
      // Re-execute view command logic
      await skillsCmd.commands.find((c) => c.name() === 'view')?.parseAsync(['view', ...(name ? [name] : [])], { from: 'user' });
    });
}

/**
 * Build the row data for `agents skills list`. Each row = one central skill
 * with a sync-status target per (agent, version) in scope.
 */
async function buildSkillRows(opts: {
  filterAgent?: AgentId;
  filterVersion?: string;
}): Promise<ResourceRow[]> {
  const central = listInstalledSkills(); // Map<name, DiscoveredSkill>
  if (central.size === 0) return [];

  const targetPairs = iterSkillsCapableVersions({
    agent: opts.filterAgent,
    version: opts.filterVersion,
  });

  // Precompute per-(agent, version) diffs so we can look up each skill's
  // status without re-diffing 16 times per skill.
  const diffByTarget = new Map<string, VersionSkillDiff>();
  const defaultByAgent = new Map<AgentId, string | null>();
  for (const { agent, version } of targetPairs) {
    if (!defaultByAgent.has(agent)) defaultByAgent.set(agent, getGlobalDefault(agent));
    diffByTarget.set(`${agent}@${version}`, diffVersionSkills(agent, version));
  }

  const rows: ResourceRow[] = [];
  for (const [name, skill] of central) {
    const targets: SyncTarget[] = [];
    for (const { agent, version } of targetPairs) {
      const diff = diffByTarget.get(`${agent}@${version}`)!;
      let status: SyncTarget['status'];
      if (diff.matched.includes(name)) status = 'synced';
      else if (diff.toUpdate.includes(name)) status = 'stale';
      else status = 'missing';
      targets.push({
        agent,
        version,
        isDefault: defaultByAgent.get(agent) === version,
        status,
      });
    }

    const fileCount = countSkillFiles(skill.path);
    rows.push({
      name,
      description: skill.metadata.description,
      extra: fileCount > 0 ? `${fileCount}` : '-',
      targets,
      buildDetail: () => formatSkillDetail(name, skill, targets, fileCount),
    });
  }

  // Sort: fully-synced first, then partial, then missing — stable by name within each tier.
  rows.sort((a, b) => {
    const aSynced = a.targets.filter((t) => t.status === 'synced').length;
    const bSynced = b.targets.filter((t) => t.status === 'synced').length;
    if (aSynced !== bSynced) return bSynced - aSynced;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function formatSkillDetail(
  name: string,
  skill: { metadata: { description?: string; author?: string; version?: string; license?: string }; ruleCount: number; path: string },
  targets: SyncTarget[],
  fileCount: number
): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan(name));
  if (skill.metadata.description) {
    lines.push(chalk.gray(skill.metadata.description));
  }
  lines.push('');

  const meta: string[] = [];
  if (skill.metadata.author) meta.push(`author ${chalk.white(skill.metadata.author)}`);
  if (skill.metadata.version) meta.push(`v${chalk.white(skill.metadata.version)}`);
  if (skill.metadata.license) meta.push(`license ${chalk.white(skill.metadata.license)}`);
  meta.push(`${chalk.white(fileCount)} file${fileCount === 1 ? '' : 's'}`);
  if (skill.ruleCount > 0) {
    meta.push(`${chalk.white(skill.ruleCount)} rule${skill.ruleCount === 1 ? '' : 's'}`);
  }
  lines.push('  ' + meta.join(chalk.gray(' · ')));
  lines.push('  ' + chalk.gray(skill.path));

  const rules = getSkillRules(name);
  if (rules.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Rules'));
    lines.push('  ' + rules.map((r) => chalk.gray(r)).join(', '));
  }

  lines.push('');
  lines.push(chalk.bold('  Synced to'));
  lines.push(buildTargetsSection(targets));

  return lines.join('\n');
}
