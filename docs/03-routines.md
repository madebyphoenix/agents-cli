# Cron Jobs

Scheduled agent execution with sandboxed permissions.

## Architecture

```
~/.agents/
  cron/
    daily-review.yaml         # Job config
    weekly-cleanup.yaml
  runs/
    daily-review/
      2024-03-10T14:30:00/    # Run output
        stdout.log
        stderr.log
        exit-code
```

## Job Config

```yaml
# ~/.agents/cron/daily-review.yaml
name: daily-review
schedule: "0 9 * * *"         # 9am daily (cron syntax)
agent: claude
version: 2.0.65               # Optional, uses default if omitted
mode: plan                    # plan (read-only) or edit
effort: default               # fast, default, or detailed
timeout: 10m
enabled: true

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

## Sandbox Isolation

Each job runs with `HOME` set to an overlay directory:

```
~/.agents/cron/daily-review/home/
  .claude/
    settings.json             # Generated with allow.tools permissions
  projects -> ~/projects      # Symlink from allow.dirs
```

The agent can only:
- See directories listed in `allow.dirs`
- Use tools listed in `allow.tools`
- Cannot access `~/.ssh`, `~/.gitconfig`, etc.

## Execution Flow

```
Cron trigger (croner)
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  runner.ts:executeJob()                                             │
│                                                                     │
│  1. Create sandbox: sandbox.ts:createOverlay()                      │
│     └─ Generate settings.json with permissions                     │
│     └─ Symlink allowed directories                                 │
│                                                                     │
│  2. Spawn agent process                                             │
│     └─ HOME=/path/to/overlay                                       │
│     └─ Pass prompt via stdin or --prompt                           │
│                                                                     │
│  3. Capture output to runs/{job}/{timestamp}/                       │
│                                                                     │
│  4. Cleanup sandbox                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

## Commands

```bash
agents cron list              # Show all jobs
agents cron add <name>        # Create new job (interactive)
agents cron add <name> --schedule "0 9 * * *" --agent claude --prompt "..."
agents cron edit <name>       # Open in $EDITOR
agents cron run <name>        # Run immediately
agents cron pause <name>      # Disable job
agents cron resume <name>     # Enable job
agents cron remove <name>     # Delete job
agents cron logs <name>       # View recent runs
```

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `parseJobConfig()` | jobs.ts | Parse job YAML |
| `executeJob()` | runner.ts | Run job with sandbox |
| `createOverlay()` | sandbox.ts | Create HOME overlay |
| `scheduleJob()` | scheduler.ts | Register cron trigger |
