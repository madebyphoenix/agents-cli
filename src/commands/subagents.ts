import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { checkbox } from '@inquirer/prompts';

import { AGENTS, agentLabel } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverSubagentsFromRepo,
  installSubagentCentrally,
  removeSubagent,
  listInstalledSubagents,
  getInstalledSubagent,
  listSubagentsForAgent,
  SUBAGENT_CAPABLE_AGENTS,
} from '../lib/subagents.js';
import {
  listInstalledVersions,
  syncResourcesToVersion,
  getGlobalDefault,
  getVersionHomePath,
} from '../lib/versions.js';
import { getSubagentsDir } from '../lib/state.js';
import {
  isInteractiveTerminal,
  isPromptCancelled,
  requireInteractiveSelection,
  requireDestructiveArg,
} from './utils.js';
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';

function formatPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

export function registerSubagentsCommands(program: Command): void {
  const subagentsCmd = program
    .command('subagents')
    .description('Install specialized agent definitions that parent agents can spawn for focused tasks')
    .addHelpText('after', `
Subagents are lightweight agent definitions (AGENT.md files) that a parent agent can spawn for specific subtasks. Each subagent has its own model, mode, and instruction set, stored in ~/.agents/subagents/ and synced to agent homes on install.

Examples:
  # List all installed subagents by agent and version
  agents subagents view

  # View details for a specific subagent
  agents subagents view code-reviewer

  # Install subagents from GitHub
  agents subagents add gh:team/subagents --agents claude,openclaw

  # Add from a local directory
  agents subagents add ~/my-subagent --agents claude

When to use:
  - Multi-agent workflows: install subagents that parent agents spawn for specialized work
  - Version isolation: sync different subagent sets to different agent versions
  - Team sharing: distribute subagent definitions via GitHub repos
`);

  // agents subagents view [name]
  subagentsCmd
    .command('view [name]')
    .description('Show subagents in a table with sync status across agent versions (or details for one)')
    .addHelpText('after', `
Examples:
  # Interactive picker (TTY) or sync-status table (piped)
  agents subagents view

  # View a specific subagent's details
  agents subagents view code-reviewer
`)
    .action(async (name?: string) => {
      if (name) {
        // Show details for a specific subagent
        const subagent = getInstalledSubagent(name);
        if (!subagent) {
          console.log(chalk.red(`Subagent '${name}' not found`));
          console.log(chalk.gray(`Run 'agents subagents view' to list all installed subagents`));
          process.exit(1);
        }

        console.log(formatSubagentDetail(subagent, buildSubagentTargets(subagent.name)));
        return;
      }

      const rows = buildSubagentRows();
      await showResourceList({
        resourcePlural: 'subagents',
        resourceSingular: 'subagent',
        extraLabel: 'Files',
        rows,
        emptyMessage: 'No subagents in ~/.agents/subagents/. Add one with: agents subagents add gh:user/repo',
        centralPath: getSubagentsDir(),
      });
    });

  // agents subagents add <source>
  subagentsCmd
    .command('add <source>')
    .description('Install subagents from a source (GitHub, local path) and sync to agent versions')
    .option('-a, --agents <agents...>', 'Targets: claude, openclaw (defaults to all subagent-capable agents)')
    .option('-y, --yes', 'Skip all prompts and confirmations')
    .addHelpText('after', `
Examples:
  # Install from GitHub
  agents subagents add gh:team/subagents --agents claude,openclaw

  # Install from local directory (must contain subagents/*/AGENT.md)
  agents subagents add ~/my-subagent --agents claude

  # Install non-interactively
  agents subagents add gh:user/repo --yes
`)
    .action(async (source, options) => {
      const spinner = ora({ text: 'Fetching source...', isSilent: !process.stdout.isTTY }).start();

      // Clone or use local source
      let sourcePath: string;
      if (source.startsWith('gh:') || source.startsWith('http')) {
        try {
          const cloneResult = await cloneRepo(source);
          sourcePath = cloneResult.localPath;
        } catch (err) {
          spinner.fail(`Failed to clone: ${(err as Error).message}`);
          process.exit(1);
        }
      } else if (fs.existsSync(source)) {
        sourcePath = path.resolve(source);
      } else {
        spinner.fail(`Source not found: ${source}`);
        process.exit(1);
      }

      // Discover subagents
      spinner.text = 'Discovering subagents...';
      const discovered = discoverSubagentsFromRepo(sourcePath);

      if (discovered.length === 0) {
        spinner.fail('No subagents found in source');
        console.log(chalk.gray(`Expected: subagents/*/AGENT.md`));
        process.exit(1);
      }

      spinner.succeed(`Found ${discovered.length} subagent(s)`);

      // Show what we found
      console.log();
      for (const sub of discovered) {
        console.log(`  ${chalk.cyan(sub.name)}: ${chalk.gray(sub.frontmatter.description)}`);
      }
      console.log();

      // Determine target agents
      let targetAgents: AgentId[] = options.agents || [];

      if (targetAgents.length === 0 && !options.yes) {
        // Prompt for target agents
        const installedAgents = SUBAGENT_CAPABLE_AGENTS.filter(id => {
          const versions = listInstalledVersions(id);
          return versions.length > 0;
        });

        if (installedAgents.length === 0) {
          console.log(chalk.yellow('No subagent-capable agents installed'));
          console.log(chalk.gray('Subagents will be stored centrally and synced when you install claude or openclaw'));
          targetAgents = [];
        } else {
          if (!isInteractiveTerminal()) {
            requireInteractiveSelection('Selecting target agents for subagents', [
              'agents subagents add <source> --agents claude openclaw',
              'agents subagents add <source> --yes',
            ]);
          }
          try {
            targetAgents = await checkbox({
              message: 'Install to which agents?',
              choices: installedAgents.map(id => ({
                name: AGENTS[id].name,
                value: id,
                checked: true,
              })),
            });
          } catch (err) {
            if (isPromptCancelled(err)) return;
            throw err;
          }
        }
      }

      // Install centrally
      const installSpinner = ora({ text: 'Installing subagents...', isSilent: !process.stdout.isTTY }).start();

      for (const sub of discovered) {
        const result = installSubagentCentrally(sub.path, sub.name);
        if (!result.success) {
          installSpinner.fail(`Failed to install ${sub.name}: ${result.error}`);
          process.exit(1);
        }
      }

      installSpinner.succeed(`Installed ${discovered.length} subagent(s) to ${formatPath(getSubagentsDir())}`);

      // Sync to target agents
      if (targetAgents.length > 0) {
        const syncSpinner = ora({ text: 'Syncing to agents...', isSilent: !process.stdout.isTTY }).start();

        for (const agentId of targetAgents) {
          const versions = listInstalledVersions(agentId);
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
          }
        }

        syncSpinner.succeed(`Synced to ${targetAgents.map(id => agentLabel(id)).join(', ')}`);
      }

      console.log();
    });

  // agents subagents remove [name]
  subagentsCmd
    .command('remove [name]')
    .description('Delete a subagent from central storage and unsync from all agent versions')
    .option('-y, --yes', 'Skip confirmation prompt')
    .addHelpText('after', `
Examples:
  # Remove a subagent by name
  agents subagents remove code-reviewer

  # Remove without confirmation
  agents subagents remove code-reviewer --yes
`)
    .action(async (nameArg, options) => {
      if (!nameArg) {
        requireDestructiveArg({
          argName: 'name',
          command: 'agents subagents remove',
          itemNoun: 'subagent',
          available: listInstalledSubagents().map((s) => s.name),
          emptyHint: 'No subagents installed.',
        });
      }
      const name = nameArg;
      const subagent = getInstalledSubagent(name);
      if (!subagent) {
        console.log(chalk.red(`Subagent '${name}' not found`));
        process.exit(1);
      }

      const spinner = ora({ text: `Removing ${name}...`, isSilent: !process.stdout.isTTY }).start();

      const result = removeSubagent(name);
      if (!result.success) {
        spinner.fail(`Failed to remove: ${result.error}`);
        process.exit(1);
      }

      // Re-sync all installed versions to remove from agent homes
      for (const agentId of SUBAGENT_CAPABLE_AGENTS) {
        const versions = listInstalledVersions(agentId);
        for (const version of versions) {
          syncResourcesToVersion(agentId, version);
        }
      }

      spinner.succeed(`Removed subagent '${name}'`);
    });
}

