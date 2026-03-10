# agents-cli

CLI for managing AI coding agent versions and config (Claude, Codex, Gemini, Cursor, OpenCode).

## Core Concepts

**Version Management** - Install/switch agent CLI versions like `nvm` for Node.js
**Config Sync** - Backup agent config (commands, skills, hooks, memory) to git, restore across machines

### Directory Structure

```
~/.agents/                    # User's git repo (source of truth)
  agents.yaml                 # Global defaults + repo config
  commands/                   # Slash commands (git-tracked)
  skills/                     # Agent skills (git-tracked)
  hooks/                      # Event hooks (git-tracked)
  memory/                     # Memory files (git-tracked)
  mcp/                        # MCP configs as YAML (git-tracked)
  permissions/groups/         # Permission groups (git-tracked)
  versions/{agent}/{version}/ # Installed CLIs (local-only)
  shims/                      # Version switching scripts (local-only)
  backups/{agent}/{timestamp}/ # Config backups from version switches
  cron/                       # Scheduled jobs
```

### Version Switching

`agents use claude@2.0.65`:
1. If `~/.claude/` is a real directory → backup to `~/.agents/backups/claude/{timestamp}/`
2. Create symlink: `~/.claude/ → ~/.agents/versions/claude/2.0.65/home/.claude/`

Shims in `~/.agents/shims/` resolve version from `.agents-version` (project) or `agents.yaml` (global), then exec.

### Resource Sync

`syncResourcesToVersion()` symlinks central resources into version homes. Memory file `AGENTS.md` maps to agent-specific names (CLAUDE.md, GEMINI.md).

## Architecture

```
src/
  index.ts           # CLI entry (commander.js)
  commands/          # Command implementations
  lib/
    types.ts         # Core types (AgentId, Meta)
    agents.ts        # Agent configs, detection, MCP ops
    state.ts         # ~/.agents/agents.yaml management
    versions.ts      # Install, remove, sync resources
    shims.ts         # Shim generation, config symlink switching
```

## Key Types

```typescript
type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';

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

## Commands

```bash
agents add claude@2.0.65     # Install version
agents use claude@2.0.65     # Set default (only way to set default)
agents remove claude@2.0.65  # Remove version
agents view                  # Show installed versions + resources
agents pull                  # Sync from git repo
agents push                  # Push to git repo
```

## Rules

- `setGlobalDefault()` MUST only be called from `agents use`
- Resources sync via symlinks, not copies (except Gemini TOML conversion)
- Version resolution: `.agents-version` (walk up) → `~/.agents/agents.yaml`

## Build

```bash
bun install && bun run build && bun test
```

## Detailed Design

See `docs/` for architecture deep-dives:
- `01-version-management.md` - Version install, switching, isolation
- `02-resource-sync.md` - Resource syncing between central and version homes
- `03-cron-jobs.md` - Scheduled jobs with sandboxed permissions
