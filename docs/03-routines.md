# Routines (Scheduled Jobs)

Scheduled agent execution with sandboxed permissions and daemon-driven cron scheduling.

## Architecture

```
~/.agents/
  routines/
    daily-review.yml        # Job config (YAML)
    weekly-cleanup.yml
  daemon/
    state.json              # Daemon PID, last reload timestamp
```

Each job is a YAML file in `~/.agents/routines/`. A background daemon (`agents daemon`) parses cron expressions with [croner](https://github.com/hucsm/croner), spawns agent processes at trigger time, and captures output.

## Job Config

```yaml
# ~/.agents/routines/daily-review.yml
name: daily-review
schedule: "0 9 * * *"         # 9am daily (cron syntax)
agent: claude
version: 2.0.65               # Optional, uses global default if omitted
mode: plan                    # plan (read-only) or edit
effort: default               # fast, default, or detailed
timeout: 10m
runOnce: false                # true for one-shot jobs (--at)

prompt: |
  Review open PRs and summarize status.

allow:
  dirs:
    - ~/projects/myapp
  tools:
    - Bash(git *)
    - Read
    - Grep
```

### One-Shot Jobs

```bash
agents routines add reminder --at "14:30" --agent claude --prompt "Remind Muqsit to stand up"
```

`--at` accepts `"14:30"` (today at that time) or `"2026-02-24 09:00"` (absolute). The daemon converts it to a cron expression with `runOnce: true`.

## Sandbox Isolation

Each job runs with `HOME` set to an overlay directory:

```
~/.agents/routines-sandbox/daily-review-<timestamp>/
  .claude/
    settings.json             # Generated with allow.tools permissions
  projects -> ~/projects      # Symlink from allow.dirs
```

The agent can only:
- See directories listed in `allow.dirs`
- Use tools listed in `allow.tools`
- Cannot access `~/.ssh`, `~/.gitconfig`, etc.

## Execution Flow

Temporal sequence from cron fire to report saved.

```
croner            JobScheduler          runner.ts           sandbox.ts       spawned agent       filesystem
(library)         scheduler.ts:20       executeJob          prepareJobHome   (claude/codex/      ~/.agents/runs/
                                                                              gemini)

     │                  │                  │                    │                │                    │
     ●──fire callback──▶│                  │                    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │──onTrigger(cfg)──▶                    │                │                    │
     │                  │  (scheduler.ts:42)                    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │──resolveJobPrompt──│                │                    │
     │                  │                  │  + buildJobCommand │                │                    │
     │                  │                  │  (runner.ts:40)    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │  if sandbox≠false: │                │                    │
     │                  │                  │──prepareJobHome───▶│                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │                    ├─rm old overlay─────────────────────▶│
     │                  │                  │                    ├─mkdir ~/.agents/routines/{name}/home▶│
     │                  │                  │                    ├─generateClaudeConfig (etc.)────────▶│ .claude/
     │                  │                  │                    │                                    │   settings.json
     │                  │                  │                    ├─symlinkAllowedDirs─────────────────▶│ home/<dir>->...
     │                  │                  │                    │                │                    │
     │                  │                  │◀──overlayHome──────│                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │──buildSpawnEnv─────▶│                │                    │
     │                  │                  │  HOME=overlay      │                │                    │
     │                  │                  │  + ENV_ALLOWLIST   │                │                    │
     │                  │                  │  (sandbox.ts:19)   │                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  ├─mkdir runDir, open stdout fd────────────────────────────▶│ runs/{job}/{runId}/
     │                  │                  ├─writeRunMeta(status='running')──────────────────────────▶│   meta.json
     │                  │                  │                    │                │                    │
     │                  │                  ├─spawn(cmd, {       │                │                    │
     │                  │                  │    detached:true,  │                │                    │
     │                  │                  │    stdio:[ign,     │                │                    │
     │                  │                  │          fd, fd],  │                │                    │
     │                  │                  │    env: spawnEnv   │                │                    │
     │                  │                  │  })  runner.ts:159─────────────────▶●                    │
     │                  │                  │                    │                │──stdout────────────▶│ stdout.log
     │                  │                  │                    │                │                    │
     │                  │                  │  setTimeout(timeout)                │                    │
     │                  │                  │  runner.ts:170     │                │                    │
     │                  │                  │                    │                ●──agent runs──       │
     │                  │                  │                    │                │   prompt, uses     │
     │                  │                  │                    │                │   allowed tools    │
     │                  │                  │                    │                ●──exits(code)───    │
     │                  │                  │◀───────'exit'──────────────────────────────────────────  │
     │                  │                  │                    │                │                    │
     │                  │                  ├─writeRunMeta(status=code===0 ? 'completed' : 'failed')──▶│ meta.json
     │                  │                  │                    │                │                    │
     │                  │                  ├─extractAndSaveReport(stdoutPath, agent, runDir)─────────▶│ report.md
     │                  │                  │  runner.ts:271     │                │                    │
     │                  │                  │                    │                │                    │
     │                  │◀──resolve────────│                    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │  if runOnce:     │                    │                │                    │
     │                  │  ├─unschedule    │                    │                │                    │
     │                  │  └─deleteJob     │                    │                │                    │
     ▼                  ▼                  ▼                    ▼                ▼                    ▼
```

On timeout: the setTimeout at `runner.ts:170` fires, sends `SIGTERM` to the
process group (`process.kill(-child.pid, 'SIGTERM')`), waits 5s, then
`SIGKILL`. Report extraction runs regardless — a truncated stdout is still
valuable.

## Run State Machine

Each `RunMeta.status` value maps to one terminal state. Transitions are
one-shot — a run never re-enters `running` once it leaves.

```
                        ┌─────────────┐
                        │  (spawned)  │
                        └──────┬──────┘
                               │
                               ▼
              writeRunMeta(status='running')
              runner.ts:149
                               │
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         │                     │                     │
         ▼                     ▼                     ▼
    exit code=0          exit code≠0         timeout fires
    runner.ts:200        runner.ts:200       runner.ts:184
         │                     │                     │
         ▼                     ▼                     ▼
    ┌─────────┐           ┌────────┐            ┌─────────┐
    │completed│           │ failed │            │ timeout │
    └─────────┘           └────────┘            └─────────┘
                                                      │
                                                      │
                                             SIGTERM → wait 5s → SIGKILL
                                             report still extracted from
                                             partial stdout
```

Plus one error branch: `child.on('error')` at `runner.ts:208` (spawn itself
failed — binary not found, EACCES, etc.) → `status='failed'` with `exitCode=null`.

## Sandbox Data Flow

What `prepareJobHome` produces on disk, given a job config.

```
Input:  JobConfig                                Output:  ~/.agents/routines/{name}/home/

┌──────────────────────────┐                    ┌─────────────────────────────────────────┐
│ name: daily-review       │                    │ (cleanJobHome removes any prior overlay)│
│ agent: claude            │                    │                                         │
│ mode: plan               │  prepareJobHome    │ .claude/                                │
│ allow:                   │  sandbox.ts:74     │   settings.json  ← generateClaudeConfig │
│   dirs:                  │                    │                    - mode → permMode    │
│     - ~/projects/myapp   │ ─────────────────▶ │                    - allow.tools        │
│   tools:                 │                    │                    - SAFE_TOOLS expand  │
│     - Bash(git *)        │                    │                                         │
│     - Read               │                    │ myapp -> /Users/you/projects/myapp      │
│     - web_search         │                    │   (symlink, from allow.dirs)            │
│                          │                    │                                         │
└──────────────────────────┘                    └─────────────────────────────────────────┘

                                                 Env handed to child process:
                                                 (sandbox.ts:52, buildSpawnEnv)
                                                 ┌─────────────────────────────────────────┐
                                                 │ HOME=~/.agents/routines/daily-review/home│
                                                 │ + forwarded from parent only if in      │
                                                 │   ENV_ALLOWLIST (sandbox.ts:19):        │
                                                 │   PATH, SHELL, TERM, LANG, LC_*, USER,  │
                                                 │   TMPDIR, XDG_*, NVM_DIR, NODE_PATH,    │
                                                 │   BUN_INSTALL, EDITOR, VISUAL, NO_COLOR │
                                                 │   FORCE_COLOR                           │
                                                 │ + TZ (if config.timezone)               │
                                                 │                                         │
                                                 │ Everything else (AWS_*, OPENAI_API_KEY, │
                                                 │ GITHUB_TOKEN, etc.) is DROPPED.         │
                                                 └─────────────────────────────────────────┘
```

Tools in `allow.tools` are expanded per two small tables at `sandbox.ts:43-49`:

- `SAFE_TOOLS` — safe wildcards (`web_search` → `WebSearch(*)`, `web_fetch` → `WebFetch(*)`)
- `DIR_SCOPED_TOOLS` — always scoped, never wildcarded (`read`, `write`, `edit`, `glob`, `grep`, `notebook_edit`). A bare `Read` in config expands to `Read(dir1)`, `Read(dir2)`… for each entry in `allow.dirs`.

This is the core isolation invariant: the spawned agent's view of the
filesystem is **only** the symlinks we created in the overlay, plus any
file:// paths its tools touch via the allowed-tool expansion. No `~/.ssh`,
no `~/.gitconfig`, no ambient AWS/OPENAI keys.

### Run Output

Each execution creates a run directory with structured output:

```
~/.agents/
  runs/
    daily-review/
      2026-04-17T09:00:00.000Z/
        stdout.log                    # Full terminal output
        stderr.log                    # Error output
        exit-code                     # Exit status (0, 1, etc.)
        report.md                     # Extracted report
        meta.json                     # { agent, version, mode, status, durationMs }
```

## Commands

```bash
# Lifecycle
agents routines list                  # List all jobs with next run + status
agents routines add <name> --schedule "0 9 * * *" --agent claude --prompt "..."  # Inline
agents routines add <path.yml>        # Add from YAML file
agents routines add <name> --at "14:30" --agent claude --prompt "..."            # One-shot
agents routines edit <name>           # Open job in $EDITOR
agents routines remove <name>         # Delete a job
agents routines pause <name>          # Disable a job
agents routines resume <name>         # Re-enable a paused job

# Execution
agents routines run <name>            # Run immediately in foreground
agents routines view <name>           # Show job config
agents routines runs <name>           # View execution history (last 10)
agents routines logs <name>           # Show stdout from latest run
agents routines logs <name> --run <id>  # Show specific run
agents routines report <name>         # Show report from latest run
agents routines report <name> --run <id>  # Show specific run report

# Scheduler (auto-starts on first `routines add`; these are manual controls)
agents routines start                 # Start the background scheduler
agents routines stop                  # Stop the scheduler
agents routines status                # Show scheduler status + upcoming runs
agents routines scheduler-logs        # Read scheduler log output

# Deprecated (removed in v2.0): `agents daemon start|stop|status|logs`
```

### Non-Interactive Usage

For scripting, pass explicit names and flags to avoid interactive pickers:

```bash
# Add a job without pickers
agents routines add morning-briefing --schedule "0 8 * * 1-5" \
  --agent claude --mode plan --prompt "Summarize overnight changes in the repo"

# Run a job in the foreground
agents routines run morning-briefing

# View the report
agents routines report morning-briefing
```

## Scheduler

A background scheduler (historically called "the daemon" internally) watches for cron-triggered jobs. It persists across CLI invocations and auto-reloads when job configs change.

```bash
agents routines start     # Start manually (usually unnecessary)
agents routines stop      # Stop
agents routines status    # Check PID, uptime, and upcoming runs
```

The scheduler **auto-starts on the first `agents routines add`**, so in most cases you never invoke `start` manually. When you `add`, `remove`, `pause`, or `resume` a job, it auto-reloads -- no manual restart needed.

The legacy `agents daemon <cmd>` subcommands still work but print a deprecation warning and will be removed in v2.0.

## Key Functions

| Function | File | Purpose |
|------|------|------|
| `listJobs()` | routines.ts | List all configured jobs |
| `writeJob()` / `readJob()` | routines.ts | Persist job config |
| `executeJob()` | runner.ts | Run job with sandbox isolation |
| `createOverlay()` | sandbox.ts | Create HOME overlay with permissions |
| `scheduleJob()` | scheduler.ts | Register cron trigger |
| `signalDaemonReload()` | daemon.ts | Notify daemon to reload config |
| `parseAtTime()` | routines.ts | Parse --at time strings to cron |
| `getLatestRun()` / `listRuns()` | routines.ts | Query execution history |
