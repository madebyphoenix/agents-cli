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
  type TaskInfo,
} from '../lib/teams/api.js';
import {
  createTeam,
  ensureTeam,
  loadTeams,
  removeTeam,
  teamExists,
} from '../lib/teams/registry.js';
import { isVersionInstalled } from '../lib/versions.js';

const AGENT_NAMES: Record<AgentType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};

const VALID_AGENTS = Object.keys(AGENT_NAMES) as AgentType[];
const VALID_MODES = ['plan', 'edit', 'ralph', 'cloud'] as const;
const VALID_EFFORTS = ['fast', 'default', 'detailed'] as const;

type Mode = (typeof VALID_MODES)[number];
type Effort = (typeof VALID_EFFORTS)[number];

// Auto-enable JSON mode when piped / not a TTY so AI agent consumers get
// parseable output by default.
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

function fullName(type: AgentType, version: string | null | undefined): string {
  const name = AGENT_NAMES[type];
  return version ? `${name} ${version}` : name;
}

function parseTeammate(spec: string): { agent: AgentType; version: string | null } {
  const [name, version] = spec.split('@');
  if (!VALID_AGENTS.includes(name as AgentType)) {
    die(
      `Unknown teammate '${name}'. Available: ${VALID_AGENTS.join(', ')}.\n` +
        `  Use the form 'claude' or 'claude@2.1.112' (see 'agents view' for installed versions).`
    );
  }
  return { agent: name as AgentType, version: version || null };
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

// Pick the display handle for a teammate: their given name if they have one,
// otherwise the 8-char UUID prefix.
function handle(a: { name?: string | null; agent_id: string }): string {
  return a.name || shortId(a.agent_id);
}

type TeammateLookup =
  | { kind: 'ok'; agentId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: { team: string; agentId: string; display: string }[] };

// Resolve a teammate reference (name / UUID / UUID prefix) by scanning every
// meta.json under the agents dir. Team hint narrows the search.
async function resolveTeammateAcrossTeams(
  base: string,
  ref: string,
  teamHint?: string
): Promise<TeammateLookup> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(base);
  } catch {
    return { kind: 'none' };
  }

  // Cheap path: exact UUID or unique UUID prefix match by directory name.
  const byDir = entries.filter((e) => e === ref || e.startsWith(ref));
  if (byDir.length === 1 && byDir[0] === ref) {
    return { kind: 'ok', agentId: ref };
  }

  // Otherwise scan meta.json files to match on name as well, and respect the
  // team hint if given.
  const candidates: { team: string; agentId: string; display: string; name: string | null }[] = [];
  for (const dir of entries) {
    try {
      const meta = JSON.parse(
        await fs.readFile(path.join(base, dir, 'meta.json'), 'utf-8')
      );
      if (teamHint && meta.task_name !== teamHint) continue;
      const matchesName = meta.name && meta.name === ref;
      const matchesPrefix = dir.startsWith(ref);
      if (matchesName || matchesPrefix) {
        candidates.push({
          team: meta.task_name || '(none)',
          agentId: dir,
          display: meta.name || shortId(dir),
          name: meta.name || null,
        });
      }
    } catch {
      /* skip entries without readable meta.json */
    }
  }

  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'ok', agentId: candidates[0].agentId };

  // If multiple match but one is an exact name hit, prefer it.
  const exactName = candidates.filter((c) => c.name === ref);
  if (exactName.length === 1) return { kind: 'ok', agentId: exactName[0].agentId };

  return { kind: 'ambiguous', candidates };
}

