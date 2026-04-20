# agents-cli

CLI for managing AI coding agent versions, config, and sessions (Claude, Codex, Gemini, Cursor, OpenCode, OpenClaw).

## Core Concepts

**Version Management** - Install/switch agent CLI versions like `nvm` for Node.js
**Config Sync** - Backup agent config (commands, skills, hooks, rules) to git, restore across machines
**Session Reading** - Unified view of session logs across Claude, Codex, and Gemini

### Directory Structure

```
~/.agents/                    # User's git repo (source of truth)
  agents.yaml                 # Global defaults + repo config
  commands/                   # Slash commands (git-tracked)
  skills/                     # Agent skills (git-tracked)
  hooks/                      # Event hooks (git-tracked)
  memory/                     # Memory/rules files (git-tracked)
  mcp/                        # MCP configs as YAML (git-tracked)
  permissions/groups/         # Permission groups (git-tracked)
  versions/{agent}/{version}/ # Installed CLIs (local-only)
  shims/                      # Version switching scripts (local-only)
  backups/{agent}/{timestamp}/ # Config backups from version switches
  routines/                   # Scheduled job configs (YAML)
  drive/                      # Drive-sync remote session data
  plugins/                    # Agent plugins (discovery via agents plugins)
  subagents/                  # Subagent definitions
  runs/                       # Execution history for scheduled jobs
```

### Version Switching

`agents use claude@2.0.65`:
1. If `~/.claude/` is a real directory -> backup to `~/.agents/backups/claude/{timestamp}/`
2. Create symlink: `~/.claude/ -> ~/.agents/versions/claude/2.0.65/home/.claude/`

Shims in `~/.agents/shims/` resolve version from `.agents-version` (project) or `agents.yaml` (global), then exec.

### Resource Sync

`syncResourcesToVersion()` symlinks central resources into version homes. Memory file `AGENTS.md` maps to agent-specific names (CLAUDE.md, GEMINI.md).

## Architecture

```
src/
  index.ts           # CLI entry (commander.js)
  commands/          # Command implementations
    sessions.ts      # agents sessions (single smart command: picker, table, or render)
    exec.ts          # agents run
    routines.ts      # agents routines (scheduled jobs)
    drive.ts         # agents drive (remote session sync)
    plugins.ts       # agents plugins
    subagents.ts     # agents subagents
    status.ts        # agents status (deprecated alias for agents view)
    daemon.ts        # agents daemon (scheduler daemon)
    ...
  lib/
    types.ts         # Core types (AgentId, Meta)
    agents.ts        # Agent configs, detection, MCP ops
    profiles.ts      # Profile schema, YAML read/write, keychain-aware resolver
    profiles-presets.ts  # Built-in preset catalog (Kimi/DeepSeek/Qwen/GLM/MiniMax via OpenRouter)
    profiles-keychain.ts # macOS keychain wrapper (shim over shared secrets module)
    state.ts         # ~/.agents/agents.yaml management
    versions.ts      # Install, remove, sync resources
    shims.ts         # Shim generation, config symlink switching
    exec.ts          # Agent execution (command building, spawning)
    routines.ts      # Scheduled job config
    scheduler.ts     # Job cron scheduling
    daemon.ts        # Daemon management (reload, health)
    runner.ts        # Job execution with sandboxing
    drive-sync.ts    # Remote drive sync (rsync to remote host)
    subagents.ts     # Subagent management (discover, install, remove)
    plugins.ts       # Plugin discovery and sync
    pty-server.ts    # PTY sidecar server (unix socket, node-pty, xterm-headless)
    pty-client.ts    # PTY client (auto-start server, IPC, escape parsing)
    session/         # Session discovery, parsing, rendering
      types.ts       # SessionEvent, SessionMeta, ViewMode
      discover.ts    # Find sessions across Claude/Codex/Gemini
      parse.ts       # Parse stored session formats into normalized events
      render.ts      # Transcript, summary, trace, JSON renderers
      prompt.ts      # Prompt cleaning and topic extraction from raw session messages
      team-filter.ts # Classify and filter team-spawned sessions
```

## Key Types

```typescript
type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'openclaw';

interface Meta {
  agents?: Partial<Record<AgentId, string>>;  // Global defaults
  repos?: Record<string, RepoConfig>;
}
```

## Agent Config

| Agent | Commands Dir | Format | Memory File |
|-------|-------------|--------|-------------|
| Claude | commands/ | markdown | CLAUDE.md |
| Codex | prompts/ | markdown | AGENTS.md |
| Gemini | commands/ | toml | GEMINI.md |
| Cursor | commands/ | markdown | .cursorrules |
| OpenCode | commands/ | markdown | OPENCODE.md |
| OpenClaw | (gateway) | markdown | AGENTS.md |

