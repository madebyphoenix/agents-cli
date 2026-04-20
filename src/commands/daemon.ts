import type { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';

import {
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  readDaemonPid,
  readDaemonLog,
  runDaemon,
} from '../lib/daemon.js';
import { listJobs as listAllJobs } from '../lib/routines.js';
import { JobScheduler } from '../lib/scheduler.js';

export function registerDaemonCommands(program: Command): void {
  const daemonCmd = program
    .command('daemon')
    .description('Control the background daemon that executes routines on schedule. Routines only fire when the daemon is running.')
    .addHelpText(
      'after',
      `
The daemon is a background process that watches your routines and executes them
on schedule. It runs independently of your terminal session (safe to log out).

Start it once after boot or when you add your first routine. It reloads automatically
when you add, edit, or remove routines.

Examples:
  # Launch the daemon (required before routines will execute)
  agents daemon start

  # Check whether it's running and see upcoming routine executions
  agents daemon status

  # Stop the daemon (scheduled routines won't fire until you restart)
  agents daemon stop

  # Read daemon logs (useful when a routine behaves unexpectedly)
  agents daemon logs
  agents daemon logs --follow
`
    );

  daemonCmd
    .command('start')
    .description('Launch the daemon if not already running. Routines will begin firing on schedule.')
    .action(() => {
      const result = startDaemon();
      if (result.method === 'already-running') {
        console.log(chalk.yellow(`Daemon already running (PID: ${result.pid})`));
      } else {
        console.log(chalk.green(`Daemon started (PID: ${result.pid}, method: ${result.method})`));
      }
    });

  daemonCmd
    .command('stop')
    .description('Shut down the daemon. Scheduled routines will not execute until you start it again.')
    .action(() => {
      if (!isDaemonRunning()) {
        console.log(chalk.yellow('Daemon is not running'));
        return;
      }
      stopDaemon();
      console.log(chalk.green('Daemon stopped'));
    });

  daemonCmd
    .command('status')
    .description('Show whether the daemon is running, how many routines are enabled, and when they fire next')
    .action(() => {
      const running = isDaemonRunning();
      const pid = readDaemonPid();

      console.log(chalk.bold('Daemon Status\n'));
      console.log(`  Status:  ${running ? chalk.green('running') : chalk.gray('stopped')}`);
      if (pid) console.log(`  PID:     ${pid}`);

      const jobs = listAllJobs();
      const enabled = jobs.filter((j) => j.enabled);
      console.log(`  Jobs:    ${enabled.length} enabled / ${jobs.length} total`);

      if (running && enabled.length > 0) {
        const scheduler = new JobScheduler(async () => {});
        scheduler.loadAll();
        const scheduled = scheduler.listScheduled();
        console.log(chalk.bold('\n  Scheduled Jobs\n'));
        for (const job of scheduled) {
          const next = job.nextRun ? job.nextRun.toLocaleString() : 'unknown';
          console.log(`    ${chalk.cyan(job.name.padEnd(24))} next: ${chalk.gray(next)}`);
        }
        scheduler.stopAll();
      }
    });

  daemonCmd
    .command('logs')
    .description('Read daemon log output. Use --follow to stream new entries as they arrive.')
    .option('-n, --lines <number>', 'Show this many recent lines (default: 50)', '50')
    .option('-f, --follow', 'Stream log output in real time (like tail -f)')
    .action(async (options) => {
      if (options.follow) {
        const { exec: execCb } = await import('child_process');
        const { getAgentsDir } = await import('../lib/state.js');
        const logPath = path.join(getAgentsDir(), 'daemon.log');
        const child = execCb(`tail -f "${logPath}"`);
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
        child.on('exit', () => process.exit(0));
        process.on('SIGINT', () => { child.kill(); process.exit(0); });
        return;
      }

      const lines = parseInt(options.lines, 10);
      const output = readDaemonLog(lines);
      if (output) {
        console.log(output);
      } else {
        console.log(chalk.gray('No daemon logs'));
      }
    });

  daemonCmd
    .command('_run', { hidden: true })
    .description('Run daemon in foreground (internal)')
    .action(async () => {
      await runDaemon();
    });
}
