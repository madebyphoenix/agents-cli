/**
 * Software Factory — TARGET ARCHITECTURE (north star, do not lose this).
 *
 * One-sentence model:
 *   submit a brief -> planner opens a PR with ARCH.md and files Linear
 *   tickets -> workers poll the queue and ship PRs -> merged PR closes the
 *   ticket, failed CI opens a bug ticket. Linear is the issue tracker
 *   (where humans live), GitHub is the review layer, our DB is the
 *   orchestration index, the laptop is optional after submit.
 *
 * Why Linear (not our own UI): we don't want to build a project manager.
 * Humans already use Linear; the factory drops work where humans look.
 *
 * Why a DB (not Linear-as-queue): workers shouldn't poll Linear directly --
 * rate limits, latency, Linear isn't a job queue. Our DB mirrors the Linear
 * tickets we care about plus orchestration state (claimed_by, heartbeat,
 * worker_pod_id). Orchestrator syncs Linear<->DB; workers read/write the DB.
 *
 * Three storage layers (each for a different concern):
 *   - Linear -- ticket details, comments, labels, status, history, human UI
 *   - DB     -- orchestration index + chain relations
 *               (factory_tickets row holds claimed_by, heartbeat,
 *                session_r2_key, pr_url, parent_ticket_id, child_ticket_ids)
 *   - R2     -- bulk artifacts (full worker session jsonl, final diffs,
 *               planner ARCH.md drafts, worker notes). DB rows point to R2
 *               keys; the DB never holds large blobs.
 *
 * The chain (planner -> tickets -> worker sessions -> PRs -> child bug
 * tickets) is graph-shaped and lives in the DB as relations. R2 holds the
 * heavy artifacts each row points to. Sessions infra is owned by another
 * dev; the factory writes to wherever that infra puts session logs and
 * stores the pointer.
 *
 *   factory submit "<brief>" --> Planner pod (one-shot)
 *                                       |
 *                                       +--> commits ARCH.md PR (GitHub)
 *                                       +--> files tickets (Linear)
 *                                                |
 *                                                v
 *                                       Linear project (humans live here)
 *                                                |
 *                                                | Linear<->DB sync (orchestrator)
 *                                                v
 *                                       Our DB (orchestration index +
 *                                       claim state, heartbeat, dispatch)
 *                                                |
 *                                                | dispatch by label
 *                                                v
 *                                       Worker pods --> open PRs (GitHub)
 *                                                |
 *                                       +--------+--------+
 *                                       v                 v
 *                                  PR merged          CI failed
 *                                  close ticket       file bug ticket
 *                                  (DB + Linear)      (DB + Linear)
 *
 * Two workflows (selected by ticket label):
 *   feature: read ARCH.md -> code -> tests -> PR -> close on merge
 *   bug:     reproduce -> root-cause -> regression test -> fix -> PR -> close
 *
 * What we DON'T build (offloaded):
 *   - UI / status / notifications   -> Linear
 *   - Persistent task store         -> Linear tickets + descriptions
 *   - Code review / merge gating    -> GitHub PRs + CI
 *   - Architecture doc              -> ARCH.md in the repo (planner commits it)
 *   - Auth / multi-user / billing   -> Linear + GitHub identities
 *   - Sessions / project context    -> separate concern, owned elsewhere
 *
 * No ledger. No oracle as a separate module. No SQLite. No `~/.agents/teams/`
 * registry. No supervisor wave loop on the user's laptop. The orchestrator
 * service owns the lifecycle; the laptop is optional after `submit`.
 * "Failed CI -> bug ticket" is a webhook handler (~20 lines), not a
 * subsystem. "Append-only project memory" is what ARCH.md + ticket history
 * + PR descriptions already are -- git history IS the memory.
 *
 * Where server code lives: `agents/prix/factory/service/src/` (Factory Floor,
 * deployed at agents.427yosemite.com). Existing primitives to reuse:
 * `/dispatch`, `/tasks`, `/tasks/:id/{events,output,message}`, `/linear/issues`,
 * plus Rush Cloud `/api/v1/cloud-runs`. Add routes inside this service; do
 * NOT stand up a new one. See `agents/prix/factory/docs/02-cloud-runs.md`.
 *
 * v0 (smallest cut that proves the model):
 *   1. POST /factory/submit -- spawns one pod with the planner prompt.
 *   2. Planner: opens PR with ARCH.md, then creates Linear tickets per slice.
 *   3. POST /factory/tick (k8s CronJob or setInterval): poll project's open
 *      tickets, dispatch a worker pod per claimable ticket (feature or bug
 *      template by label).
 *   4. POST /factory/github-webhook: on PR merge -> mark ticket Done;
 *      on PR check fail -> create bug ticket (this is the entire oracle).
 *   5. CLI shrinks to: `agents factory submit "<brief>" --repo X --project RUSH`.
 *
 * --- CURRENT STATE (legacy, being migrated away from) ---
 *
 * Today this file ships an ergonomic wrapper around `agents teams` for the
 * planner -> implement -> test -> review pipeline, with a laptop-resident
 * supervisor (lib/teams/supervisor.ts), a SQLite ledger, an oracle that
 * auto-files bugfixes, and a filesystem-backed registry under ~/.agents/.
 * It works for local-mode but the supervisor-on-laptop choice doesn't
 * survive cloud dispatch (see "design wart" notes in conversation history).
 * Keep `factory submit-local` (or equivalent) as the offline escape hatch
 * during/after migration.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { AgentManager, VALID_TASK_TYPES } from '../lib/teams/agents.js';
import { resolveLedger, syncOnEviction, syncTeammate } from '../lib/ledger/index.js';
import { handleSpawn, handleStatus } from '../lib/teams/api.js';
import { ensureTeam } from '../lib/teams/registry.js';
import { resolveProvider } from '../lib/cloud/registry.js';
import type { CloudProviderId } from '../lib/cloud/types.js';
import { runSupervisor } from '../lib/teams/supervisor.js';
import { maybeFileBugfix } from '../lib/teams/oracle.js';
import {
  readFactoryConfig,
  writeFactoryConfig,
  resolveDispatch,
  type FactoryConfig,
  type DispatchProvider,
} from '../lib/factory/config.js';

function die(msg: string, code = 1): never {
  console.error(chalk.red(msg));
  process.exit(code);
}

/** Per-team file where a detached supervisor streams its wave output. */
function supervisorLogPath(team: string): string {
  const safe = team.replace(/[/\\]/g, '_');
  return path.join(homedir(), '.agents', 'factory', `${safe}.supervisor.log`);
}

