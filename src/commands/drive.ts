import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  setRemote,
  pull,
  push,
  attach,
  detach,
  getDriveStatus,
} from '../lib/drive-sync.js';

export function registerDriveCommands(program: Command): void {
  const driveCmd = program
    .command('drive')
    .description('Sync agent sessions across machines');

  driveCmd
    .command('remote <target>')
    .description('Set rsync remote target (e.g. muqsit@spark)')
    .action((target: string) => {
      try {
        setRemote(target);
        console.log(chalk.green(`Remote set to ${target}`));
        console.log(chalk.gray(`Syncs to ${target}:~/.agents/drive/`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  driveCmd
    .command('pull')
    .description('Pull sessions from remote')
    .action(async () => {
      const spinner = ora('Pulling from remote...').start();
      try {
        await pull();
        spinner.succeed('Pull complete');
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  driveCmd
    .command('push')
    .description('Push sessions to remote')
    .action(async () => {
      const spinner = ora('Pushing to remote...').start();
      try {
        await push();
        spinner.succeed('Push complete');
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  driveCmd
    .command('attach')
    .description('Use drive as active agent home')
    .action(() => {
      try {
        attach();
        console.log(chalk.green('Drive attached'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  driveCmd
    .command('detach')
    .description('Restore agent home to version config')
    .action(() => {
      try {
        detach();
        console.log(chalk.green('Drive detached'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  driveCmd
    .command('status')
    .description('Show drive state')
    .action(() => {
      const status = getDriveStatus();

      console.log(chalk.bold('Drive'));
      console.log(`  Remote:     ${status.remote || chalk.gray('not set')}`);
      console.log(`  Attached:   ${status.attached ? chalk.green('yes') : chalk.gray('no')}`);
      console.log(`  Last pull:  ${status.lastPull ? formatTime(status.lastPull) : chalk.gray('never')}`);
      console.log(`  Last push:  ${status.lastPush ? formatTime(status.lastPush) : chalk.gray('never')}`);
      console.log(`  Path:       ${chalk.gray(status.driveDir)}`);
      console.log('');
      console.log(chalk.bold('Symlinks'));
      console.log(`  ~/.claude       -> ${status.configDirTarget || chalk.gray('not a symlink')}`);
      for (const [hf, target] of Object.entries(status.homeFileTargets)) {
        console.log(`  ~/${hf}  -> ${target || chalk.gray('not a symlink')}`);
      }
    });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs === 1 ? '' : 's'} ago`;

  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}
