import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  AgentManager,
  checkAllClis,
  getAgentsDir,
  type AgentType,
} from '../lib/teams/agents.js';
import {
  handleSpawn,
  handleStatus,
  handleStop,
  handleTasks,
  type AgentStatusDetail,
} from '../lib/teams/api.js';

const VALID_AGENTS: AgentType[] = ['claude', 'codex', 'gemini', 'cursor', 'opencode'];
const VALID_MODES = ['plan', 'edit', 'ralph', 'cloud'] as const;
const VALID_EFFORTS = ['fast', 'default', 'detailed'] as const;

type Mode = (typeof VALID_MODES)[number];
type Effort = (typeof VALID_EFFORTS)[number];

// Auto-enable JSON mode when piped / not a TTY. AI agent consumers get
// parseable output by default without needing --json.
function isJsonMode(opts: { json?: boolean }): boolean {
  return Boolean(opts.json) || !process.stdout.isTTY;
}

function die(msg: string, code = 1): never {
  console.error(chalk.red(msg));
  process.exit(code);
}

function statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'running': return chalk.yellow;
    case 'completed': return chalk.green;
    case 'failed': return chalk.red;
    case 'stopped': return chalk.gray;
    default: return chalk.white;
  }
}

function relTime(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function printAgentDetail(a: AgentStatusDetail): void {
  const label = statusColor(a.status)(a.status.toUpperCase());
  console.log(
    `  ${chalk.cyan(a.agent_id)} ${a.agent_type.padEnd(8)} ${label}  ${chalk.gray(a.duration || '')}`
  );
  if (a.files_modified.length) console.log(`    ${chalk.gray('modified')}  ${a.files_modified.join(', ')}`);
  if (a.files_created.length)  console.log(`    ${chalk.gray('created ')}  ${a.files_created.join(', ')}`);
  if (a.files_read.length)     console.log(`    ${chalk.gray('read    ')}  ${a.files_read.join(', ')}`);
  if (a.files_deleted.length)  console.log(`    ${chalk.gray('deleted ')}  ${a.files_deleted.join(', ')}`);
  for (const cmd of a.bash_commands.slice(-3)) {
    console.log(`    ${chalk.gray('$')} ${truncate(cmd, 96)}`);
  }
  const lastMsg = a.last_messages[a.last_messages.length - 1];
  if (lastMsg) console.log(`    ${chalk.gray('>')} ${truncate(lastMsg, 96)}`);
  if (a.has_errors) console.log(`    ${chalk.red('errors reported')}`);
  if (a.pr_url) console.log(`    ${chalk.gray('PR')} ${a.pr_url}`);
}

export function registerTeamsCommands(program: Command): void {
  const teams = program
    .command('teams')
    .description('Spawn and orchestrate AI coding agents as named teams')
    .addHelpText('after', `
Examples:
  agents teams spawn auth-fix codex "Fix bug in src/auth.ts" --mode edit
  agents teams status auth-fix
  agents teams status auth-fix --since 2026-04-19T12:00:00Z --json
  agents teams stop auth-fix --agent-id a1b2c3d4
  agents teams list

A "team" is just a named group of agents working on a shared task. Agents
run detached in the background; poll progress with 'status' and capture the
'cursor' from each response to do efficient delta polling next time.
`);

  // teams list
  teams
    .command('list')
    .description('List teams, most recent activity first')
    .option('-n, --limit <n>', 'Max teams to show', '10')
    .option('--json', 'Output JSON')
    .action(async (opts: { limit: string; json?: boolean }) => {
      const mgr = new AgentManager();
      const limit = Math.max(1, parseInt(opts.limit, 10) || 10);
      const result = await handleTasks(mgr, limit);

      if (isJsonMode(opts)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.tasks.length === 0) {
        console.log(chalk.gray('No teams yet. Create one:'));
        console.log(chalk.gray('  agents teams spawn <team> <agent> "<prompt>"'));
        return;
      }

      const nameWidth = Math.max(12, ...result.tasks.map((t) => t.task_name.length));
      console.log(chalk.bold(`${'TEAM'.padEnd(nameWidth)}  AGENTS  STATE                          UPDATED`));
      for (const t of result.tasks) {
        const parts: string[] = [];
        if (t.running) parts.push(chalk.yellow(`${t.running} running`));
        if (t.completed) parts.push(chalk.green(`${t.completed} done`));
        if (t.failed) parts.push(chalk.red(`${t.failed} failed`));
        if (t.stopped) parts.push(chalk.gray(`${t.stopped} stopped`));
        const state = parts.join(' ') || chalk.gray('-');
        console.log(
          `${chalk.cyan(t.task_name.padEnd(nameWidth))}  ${String(t.agent_count).padEnd(6)}  ${state.padEnd(30)} ${chalk.gray(relTime(t.modified_at))}`
        );
      }
    });

  // teams spawn
  teams
    .command('spawn <team> <agent> <prompt>')
    .description('Spawn an agent into a team. Returns immediately with agent_id.')
    .option('-m, --mode <mode>', `Execution mode: ${VALID_MODES.join('|')}`, 'edit')
    .option('-e, --effort <effort>', `Model tier: ${VALID_EFFORTS.join('|')}`, 'default')
    .option('--cwd <dir>', "Working directory for the agent (defaults to current directory)")
    .option('--json', 'Output JSON')
    .action(async (team: string, agent: string, prompt: string, opts: {
      mode: string; effort: string; cwd?: string; json?: boolean;
    }) => {
      if (!VALID_AGENTS.includes(agent as AgentType)) {
        die(`Unknown agent '${agent}'. Use one of: ${VALID_AGENTS.join(', ')}`);
      }
      if (!(VALID_MODES as readonly string[]).includes(opts.mode)) {
        die(`Invalid mode '${opts.mode}'. Use one of: ${VALID_MODES.join(', ')}`);
      }
      if (!(VALID_EFFORTS as readonly string[]).includes(opts.effort)) {
        die(`Invalid effort '${opts.effort}'. Use one of: ${VALID_EFFORTS.join(', ')}`);
      }

      const cwd = opts.cwd ?? process.cwd();
      const mgr = new AgentManager();
      try {
        const result = await handleSpawn(
          mgr,
          team,
          agent as AgentType,
          prompt,
          cwd,
          opts.mode as Mode,
          opts.effort as Effort,
          null,
          cwd
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.green(`Spawned ${result.agent_type} into team ${chalk.cyan(result.task_name)}`));
        console.log(`  ${chalk.gray('agent_id')}   ${chalk.cyan(result.agent_id)}`);
        console.log(`  ${chalk.gray('status  ')}   ${statusColor(result.status)(result.status)}`);
        console.log(`  ${chalk.gray('started ')}   ${result.started_at}`);
        console.log();
        console.log(chalk.gray(`Poll with: agents teams status ${result.task_name}`));
      } catch (err) {
        die(`Spawn failed: ${(err as Error).message}`);
      }
    });

  // teams status
  teams
    .command('status <team>')
    .description("Show a team's progress. Pass --since <cursor> for delta polling.")
    .option('-f, --filter <state>', 'running|completed|failed|stopped|all', 'all')
    .option('-s, --since <iso>', 'Cursor from previous status call (only newer events)')
    .option('--agent-id <id>', 'Only this agent')
    .option('--json', 'Output JSON')
    .action(async (team: string, opts: {
      filter: string; since?: string; agentId?: string; json?: boolean;
    }) => {
      const mgr = new AgentManager();
      try {
        const result = await handleStatus(mgr, team, opts.filter, opts.since);
        const agents = opts.agentId
          ? result.agents.filter((a) => a.agent_id === opts.agentId)
          : result.agents;

        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ ...result, agents }, null, 2));
          return;
        }

        const { summary } = result;
        console.log(
          chalk.bold(`Team ${chalk.cyan(team)}  `) +
            chalk.gray(
              `(${summary.running} running, ${summary.completed} done, ${summary.failed} failed, ${summary.stopped} stopped)`
            )
        );

        if (agents.length === 0) {
          console.log(chalk.gray('  (no agents match)'));
        } else {
          for (const a of agents) {
            console.log();
            printAgentDetail(a);
          }
        }
        console.log();
        console.log(chalk.gray(`cursor: ${result.cursor}`));
      } catch (err) {
        die(`Status failed: ${(err as Error).message}`);
      }
    });

  // teams stop
  teams
    .command('stop <team>')
    .description('Stop all agents in a team, or one agent with --agent-id')
    .option('--agent-id <id>', 'Stop only this agent in the team')
    .option('--json', 'Output JSON')
    .action(async (team: string, opts: { agentId?: string; json?: boolean }) => {
      const mgr = new AgentManager();
      const result = await handleStop(mgr, team, opts.agentId);
      if ('error' in result) die(result.error);

      if (isJsonMode(opts)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.stopped.length) {
        console.log(chalk.green(`Stopped ${result.stopped.length} in team ${chalk.cyan(team)}:`));
        for (const id of result.stopped) console.log(`  ${chalk.cyan(id)}`);
      }
      if (result.already_stopped.length) {
        console.log(chalk.gray(`Already stopped: ${result.already_stopped.join(', ')}`));
      }
      if (result.not_found.length) {
        console.log(chalk.yellow(`Not found: ${result.not_found.join(', ')}`));
      }
      if (!result.stopped.length && !result.already_stopped.length && !result.not_found.length) {
        console.log(chalk.gray(`No agents to stop in team ${team}.`));
      }
    });

  // teams logs
  teams
    .command('logs <agent-id>')
    .description("Print an agent's raw stdout log")
    .option('-n, --tail <n>', 'Tail only the last N lines')
    .action(async (agentId: string, opts: { tail?: string }) => {
      const base = await getAgentsDir();
      const logPath = path.join(base, agentId, 'stdout.log');
      try {
        const content = await fs.readFile(logPath, 'utf-8');
        if (!opts.tail) {
          process.stdout.write(content);
          return;
        }
        const n = Math.max(1, parseInt(opts.tail, 10) || 50);
        const lines = content.split('\n');
        process.stdout.write(lines.slice(-n).join('\n'));
      } catch {
        die(`No logs for agent ${agentId} at ${logPath}`, 2);
      }
    });

  // teams doctor
  teams
    .command('doctor')
    .description('Check which agent CLIs are installed and usable')
    .option('--json', 'Output JSON')
    .action(async (opts: { json?: boolean }) => {
      const info = checkAllClis();
      if (isJsonMode(opts)) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      console.log(chalk.bold('Agent CLIs'));
      for (const [name, entry] of Object.entries(info)) {
        if (entry.installed) {
          console.log(`  ${chalk.green('ok ')}  ${name.padEnd(10)} ${chalk.gray(entry.path || '')}`);
        } else {
          console.log(`  ${chalk.red('no ')}  ${name.padEnd(10)} ${chalk.gray(entry.error || 'not installed')}`);
        }
      }
    });
}