import type { InstalledSubagent } from '../lib/types.js';

/** Every (agent, version) that supports subagents and is installed. */
function iterSubagentCapableVersions(): Array<{ agent: AgentId; version: string; home: string }> {
  const out: Array<{ agent: AgentId; version: string; home: string }> = [];
  for (const agent of SUBAGENT_CAPABLE_AGENTS) {
    for (const version of listInstalledVersions(agent)) {
      out.push({ agent, version, home: getVersionHomePath(agent, version) });
    }
  }
  return out;
}

/** Compute sync targets for a single subagent by name across all capable versions. */
function buildSubagentTargets(name: string): SyncTarget[] {
  const targets: SyncTarget[] = [];
  for (const { agent, version, home } of iterSubagentCapableVersions()) {
    const installed = listSubagentsForAgent(agent, home).some((s) => s.name === name);
    targets.push({
      agent,
      version,
      isDefault: getGlobalDefault(agent) === version,
      status: installed ? 'synced' : 'missing',
    });
  }
  return targets;
}

function buildSubagentRows(): ResourceRow[] {
  const central = listInstalledSubagents();
  if (central.length === 0) return [];

  const pairs = iterSubagentCapableVersions();

  // Read each target's installed subagents once; lookup by name per row.
  const installedByTarget = new Map<string, Set<string>>();
  for (const { agent, version, home } of pairs) {
    const names = new Set(listSubagentsForAgent(agent, home).map((s) => s.name));
    installedByTarget.set(`${agent}@${version}`, names);
  }

  const rows: ResourceRow[] = [];
  for (const sub of central) {
    const targets: SyncTarget[] = [];
    for (const { agent, version } of pairs) {
      const set = installedByTarget.get(`${agent}@${version}`)!;
      targets.push({
        agent,
        version,
        isDefault: getGlobalDefault(agent) === version,
        status: set.has(sub.name) ? 'synced' : 'missing',
      });
    }

    rows.push({
      name: sub.name,
      description: sub.frontmatter.description,
      extra: String(sub.files.length),
      targets,
      buildDetail: () => formatSubagentDetail(sub, targets),
    });
  }

  rows.sort((a, b) => {
    const aSynced = a.targets.filter((t) => t.status === 'synced').length;
    const bSynced = b.targets.filter((t) => t.status === 'synced').length;
    if (aSynced !== bSynced) return bSynced - aSynced;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function formatSubagentDetail(sub: InstalledSubagent, targets: SyncTarget[]): string {
  const lines: string[] = [];
  lines.push(chalk.bold.cyan(sub.name));
  if (sub.frontmatter.description) {
    lines.push(chalk.gray(sub.frontmatter.description));
  }

  const meta: string[] = [];
  if (sub.frontmatter.model) meta.push(`model ${chalk.white(sub.frontmatter.model)}`);
  if (sub.frontmatter.color) meta.push(`color ${chalk.white(sub.frontmatter.color)}`);
  meta.push(`${chalk.white(sub.files.length)} file${sub.files.length === 1 ? '' : 's'}`);
  lines.push('  ' + meta.join(chalk.gray(' · ')));
  lines.push('  ' + chalk.gray(formatPath(sub.path)));

  if (sub.files.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Files'));
    for (const file of sub.files) {
      const filePath = path.join(sub.path, file);
      try {
        const stat = fs.statSync(filePath);
        const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
        lines.push(`    ${chalk.cyan(file)} ${chalk.gray(`(${size})`)}`);
      } catch {
        lines.push(`    ${chalk.cyan(file)}`);
      }
    }
  }

  if (targets.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Synced to'));
    lines.push(buildTargetsSection(targets));
  }

  return lines.join('\n');
}
