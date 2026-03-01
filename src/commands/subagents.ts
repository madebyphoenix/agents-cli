import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { checkbox } from '@inquirer/prompts';

import { AGENTS } from '../lib/agents.js';
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
import { isPromptCancelled } from './utils.js';

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
    .description('Manage subagent definitions');

  // agents subagents view [name]
  subagentsCmd
    .command('view [name]')
    .description('View subagents (list all if no name given)')
    .action(async (name?: string) => {
      if (name) {
        // Show details for a specific subagent
        const subagent = getInstalledSubagent(name);
        if (!subagent) {
          console.log(chalk.red(`Subagent '${name}' not found`));
          console.log(chalk.gray(`Run 'agents subagents view' to list all installed subagents`));
          process.exit(1);
        }

        console.log(chalk.bold(`\n${subagent.name}`));
        console.log(chalk.gray(`  Path: ${formatPath(subagent.path)}`));
        console.log(chalk.gray(`  Description: ${subagent.frontmatter.description}`));
        if (subagent.frontmatter.model) {
          console.log(chalk.gray(`  Model: ${subagent.frontmatter.model}`));
        }
        if (subagent.frontmatter.color) {
          console.log(chalk.gray(`  Color: ${subagent.frontmatter.color}`));
        }
        console.log(chalk.gray(`\n  Files:`));
        for (const file of subagent.files) {
          const filePath = path.join(subagent.path, file);
          const stat = fs.statSync(filePath);
          const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
          console.log(`    ${chalk.cyan(file)} ${chalk.gray(`(${size})`)}`);
        }
        console.log();
      } else {
        // List subagents per agent (like `agents view` shows versions)
        console.log(chalk.bold('\nInstalled Subagents\n'));

        let hasAny = false;

        for (const agentId of SUBAGENT_CAPABLE_AGENTS) {
          const versions = listInstalledVersions(agentId);
          if (versions.length === 0) continue;

          const defaultVer = getGlobalDefault(agentId);
          const agent = AGENTS[agentId];

          console.log(`  ${chalk.bold(agent.name)}`);

          for (const version of versions) {
            const isDefault = version === defaultVer;
            const home = getVersionHomePath(agentId, version);
            const subagents = listSubagentsForAgent(agentId, home);

            const versionLabel = isDefault ? `${version} ${chalk.green('(default)')}` : version;
            console.log(`    ${versionLabel}`);

            if (subagents.length === 0) {
              console.log(chalk.gray('      (none)'));
            } else {
              hasAny = true;
              const maxNameLen = Math.max(...subagents.map(s => s.name.length));
              for (const sub of subagents) {
                const files = sub.files.length === 1 ? '1 file' : `${sub.files.length} files`;
                const desc = sub.frontmatter.description.slice(0, 40) || '';
                console.log(
                  `      ${chalk.cyan(sub.name.padEnd(maxNameLen))}  ${chalk.gray(desc)}  ${chalk.gray(`(${files})`)}`
                );
              }
            }
          }
          console.log();
        }

        if (!hasAny) {
          console.log(chalk.gray('  No subagents installed'));
          console.log(chalk.gray(`  Run 'agents subagents add <source>' to add one\n`));
        }
      }
    });

  // agents subagents add <source>
  subagentsCmd
    .command('add <source>')
    .description('Add subagent from source (gh:user/repo, URL, or local path)')
    .option('-a, --agents <agents...>', 'Target agents (claude, openclaw)')
    .option('-y, --yes', 'Skip confirmation prompts')
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

        syncSpinner.succeed(`Synced to ${targetAgents.map(id => AGENTS[id].name).join(', ')}`);
      }

      console.log();
    });

  // agents subagents remove <name>
  subagentsCmd
    .command('remove <name>')
    .description('Remove a subagent')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (name, options) => {
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