function printAgentDetail(a: AgentStatusDetail): void {
  const label = statusColor(a.status)(a.status.toUpperCase());
  const who = fullName(a.agent_type as AgentType, a.version);
  const h = handle(a);
  const secondary = a.name ? chalk.gray(`(${shortId(a.agent_id)})`) : '';
  console.log(
    `  ${chalk.cyan(h.padEnd(10))} ${secondary.padEnd(11)} ${who.padEnd(18)} ${label}  ${chalk.gray(a.duration || '')}`
  );
  // If the agent's internal session id differs from ours (non-Claude), show
  // it as a hint for `agents sessions view <id>`.
  if (a.remote_session_id && a.remote_session_id !== a.agent_id) {
    console.log(`    ${chalk.gray('session ')} ${chalk.gray(a.remote_session_id)}`);
  }
  if (a.files_modified.length) console.log(`    ${chalk.gray('touched ')} ${a.files_modified.join(', ')}`);
  if (a.files_created.length)  console.log(`    ${chalk.gray('created ')} ${a.files_created.join(', ')}`);
  if (a.files_read.length)     console.log(`    ${chalk.gray('read    ')} ${a.files_read.join(', ')}`);
  if (a.files_deleted.length)  console.log(`    ${chalk.gray('deleted ')} ${a.files_deleted.join(', ')}`);
  for (const cmd of a.bash_commands.slice(-3)) {
    console.log(`    ${chalk.gray('$')} ${truncate(cmd, 96)}`);
  }
  const lastMsg = a.last_messages[a.last_messages.length - 1];
  if (lastMsg) console.log(`    ${chalk.gray('>')} ${truncate(lastMsg, 96)}`);
  if (a.has_errors) console.log(`    ${chalk.red('reported an error')}`);
  if (a.pr_url) console.log(`    ${chalk.gray('PR')} ${a.pr_url}`);
}

