/**
 * Cloud dispatch commands for running agent tasks on remote infrastructure.
 *
 * Provides a unified CLI for dispatching, monitoring, and managing tasks
 * across multiple cloud providers (Rush Cloud, Codex Cloud, Factory/Droid).
 * All tasks are tracked locally in a SQLite database for cross-provider listing.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import ora from 'ora';
import { resolveProvider, getAllProviders, getDefaultProviderId } from '../lib/cloud/registry.js';
import { insertTask, updateTaskStatus, getTaskById, listTasks as listStoredTasks, listActiveTasks } from '../lib/cloud/store.js';
import { renderStream } from '../lib/cloud/stream.js';
import type { CloudProviderId, CloudTaskStatus, DispatchOptions } from '../lib/cloud/types.js';

/** Print an error message to stderr and exit. */
function die(msg: string, code = 1): never {
  console.error(chalk.red(msg));
  process.exit(code);
}

/** Format an ISO timestamp as a human-readable relative time string. */
function relTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)} minutes ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hours ago`;
  return `${Math.floor(secs / 86400)} days ago`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '...';
}

/** Return a chalk color function appropriate for the given task status. */
function statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'queued':
    case 'allocating': return chalk.blue;
    case 'running': return chalk.yellow;
    case 'completed': return chalk.green;
    case 'input_required': return chalk.magenta;
    case 'failed': return chalk.red;
    case 'cancelled': return chalk.gray;
    default: return chalk.white;
  }
}

function isJsonMode(opts: { json?: boolean }): boolean {
  return Boolean(opts.json) || !process.stdout.isTTY;
}

/** Register the `agents cloud` command tree (run, list, status, logs, cancel, message, providers). */
export function registerCloudCommands(program: Command): void {
  const cloud = program
    .command('cloud')
    .description('Dispatch and manage cloud agent tasks across providers (Rush Cloud, Codex Cloud, Factory).');

  // ── agents cloud run ──────────────────────────────────────────────────
  cloud
    .command('run [prompt]')
    .description('Dispatch a task to a cloud agent.')
    .option('--provider <id>', 'Cloud backend: rush, codex, factory')
    .option('--agent <name>', 'Agent to run: claude, codex, droid')
    .option(
      '--repo <owner/repo>',
      'GitHub repository. Repeatable for multi-repo dispatch (Rush Cloud only).',
      (value: string, previous: string[] | undefined) => {
        const acc = Array.isArray(previous) ? previous : [];
        acc.push(value);
        return acc;
      },
    )
    .option('--branch <name>', 'Target git branch')
    .option('-p, --prompt <text>', 'Inline prompt (alternative to positional argument)')
    .option('--timeout <duration>', 'Kill after duration (e.g., 30m, 2h)')
    .option('--model <model>', 'Model override')
    .option('--env <id>', 'Codex Cloud environment ID')
    .option('--computer <name>', 'Factory/Droid computer target')
    .option('--mode <mode>', 'Execution mode (e.g., plan, edit, full)')
    .option('--json', 'Structured JSON output')
    .option('--no-follow', 'Dispatch and exit without streaming output')
    .addHelpText('after', `
Examples:
  # Rush Cloud
  agents cloud run "fix the flaky test" --provider rush --repo user/repo
  agents cloud run task.md --provider rush --repo org/project --agent codex

  # Rush Cloud — multi-repo (clones each into /workspace/<owner>/<name>/)
  agents cloud run "refactor shared logger" --provider rush --repo user/rush --repo user/agents

  # Codex Cloud
  agents cloud run "add auth tests" --provider codex --env env_abc123

  # Default provider (set in ~/.agents/agents.yaml)
  agents cloud run "refactor auth module" --repo user/repo
