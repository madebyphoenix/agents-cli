# agents-cli: Cron + Exec Layer

## Vision

Make agents-cli the **infrastructure layer** for AI agent orchestration:
- **Version management** - nvm for agent CLIs
- **Config sync** - git-backed backup/restore
- **Unified exec** - one interface, any agent
- **Scheduled jobs** - cron with YAML configs (like Rush agents)

## Part 1: `agents cron` (rename from `jobs`)

### Current State

```
~/.agents/jobs/
  daily-review.yml     # Job config
~/.agents/runs/
  daily-review/
    2026-02-21-0900/
      meta.json
      stdout.log
      report.md
```

### Target State

```
~/.agents/cron/
  daily-review.yml     # Job config (renamed from jobs/)
~/.agents/runs/
  daily-review/        # Same structure
```

### Command Changes

| Current | New | Notes |
|---------|-----|-------|
| `agents jobs list` | `agents cron list` | Rename |
| `agents jobs add <path>` | `agents cron add <path>` | From YAML file |
| - | `agents cron add <name> --schedule "..." --agent <agent> --prompt "..."` | Quick inline |
| `agents jobs run <name>` | `agents cron run <name>` | Manual trigger |
| `agents jobs logs <name>` | `agents cron logs <name>` | View stdout |
| `agents jobs report <name>` | `agents cron report <name>` | View report |
| `agents jobs enable <name>` | `agents cron resume <name>` | Match OpenClaw |
| `agents jobs disable <name>` | `agents cron pause <name>` | Match OpenClaw |
| - | `agents cron remove <name>` | Delete job |
| - | `agents cron view <name>` | Show job config |
| - | `agents cron runs <name>` | Execution history |
| - | `agents cron edit <name>` | Edit config (opens $EDITOR) |

### Inline Add (writes YAML under the hood)

```bash
# Quick one-liner
agents cron add "morning-standup" \
  --schedule "0 9 * * 1-5" \
  --agent claude \
  --prompt "Review overnight PRs and summarize"

# Creates ~/.agents/cron/morning-standup.yml:
name: morning-standup
schedule: "0 9 * * 1-5"
agent: claude
prompt: "Review overnight PRs and summarize"
mode: plan
effort: default
timeout: 30m
enabled: true
```

### Full YAML Format (Rush-inspired)

```yaml
# ~/.agents/cron/deep-review.yml
name: deep-review
schedule: "0 9 * * 1"  # Every Monday 9am
timezone: America/Los_Angeles

# Agent selection
agent: claude
version: 2.1.37  # Pin version (optional)

# Execution config
mode: plan  # plan | edit
effort: detailed  # fast | default | detailed
timeout: 2h

# The prompt (supports variables)
prompt: |
  Review all PRs merged last week.
  Focus on: {focus_areas}

  Previous report: {last_report}

# Variables for prompt templating
variables:
  focus_areas: "security, performance, breaking changes"

# Sandbox permissions (from current jobs system)
allow:
  tools:
    - Read
    - Glob
    - Grep
  dirs:
    - ~/src/myproject

# Output
output:
  artifact: weekly-review.md  # Save as artifact
  notify:
    - slack:#engineering  # Future: notifications

enabled: true
```

### Key Features

1. **YAML-first** - Complex configs work, git-trackable
2. **Inline shorthand** - Quick jobs via CLI flags
3. **Variable templating** - `{last_report}`, `{date}`, `{day}`
4. **Version pinning** - Use specific agent CLI version
5. **Timezone support** - Like OpenClaw
6. **Sandbox permissions** - Already have this, keep it

---

## Part 2: `agents exec` (Unified Execution)

### Goal

One command to execute any agent with consistent interface:

```bash
agents exec <agent>[@version] "<prompt>" [options]
```

### Examples

```bash
# Basic
agents exec claude "implement auth"
agents exec codex "fix the bug" --mode edit
agents exec gemini "plan the refactor" --effort detailed

# With version
agents exec claude@2.1.37 "task"

# With working directory
agents exec claude "review this code" --cwd ~/myproject

# Interactive (default) vs non-interactive
agents exec claude "task"              # Interactive
agents exec claude "task" --headless   # Non-interactive (for scripts)

# Output format
agents exec claude "task" --json       # Stream JSON events
agents exec claude "task" --quiet      # Suppress progress, show final output
```

### How It Works

```
agents exec claude@2.1.37 "implement auth" --mode edit --effort detailed
         │        │              │              │           │
         ▼        ▼              ▼              ▼           ▼
     1. Resolve   2. Get      3. Build      4. Apply    5. Map effort
        version      shim       command       mode         to model
                                             flags

                              ┌─────────────────┐
                              │ HOME Overlay    │
                              │ (~/.agents/     │
                              │  versions/      │
                              │  claude/2.1.37/ │
                              │  home/)         │
                              └────────┬────────┘
                                       │
                              ┌────────▼────────┐
                              │ claude -p       │
                              │ --model opus    │
                              │ --permission-   │
                              │  mode acceptEdits│
                              │ "implement auth"│
                              └─────────────────┘
```

