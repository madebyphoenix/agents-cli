# Changelog

## 1.6.12

**"memory" is now "rules"**

The `agents memory` command has been renamed to `agents rules`. This better reflects what these files actually are -- instruction files like AGENTS.md, CLAUDE.md, and .cursorrules that tell your agents how to behave.

- `agents rules list` -- see your instruction files across all agents
- `agents rules add` -- install and sync rule files from a repo or local path
- `agents rules view` -- view rule file content for any agent
- `agents rules remove` -- remove a rule file

If you run `agents memory`, you'll see a message pointing you to the new command.

The files themselves haven't changed -- AGENTS.md is still AGENTS.md. Only the CLI command name changed.

## 1.6.8

**Bug fix**

- Skip commands and memory sync for agents that don't support file-based commands (openclaw)
- Added `commands` capability flag to agent configs
- `agents use openclaw` and `agents view openclaw` no longer show or sync slash commands or memory files
- Fixed `hasNewResources` to filter by agent capabilities (was triggering prompt even when no applicable resources existed)

## 1.6.5

**Bug fix**

- Fixed memory file detection counting symlinks as separate files (CLAUDE.md/GEMINI.md -> AGENTS.md)

## 1.6.4

**Bug fixes**

- Fixed Claude email not showing in `agents view` (was reading from version home instead of real ~/.claude.json)
- Fixed memory file updates not being detected in `agents use` (now compares content, not just existence)

## 1.6.3

**Bug fix**

- Fixed infinite "new resources available" loop in `agents view`
- Partial resource syncs no longer wipe out previously synced resources

## 1.5.82

**MCP & Permission improvements**

- MCP configs now stored as YAML in `~/.agents/mcp/` (was JSON)
- Permissions now use groups from `~/.agents/permissions/groups/`
- Resource selection shows proper counts: "Permissions (19 groups, 3132 rules)"
- When selecting "specific" permissions, shows individual groups with rule counts
- Added MCP support for cursor and opencode agents
- Removed `agents` filter from MCP configs - selection tracked in agents.yaml
- Added capability checks for MCPs (consistent with hooks/permissions)

## 1.5.81

**Cron jobs & unified execution**

- Renamed `jobs` command to `cron` (`jobs` still works with deprecation warning)
- New `agents exec <agent> <prompt>` for unified agent execution across all CLIs
- Inline job creation: `agents cron add my-job --schedule "..." --agent claude --prompt "..."`
- One-shot jobs with `--at`: `agents cron add reminder --at "14:30" -a claude -p "..."`
- New `agents cron edit [name]` opens job in `$EDITOR`
- Timezone support: `--timezone America/Los_Angeles`
- Custom variables in prompts: define `variables:` block, use `{var_name}` in prompt
- Interactive pickers for all cron subcommands when name is omitted
- Smart filtering: `resume` shows only paused jobs, `pause` shows only enabled jobs
- Effort-based model mapping: `--effort fast|default|detailed` maps to agent-specific models

**Resource command cleanup**

- Added `view` command to commands, mcp, hooks, and permissions
- Removed `push` commands from all resources (commands, skills, mcp, memory, hooks)
- Deprecated `perms` alias for `permissions` (shows warning but still works)
- Deprecated `info` alias for `skills view`, `show` alias for `memory view`

## 1.5.68

- Upgrade prompt now shows on ALL command flows (--version, --help, bare `agents`)

## 1.5.67

**Unified view command**

- New `agents view` command replaces `list` and `status`
- `agents view` / `agents view claude` shows installed versions
- `agents view claude@2.0.65` shows full resources (commands, skills, mcp, hooks, memory)
- Old commands show deprecation warning but continue to work

## 1.5.48

**Simplified repo structure**

- Flattened repo structure: removed `shared/` prefix
- Resources now live at top level: `commands/`, `skills/`, `hooks/`, `memory/`, `permissions/`
- Removed agent-specific override directories (no more `claude/commands/`, etc.)
- Simplified discovery functions

## 1.5.29

**Version-aware resource installation**

- `agents pull` now prompts for version selection per agent when multiple versions are installed
- Resources (commands, skills, hooks, memory) are linked into version homes at pull time via `syncResourcesToVersion()`
- Simplified shims: HOME overlay + exec only (~80 lines, down from ~160). No more runtime sync logic.
- MCP registration uses direct binary path for version-managed agents (bypasses shim)

## 1.5.7

- Remove trailing newlines from command output

## 1.5.5

- Update prompt: Interactive menu before command runs (Upgrade now / Later)

## 1.5.4

- `cli list`: Shows spinner while checking installed CLIs

## 1.5.3

- `skills view`: Opens in pager (less) for scrolling, press `q` to quit

## 1.5.2

- `skills view`: Truncate descriptions to fit on one line

## 1.5.1

- Update check: Shows prompt when new version available
- What's new: Displays changelog after upgrade
- `skills view`: Interactive skill selector (renamed from `info`)
- Fixed `--version` showing hardcoded 1.0.0 (now reads from package.json)
- Silent npm/bun output during upgrade

## 1.5.0

**Pull command redesign**

- Agent-specific sync: `agents pull claude` syncs only Claude resources
- Agent aliases: `cc`, `cx`, `gx`, `cr`, `oc` for quick filtering
- Overview display: Shows NEW vs EXISTING resources before installation
- Per-resource prompts: Choose overwrite/skip/cancel for each conflict
- `-y` flag: Auto-confirm and skip conflicts
- `-f` flag: Auto-confirm and overwrite conflicts
- Graceful cancellation: Ctrl+C shows "Cancelled" cleanly

## 1.4.0

- Conflict detection for pull command
- Bulk conflict handling (overwrite all / skip all / cancel)

## 1.3.13

- Enabled skills support for Cursor and OpenCode
- Fixed Cursor MCP config path (now uses mcp.json)

## 1.3.12

- Fixed MCP detection for Codex (TOML config format)
- Fixed MCP detection for OpenCode (JSONC config format)
- Added smol-toml dependency for TOML parsing

## 1.3.11

- Status command shows resource names instead of counts
- Better formatting for installed commands, skills, and MCPs

## 1.3.0

- Added Agent Skills support (SKILL.md + rules/)
- Skills validation with metadata requirements
- Central skills directory at ~/.agents/skills/

## 1.2.0

- Added hooks support for Claude and Gemini
- Hook discovery from hooks/ directory
- Project-scope hooks support

## 1.1.0

- Added MCP server registration
- Support for stdio and http transports
- Per-agent MCP configuration

## 1.0.0

- Initial release
- Pull/push commands for syncing agent configurations
- Slash command management
- Multi-agent support (Claude, Codex, Gemini, Cursor, OpenCode)
