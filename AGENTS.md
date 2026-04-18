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
    sessions.ts      # agents sessions list/view (default: summary mode)
    exec.ts          # agents exec
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
agents sessions              # List sessions across all agents
agents sessions list         # Same, with --agent/--project filters
agents sessions view <id>    # View session (summary by default)
agents sessions view <id> --transcript   # Full conversation transcript
agents sessions view <id> --trace        # Reasoning trace as markdown
agents sessions view <id> --json         # Normalized events as JSON

# Execution
agents exec <agent> <prompt> # Execute agent non-interactively

# Automation
agents routines              # Manage scheduled jobs
agents daemon                # Manage the scheduler daemon

# PTY sessions
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