### Implementation

Leverage existing infrastructure:
- **Version resolution**: `resolveVersion()` from `lib/versions.ts`
- **Shim execution**: Use shims for HOME overlay (already built)
- **Command building**: Similar to `agents-mcp/src/agents.ts` `buildCommand()`

```typescript
// New: src/lib/exec.ts
export interface ExecOptions {
  agent: AgentId;
  version?: string;
  prompt: string;
  mode: 'plan' | 'edit';
  effort: 'fast' | 'default' | 'detailed';
  cwd?: string;
  headless?: boolean;
  json?: boolean;
}

export async function execAgent(options: ExecOptions): Promise<void> {
  // 1. Resolve version (project manifest → global default)
  const version = await resolveVersion(options.agent, options.version);

  // 2. Get shim path
  const shimPath = getShimPath(options.agent);

  // 3. Build command with mode/effort flags
  const cmd = buildCommand(options.agent, options);

  // 4. Execute via shim (handles HOME overlay)
  await spawn(shimPath, cmd, { cwd: options.cwd });
}
```

### Agent Command Templates

Each agent CLI has different argument structure. `agents exec` abstracts this:

```typescript
// src/lib/exec.ts

export const AGENT_COMMANDS: Record<AgentId, {
  base: string[];           // Base command
  promptFlag: string;       // How to pass prompt (-p, --prompt, or positional)
  outputFormat?: string[];  // JSON output flags
  modeFlags: {
    plan: string[];
    edit: string[];
  };
  modelFlag?: string;       // --model, -m, etc.
}> = {
  claude: {
    base: ['claude'],
    promptFlag: '-p',
    outputFormat: ['--output-format', 'stream-json', '--verbose'],
    modeFlags: {
      plan: ['--permission-mode', 'plan'],
      edit: ['--permission-mode', 'acceptEdits'],
    },
    modelFlag: '--model',
  },
  codex: {
    base: ['codex', 'exec'],
    promptFlag: 'positional',  // prompt is positional arg
    outputFormat: ['--json'],
    modeFlags: {
      plan: ['--sandbox', 'workspace-write'],
      edit: ['--sandbox', 'workspace-write', '--full-auto'],
    },
    modelFlag: '--model',
  },
  gemini: {
    base: ['gemini'],
    promptFlag: 'positional',
    outputFormat: ['--output-format', 'stream-json'],
    modeFlags: {
      plan: [],
      edit: ['--yolo'],
    },
    modelFlag: '--model',
  },
  cursor: {
    base: ['cursor-agent'],
    promptFlag: '-p',
    outputFormat: ['--output-format', 'stream-json'],
    modeFlags: {
      plan: [],
      edit: ['-f'],
    },
    modelFlag: '--model',
  },
  opencode: {
    base: ['opencode', 'run'],
    promptFlag: 'positional',
    outputFormat: ['--format', 'json'],
    modeFlags: {
      plan: ['--agent', 'plan'],
      edit: ['--agent', 'build'],
    },
    modelFlag: '--model',
  },
  openclaw: {
    base: ['openclaw'],
    promptFlag: 'positional',
    outputFormat: ['--output-format', 'stream-json'],
    modeFlags: {
      plan: ['--mode', 'plan'],
      edit: ['--mode', 'edit'],
    },
    modelFlag: '--model',
  },
};
```

### Built Commands Example

```bash
# User runs:
agents exec claude "implement auth" --mode edit --effort detailed

# agents-cli builds:
claude -p "implement auth" \
  --output-format stream-json \
  --verbose \
  --permission-mode acceptEdits \
  --model claude-opus-4-5
```

```bash
# User runs:
agents exec codex "fix bug" --mode edit --effort fast

# agents-cli builds:
codex exec \
  --sandbox workspace-write \
  --full-auto \
  --model gpt-4o-mini \
  --json \
  "fix bug"
```

```bash
# User runs:
agents exec gemini "plan refactor" --effort detailed

# agents-cli builds:
gemini "plan refactor" \
  --output-format stream-json \
  --model gemini-3-pro-preview
```

```bash
# User runs:
agents exec opencode "build feature" --mode edit

# agents-cli builds:
opencode run \
  --agent build \
  --format json \
  --model zai-coding-plan/glm-4.7 \
  "build feature"
```

### Mode Flags by Agent