## Commands

```bash
# Agents
agents add claude@2.0.65     # Install version
agents use claude@2.0.65     # Set default (only way to set default)
agents remove claude@2.0.65  # Remove version
agents view                  # Show installed versions + resources

# Resources
agents rules                 # Manage agent rules/instructions
agents commands              # Manage slash commands
agents subagents             # Manage subagent definitions
agents skills                # Manage skills (SKILL.md + rules/)
agents mcp                   # Manage MCP servers
agents permissions           # Manage agent permissions
agents hooks                 # Manage agent hooks
agents plugins               # Manage agent plugins

# Packages
agents search <query>        # Search MCP servers
agents install <pkg>         # Install mcp:name or skill:user/repo

# Sessions
agents sessions                       # Interactive picker (TTY) or table (piped); team-spawned sessions hidden by default
agents sessions <query>               # Search by text, path, or session ID
agents sessions --teams               # Include team-spawned sessions with [team/handle · mode] tag
agents sessions <id>                  # Default activity summary
agents sessions <id> --markdown       # Full conversation as markdown (user, assistant, thinking, tools)
agents sessions <id> --json           # Normalized events as JSON
agents sessions <id> --include user   # Only user messages (auto-markdown)
agents sessions <id> --exclude thinking --markdown   # Drop reasoning from markdown
agents sessions <id> --last 3         # Last 3 turns (turn = user message)
agents sessions <id> --first 10 --include user --json # Compose filters + format

# Profiles (host CLI + endpoint + model + keychain auth)
agents profiles add kimi              # apply a preset; prompts for API key once per provider
agents profiles presets               # list built-in presets (Kimi, DeepSeek, Qwen, GLM, MiniMax)
agents profiles list                  # list installed profiles
agents profiles view <name>           # env + keychain status
agents profiles login <provider>      # rotate stored key
agents profiles remove <name>         # delete a profile (keychain item preserved)

# Execution
agents run <agent|profile> <prompt>   # Execute agent non-interactively (profile name resolves to host CLI + env)

# Schedule
agents routines              # Manage scheduled jobs (add, list, run, pause, resume)
agents routines start        # Start scheduler manually (auto-starts on first 'routines add')
agents routines stop         # Stop scheduler
agents routines status       # Scheduler status + upcoming runs
agents routines scheduler-logs  # Scheduler log output
# agents daemon ... is deprecated (removed in v2.0); use `agents routines` equivalents

# Helpers (PTY sessions)
agents pty start             # Start interactive PTY session (returns ID)
agents pty exec <id> <cmd>   # Run command (non-blocking, sentinel detection)
agents pty screen <id>       # Render terminal as clean text (xterm-headless)
agents pty write <id> <input> # Send keystrokes (\n \t \e \xHH)
agents pty read <id>         # Read raw PTY output
agents pty signal <id> INT   # Send signal to process
agents pty list              # Show active sessions
agents pty stop <id>         # Kill session
agents pty server status     # Sidecar server on ~/.agents/pty.sock

# Env
agents pull                  # Sync from git repo
agents push                  # Push config to your .agents repo
agents fork                  # Fork system repo to your GitHub
```

## Session Storage

Sessions are stored differently by each agent. `agents sessions` normalizes all three formats.

| Agent | Format | Location |
|-------|--------|----------|
| Claude | JSONL (one line per message) | `~/.claude/projects/{encoded-path}/{uuid}.jsonl` |
| Codex | JSONL (one line per event) | `~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{uuid}.jsonl` |
| Gemini | Single JSON | `~/.gemini/tmp/{project-hash}/chats/session-{ts}-{uuid}.json` |

All formats normalize to `SessionEvent` with types: message, tool_use, tool_result, thinking, error, init, result.

## Rules

- `setGlobalDefault()` MUST only be called from `agents use`
- Resources sync via symlinks, not copies (except Gemini TOML conversion)
- Version resolution: `.agents-version` (walk up) -> `~/.agents/agents.yaml`

## Build

```bash
bun install && bun run build && bun test
```

## Detailed Design

See `docs/` for architecture deep-dives:
- `01-version-management.md` - Version install, switching, isolation
- `02-resource-sync.md` - Resource syncing between central and version homes
- `03-routines.md` - Scheduled jobs (routines) with sandboxed permissions
- `04-landscape.md` - Competitive landscape vs Rivet, Agentloom, mise, cass, and others
