/**
 * PTY Commands
 *
 * CLI commands for managing interactive PTY sessions.
 * Auto-starts the sidecar server on first use.
 *
 * Usage:
 *   agents pty start [--rows 24 --cols 120 --shell zsh --cwd /path]
 *   agents pty exec  <id> <command>
 *   agents pty read  <id> [--ms 200]
 *   agents pty write <id> <input>
 *   agents pty screen <id>
 *   agents pty signal <id> [INT|TERM|KILL]
 *   agents pty list
 *   agents pty stop  <id>
 *   agents pty server [start|stop|status]
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { ptyRequest, unescapeInput } from '../lib/pty-client.js';
import { isPtyServerRunning, runPtyServer, getPtyPidPath, getPtyLogPath } from '../lib/pty-server.js';
import * as fs from 'fs';

export function registerPtyCommands(program: Command): void {
  const pty = program.command('pty').description('Interactive PTY sessions for AI agents');

  // --- Session lifecycle ---

  pty
    .command('start')
    .description('Start a new PTY session')
    .option('-r, --rows <n>', 'Terminal rows', '24')
    .option('-c, --cols <n>', 'Terminal columns', '120')
    .option('-s, --shell <shell>', 'Shell to use (default: $SHELL)')
    .option('-d, --cwd <dir>', 'Working directory')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const params: Record<string, any> = {
        rows: parseInt(opts.rows, 10),
        cols: parseInt(opts.cols, 10),
      };
      if (opts.shell) params.shell = opts.shell;
      if (opts.cwd) params.cwd = opts.cwd;

      const res = await ptyRequest('start', undefined, params);
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res));
      } else {
        console.log(res.id);
      }
    });

  pty
    .command('exec <id> <command>')
    .description('Execute a command in a PTY session (non-blocking)')
    .option('--wait <ms>', 'Wait for output after submission', '0')
    .option('--json', 'Output as JSON')
    .action(async (id, command, opts) => {
      const res = await ptyRequest('exec', id, { command });
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      const waitMs = parseInt(opts.wait, 10);
      if (waitMs > 0) {
        // Wait then return screen
        await new Promise(r => setTimeout(r, waitMs));
        const screen = await ptyRequest('screen', id);
        if (opts.json) {
          console.log(JSON.stringify(screen));
        } else if (screen.ok) {
          console.log(screen.screen);
        }
      } else if (opts.json) {
        console.log(JSON.stringify(res));
      }
    });

  pty
    .command('read <id>')
    .description('Read pending output from a PTY session')
    .option('-m, --ms <ms>', 'Wait timeout in ms (50-5000)', '200')
    .option('--json', 'Output as JSON')
    .action(async (id, opts) => {
      const ms = parseInt(opts.ms, 10);
      const res = await ptyRequest('read', id, { ms });
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res));
      } else {
        if (res.output) process.stdout.write(res.output);
      }
    });

  pty
    .command('write <id> <input>')
    .description('Send input to a PTY session (supports \\n \\t \\e \\xHH)')
    .option('--raw', 'Send input without escape processing')
    .option('--json', 'Output as JSON')
    .action(async (id, input, opts) => {
      const processed = opts.raw ? input : unescapeInput(input);
      const res = await ptyRequest('write', id, { input: processed });
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res));
      }
    });

  pty
    .command('screen <id>')
    .description('Render the current terminal screen as text')
    .option('--json', 'Output as JSON (includes cursor position)')
    .action(async (id, opts) => {
      const res = await ptyRequest('screen', id);
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res));
      } else {
        console.log(res.screen);
      }
    });

  pty
    .command('signal <id> [signal]')
    .description('Send a signal to the PTY process (INT, TERM, KILL)')
    .action(async (id, signal) => {
      const res = await ptyRequest('signal', id, { signal: signal || 'INT' });
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }
    });

  pty
    .command('resize <id>')
    .description('Resize a PTY session')
    .option('-r, --rows <n>', 'Terminal rows')
    .option('-c, --cols <n>', 'Terminal columns')
    .action(async (id, opts) => {
      const params: Record<string, any> = {};
      if (opts.rows) params.rows = parseInt(opts.rows, 10);
      if (opts.cols) params.cols = parseInt(opts.cols, 10);

      const res = await ptyRequest('resize', id, params);
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }
      console.log(`${res.cols}x${res.rows}`);
    });

  pty
    .command('stop <id>')
    .description('Stop a PTY session')
    .action(async (id) => {
      const res = await ptyRequest('stop', id);
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }
    });

  // --- Session listing ---

  pty
    .command('list')
    .description('List active PTY sessions')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const res = await ptyRequest('list');
      if (!res.ok) {
        console.error(chalk.red(res.error));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(res.sessions));
        return;
      }

      if (res.sessions.length === 0) {
        console.log(chalk.gray('No active PTY sessions'));
        return;
      }

      for (const s of res.sessions) {
        const age = formatAge(Date.now() - s.started_at);
        const status = s.exited
          ? chalk.red(`exited (${s.exit_code})`)
          : s.app_active
            ? chalk.yellow(`running: ${s.active_command}`)
            : chalk.green('idle');

        console.log(`  ${chalk.bold(s.id)}  pid=${s.pid}  ${s.shell}  ${s.cols}x${s.rows}  ${age}  ${status}`);
        console.log(`    ${chalk.gray(s.cwd)}`);
      }
    });

  // --- Server management ---

  const serverCmd = pty.command('server').description('Manage the PTY sidecar server');

  serverCmd
    .command('start')
    .description('Start the PTY server')
    .action(async () => {
      if (isPtyServerRunning()) {
        const pidPath = getPtyPidPath();
        const pid = fs.existsSync(pidPath) ? fs.readFileSync(pidPath, 'utf-8').trim() : '?';
        console.log(chalk.yellow(`PTY server already running (PID: ${pid})`));
        return;
      }

      // Use ptyRequest which auto-starts the server
      const res = await ptyRequest('ping');
      if (res.ok) {
        console.log(chalk.green(`PTY server started (PID: ${res.pid})`));
      } else {
        console.error(chalk.red('Failed to start PTY server'));
        process.exit(1);
      }
    });

  serverCmd
    .command('stop')
    .description('Stop the PTY server')
    .action(async () => {
      if (!isPtyServerRunning()) {
        console.log(chalk.yellow('PTY server is not running'));
        return;
      }

      const pidPath = getPtyPidPath();
      try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        process.kill(pid, 'SIGTERM');
        console.log(chalk.green('PTY server stopped'));
      } catch {
        console.error(chalk.red('Failed to stop PTY server'));
        process.exit(1);
      }
    });

  serverCmd
    .command('status')
    .description('Show PTY server status')
    .action(async () => {
      const running = isPtyServerRunning();
      console.log(`  Status: ${running ? chalk.green('running') : chalk.gray('stopped')}`);

      if (running) {
        try {
          const res = await ptyRequest('ping');
          if (res.ok) {
            console.log(`  PID:      ${res.pid}`);
            console.log(`  Sessions: ${res.sessions}`);
          }
        } catch {}
      }

      const logPath = getPtyLogPath();
      console.log(`  Log:    ${logPath}`);
    });

  // Internal: run server in foreground (spawned by auto-start)
  pty
    .command('_server', { hidden: true })
    .description('Run PTY server (internal)')
    .action(async () => {
      await runPtyServer();
    });
}

function formatAge(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