| Agent | Plan Mode | Edit Mode |
|-------|-----------|-----------|
| Claude | `--permission-mode plan` | `--permission-mode acceptEdits` |
| Codex | `--sandbox workspace-write` | `--sandbox workspace-write --full-auto` |
| Gemini | (default) | `--yolo` |
| Cursor | (default) | `-f` |
| OpenCode | `--agent plan` | `--agent build` |
| OpenClaw | `--mode plan` | `--mode edit` |

### Effort → Model Mapping

| Effort | Claude | Codex | Gemini | OpenCode | OpenClaw |
|--------|--------|-------|--------|----------|----------|
| fast | haiku-4-5 | gpt-4o-mini | flash | glm-4.7-flash | haiku-4-5 |
| default | sonnet-4-5 | gpt-5.2-codex | flash | glm-4.7 | sonnet-4-5 |
| detailed | opus-4-5 | gpt-5.1-codex-max | pro | glm-4.7 | opus-4-5 |

Model mappings are hardcoded in `src/lib/exec.ts`. Use `--model` flag to override.

### Additional Flags

The exec command also supports:

```bash
# Working directory
agents exec claude "task" --cwd ~/project

# Add directory access (Claude-specific, passed as --add-dir)
agents exec claude "review code" --add-dir ~/project --add-dir ~/libs

# Settings file (Claude-specific)
agents exec claude "task" --settings ~/.claude/settings.json

# Headless/non-interactive (for scripts, cron jobs)
agents exec claude "task" --headless

# JSON output (stream events)
agents exec claude "task" --json

# Timeout
agents exec claude "task" --timeout 30m
```

### Agent-Specific Flag Mapping

| agents exec flag | Claude | Codex | Gemini | OpenCode |
|------------------|--------|-------|--------|----------|
| `--cwd` | `cwd` option | `cwd` option | `cwd` option | `cwd` option |
| `--add-dir` | `--add-dir` | N/A | N/A | N/A |
| `--settings` | `--settings` | N/A | N/A | N/A |
| `--headless` | `-p` (already) | `exec` (already) | (default) | `run` (already) |
| `--json` | `--output-format stream-json` | `--json` | `--output-format stream-json` | `--format json` |
| `--timeout` | N/A (external) | N/A (external) | N/A (external) | N/A (external) |

---

## File Structure (Final)

```
~/.agents/
  agents.yaml           # Existing: default versions, registries

  cron/                 # RENAMED from jobs/
    daily-review.yml
    weekly-report.yml

  runs/                 # Existing: job execution history
    daily-review/
      2026-02-21-0900/

  versions/             # Existing: installed CLIs
  shims/                # Existing: version switching
  commands/             # Existing: slash commands
  skills/               # Existing: agent skills
  hooks/                # Existing: event hooks
  memory/               # Existing: memory files
  permissions/          # Existing: permission sets
  mcp/                  # Existing: MCP configs
```

---

## Migration Plan

1. **Rename `jobs/` → `cron/`**
   - Move files
   - Update all references in code
   - Alias `agents jobs` → `agents cron` with deprecation warning

2. **Add `exec` command**
   - New `src/commands/exec.ts`
   - New `src/lib/exec.ts` (includes hardcoded model mappings)
   - Uses existing shim infrastructure

3. **Cron improvements**
   - Add inline `cron add` with flags
   - Add `pause`/`resume`/`remove`/`view`/`runs`
   - Add timezone support
   - Add `--at` for one-shot jobs

---

## Implementation Order

### Phase 1: Rename + Basic Cron
1. Rename `jobs` → `cron` in commands
2. Add `cron remove`, `cron view`, `cron runs`
3. Rename `enable`/`disable` → `resume`/`pause`
4. Add deprecation alias for `agents jobs`

### Phase 2: Exec Command
1. Create `src/lib/exec.ts` with command building + hardcoded model mappings
2. Create `src/commands/exec.ts`
3. Test with all agents

### Phase 3: Enhanced Cron
1. Inline `cron add` with flags
2. Timezone support
3. One-shot jobs (`--at`)
4. Variable templating in prompts

### Phase 4: Polish
1. `cron edit` (opens $EDITOR)
2. Execution notifications (future)
3. Integration with `agents push/pull` (jobs are already git-tracked)

---

## Positioning

After these changes, agents-cli becomes:

| What | How |
|------|-----|
| **nvm for AI agents** | `agents add claude@2.1.37`, `agents use` |
| **dotfiles for AI agents** | `agents push`, `agents pull` |
| **unified runner** | `agents exec claude "task"` |
| **cron for AI agents** | `agents cron add`, `agents daemon start` |

**Tagline**: "The infrastructure layer for AI coding agents"

vs AgentSync (just symlinks), vs OpenClaw (one agent), vs bare CLIs (no orchestration)