function supervisorPidPath(team: string): string {
  const safe = team.replace(/[/\\]/g, '_');
  return path.join(homedir(), '.agents', 'factory', `${safe}.supervisor.pid`);
}

interface FactoryTeamEntry {
  team: string;
  lastActivity: Date;
  pid?: number;
  alive: boolean;
}

/**
 * Discover factory teams by scanning ~/.agents/factory/ for supervisor logs.
 * Pid presence + `kill -0` tells us if the supervisor is still running. Sorted
 * most-recent first so the picker / list show the team you most likely want.
 */
function listFactoryTeams(): FactoryTeamEntry[] {
  const dir = path.join(homedir(), '.agents', 'factory');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const teams: FactoryTeamEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith('.supervisor.log')) continue;
    const team = name.slice(0, -'.supervisor.log'.length);
    const logPath = path.join(dir, name);
    let lastActivity: Date;
    try {
      lastActivity = fs.statSync(logPath).mtime;
    } catch {
      continue;
    }
    let pid: number | undefined;
    let alive = false;
    try {
      const raw = fs.readFileSync(supervisorPidPath(team), 'utf-8').trim();
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        pid = n;
        try { process.kill(n, 0); alive = true; } catch { alive = false; }
      }
    } catch {}
    teams.push({ team, lastActivity, pid, alive });
  }
  teams.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  return teams;
}

function formatRelative(d: Date): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/**
 * Resolve a team argument: if the caller passed a name, use it; otherwise
 * present an interactive picker (TTY) or fail with a hint (non-TTY).
 */
async function pickTeamOrDie(verb: string, team: string | undefined): Promise<string> {
  if (team) return team;
  const teams = listFactoryTeams();
  if (teams.length === 0) {
    die(`No factory teams found. Start one with: agents factory start "<brief>"`);
  }
  if (!process.stdout.isTTY) {
    die(`Missing <team>. Run \`agents factory list\` to see options, then \`agents factory ${verb} <team>\`.`);
  }
  const { select } = await import('@inquirer/prompts');
  const choice = await select({
    message: `Pick a factory team to ${verb}`,
    choices: teams.map((t) => ({
      name: `${t.team.padEnd(36)} ${chalk.gray(formatRelative(t.lastActivity).padEnd(10))} ${t.alive ? chalk.green('supervisor live') : chalk.gray('supervisor stopped')}`,
      value: t.team,
    })),
  });
  return choice;
}

