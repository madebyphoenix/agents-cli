import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';

import {
  readMeta,
  getRepoLocalPath as getRepoLocalPathFromState,
  getRepo,
  setRepo,
  removeRepo,
  getReposByPriority,
  getRepoPriority,
} from '../lib/state.js';

// Re-export for use by other command modules
export { getRepoLocalPathFromState as getRepoLocalPath };
import { REPO_PRIORITIES, DEFAULT_SYSTEM_REPO } from '../lib/types.js';
import type { RepoName } from '../lib/types.js';
import { cloneRepo, parseSource } from '../lib/git.js';
import { isPromptCancelled } from './utils.js';

/**
 * Ensure at least one repo is configured.
 * If not, automatically initialize the system repo from DEFAULT_SYSTEM_REPO.
 * Returns the highest priority repo's source.
 */
export async function ensureSource(repoName?: RepoName): Promise<string> {
  const meta = readMeta();

  // If specific repo requested, check if it exists
  if (repoName) {
    const repo = meta.repos[repoName];
    if (repo?.source) {
      return repo.source;
    }
    throw new Error(`Repo '${repoName}' not configured. Run: agents repo add <source> --name ${repoName}`);
  }

  // Check if any repo is configured
  const repos = getReposByPriority();
  if (repos.length > 0) {
    return repos[repos.length - 1].config.source;
  }

  // No repos configured - initialize system repo
  console.log(chalk.gray(`No repo configured. Initializing from ${DEFAULT_SYSTEM_REPO}...`));

  const parsed = parseSource(DEFAULT_SYSTEM_REPO);
  const { commit } = await cloneRepo(DEFAULT_SYSTEM_REPO);

  setRepo('system', {
    source: DEFAULT_SYSTEM_REPO,
    branch: parsed.ref || 'main',
    commit,
    lastSync: new Date().toISOString(),
    priority: REPO_PRIORITIES.system,
    readonly: true,
  });

  return DEFAULT_SYSTEM_REPO;
}

/**
 * Get local path for a named repo.
 */
export function getRepoPath(repoName: RepoName): string | null {
  const repo = getRepo(repoName);
  if (!repo) return null;
  return getRepoLocalPathFromState(repo.source);
}

export function registerRepoCommands(program: Command): void {
  const repoCmd = program
    .command('repo')
    .description('Manage .agents repos');

  repoCmd
    .command('list')
    .description('List configured repos')
    .action(() => {
      const scopes = getReposByPriority();

      if (scopes.length === 0) {
        console.log(chalk.yellow('No repos configured.'));
        console.log(chalk.gray('  Run: agents repo add <source>'));
        console.log();
        return;
      }

      console.log(chalk.bold('Configured Repos\n'));
      console.log(chalk.gray('  Repos are applied in priority order (higher overrides lower)\n'));

      for (const { name, config } of scopes) {
        const readonlyTag = config.readonly ? chalk.gray(' (readonly)') : '';
        console.log(`  ${chalk.bold(name)}${readonlyTag}`);
        console.log(`    Source:   ${config.source}`);
        console.log(`    Branch:   ${config.branch}`);
        console.log(`    Commit:   ${config.commit.substring(0, 8)}`);
        console.log(`    Priority: ${config.priority}`);
        console.log(`    Synced:   ${new Date(config.lastSync).toLocaleString()}`);
        console.log();
      }
    });

  repoCmd
    .command('add <source>')
    .description('Add or update a repo')
    .option('-s, --scope <scope>', 'Target repo name', 'user')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (source: string, options) => {
      const repoName = options.scope as RepoName;
      const existingRepo = getRepo(repoName);

      if (existingRepo && !options.yes) {
        const shouldOverwrite = await confirm({
          message: `Repo '${repoName}' already exists (${existingRepo.source}). Overwrite?`,
          default: false,
        });
        if (!shouldOverwrite) {
          console.log(chalk.yellow('Cancelled.'));
          return;
        }
      }

      if (existingRepo?.readonly && !options.yes) {
        console.log(chalk.red(`Repo '${repoName}' is readonly. Cannot overwrite.`));
        return;
      }

      const parsed = parseSource(source);
      const spinner = ora(`Cloning repository for ${repoName} repo...`).start();

      try {
        const { commit, isNew } = await cloneRepo(source);
        spinner.succeed(isNew ? 'Repository cloned' : 'Repository updated');

        const priority = getRepoPriority(repoName);
        setRepo(repoName, {
          source,
          branch: parsed.ref || 'main',
          commit,
          lastSync: new Date().toISOString(),
          priority,
          readonly: repoName === 'system',
        });

        console.log(chalk.green(`\nAdded repo '${repoName}' with priority ${priority}`));
        const repoHint = repoName === 'user' ? '' : ` --scope ${repoName}`;
        console.log(chalk.gray(`  Run: agents pull${repoHint} to sync commands`));
      } catch (err) {
        spinner.fail('Failed to add repo');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  repoCmd
    .command('remove <scope>')
    .description('Remove a repo')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (repoName: string, options) => {
      const existingRepo = getRepo(repoName);

      if (!existingRepo) {
        console.log(chalk.yellow(`Repo '${repoName}' not found.`));
        return;
      }

      if (existingRepo.readonly) {
        console.log(chalk.red(`Repo '${repoName}' is readonly. Cannot remove.`));
        return;
      }

      if (!options.yes) {
        const shouldRemove = await confirm({
          message: `Remove repo '${repoName}' (${existingRepo.source})?`,
          default: false,
        });
        if (!shouldRemove) {
          console.log(chalk.yellow('Cancelled.'));
          return;
        }
      }

      const removed = removeRepo(repoName);
      if (removed) {
        console.log(chalk.green(`Removed repo '${repoName}'`));
      } else {
        console.log(chalk.yellow(`Failed to remove repo '${repoName}'`));
      }
    });
}