// Merge persistent team registry with tasks derived from live agents so empty
// teams (created but no teammates yet) still show up.
function mergeTeams(
  registry: Record<string, { created_at: string; description?: string }>,
  tasks: TaskInfo[]
): TaskInfo[] {
  const byName = new Map<string, TaskInfo>();
  for (const t of tasks) byName.set(t.task_name, t);
  for (const [name, meta] of Object.entries(registry)) {
    if (!byName.has(name)) {
      byName.set(name, {
        task_name: name,
        agent_count: 0,
        running: 0,
        completed: 0,
        failed: 0,
        stopped: 0,
        workspace_dir: null,
        created_at: meta.created_at,
        modified_at: meta.created_at,
      });
    }
  }
  return Array.from(byName.values()).sort(
    (a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime()
  );
}

export function registerTeamsCommands(program: Command): void {
  const teams = program
    .command('teams')
    .description('Organize AI coding agents into teams that collaborate on a shared task')
    .addHelpText(
      'after',
      `
Examples:
  agents teams create auth-feature
  agents teams add    auth-feature claude "Add JWT auth" --name alice
  agents teams add    auth-feature codex@0.116.0 "Write tests" --name bob
  agents teams status auth-feature
  agents teams remove auth-feature alice
  agents teams disband auth-feature

Short aliases:
  teams c  = create    teams a  = add       teams s  = status
  teams rm = remove    teams d  = disband   teams ls = list

A team is a named group of agents collaborating on a shared task. Each teammate
runs in the background; you can check in with 'status' (pass --since <cursor>
for efficient delta polling) and let them go with 'remove' or 'disband'.

Teammates use the same syntax as the rest of agents-cli:
  'claude'              -> the default Claude version on this machine
  'claude@2.1.112'      -> a specific installed version (see 'agents view')

Name them with --name alice  to refer to them as 'alice' instead of a UUID.
`
    );

  // list
  teams
    .command('list')
    .alias('ls')
    .description('List your teams, most recent activity first')
    .option('-n, --limit <n>', 'Max teams to show', '20')
    .option('--json', 'Output JSON')
    .action(async (opts: { limit: string; json?: boolean }) => {
      const mgr = new AgentManager();
      const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
      const [tasks, registry] = await Promise.all([handleTasks(mgr, 1000), loadTeams()]);
      const merged = mergeTeams(registry, tasks.tasks).slice(0, limit);

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ teams: merged }, null, 2));
        return;
      }

      if (merged.length === 0) {
        console.log(chalk.gray("You haven't started any teams yet."));
        console.log(chalk.gray('  Start one with:  agents teams create <name>'));
        return;
      }

      const nameWidth = Math.max(12, ...merged.map((t) => t.task_name.length));
      console.log(chalk.bold(`${'TEAM'.padEnd(nameWidth)}  MEMBERS  STATE                          UPDATED`));
      for (const t of merged) {
        const parts: string[] = [];
        if (t.running) parts.push(chalk.yellow(`${t.running} working`));
        if (t.completed) parts.push(chalk.green(`${t.completed} done`));
        if (t.failed) parts.push(chalk.red(`${t.failed} failed`));
        if (t.stopped) parts.push(chalk.gray(`${t.stopped} stopped`));
        const state = parts.join(' ') || chalk.gray(t.agent_count === 0 ? 'empty' : '-');
        console.log(
          `${chalk.cyan(t.task_name.padEnd(nameWidth))}  ${String(t.agent_count).padEnd(7)}  ${state.padEnd(30)} ${chalk.gray(relTime(t.modified_at))}`
        );
      }
    });

  // create
  teams
    .command('create <team>')
    .aliases(['c', 'new'])
    .description('Start a new team. No teammates yet — add them with `teams add`.')
    .option('-d, --description <text>', 'Short description of what this team is working on')
    .option('--json', 'Output JSON')
    .action(async (team: string, opts: { description?: string; json?: boolean }) => {
      try {
        const meta = await createTeam(team, opts.description);
        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ team, ...meta }, null, 2));
          return;
        }
        console.log(chalk.green(`New team: ${chalk.cyan(team)}`));
        if (meta.description) console.log(chalk.gray(`  ${meta.description}`));
        console.log();
        console.log(chalk.gray('Add your first teammate:'));
        console.log(chalk.gray(`  agents teams add ${team} claude "your task here"`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  // add
  teams
    .command('add <team> <teammate> <task>')
    .alias('a')
    .description("Bring someone onto the team to work on a task. Returns immediately.")
    .option('-n, --name <name>', 'Give this teammate a friendly name (e.g. alice). Unique within team.')
    .option('-m, --mode <mode>', `How much they can do: ${VALID_MODES.join('|')}`, 'edit')
    .option('-e, --effort <effort>', `Model tier: ${VALID_EFFORTS.join('|')}`, 'default')
    .option('--cwd <dir>', 'Where they should work (defaults to current directory)')
    .option('--json', 'Output JSON')
    .action(async (team: string, teammate: string, task: string, opts: {
      name?: string; mode: string; effort: string; cwd?: string; json?: boolean;
    }) => {
      if (!(VALID_MODES as readonly string[]).includes(opts.mode)) {
        die(`Invalid mode '${opts.mode}'. Use one of: ${VALID_MODES.join(', ')}`);
      }
      if (!(VALID_EFFORTS as readonly string[]).includes(opts.effort)) {
        die(`Invalid effort '${opts.effort}'. Use one of: ${VALID_EFFORTS.join(', ')}`);
      }

      const { agent, version } = parseTeammate(teammate);
      if (version && !isVersionInstalled(agent, version)) {
        die(
          `${AGENT_NAMES[agent]} ${version} isn't installed.\n` +
            `  Install it:  agents add ${agent}@${version}\n` +
            `  Or see what's installed:  agents view ${agent}`
        );
      }

      if (opts.name !== undefined) {
        if (!opts.name || !/^[A-Za-z0-9_-]+$/.test(opts.name)) {
          die(`Invalid teammate name '${opts.name}'. Use letters, numbers, '-', or '_'.`);
        }
      }

      // Auto-create the team if it doesn't exist yet (friendlier UX than erroring).
      await ensureTeam(team);

      const cwd = opts.cwd ?? process.cwd();
      const mgr = new AgentManager();
      try {
        const result = await handleSpawn(
          mgr,
          team,
          agent,
          task,
          cwd,
          opts.mode as Mode,
          opts.effort as Effort,
          null,
          cwd,
          version,
          opts.name ?? null
        );

        if (isJsonMode(opts)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const who = fullName(agent, version);
        const greeting = result.name
          ? `Welcomed ${chalk.cyan(result.name)} (${who}) to team ${chalk.cyan(team)}`
          : `Welcomed ${who} to team ${chalk.cyan(team)}`;
        console.log(chalk.green(greeting));
        if (result.name) {
          console.log(`  ${chalk.gray('name    ')}  ${chalk.cyan(result.name)}`);
        }
        console.log(`  ${chalk.gray('agent_id')}  ${chalk.cyan(shortId(result.agent_id))} ${chalk.gray(`(${result.agent_id})`)}`);
        console.log(`  ${chalk.gray('status  ')}  ${statusColor(result.status)(result.status)}`);
        console.log(`  ${chalk.gray('mode    ')}  ${opts.mode}`);
        console.log(`  ${chalk.gray('working ')}  ${cwd}`);
        console.log();
        console.log(chalk.gray(`Check in later:  agents teams status ${team}`));
      } catch (err) {
        die(`Could not add ${fullName(agent, version)} to ${team}: ${(err as Error).message}`);
      }
    });

  // status
  teams
    .command('status <team>')
    .aliases(['s', 'st', 'check'])
    .description("See what a team has been up to. Pass --since <cursor> for efficient polling.")
    .option('-f, --filter <state>', 'working|completed|failed|stopped|all', 'all')
    .option('-s, --since <iso>', 'Cursor from a previous status call')
    .option('--agent-id <id>', 'Show only one teammate')
    .option('--json', 'Output JSON')
    .action(async (team: string, opts: {
      filter: string; since?: string; agentId?: string; json?: boolean;
    }) => {
      // Map friendly 'working' → internal 'running' for filter.
      const filter = opts.filter === 'working' ? 'running' : opts.filter;
      const mgr = new AgentManager();
      try {
        const result = await handleStatus(mgr, team, filter, opts.since);
        const agents = opts.agentId
          ? result.agents.filter((a) => a.agent_id.startsWith(opts.agentId!))
          : result.agents;

        if (isJsonMode(opts)) {
          console.log(JSON.stringify({ ...result, agents }, null, 2));
          return;
        }

        const { summary } = result;
        const exists = await teamExists(team);
        if (!exists && result.agents.length === 0) {
          console.log(chalk.yellow(`No team called '${team}'. Create it with: agents teams create ${team}`));
          return;
        }

        console.log(
          chalk.bold(`Team ${chalk.cyan(team)}  `) +
            chalk.gray(
              `(${summary.running} working, ${summary.completed} done, ${summary.failed} failed, ${summary.stopped} stopped)`
            )
        );

        if (agents.length === 0) {
          console.log(chalk.gray('  (no teammates yet — add one with `agents teams add`)'));
        } else {
          for (const a of agents) {
            console.log();
            printAgentDetail(a);
          }
        }
        console.log();
        console.log(chalk.gray(`cursor: ${result.cursor}`));
      } catch (err) {
        die(`Could not check on team ${team}: ${(err as Error).message}`);
      }
    });

  // remove
  teams
    .command('remove <team> <teammate>')
    .alias('rm')
    .description("Let a teammate go. Accepts a name ('alice') or UUID prefix. Stops them cleanly if they're still working.")
    .option('--keep-logs', 'Keep the log files on disk (default: delete)')
    .option('--json', 'Output JSON')
    .action(async (team: string, ref: string, opts: { keepLogs?: boolean; json?: boolean }) => {
      const mgr = new AgentManager();
      const lookup = await mgr.resolveAgentIdInTask(team, ref);
      if (lookup.kind === 'none') {
        die(`No teammate matching '${ref}' in team ${team}`, 2);
      }
      if (lookup.kind === 'ambiguous') {
        const shorts = lookup.matches.map(shortId).join(', ');
        die(`'${ref}' matches multiple teammates: ${shorts}. Use more characters or a name.`, 2);
      }
      const agentId = lookup.agentId;

      // Look up the display handle (name if they had one) before we tear down.
      const agent = await mgr.get(agentId);
      const display = agent?.name || shortId(agentId);

      const stopRes = await handleStop(mgr, team, agentId);
      if ('error' in stopRes) die(stopRes.error);

      if (!opts.keepLogs && stopRes.not_found.length === 0) {
        try {
          const dir = path.join(await getAgentsDir(), agentId);
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ team, agent_id: agentId, name: agent?.name ?? null, result: stopRes }, null, 2));
        return;
      }

      if (stopRes.stopped.length) {
        console.log(chalk.green(`${display} has left team ${chalk.cyan(team)} (was working, now stopped).`));
      } else {
        console.log(chalk.green(`${display} has left team ${chalk.cyan(team)}.`));
      }
    });

  // disband
  teams
    .command('disband <team>')
    .alias('d')
    .description('Wind down the team. Stops everyone and removes the team.')
    .option('--keep-logs', 'Keep teammate logs on disk (default: delete)')
    .option('--json', 'Output JSON')
    .action(async (team: string, opts: { keepLogs?: boolean; json?: boolean }) => {
      const mgr = new AgentManager();
      const stopRes = await handleStop(mgr, team);
      if ('error' in stopRes) die(stopRes.error);

      const status = await handleStatus(mgr, team, 'all');
      const removedIds: string[] = [];
      if (!opts.keepLogs) {
        const base = await getAgentsDir();
        for (const a of status.agents) {
          try {
            await fs.rm(path.join(base, a.agent_id), { recursive: true, force: true });
            removedIds.push(a.agent_id);
          } catch { /* best-effort */ }
        }
      }

      const existed = await removeTeam(team);

      if (isJsonMode(opts)) {
        console.log(JSON.stringify({ team, existed, stopped: stopRes.stopped, removed_members: removedIds }, null, 2));
        return;
      }
      if (!existed && stopRes.stopped.length === 0 && status.agents.length === 0) {
        die(`No team called '${team}'`, 2);
      }
      console.log(chalk.green(`Team ${chalk.cyan(team)} disbanded.`));
      if (stopRes.stopped.length) console.log(chalk.gray(`  Stopped ${stopRes.stopped.length} working teammate(s).`));
      if (removedIds.length) console.log(chalk.gray(`  Cleared ${removedIds.length} teammate log(s).`));
    });

  // logs
  teams
    .command('logs <teammate>')
    .alias('log')
    .description("Read a teammate's raw log. Accepts a name ('alice'), UUID, or UUID prefix.")
    .option('-n, --tail <n>', 'Show only the last N lines')
    .option('--team <team>', 'Disambiguate when a name is used in multiple teams')
    .action(async (ref: string, opts: { tail?: string; team?: string }) => {
      const base = await getAgentsDir();
      const resolved = await resolveTeammateAcrossTeams(base, ref, opts.team);
      if (resolved.kind === 'none') {
        die(`No notes on record for teammate '${ref}'`, 2);
      }
      if (resolved.kind === 'ambiguous') {
        const hints = resolved.candidates.map((c) => `${c.team}/${c.display}`).join(', ');
        die(
          `'${ref}' matches multiple teammates: ${hints}.\n` +
            `  Narrow it with --team <team>, or pass a UUID prefix.`,
          2
        );
      }
      const logPath = path.join(base, resolved.agentId, 'stdout.log');
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
        die(`No notes on record for teammate '${ref}' (looked in ${logPath})`, 2);
      }
    });

  // doctor
  teams
    .command('doctor')
    .alias('dr')
    .description('Check which agents are available to join a team')
    .option('--json', 'Output JSON')
    .action(async (opts: { json?: boolean }) => {
      const info = checkAllClis();
      if (isJsonMode(opts)) {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      console.log(chalk.bold('Who can join a team:'));
      for (const [name, entry] of Object.entries(info)) {
        const pretty = AGENT_NAMES[name as AgentType] || name;
        if (entry.installed) {
          console.log(`  ${chalk.green('ready')}  ${pretty.padEnd(10)} ${chalk.gray(entry.path || '')}`);
        } else {
          console.log(`  ${chalk.red('no   ')}  ${pretty.padEnd(10)} ${chalk.gray(entry.error || 'not installed')}`);
        }
      }
    });
}