/**
 * Fork a detached `agents factory run <team>` child that survives this
 * parent process. Writes pid + log path to disk so `factory watch` and
 * `factory stop` can find it.
 */
function startDetachedSupervisor(team: string): { pid: number; log: string } {
  const log = supervisorLogPath(team);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const logFd = fs.openSync(log, 'a');

  // Re-launch ourselves with `factory run <team>`. argv[0] is the node
  // binary and argv[1] is this CLI entry point — that pair reconstructs
  // the exact command the parent is running.
  const child = spawn(process.argv[0], [process.argv[1], 'factory', 'run', team], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();

  const pid = child.pid ?? -1;
  if (pid > 0) {
    fs.writeFileSync(supervisorPidPath(team), String(pid), 'utf-8');
  }
  return { pid, log };
}

/**
 * Run the supervisor in-process for the foreground case. Thin wrapper that
 * defers to the exact same code the `factory run` subcommand uses.
 */
async function runForegroundSupervisor(team: string): Promise<void> {
  const ledger = resolveLedger();
  const mgr = new AgentManager();
  mgr.setCompletionHook(async (a) => {
    const snap = await a.toSnapshot();
    await syncTeammate(snap, ledger);
    await maybeFileBugfix(a, mgr);
  });
  mgr.setCloudDispatcher(async (a) => {
    if (!a.cloudProvider) throw new Error(`Teammate ${a.agentId} missing cloudProvider`);
    const prov = resolveProvider(a.cloudProvider as CloudProviderId);
    const ct = await prov.dispatch({
      prompt: a.prompt, agent: a.agentType,
      repo: a.cloudRepo ?? undefined, branch: a.cloudBranch ?? undefined,
      model: a.model ?? undefined,
    });
    return { cloudSessionId: ct.id };
  });
  await runSupervisor(mgr, {
    team,
    intervalMs: 8000,
    maxWaves: 1000,
    onWave: (s) => {
      const ts = s.timestamp.slice(11, 19);
      const taskTypes = s.launched.map((l) => l.taskType ?? '?').join(',') || '-';
      console.log(
        `[${ts}] wave ${s.wave}  launched=${s.launched.length} (${taskTypes})  ` +
        `running=${s.running}  pending=${s.pending}  done=${s.completed}  failed=${s.failed}`
      );
    },
  });
}

// ---------------------------------------------------------------------------
// `agents factory submit <linear-ref>` — Software Factory v0 entry point.
// Thin HTTP client: POSTs to the Factory Floor's /factory/submit. The factory
// resolves the Linear ref, picks the workflow by label, and dispatches a pod.
// ---------------------------------------------------------------------------

const FACTORY_URL = process.env.FACTORY_FLOOR_URL ?? 'https://agents.427yosemite.com';

function readRushToken(): string {
  const userYaml = path.join(homedir(), '.rush', 'user.yaml');
  if (!fs.existsSync(userYaml)) {
    die('Not logged in to Rush. Run `rush login` first.');
  }
  const raw = fs.readFileSync(userYaml, 'utf-8');
  // Minimal YAML parse — we only need session.access_token.
  const match = raw.match(/access_token:\s*([^\s#]+)/);
  if (!match) {
    die('No session token in ~/.rush/user.yaml. Run `rush login` first.');
  }
  return match[1].replace(/^['"]|['"]$/g, '');
}

async function postFactorySubmit(ref: string): Promise<{
  ticket_id: string;
  linear_identifier: string;
  label: string;
  cloud_execution_id: string;
}> {
  const token = readRushToken();
  const res = await fetch(`${FACTORY_URL}/factory/submit`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`Factory submit failed (${res.status}): ${body.slice(0, 400)}`);
  }
  return res.json() as Promise<{
    ticket_id: string;
    linear_identifier: string;
    label: string;
    cloud_execution_id: string;
  }>;
}

export function registerFactoryCommands(program: Command): void {
  const factory = program
    .command('factory')
    .description('Software Factory — planner/worker DAG with a shared team Ledger.')
    .addHelpText('after', `
Mental model:
  Submit Linear tickets; the factory plans a DAG of worker agents, dispatches
  them to the cloud, and lands PRs. The local laptop is just the dispatcher —
  workers run on Rush Cloud / Codex Cloud / Factory pods, not your machine.

Examples:
  # Hand off a Linear ticket and walk away (one-shot, factory picks the agent)
  agents factory submit RUSH-2451

  # Same thing from a Linear URL (drag-and-drop friendly)
  agents factory submit https://linear.app/getrush/issue/RUSH-2451

  # Spin up a planner from a free-form brief — emits the DAG, you approve, it runs
  agents factory start "Cut Stripe webhook latency in half; ship behind a flag"

  # Drive a team dynamically — keep dispatching ready workers as the DAG drains
  agents factory run rush-stripe-latency

  # Tail the supervisor log while the factory works
  agents factory watch rush-stripe-latency

  # Roll-up status: who's blocked, what's ready, last activity per worker
  agents factory status rush-stripe-latency

  # See every factory team on disk, with last-activity and supervisor liveness
  agents factory list

  # A worker asked a question — answer it from your laptop
  agents factory answer rush-stripe-latency "use the v2 webhook payload, drop legacy"

  # Stop firing new waves; leave running workers alone
  agents factory stop rush-stripe-latency

  # Show / edit factory config (cloud provider priority, default planner agent)
  agents factory config

  # Snapshot a teammate's state to the Ledger before SIGTERM (preempt-safe)
  agents factory evict worker-7c4a
`);

  // `agents factory submit <ref>` — Software Factory v0. One shot: hand
  // off a Linear ref, factory dispatches a pod, the laptop is done.
  factory
    .command('submit <linear-ref>')
    .description('Submit a Linear issue (RUSH-123 or URL) to the Software Factory.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (ref: string, opts: { json?: boolean }) => {
      const result = await postFactorySubmit(ref);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(chalk.green(`Submitted ${result.linear_identifier} (${result.label})`));
      console.log(`  ticket       ${result.ticket_id}`);
      console.log(`  execution    ${result.cloud_execution_id}`);
      console.log(`  tail output  agents cloud tail ${result.cloud_execution_id}`);
    });

  // `agents factory start <brief>` — seed a team with a Planner teammate.
  factory
    .command('start <brief>')
    .description('Start a new Software Factory run: spawns a Planner teammate who emits the DAG.')
    .option('-t, --team <name>', 'Team name (defaults to factory-<timestamp>)')
    .option('-a, --agent <type>', 'Agent type for the planner (defaults to factory config default_planner_agent)')
    .option('--cwd <dir>', 'Working directory for all teammates', process.cwd())
    .option('--cloud <provider>', 'Dispatch planner to cloud: rush | codex | factory. Defaults to your factory config priority (typically `rush`).')
    .option('--local', 'Force-run the planner locally instead of dispatching to cloud. Escape hatch for debugging.')
    .option('--repo <owner/repo>', 'GitHub repository (required with --cloud rush; auto-detected from git remote otherwise).')
    .option('--detach', 'Also start the supervisor loop in the background; tail with `agents factory watch <team>`')
    .option('--foreground', 'Also start the supervisor loop in the foreground (blocks until drained)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (brief: string, opts: {
      team?: string; agent?: string; cwd: string; cloud?: string; local?: boolean; repo?: string;
      detach?: boolean; foreground?: boolean; json?: boolean;
    }) => {
      const teamId = opts.team || `factory-${Date.now()}`;
      await ensureTeam(teamId);

      const ledger = resolveLedger();
      const mgr = new AgentManager();
      mgr.setCompletionHook(async (a) => {
        const snap = await a.toSnapshot();
        await syncTeammate(snap, ledger);
      });

      const plannerPrompt = `You are the Planner teammate in a Software Factory team.

Team id: ${teamId}
Working directory: ${opts.cwd}
Brief: ${brief}

YOUR JOB: Seed an initial DAG of worker tasks by EXECUTING \`agents teams add\` commands via the Bash tool. You must actually run them — do not print them in a code block and stop.

For each slice (narrow, file-scoped ask), run three Bash commands:
  agents teams add ${teamId} codex "implement <slice>" --name impl-<slug> --task-type implement --cwd ${opts.cwd}
  agents teams add ${teamId} codex "write tests for <slice>; run them; last line: TESTS: N passed, M failed" --name test-<slug> --task-type test --after impl-<slug> --cwd ${opts.cwd}
  agents teams add ${teamId} codex "review diff from impl-<slug>; file bugs via LedgerNote" --name review-<slug> --task-type review --after impl-<slug>,test-<slug> --cwd ${opts.cwd}

Use the agent type that matches your own type for workers (cheapest-and-adequate). Use --agent claude only where you need top capability.

Rules:
1. Plant the FIRST LAYER ONLY. Workers can add more tasks via \`agents teams add\` as they discover work; a background supervisor will pick them up.
2. Split slices by file ownership — two implementers must not touch the same files in parallel.
3. Names must be unique within the team (--name alice, --name bob). Dependencies reference the name via --after.
4. Before exiting, print a one-paragraph strategy narrative. Do NOT spawn a separate process to do this — just print it as your final message.

After you have run the teams-add commands and printed your strategy, STOP. The supervisor will drive the DAG from here.`;

      // Resolve dispatch against the factory config priority. --cloud and
      // --local are CLI overrides; otherwise we use the user's configured
      // order (default: rush > codex > local).
      const dispatch = await resolveDispatch(opts.cwd, opts.cloud, opts.local, opts.repo);
      const plannerAgent = (opts.agent ?? (await readFactoryConfig()).default_planner_agent) as string;

      let cloudSessionId: string | null = null;
      let cloudProvider: string | null = null;
      let cloudRepo: string | null = null;
      if (dispatch.provider !== 'local') {
        if (dispatch.provider === 'rush' && !dispatch.repo) {
          die(`--cloud rush requires --repo (auto-detect from git remote failed). Pass --repo <owner/repo> or run in a git repo with an origin remote.`);
        }
        cloudProvider = dispatch.provider;
        cloudRepo = dispatch.repo ?? null;
        try {
          const prov = resolveProvider(dispatch.provider as CloudProviderId);
          const task = await prov.dispatch({
            prompt: plannerPrompt,
            agent: plannerAgent,
            repo: dispatch.repo,
          });
          cloudSessionId = task.id;
        } catch (err) {
          die(`Cloud dispatch to ${dispatch.provider} failed: ${(err as Error).message}`);
        }
      }

      const result = await handleSpawn(
        mgr, teamId, plannerAgent as any, plannerPrompt,
        opts.cwd, 'edit', 'medium', null, opts.cwd, null, 'planner', [], null, null,
        'plan', cloudProvider, cloudSessionId, cloudRepo, null
      );

      // Auto-launch the supervisor unless the user explicitly opts out by
      // passing neither --detach nor --foreground. Default is --detach: the
      // factory is meant to be dynamic, so it'd be weird to leave the DAG
      // stalled after the planner emits tasks.
      const mode = opts.foreground ? 'foreground' : 'detach';
      const supervisorInfo = mode === 'foreground' ? null : startDetachedSupervisor(teamId);

      if (opts.json) {
        console.log(JSON.stringify({
          team_id: teamId,
          planner_id: result.agent_id,
          planner_agent: plannerAgent,
          status: result.status,
          dispatch: { provider: dispatch.provider, repo: dispatch.repo ?? null, considered: dispatch.considered },
          supervisor: supervisorInfo,
        }, null, 2));
        if (mode === 'foreground') await runForegroundSupervisor(teamId);
        return;
      }

      console.log(chalk.green(`Factory started: team ${chalk.cyan(teamId)}`));
      console.log(`  ${chalk.gray('planner    ')}  ${result.name} (${result.agent_id.slice(0, 8)})  ${plannerAgent}`);
      const dispatchLabel = dispatch.provider === 'local'
        ? chalk.gray('local')
        : `${chalk.magenta(dispatch.provider)}${dispatch.repo ? chalk.gray(` repo=${dispatch.repo}`) : ''}`;
      console.log(`  ${chalk.gray('dispatch   ')}  ${dispatchLabel}`);
      if (supervisorInfo) {
        console.log(`  ${chalk.gray('supervisor ')}  pid ${supervisorInfo.pid}, log ${supervisorInfo.log}`);
      } else {
        console.log(chalk.gray(`  supervisor   foreground`));
      }
      console.log();
      console.log(chalk.gray(`Watch live:    agents factory watch ${teamId}`));
      console.log(chalk.gray(`Check status:  agents factory status ${teamId}`));
      console.log(chalk.gray(`Q&A modal:     shows up in the Factory Floor pane when a teammate needs input`));

      if (mode === 'foreground') await runForegroundSupervisor(teamId);
    });

  // `agents factory status <team>` — rolled-up view of teammates + DAG state.
  factory
    .command('status [team]')
    .description('Show roll-up status for a Factory team: DAG state, blocked teammates, recent tasks. Omit team for an interactive picker.')
    .option('--json', 'Output machine-readable JSON')
    .action(async (teamArg: string | undefined, opts: { json?: boolean }) => {
      const team = await pickTeamOrDie('inspect', teamArg);
      const mgr = new AgentManager();
      const result = await handleStatus(mgr, team, 'all');
      const byType: Record<string, number> = {};
      for (const a of result.agents) {
        const t = a.task_type ?? 'other';
        byType[t] = (byType[t] ?? 0) + 1;
      }
      const input_required = result.agents.filter((a) => a.status === 'pending' && a.after?.length === 0).length;

      if (opts.json) {
        console.log(JSON.stringify({
          team_id: team,
          counts: result.summary,
          by_task_type: byType,
          input_required_count: input_required,
          agents: result.agents,
        }, null, 2));
        return;
      }

      console.log(chalk.bold(`Factory ${chalk.cyan(team)}`));
      console.log(`  ${chalk.gray('running  ')}  ${result.summary.running}`);
      console.log(`  ${chalk.gray('pending  ')}  ${result.summary.pending}`);
      console.log(`  ${chalk.gray('completed')}  ${result.summary.completed}`);
      console.log(`  ${chalk.gray('failed   ')}  ${result.summary.failed}`);
      if (Object.keys(byType).length > 0) {
        console.log(`  ${chalk.gray('by type  ')}  ` +
          Object.entries(byType).map(([k, v]) => `${k}:${v}`).join(' · '));
      }
      if (input_required > 0) {
        console.log(chalk.yellow(`\n${input_required} teammate(s) waiting on user input — answer with: agents factory answer ${team} <text>`));
      }
    });

  // `agents factory run <team>` — run the continuous DAG supervisor in the
  // foreground. Drives the team dynamically: as teammates add more tasks via
  // `agents teams add`, those tasks get picked up in the next wave.
  factory
    .command('run <team>')
    .description('Drive a team dynamically: keep dispatching ready teammates until the DAG drains. Workers can add more tasks mid-flight and this loop picks them up.')
    .option('--interval <seconds>', 'Seconds between waves', '8')
    .option('--max-waves <n>', 'Safety cap on waves', '1000')
    .option('--json', 'Emit one JSON object per wave')
    .action(async (team: string, opts: { interval: string; maxWaves: string; json?: boolean }) => {
      const ledger = resolveLedger();
      const mgr = new AgentManager();
      // Wire the same completion hook as `teams start` so failed tests
      // auto-file bugfix teammates and outputs land in the Ledger.
      mgr.setCompletionHook(async (a) => {
        const snap = await a.toSnapshot();
        await syncTeammate(snap, ledger);
        await maybeFileBugfix(a, mgr);
      });
      mgr.setCloudDispatcher(async (a) => {
        if (!a.cloudProvider) throw new Error(`Teammate ${a.agentId} missing cloudProvider`);
        const prov = resolveProvider(a.cloudProvider as CloudProviderId);
        const ct = await prov.dispatch({
          prompt: a.prompt, agent: a.agentType,
          repo: a.cloudRepo ?? undefined, branch: a.cloudBranch ?? undefined,
          model: a.model ?? undefined,
        });
        return { cloudSessionId: ct.id };
      });

      const intervalMs = Math.max(1000, Number.parseInt(opts.interval, 10) * 1000 || 8000);
      const maxWaves = Math.max(1, Number.parseInt(opts.maxWaves, 10) || 1000);

      const result = await runSupervisor(mgr, {
        team, intervalMs, maxWaves,
        onWave: (s) => {
          const ts = s.timestamp.slice(11, 19);
          if (opts.json) {
            console.log(JSON.stringify({
              wave: s.wave, ts, team: s.team,
              launched: s.launched.map((l) => ({ agent_id: l.agentId, name: l.name, task_type: l.taskType })),
              pending: s.pending, running: s.running, completed: s.completed, failed: s.failed,
            }));
            return;
          }
          const taskTypes = s.launched.map((l) => l.taskType ?? '?').join(',') || '-';
          console.log(
            `[${ts}] wave ${s.wave}  ${chalk.cyan(s.team)}  ` +
            `launched=${chalk.green(s.launched.length)} (${taskTypes})  ` +
            `running=${chalk.yellow(s.running)}  pending=${chalk.blue(s.pending)}  ` +
            `done=${chalk.green(s.completed)}  failed=${s.failed > 0 ? chalk.red(s.failed) : '0'}`
          );
        },
      });

      const elapsed = Math.floor(result.elapsed_ms / 1000);
      if (result.stoppedBy === 'drained') {
        console.log(chalk.green(`\nFactory drained in ${elapsed}s (${result.waves} waves).`));
      } else if (result.stoppedBy === 'max-waves') {
        console.error(chalk.yellow(`\nHit --max-waves=${maxWaves}; stopping.`));
      } else if (result.stoppedBy === 'signal') {
        console.error(chalk.yellow(`\nStopped by signal after ${result.waves} waves.`));
      }
    });

  // `agents factory watch <team>` — tail the supervisor's log file written
  // by a background `factory start`. Non-blocking view of a running factory.
  factory
    .command('watch [team]')
    .description('Tail the supervisor log for a team started in the background. Omit team for an interactive picker. Press Ctrl-C to stop watching; the factory keeps running.')
    .action(async (teamArg: string | undefined) => {
      const team = await pickTeamOrDie('watch', teamArg);
      const logPath = supervisorLogPath(team);
      if (!fs.existsSync(logPath)) {
        die(`No supervisor log at ${logPath}. Start one with: agents factory start "<brief>" --team ${team} --detach`);
      }
      // Use tail -F so we survive log rotation and missing files.
      const tailProc = spawn('tail', ['-F', '-n', '200', logPath], { stdio: 'inherit' });
      const onSig = () => tailProc.kill('SIGTERM');
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);
    });

  // `agents factory config` — show or edit the factory config file.
  // Thin CLI shim over readFactoryConfig/writeFactoryConfig; the settings
  // panel uses the same API for visual editing.
  factory
    .command('config')
    .description('Show or edit ~/.agents/factory/config.json (cloud provider priority, auto-detect repo, default planner agent).')
    .option('--set-priority <providers>', 'Comma-separated priority list, e.g. "rush,codex,local"')
    .option('--set-planner <agent>', 'Default planner agent: claude|codex|gemini|cursor|opencode')
    .option('--set-auto-detect-repo <bool>', '"true" or "false" — whether rush auto-detects --repo from git remote')
    .option('--set-interval <seconds>', 'Seconds between supervisor waves')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: {
      setPriority?: string; setPlanner?: string; setAutoDetectRepo?: string; setInterval?: string; json?: boolean;
    }) => {
      const update: Partial<FactoryConfig> = {};
      if (opts.setPriority) {
        update.cloud_priority = opts.setPriority.split(',').map((s) => s.trim()) as DispatchProvider[];
      }
      if (opts.setPlanner) {
        update.default_planner_agent = opts.setPlanner as FactoryConfig['default_planner_agent'];
      }
      if (opts.setAutoDetectRepo !== undefined) {
        update.auto_detect_repo = opts.setAutoDetectRepo === 'true';
      }
      if (opts.setInterval) {
        const n = Number.parseInt(opts.setInterval, 10);
        if (Number.isFinite(n) && n >= 1) update.supervisor_interval_seconds = n;
      }

      const final = Object.keys(update).length > 0
        ? await writeFactoryConfig(update)
        : await readFactoryConfig();

      if (opts.json) {
        console.log(JSON.stringify(final, null, 2));
        return;
      }
      console.log(chalk.bold('Factory config'));
      console.log(`  ${chalk.gray('cloud_priority         ')}  ${final.cloud_priority.join(' > ')}`);
      console.log(`  ${chalk.gray('default_planner_agent  ')}  ${final.default_planner_agent}`);
      console.log(`  ${chalk.gray('auto_detect_repo       ')}  ${final.auto_detect_repo}`);
      console.log(`  ${chalk.gray('supervisor_interval_s  ')}  ${final.supervisor_interval_seconds}`);
    });

  // `agents factory list` — show known factory teams (sourced from supervisor
  // log files on disk). Useful for scripts and as a non-interactive companion
  // to the picker baked into status / watch / stop.
  factory
    .command('list')
    .alias('ls')
    .description('List factory teams discovered on disk, with last-activity time and supervisor liveness.')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      const teams = listFactoryTeams();
      if (opts.json) {
        console.log(JSON.stringify(teams.map((t) => ({
          team: t.team,
          last_activity: t.lastActivity.toISOString(),
          pid: t.pid ?? null,
          supervisor_alive: t.alive,
        })), null, 2));
        return;
      }
      if (teams.length === 0) {
        console.log(chalk.gray('No factory teams found. Start one with: agents factory start "<brief>"'));
        return;
      }
      console.log(chalk.bold('Factory teams'));
      for (const t of teams) {
        const state = t.alive ? chalk.green('live') : chalk.gray('stopped');
        console.log(`  ${chalk.cyan(t.team.padEnd(36))}  ${formatRelative(t.lastActivity).padEnd(10)}  ${state}`);
      }
    });

  // `agents factory stop <team>` — kill the detached supervisor for this team.
  // Teammate processes keep running; this only stops the wave dispatcher.
  factory
    .command('stop [team]')
    .description("Stop a team's background supervisor loop. Omit team for an interactive picker. Running teammates keep running; new waves stop firing.")
    .action(async (teamArg: string | undefined) => {
      const team = await pickTeamOrDie('stop', teamArg);
      const pidFile = supervisorPidPath(team);
      if (!fs.existsSync(pidFile)) die(`No supervisor pid file for team '${team}'.`);
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) die(`Invalid pid in ${pidFile}.`);
      try {
        process.kill(pid, 'SIGTERM');
        console.log(chalk.green(`Sent SIGTERM to supervisor pid ${pid} for team ${team}.`));
        fs.rmSync(pidFile, { force: true });
      } catch (err: any) {
        if (err?.code === 'ESRCH') {
          console.log(chalk.gray(`Supervisor pid ${pid} already gone; cleaning up pidfile.`));
          fs.rmSync(pidFile, { force: true });
        } else {
          die(`Failed to stop supervisor: ${err.message}`);
        }
      }
    });

  // `agents factory answer <team> <text>` — reply to the oldest input_required teammate.
  factory
    .command('answer <team> <text>')
    .description("Answer an open question from a teammate — forwards the text to the oldest 'input_required' cloud task.")
    .option('--json', 'Output machine-readable JSON')
    .action(async (team: string, text: string, opts: { json?: boolean }) => {
      const mgr = new AgentManager();
      const teammates = await mgr.listByTask(team);
      // input_required is a cloud-task status, not a local AgentStatus. Detect
      // via status string so we still work for non-cloud teams (if someone ever
      // plumbs the same status through).
      const waiting = teammates.filter((t) => (t.status as string) === 'input_required');
      if (waiting.length === 0) {
        die(`No teammates waiting on input in team '${team}'.`);
      }
      waiting.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      const target = waiting[0];
      if (!target.cloudProvider || !target.cloudSessionId) {
        die(`Teammate '${target.name ?? target.agentId}' is waiting on input but has no cloud session to message.`);
      }
      try {
        const prov = resolveProvider(target.cloudProvider as CloudProviderId);
        await prov.message(target.cloudSessionId, text);
      } catch (err) {
        die(`Provider rejected the message: ${(err as Error).message}`);
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, teammate: target.name ?? target.agentId }, null, 2));
        return;
      }
      console.log(chalk.green(`Replied to ${target.name ?? target.agentId.slice(0, 8)} on ${target.cloudProvider}.`));
    });

  // `agents factory evict <agent_id>`
  //
  // Designed to run from a Kubernetes pod's preStop hook. Flushes the local
  // teammate state (session log, git diff, registry entry, note) to the
  // configured Ledger backend so it survives SIGTERM.
  factory
    .command('evict <agent_id>')
    .description("Pre-SIGTERM: flush this teammate's state to the Team Ledger so other teammates can still read it.")
    .option('--reason <text>', 'Short note describing why eviction happened', 'pod eviction')
    .option('--json', 'Output machine-readable JSON')
    .action(async (agentId: string, opts: { reason: string; json?: boolean }) => {
      const mgr = new AgentManager();
      const agent = await mgr.get(agentId);
      if (!agent) die(`No teammate with id '${agentId}'`);

      const ledger = resolveLedger();
      const snap = await agent.toSnapshot();
      try {
        await syncOnEviction(snap, ledger);
      } catch (err) {
        die(`Eviction sync failed: ${(err as Error).message}`);
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, agent_id: agentId, ledger: ledger.kind, reason: opts.reason }, null, 2));
        return;
      }
      console.log(chalk.green(`Flushed ${agentId.slice(0, 8)} to ${ledger.kind} ledger (${opts.reason}).`));
    });
}
