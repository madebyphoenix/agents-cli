import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

import {
  isDaemonRunning,
  signalDaemonReload,
} from '../lib/daemon.js';
import {
  listJobs as listAllJobs,
  deleteJob,
  readJob,
  validateJob,
  writeJob,
  setJobEnabled,
  listRuns,
  getLatestRun,
  getRunDir,
  getJobPath,
  parseAtTime,
} from '../lib/cron.js';
import type { JobConfig } from '../lib/cron.js';
import { getCronDir } from '../lib/state.js';
import { executeJob } from '../lib/runner.js';
import { JobScheduler } from '../lib/scheduler.js';

function isPromptCancelled(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes('User force closed') ||
      err.name === 'ExitPromptError' ||
      (err as any).code === 'ERR_USE_AFTER_CLOSE')
  );
}

async function pickJob(message: string, filter?: (job: JobConfig) => boolean): Promise<string | null> {
  let jobs = listAllJobs();
  if (filter) {
    jobs = jobs.filter(filter);
  }

  if (jobs.length === 0) {
    console.log(chalk.yellow('No jobs available'));
    return null;
  }

  try {
    const { select } = await import('@inquirer/prompts');
    return await select({
      message,
      choices: jobs.map((job) => ({
        value: job.name,
        name: `${job.name} ${chalk.gray(`(${job.agent}, ${job.schedule})`)}`,
      })),
    });
  } catch (err) {
    if (isPromptCancelled(err)) {
      console.log(chalk.gray('Cancelled'));
      return null;
    }
    throw err;
  }
}

