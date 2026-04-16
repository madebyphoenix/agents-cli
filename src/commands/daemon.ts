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
import {
  isReportRunning,
  readReportPid,
  readReportLog,
  startReportDaemon,
  stopReportDaemon,
  runReportDaemon,
} from '../lib/report.js';
import { loadDaemonConfig } from '../lib/factory.js';

export function registerDaemonCommands(program: Command): void {
  const daemonCmd = program.command('daemon').description('Manage the jobs daemon');

  daemonCmd
    .command('start')
    .description('Start the daemon')
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
    .description('Stop the daemon')
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
    .description('Show daemon status')
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
    .description('Show daemon logs')
    .option('-n, --lines <number>', 'Number of lines to show', '50')
    .option('-f, --follow', 'Follow log output')
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

  // ---------------------------------------------------------------------------
  // Report command - reports local sessions to Factory Floor
  // ---------------------------------------------------------------------------

  const reportCmd = daemonCmd
    .command('report')
    .description('Report local sessions to Factory Floor');

  reportCmd
    .command('start')
    .description('Start reporting sessions to Factory Floor')
    .option('--node-token <token>', 'Node token from Factory Floor')
    .option('--endpoint <url>', 'Factory Floor endpoint', 'https://agents.427yosemite.com')
    .action(async (options) => {
      const config = loadDaemonConfig();
      const nodeToken = options.nodeToken || config.nodeToken;

      if (!nodeToken) {
        console.error(chalk.red('Error: --node-token is required for first run'));
        console.log(chalk.gray('\nTo get a node token:'));
        console.log(chalk.gray('  1. Open Factory Floor: https://agents.427yosemite.com'));
        console.log(chalk.gray('  2. Click "Add Machine"'));
        console.log(chalk.gray('  3. Copy the token and run:'));
        console.log(chalk.cyan('\n  agents daemon report start --node-token <your-token>\n'));
        process.exit(1);
      }

      if (isReportRunning()) {
        const pid = readReportPid();
        console.log(chalk.yellow(`Report daemon already running (PID: ${pid})`));
        return;
      }

      try {
        const result = startReportDaemon({
          nodeToken,
          endpoint: options.endpoint,
        });
        console.log(chalk.green(`Report daemon started (PID: ${result.pid})`));
        console.log(chalk.gray(`Endpoint: ${options.endpoint}`));
        console.log(chalk.gray(`Syncing sessions every 30 seconds`));
      } catch (err) {
        console.error(chalk.red(`Failed to start: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  reportCmd
    .command('stop')
    .description('Stop reporting sessions')
    .action(() => {
      if (!isReportRunning()) {
        console.log(chalk.yellow('Report daemon is not running'));
        return;
      }
      stopReportDaemon();
      console.log(chalk.green('Report daemon stopped'));
    });

  reportCmd
    .command('status')
    .description('Show report daemon status')
    .action(() => {
      const running = isReportRunning();
      const pid = readReportPid();
      const config = loadDaemonConfig();

      console.log(chalk.bold('Report Daemon Status\n'));
      console.log(`  Status:    ${running ? chalk.green('running') : chalk.gray('stopped')}`);
      if (pid) console.log(`  PID:       ${pid}`);
      if (config.nodeId) console.log(`  Node ID:   ${config.nodeId}`);
      if (config.endpoint) console.log(`  Endpoint:  ${config.endpoint}`);
      if (config.lastSync) {
        const ago = Math.round((Date.now() - config.lastSync) / 1000);
        console.log(`  Last sync: ${ago} seconds ago`);
      }
    });

  reportCmd
    .command('logs')
    .description('Show report daemon logs')
    .option('-n, --lines <number>', 'Number of lines to show', '50')
    .option('-f, --follow', 'Follow log output')
    .action(async (options) => {
      if (options.follow) {
        const { exec: execCb } = await import('child_process');
        const { getAgentsDir } = await import('../lib/state.js');
        const logPath = path.join(getAgentsDir(), 'report.log');
        const child = execCb(`tail -f "${logPath}"`);
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
        child.on('exit', () => process.exit(0));
        process.on('SIGINT', () => { child.kill(); process.exit(0); });
        return;
      }

      const lines = parseInt(options.lines, 10);
      const output = readReportLog(lines);
      if (output) {
        console.log(output);
      } else {
        console.log(chalk.gray('No report logs'));
      }
    });

  // Hidden command for internal foreground execution
  daemonCmd
    .command('_report', { hidden: true })
    .description('Run report daemon in foreground (internal)')
    .requiredOption('--node-token <token>', 'Node token')
    .requiredOption('--endpoint <url>', 'Factory Floor endpoint')
    .action(async (options) => {
      await runReportDaemon({
        nodeToken: options.nodeToken,
        endpoint: options.endpoint,
      });
    });
}