`)
    .action(async (positionalPrompt: string | undefined, options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });

      // Resolve prompt: --prompt flag, positional arg, or file
      let prompt = (options.prompt as string) || positionalPrompt;
      if (!prompt) die('Prompt is required. Pass it as an argument or with --prompt.');

      // If prompt is a file path, read it
      if (fs.existsSync(prompt) && fs.statSync(prompt).isFile()) {
        prompt = fs.readFileSync(prompt, 'utf-8').trim();
      }

      const provider = resolveProvider(options.provider as string | undefined);

      // --repo is repeatable: commander gives us an array via our collector.
      // A single --repo value arrives as a one-element array; keep the legacy
      // singular `repo` field in sync so providers that only know that field
      // still dispatch correctly.
      const repoValues = Array.isArray(options.repo)
        ? (options.repo as string[])
        : options.repo
          ? [options.repo as string]
          : [];

      const dispatchOptions: DispatchOptions = {
        prompt,
        agent: options.agent as string | undefined,
        repo: repoValues[0],
        repos: repoValues.length > 0 ? repoValues : undefined,
        branch: options.branch as string | undefined,
        timeout: options.timeout as string | undefined,
        model: options.model as string | undefined,
        providerOptions: {},
      };

      if (options.env) dispatchOptions.providerOptions!.env = options.env as string;
      if (options.computer) dispatchOptions.providerOptions!.computer = options.computer as string;
      if (options.mode) dispatchOptions.providerOptions!.mode = options.mode as string;

      // Dispatch
      const spinner = ora({ text: `Dispatching to ${provider.name}...`, stream: process.stderr }).start();
      let task;
      try {
        task = await provider.dispatch(dispatchOptions);
        spinner.succeed(`Task ${task.id} dispatched to ${provider.name}`);
      } catch (err) {
        spinner.fail('Dispatch failed');
        die((err as Error).message);
      }

      // Persist locally
      insertTask(task);

      if (json) {
        process.stdout.write(JSON.stringify(task) + '\n');
      }

      // Stream output unless --no-follow
      if (options.follow === false) return;

      try {
        const result = await renderStream(provider.stream(task.id), { json });
        updateTaskStatus(task.id, result.status as CloudTaskStatus, {
          summary: result.summary,
          prUrl: result.prUrl,
        });
      } catch (err) {
        // Stream disconnect is OK — task keeps running
        process.stderr.write(chalk.dim(`\nStream disconnected. Task ${task.id} continues running.\n`));
        process.stderr.write(chalk.dim(`Check status: agents cloud status ${task.id}\n`));
      }
    });

  // ── agents cloud list ─────────────────────────────────────────────────
  cloud
    .command('list')
    .description('List cloud tasks.')
    .option('--provider <id>', 'Filter by provider')
    .option('--status <status>', 'Filter by status')
    .option('--limit <n>', 'Max results', '20')
    .option('--json', 'JSON output')
    .action(async (options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });
      const providerId = options.provider as CloudProviderId | undefined;
      const status = options.status as CloudTaskStatus | undefined;
      const limit = parseInt(options.limit as string, 10) || 20;

      // Auto-refresh tasks still in transient states (queued, allocating, running, input_required).
      // Groups by provider to minimise resolver calls, refreshes each via provider.status().
      const activeTasks = listActiveTasks();
      if (activeTasks.length > 0) {
        const byProvider = new Map<CloudProviderId, string[]>();
        for (const t of activeTasks) {
          if (providerId && t.provider !== providerId) continue;
          let ids = byProvider.get(t.provider);
          if (!ids) { ids = []; byProvider.set(t.provider, ids); }
          ids.push(t.id);
        }

        const refreshJobs: Promise<void>[] = [];
        for (const [pid, ids] of byProvider) {
          try {
            const provider = resolveProvider(pid);
            for (const id of ids) {
              refreshJobs.push(
                provider.status(id)
                  .then((fresh) => { insertTask(fresh); })
                  .catch(() => {}),  // stale cache is acceptable if API is down
              );
            }
          } catch {
            // provider not configured — skip
          }
        }

        if (refreshJobs.length > 0) {
          await Promise.allSettled(refreshJobs);
        }
      }

      const tasks = listStoredTasks({ provider: providerId, status, limit });

      if (json) {
        process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
        return;
      }

      if (tasks.length === 0) {
        console.log(chalk.dim('No cloud tasks found.'));
        return;
      }

      // Table header
      const header = [
        chalk.dim('ID'.padEnd(14)),
        chalk.dim('Provider'.padEnd(10)),
        chalk.dim('Status'.padEnd(16)),
        chalk.dim('Agent'.padEnd(8)),
        chalk.dim('Prompt'.padEnd(40)),
        chalk.dim('When'),
      ].join('  ');
      console.log(header);
      console.log(chalk.dim('-'.repeat(100)));

      for (const t of tasks) {
        const row = [
          t.id.slice(0, 12).padEnd(14),
          t.provider.padEnd(10),
          statusColor(t.status)(t.status.padEnd(16)),
          (t.agent ?? '-').padEnd(8),
          truncate(t.prompt.replace(/\n/g, ' '), 40).padEnd(40),
          chalk.dim(relTime(t.createdAt)),
        ].join('  ');
        console.log(row);
      }
    });

  // ── agents cloud status ───────────────────────────────────────────────
  cloud
    .command('status <id>')
    .description('Show task detail and latest status.')
    .option('--json', 'JSON output')
    .action(async (id: string, options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });

      // Try local first, then remote
      let task = getTaskById(id);
      const providerId = task?.provider;

      if (providerId) {
        try {
          const provider = resolveProvider(providerId);
          task = await provider.status(id);
          insertTask(task);
        } catch {
          // Fall back to local cache
        }
      }

      if (!task) die(`Task ${id} not found.`);

      if (json) {
        process.stdout.write(JSON.stringify(task, null, 2) + '\n');
        return;
      }

      console.log(`${chalk.bold('Task')} ${task.id}`);
      console.log(`  ${chalk.dim('Provider:')}  ${task.provider}`);
      console.log(`  ${chalk.dim('Status:')}    ${statusColor(task.status)(task.status)}`);
      if (task.agent) console.log(`  ${chalk.dim('Agent:')}     ${task.agent}`);
      if (task.repo) console.log(`  ${chalk.dim('Repo:')}      ${task.repo}`);
      if (task.branch) console.log(`  ${chalk.dim('Branch:')}    ${task.branch}`);
      if (task.prUrl) console.log(`  ${chalk.dim('PR:')}        ${task.prUrl}`);
      console.log(`  ${chalk.dim('Prompt:')}    ${truncate(task.prompt.replace(/\n/g, ' '), 80)}`);
      console.log(`  ${chalk.dim('Created:')}   ${relTime(task.createdAt)}`);
      if (task.summary) {
        console.log(`  ${chalk.dim('Summary:')}   ${truncate(task.summary.replace(/\n/g, ' '), 120)}`);
      }
    });

  // ── agents cloud logs ─────────────────────────────────────────────────
  cloud
    .command('logs <id>')
    .description('Stream live output from a cloud task.')
    .option('-f, --follow', 'Follow output (default for running tasks)', true)
    .option('--json', 'JSON event stream')
    .action(async (id: string, options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });

      const task = getTaskById(id);
      if (!task) die(`Task ${id} not found locally. Run 'agents cloud list' first.`);

      const provider = resolveProvider(task.provider);

      try {
        const result = await renderStream(provider.stream(id), { json });
        updateTaskStatus(id, result.status as CloudTaskStatus, {
          summary: result.summary,
          prUrl: result.prUrl,
        });
      } catch (err) {
        process.stderr.write(chalk.dim(`\nStream ended. ${(err as Error).message}\n`));
      }
    });

  // ── agents cloud cancel ───────────────────────────────────────────────
  cloud
    .command('cancel <id>')
    .description('Cancel a running cloud task.')
    .action(async (id: string) => {
      const task = getTaskById(id);
      if (!task) die(`Task ${id} not found.`);

      const provider = resolveProvider(task.provider);

      try {
        await provider.cancel(id);
        updateTaskStatus(id, 'cancelled');
        console.log(chalk.green(`Task ${id} cancelled.`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  // ── agents cloud message ──────────────────────────────────────────────
  cloud
    .command('message <id> <text>')
    .description('Send a follow-up message to a finished or needs-review task.')
    .action(async (id: string, text: string) => {
      const task = getTaskById(id);
      if (!task) die(`Task ${id} not found.`);

      const provider = resolveProvider(task.provider);

      try {
        await provider.message(id, text);
        updateTaskStatus(id, 'running');
        console.log(chalk.green(`Message sent to task ${id}. Agent is continuing.`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  // ── agents cloud providers ────────────────────────────────────────────
  cloud
    .command('providers')
    .description('List available cloud providers and their status.')
    .option('--json', 'JSON output')
    .action((options: Record<string, unknown>) => {
      const json = isJsonMode(options as { json?: boolean });
      const providers = getAllProviders();
      const defaultId = getDefaultProviderId();

      if (json) {
        const data = providers.map((p) => ({
          id: p.id,
          name: p.name,
          available: p.supports({} as DispatchOptions),
          default: p.id === defaultId,
        }));
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
      }

      console.log(chalk.bold('Cloud Providers\n'));
      for (const p of providers) {
        const available = p.supports({} as DispatchOptions);
        const isDefault = p.id === defaultId;
        const status = available ? chalk.green('ready') : chalk.dim('not configured');
        const defaultTag = isDefault ? chalk.cyan(' (default)') : '';
        console.log(`  ${p.id.padEnd(12)} ${p.name.padEnd(20)} ${status}${defaultTag}`);
      }
    });
}