export function registerCronCommands(program: Command): void {
  const cronCmd = program.command('cron').description('Manage scheduled jobs');

  cronCmd
    .command('list')
    .description('List all jobs')
    .action(() => {
      const jobs = listAllJobs();
      if (jobs.length === 0) {
        console.log(chalk.gray('No jobs configured'));
        console.log(chalk.gray('  Add a job: agents cron add <path-to-job.yml>'));
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

  cronCmd
    .command('add [nameOrPath]')
    .description('Add a job from YAML file or inline flags')
    .option('-s, --schedule <cron>', 'Cron schedule (e.g., "0 9 * * 1-5")')
    .option('-a, --agent <agent>', 'Agent to use (claude, codex, gemini, cursor, opencode)')
    .option('-p, --prompt <prompt>', 'Prompt for the agent')
    .option('-m, --mode <mode>', 'Mode: plan or edit', 'plan')
    .option('-e, --effort <effort>', 'Effort level: fast, default, detailed', 'default')
    .option('-t, --timeout <timeout>', 'Timeout (e.g., 30m, 2h)', '30m')
    .option('--timezone <tz>', 'Timezone (e.g., America/Los_Angeles)')
    .option('--at <time>', 'One-shot: run once at time (e.g., "14:30" or "2026-02-24 09:00")')
    .option('--disabled', 'Create job in disabled state')
    .action(async (nameOrPath: string | undefined, options) => {
      // Check if inline mode (has flags) or file mode
      const hasInlineFlags = options.schedule || options.agent || options.prompt || options.at;

      if (hasInlineFlags) {
        // Inline mode: create job from flags
        if (!nameOrPath) {
          console.log(chalk.red('Job name is required'));
          console.log(chalk.gray('Usage: agents cron add <name> --schedule "..." --agent <agent> --prompt "..."'));
          process.exit(1);
        }

        let schedule = options.schedule;
        let runOnce = false;

        // Handle --at for one-shot jobs
        if (options.at) {
          const parsed = parseAtTime(options.at);
          if (!parsed) {
            console.log(chalk.red(`Invalid --at format: ${options.at}`));
            console.log(chalk.gray('Supported formats: "14:30" or "2026-02-24 09:00"'));
            process.exit(1);
          }
          schedule = parsed.schedule;
          runOnce = parsed.runOnce;
        }

        if (!schedule) {
          console.log(chalk.red('Schedule is required (use --schedule or --at)'));
          process.exit(1);
        }

        if (!options.agent) {
          console.log(chalk.red('Agent is required (use --agent)'));
          process.exit(1);
        }

        if (!options.prompt) {
          console.log(chalk.red('Prompt is required (use --prompt)'));
          process.exit(1);
        }

        const config: JobConfig = {
          name: nameOrPath,
          schedule,
          agent: options.agent,
          mode: options.mode,
          effort: options.effort,
          timeout: options.timeout,
          enabled: !options.disabled,
          prompt: options.prompt,
          timezone: options.timezone,
          ...(runOnce ? { runOnce: true } : {}),
        };

        const errors = validateJob(config);
        if (errors.length > 0) {
          console.log(chalk.red('Validation errors:'));
          for (const err of errors) {
            console.log(chalk.red(`  - ${err}`));
          }
          process.exit(1);
        }

        writeJob(config);
        console.log(chalk.green(`Job '${nameOrPath}' added`));
        if (runOnce) {
          console.log(chalk.gray(`One-shot job scheduled for: ${options.at}`));
        }

        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Daemon reloaded'));
        }
      } else {
        // File mode: load from YAML file
        if (!nameOrPath) {
          console.log(chalk.red('File path or job name with flags is required'));
          console.log(chalk.gray('Usage: agents cron add <path-to-job.yml>'));
          console.log(chalk.gray('   or: agents cron add <name> --schedule "..." --agent <agent> --prompt "..."'));
          process.exit(1);
        }

        const resolved = path.resolve(nameOrPath);
        if (!fs.existsSync(resolved)) {
          console.log(chalk.red(`File not found: ${resolved}`));
          process.exit(1);
        }

        const content = fs.readFileSync(resolved, 'utf-8');
        let parsed: any;
        try {
          parsed = yaml.parse(content);
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
      }
    });

  cronCmd
    .command('remove [name]')
    .description('Remove a cron job')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to remove') ?? undefined;
        if (!name) return;
      }

      const deleted = deleteJob(name);
      if (deleted) {
        console.log(chalk.green(`Job '${name}' removed`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Daemon reloaded'));
        }
      } else {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }
    });

  cronCmd
    .command('view [name]')
    .description('Show job configuration')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to view') ?? undefined;
        if (!name) return;
      }

      const job = readJob(name);
      if (!job) {
        console.log(chalk.red(`Job '${name}' not found`));
        process.exit(1);
      }

      console.log(chalk.bold(`Job: ${name}\n`));
      console.log(yaml.stringify(job));
    });

  cronCmd
    .command('edit [name]')
    .description('Edit job configuration in $EDITOR')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to edit') ?? undefined;
        if (!name) return;
      }

      const jobPath = getJobPath(name);
      if (!jobPath) {
        // Job doesn't exist - create a new one
        const cronDir = getCronDir();
        const newPath = path.join(cronDir, `${name}.yml`);

        // Create template
        const template = yaml.stringify({
          name,
          schedule: '0 9 * * *',
          agent: 'claude',
          prompt: 'Your prompt here',
        });
        fs.writeFileSync(newPath, template, 'utf-8');
        console.log(chalk.gray(`Created new job file: ${newPath}`));
      }

      const targetPath = jobPath || path.join(getCronDir(), `${name}.yml`);
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';

      const { spawn: spawnSync } = await import('child_process');
      const child = spawnSync(editor, [targetPath], {
        stdio: 'inherit',
        shell: true,
      });

      child.on('close', (code) => {
        if (code === 0) {
          // Validate the edited file
          const job = readJob(name!);
          if (job) {
            const errors = validateJob(job);
            if (errors.length > 0) {
              console.log(chalk.yellow('\nWarning: Job has validation errors:'));
              for (const err of errors) {
                console.log(chalk.yellow(`  - ${err}`));
              }
            } else {
              console.log(chalk.green(`\nJob '${name}' saved`));
              if (isDaemonRunning()) {
                signalDaemonReload();
                console.log(chalk.gray('Daemon reloaded'));
              }
            }
          }
        }
      });
    });

  cronCmd
    .command('runs [name]')
    .description('Show execution history')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to view runs') ?? undefined;
        if (!name) return;
      }

      const runs = listRuns(name);
      if (runs.length === 0) {
        console.log(chalk.yellow(`No runs found for job '${name}'`));
        return;
      }

      console.log(chalk.bold(`Execution History: ${name}\n`));
      for (const run of runs.slice(-10)) {
        const status = run.status === 'completed'
          ? chalk.green(run.status)
          : run.status === 'failed'
            ? chalk.red(run.status)
            : chalk.yellow(run.status);
        console.log(`  ${run.runId}  ${status}  ${run.startedAt}`);
      }
    });

  cronCmd
    .command('run [name]')
    .description('Run a job immediately in the foreground')
    .action(async (name: string | undefined) => {
      if (!name) {
        name = await pickJob('Select job to run') ?? undefined;
        if (!name) return;
      }

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

  cronCmd
    .command('logs [name]')
    .description('Show stdout from the latest (or specific) run')
    .option('-r, --run <runId>', 'Specific run ID')
    .action(async (name: string | undefined, options) => {
      if (!name) {
        name = await pickJob('Select job to view logs') ?? undefined;
        if (!name) return;
      }

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

  cronCmd
    .command('report [name]')
    .description('Show report from the latest (or specific) run')
    .option('-r, --run <runId>', 'Specific run ID')
    .action(async (name: string | undefined, options) => {
      if (!name) {
        name = await pickJob('Select job to view report') ?? undefined;
        if (!name) return;
      }

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

  cronCmd
    .command('resume [name]')
    .description('Resume a paused job')
    .action(async (name: string | undefined) => {
      if (!name) {
        // Only show paused jobs
        name = await pickJob('Select job to resume', (job) => !job.enabled) ?? undefined;
        if (!name) return;
      }

      try {
        setJobEnabled(name, true);
        console.log(chalk.green(`Job '${name}' resumed`));
        if (isDaemonRunning()) {
          signalDaemonReload();
          console.log(chalk.gray('Daemon reloaded'));
        }
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cronCmd
    .command('pause [name]')
    .description('Pause a job')
    .action(async (name: string | undefined) => {
      if (!name) {
        // Only show enabled jobs
        name = await pickJob('Select job to pause', (job) => job.enabled) ?? undefined;
        if (!name) return;
      }

      try {
        setJobEnabled(name, false);
        console.log(chalk.green(`Job '${name}' paused`));
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
