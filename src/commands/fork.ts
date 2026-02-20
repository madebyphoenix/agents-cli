import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

import { getAgentsDir, ensureAgentsDir, ensureGitignore } from '../lib/state.js';
import {
  isGitRepo,
  isSystemRepoOrigin,
  getGitHubUsername,
  hasLocalChanges,
  setUpstreamRemote,
  setRemoteUrl,
  getRemoteUrl,
} from '../lib/git.js';
import { DEFAULT_SYSTEM_REPO } from '../lib/types.js';
import { isPromptCancelled } from './utils.js';

export function registerForkCommand(program: Command): void {
  program
    .command('fork')
    .description('Fork system repo to your GitHub and reconfigure remotes')
    .action(async () => {
      try {
        const agentsDir = getAgentsDir();
        ensureAgentsDir();
        ensureGitignore();

        // Check if ~/.agents/ is a git repo
        if (!isGitRepo(agentsDir)) {
          console.log(chalk.yellow('~/.agents/ is not a git repository.'));
          console.log(chalk.gray('\nInitialize first:'));
          console.log(chalk.cyan('  agents pull'));
          return;
        }

        // Check if already forked (origin is not system repo)
        if (!await isSystemRepoOrigin(agentsDir)) {
          const currentOrigin = await getRemoteUrl(agentsDir);
          console.log(chalk.green('Already forked!'));
          console.log(chalk.gray(`\nOrigin: ${currentOrigin}`));
          console.log(chalk.gray('\nTo push your changes:'));
          console.log(chalk.cyan('  agents push'));
          console.log(chalk.gray('\nTo pull updates from system repo:'));
          console.log(chalk.cyan('  agents pull --upstream'));
          return;
        }

        // Get GitHub username
        const spinner = ora('Checking GitHub...').start();
        const username = await getGitHubUsername();
        if (!username) {
          spinner.fail('GitHub CLI not authenticated');
          console.log(chalk.gray('\nTo authenticate:'));
          console.log(chalk.cyan('  gh auth login'));
          return;
        }
        spinner.succeed(`Logged in as ${username}`);

        // Fork the system repo
        const forkSpinner = ora('Forking system repo...').start();
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        try {
          // gh repo fork creates a fork and optionally clones it
          // We just want to create the fork on GitHub, not clone
          await execAsync(`gh repo fork muqsitnawaz/.agents --clone=false`);
          forkSpinner.succeed(`Forked to ${username}/.agents`);
        } catch (err) {
          const errorMsg = (err as Error).message;
          // Check if fork already exists
          if (errorMsg.includes('already exists') || errorMsg.includes('409')) {
            forkSpinner.info(`Fork ${username}/.agents already exists`);
          } else {
            forkSpinner.fail(`Failed to fork: ${errorMsg}`);
            return;
          }
        }

        // Reconfigure remotes
        const remoteSpinner = ora('Reconfiguring remotes...').start();

        // Set current origin as upstream
        await setUpstreamRemote(agentsDir, 'https://github.com/muqsitnawaz/.agents.git');

        // Set user's fork as new origin
        await setRemoteUrl(agentsDir, `https://github.com/${username}/.agents.git`);

        remoteSpinner.succeed('Reconfigured remotes');
        console.log(chalk.gray(`  origin   -> ${username}/.agents`));
        console.log(chalk.gray(`  upstream -> muqsitnawaz/.agents`));

        // Commit any local changes
        if (await hasLocalChanges(agentsDir)) {
          const commitSpinner = ora('Committing local changes...').start();
          const simpleGit = (await import('simple-git')).default;
          const git = simpleGit(agentsDir);
          await git.add('-A');
          await git.commit('Local changes before fork');
          commitSpinner.succeed('Committed local changes');
        }

        // Push to new origin
        const pushSpinner = ora('Pushing to your fork...').start();
        try {
          const simpleGit = (await import('simple-git')).default;
          const git = simpleGit(agentsDir);
          await git.push('origin', 'main', ['--set-upstream']);
          pushSpinner.succeed('Pushed to your fork');
        } catch (err) {
          pushSpinner.fail(`Push failed: ${(err as Error).message}`);
          console.log(chalk.yellow('\nYou can push manually later:'));
          console.log(chalk.cyan('  agents push'));
          return;
        }

        console.log(chalk.green('\nFork complete!'));
        console.log(chalk.gray(`\nView: https://github.com/${username}/.agents`));
        console.log(chalk.gray('\nTo push future changes:'));
        console.log(chalk.cyan('  agents push'));
        console.log(chalk.gray('\nTo pull updates from system repo:'));
        console.log(chalk.cyan('  agents pull --upstream'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          process.exit(0);
        }
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
