# Resource Sync

How agents-cli syncs resources (commands, skills, hooks, memory, MCP, permissions) between central storage and version homes.

## Resource Types

| Resource | Central Location | Version Home Location | Sync Method |
|----------|-----------------|----------------------|-------------|
| Commands | `~/.agents/commands/*.md` | `.{agent}/commands/` | Symlink (copy+convert for Gemini) |
| Skills | `~/.agents/skills/{name}/` | `.{agent}/skills/` | Symlink |
| Hooks | `~/.agents/hooks/*.sh` | `.{agent}/hooks/` | Symlink |
| Memory | `~/.agents/memory/AGENTS.md` | `.{agent}/{instructionsFile}` | Symlink |
| MCP | `~/.agents/mcp/*.yaml` | `.{agent}/settings.json` | Merge into JSON |
| Permissions | `~/.agents/permissions/groups/*.yaml` | `.{agent}/settings.json` | Merge into JSON |

## Memory File Mapping

Central `AGENTS.md` maps to agent-specific filenames:

```
~/.agents/memory/AGENTS.md  ───▶  ~/.claude/CLAUDE.md
                            ───▶  ~/.codex/AGENTS.md
                            ───▶  ~/.gemini/GEMINI.md
                            ───▶  ~/.cursor/.cursorrules
                            ───▶  ~/.opencode/OPENCODE.md
```

Symlinks in `~/.agents/memory/`:
```
AGENTS.md       # Real file (source of truth)
CLAUDE.md -> AGENTS.md
GEMINI.md -> AGENTS.md
```

## Sync Detection

`getAvailableResources()` - What exists in central `~/.agents/`:
- Lists files/dirs in commands/, skills/, hooks/, memory/, mcp/, permissions/
- Filters out symlinks for memory (CLAUDE.md -> AGENTS.md counted as one)

`getActuallySyncedResources()` - What's in version home matching central:
- Checks if symlinks exist pointing to central resources
- For memory: compares file content (not just existence)

`getNewResources()` - Available minus synced = what needs syncing

## Sync Flow

```
agents use claude@2.0.65
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. getNewResources(claude, 2.0.65)                                 │
│     └─ Returns: { commands: [foo], skills: [], memory: [AGENTS] }  │
│                                                                     │
│  2. If new resources found, prompt user                             │
│     └─ "2 commands, 1 memory file available. Sync now?"            │
│                                                                     │
│  3. syncResourcesToVersion(claude, 2.0.65)                          │
│     └─ Creates symlinks in version home                             │
│     └─ Records synced resources in agents.yaml                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Format Conversion (Gemini)

Gemini requires TOML format for commands. Markdown commands are converted:

```markdown
# ~/.agents/commands/commit.md
---
description: Create a commit
---
Review changes and create a commit with a descriptive message.
```

Becomes:

```toml
# ~/.gemini/commands/commit.toml
[command]
description = "Create a commit"

[[command.steps]]
prompt = "Review changes and create a commit with a descriptive message."
```

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `getAvailableResources()` | versions.ts | List central resources |
| `getActuallySyncedResources()` | versions.ts | Check what's synced to version |
| `getNewResources()` | versions.ts | Diff available vs synced |
| `syncResourcesToVersion()` | versions.ts | Create symlinks in version home |
| `markdownToToml()` | convert.ts | Convert command format for Gemini |
