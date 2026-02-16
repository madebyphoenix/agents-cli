import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';

import {
  isDaemonRunning,
  signalDaemonReload,
} from '../lib/daemon.js';
import {
  listJobs as listAllJobs,
  readJob,
  validateJob,
  writeJob,
  setJobEnabled,
  getLatestRun,
  getRunDir,
} from '../lib/jobs.js';
import type { JobConfig } from '../lib/jobs.js';
import { executeJob } from '../lib/runner.js';
import { JobScheduler } from '../lib/scheduler.js';

export function registerJobsCommands(program: Command): void {
  const jobsCmd = program.command('jobs').description('Manage scheduled jobs');

  jobsCmd
    .command('list')
    .description('List all jobs')
    .action(() => {
      const jobs = listAllJobs();
      if (jobs.length === 0) {
        console.log(chalk.gray('No jobs configured'));
        console.log(chalk.gray('  Add a job: agents jobs add <path-to-job.yml>'));
        return;
      }

      const scheduler = new JobScheduler(async () => {});
      scheduler.loadAll();

      console.log(chalk.bold('Scheduled Jobs\n'));

      const header = `  ${'Name'.padEnd(24)} ${'Agent'.padEnd(10)} ${'Schedule'.padEnd(20)} ${'Enabled'.padEnd(10)} ${'Next Run'.padEnd(24)} ${'Last Status'}`;
      console.log(chalk.gray(header));
      console.log(chalk.gray('  ' + '-'.repeat(110)));

      for (const job of jobs) {
        const nextRun = scheduler.getNextRun(job.name);
        const nextStr = nextRun ? nextRun.toLocaleString() : '-';
        const latestRun = getLatestRun(job.name);
        const lastStatus = latestRun?.status || '-';

        const enabledStr = job.enabled ? chalk.green('yes') : chalk.gray('no');
        const statusColor = lastStatus === 'completed' ? chalk.green : lastStatus === 'failed' ? chalk.red : lastStatus === 'timeout' ? chalk.yellow : chalk.gray;

        console.log(
          `  ${chalk.cyan(job.name.padEnd(24))} ${job.agent.padEnd(10)} ${job.schedule.padEnd(20)} ${enabledStr.padEnd(10 + 10)} ${chalk.gray(nextStr.padEnd(24))} ${statusColor(lastStatus)}`
        );
      }

      scheduler.stopAll();
      console.log();
    });

  jobsCmd
    .command('add <path>')
    .description('Add a job from a YAML file')
    .action(async (filePath: string) => {
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) {
        console.log(chalk.red(`File not found: ${resolved}`));
        process.exit(1);
      }

      const content = fs.readFileSync(resolved, 'utf-8');
      let parsed: any;
      try {
        const yamlMod = await import('yaml');
        parsed = yamlMod.parse(content);
      } catch (err) {
        console.log(chalk.red(`Invalid YAML: ${(err as Error).message}`));
        process.exit(1);
      }

      const name = parsed.name || path.basename(resolved).replace(/\.ya?ml$/, '');
      parsed.name = name;

      const errors = validateJob(parsed);
      if (errors.length > 0) {
        console.log(chalk.red('Validation errors:'));
        for (const err of errors) {
          console.log(chalk.red(`  - ${err}`));
        }
        process.exit(1);
      }

      const config: JobConfig = {
        mode: 'plan',
        effort: 'default',
        timeout: '30m',
        enabled: true,
        ...parsed,
      } as JobConfig;

      writeJob(config);
      console.log(chalk.green(`Job '${name}' added`));

      if (isDaemonRunning()) {
        signalDaemonReload();
        console.log(chalk.gray('Daemon reloaded'));
      }
    });

  jobsCmd
    .command('run <name>')
    .description('Run a job immediately in the foreground')
    .action(async (name: string) => {
      const job = readJob(name);
      if (!job) {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }

      console.log(chalk.bold(`Running job '${name}' (agent: ${job.agent}, mode: ${job.mode})\n`));
      const spinner = ora('Executing...').start();

      try {
        const result = await executeJob(job);
        if (result.meta.status === 'completed') {
          spinner.succeed(`Job completed (exit code: ${result.meta.exitCode})`);
        } else if (result.meta.status === 'timeout') {
          spinner.warn(`Job timed out after ${job.timeout}`);
        } else {
          spinner.fail(`Job failed (exit code: ${result.meta.exitCode})`);
        }

        console.log(chalk.gray(`  Run: ${result.meta.runId}`));
        console.log(chalk.gray(`  Log: ${getRunDir(name, result.meta.runId)}/stdout.log`));

        if (result.reportPath) {
          console.log(chalk.bold('\nReport:\n'));
          console.log(fs.readFileSync(result.reportPath, 'utf-8'));
        }
      } catch (err) {
        spinner.fail('Execution failed');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  jobsCmd
    .command('logs <name>')
    .description('Show stdout from the latest (or specific) run')
    .option('-r, --run <runId>', 'Specific run ID')
    .action((name: string, options) => {
      let runId = options.run;
      if (!runId) {
        const latest = getLatestRun(name);
        if (!latest) {
          console.log(chalk.yellow(`No runs found for job '${name}'`));
          return;
        }
        runId = latest.runId;
      }

      const logPath = path.join(getRunDir(name, runId), 'stdout.log');
      if (!fs.existsSync(logPath)) {
        console.log(chalk.yellow(`Log not found: ${logPath}`));
        return;
      }

      console.log(chalk.gray(`Run: ${runId}\n`));
      console.log(fs.readFileSync(logPath, 'utf-8'));
    });

  jobsCmd
    .command('report <name>')
    .description('Show report from the latest (or specific) run')
    .option('-r, --run <runId>', 'Specific run ID')
    .action((name: string, options) => {
      let runId = options.run;
      if (!runId) {
        const latest = getLatestRun(name);
        if (!latest) {
          console.log(chalk.yellow(`No runs found for job '${name}'`));
          return;
        }
        runId = latest.runId;
      }

      const reportPath = path.join(getRunDir(name, runId), 'report.md');
      if (!fs.existsSync(reportPath)) {
        console.log(chalk.yellow(`No report found for run ${runId}`));
        console.log(chalk.gray(`  Reports are extracted from agent output on completion`));
        return;
      }

      console.log(chalk.gray(`Run: ${runId}\n`));
      console.log(fs.readFileSync(reportPath, 'utf-8'));
    });

  jobsCmd
    .command('enable <name>')
    .description('Enable a job')
    .action((name: string) => {
      try {
        setJobEnabled(name, true);
        console.log(chalk.green(`Job '${name}' enabled`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Daemon reloaded'));
        }
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  jobsCmd
    .command('disable <name>')
    .description('Disable a job')
    .action((name: string) => {
      try {
        setJobEnabled(name, false);
        console.log(chalk.green(`Job '${name}' disabled`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Daemon reloaded'));
        }
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
