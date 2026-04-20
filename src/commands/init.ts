import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { select, input } from '@inquirer/prompts';

import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from '../lib/types.js';
import { getAgentsDir } from '../lib/state.js';
import { isGitRepo } from '../lib/git.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

function isValidSourceInput(value: string): true | string {
  const trimmed = value.trim();
  if (!trimmed) return 'Repo is required';
  // Accept gh:owner/repo, owner/repo, github.com/..., https://github.com/...
  if (
    trimmed.startsWith('gh:') ||
    trimmed.startsWith('github.com') ||
    trimmed.startsWith('https://github.com/') ||
    trimmed.startsWith('git@github.com:') ||
    /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed)
  ) {
    return true;
  }
  return 'Format: gh:owner/repo';
}

export async function runInit(program: Command, options: { force?: boolean } = {}): Promise<void> {
  const agentsDir = getAgentsDir();
  const metaFile = path.join(agentsDir, 'agents.yaml');
  const alreadyConfigured = fs.existsSync(metaFile) || isGitRepo(agentsDir);

  if (alreadyConfigured && !options.force) {
    console.log(chalk.yellow('~/.agents/ is already set up.'));
    console.log(chalk.gray('\nTo sync updates:      agents pull'));
    console.log(chalk.gray('To re-initialize:     agents init --force'));
    return;
  }

  if (!isInteractiveTerminal()) {
    console.error(chalk.red('agents init requires an interactive terminal.'));
    console.error(chalk.gray('\nNon-interactive setup:'));
    console.error(chalk.cyan(`  agents pull ${DEFAULT_SYSTEM_REPO}   # use the default config`));
    console.error(chalk.cyan(`  agents pull gh:you/.agents           # use your own repo`));
    process.exit(1);
  }

  console.log(chalk.bold('\nWelcome to agents-cli.'));
  console.log(chalk.gray('Let\'s pick where your agent config comes from.\n'));

  const choice = await select({
    message: "Where's your config?",
    choices: [
      {
        name: `Use default  (${systemRepoSlug(DEFAULT_SYSTEM_REPO)})`,
        value: 'default',
        description: 'Clones the curated config. Push later with `agents fork`.',
      },
      {
        name: 'Pull mine    (from GitHub)',
        value: 'mine',
        description: 'Use an existing .agents repo you own.',
      },
    ],
  });

  let source: string;
  if (choice === 'default') {
    source = DEFAULT_SYSTEM_REPO;
  } else {
    const answer = await input({
      message: 'Your repo (e.g. gh:you/.agents):',
      validate: isValidSourceInput,
    });
    source = answer.trim();
  }

  console.log();
  await program.parseAsync(['node', 'agents', 'pull', source]);

  console.log(chalk.bold('\nSetup complete. Try:'));
  console.log(chalk.cyan('  agents view                 ') + chalk.gray(' # see what\'s installed'));
  console.log(chalk.cyan('  agents run <agent> "hello"  ') + chalk.gray(' # run an agent'));
  if (choice === 'default') {
    console.log(chalk.gray('\nWhen you want to save your own changes, run:'));
    console.log(chalk.cyan('  agents fork'));
  }
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('First-time setup: pick a config source and install agents')
    .option('-f, --force', 'Re-run even if ~/.agents/ is already set up')
    .action(async (options) => {
      try {
        await runInit(program, options);
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        throw err;
      }
    });
}
