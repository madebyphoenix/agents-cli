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

Sync state is derived, not stored. Three set operations over the filesystem:

```
available = contents of ~/.agents/{commands,skills,hooks,memory,mcp,permissions}
synced    = symlinks in <version home> whose target is under ~/.agents/
new       = available - synced
```

```
┌──────────────────────────────┬────────────────────────────────┬─────────────────────────────────┐
│ Function                     │ Reads                          │ Returns                         │
├──────────────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ getAvailableResources()      │ ~/.agents/*/                   │ { commands: string[],           │
│                              │ (skip symlinks in memory/)     │   skills: string[],             │
│                              │                                │   hooks: string[],              │
│                              │                                │   memory: string[], ... }       │
├──────────────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ getActuallySyncedResources   │ <version home>/.{agent}/*/     │ same shape                      │
│   (agent, version)           │ (readlink each entry, match    │                                 │
│                              │  against ~/.agents/)           │                                 │
│                              │ memory: file content compare   │                                 │
├──────────────────────────────┼────────────────────────────────┼─────────────────────────────────┤
│ getNewResources(...)         │ both above                     │ available − synced (per type)   │
└──────────────────────────────┴────────────────────────────────┴─────────────────────────────────┘
```

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

## MCP Servers: Per-Agent JSON Write

MCP is the one resource that isn't symlinked. Each agent stores MCP server
lists in its own settings file with its own key shape, so sync writes them
directly into the agent's config.

```
Source: ~/.agents/mcp/*.yaml       Per-agent destinations:

┌────────────────────┐             Gemini  → <home>/.gemini/settings.json
│ github.yaml        │                      · key: mcpServers.<name> = {command,args,env}
│ ───────            │             Cursor  → <home>/.cursor/mcp.json
│ name: github       │                      · key: mcpServers.<name> = {command,args,env}
│ transport: stdio   │             Claude  → CLI: `claude mcp add ...`
│ command: npx ...   │                      (claude owns its own settings)
│ args: [...]        │             Codex   → CLI: `codex mcp add ...`
│ env: { ... }       │                      · HTTP transport not supported
└────────────────────┘             OpenCode → <home>/.config/opencode/config.toml
                                            · key: mcp.<name> (TOML)
```

Behavior rules, per `src/lib/mcp.ts`:

1. **Read existing, set by name, write back.** For Gemini/Cursor
   (`installMcpToGeminiConfig:194`, `installMcpToCursorConfig:227`):

   ```
   config = JSON.parse(fs.readFileSync(settings.json)) || {}
   config.mcpServers[server.name] = { command, args, env }  // or { url }
   fs.writeFileSync(settings.json, JSON.stringify(config, null, 2))
   ```

   User-owned top-level keys (theme, editor settings, etc.) are preserved
   because the merge only touches `mcpServers`.

2. **No ownership tracking.** There's no `_agents_managed` marker. If a user
   hand-edits `mcpServers.github`, the next sync silently overwrites it with
   the YAML's values.

3. **Source delete ≠ destination clean.** `removeMcpServerConfig(name)`
   (`mcp.ts:381`) only unlinks the YAML file. The matching entry in each
   agent's settings stays until manually removed.

4. **Claude and Codex delegate.** Instead of editing settings.json directly,
   agents-cli invokes `claude mcp add` / `codex mcp add` (`mcp.ts:169-186`).
   Those commands own the merge. Benefit: agent-internal validation runs.
   Cost: write failures surface as `execSync` errors, not structured results.

## Permissions: Per-Agent Format Conversion

Permissions take a different path: collected into a canonical `PermissionSet`,
then converted per agent into that agent's native format. Not a JSON merge —
a format rewrite.

```
~/.agents/permissions/groups/                     Canonical                    Per-agent native
*.yaml                                            PermissionSet

┌─────────────────────┐                       ┌──────────────────┐          Claude (JSON):
│ read-only.yaml      │                       │ allow: [         │          { permissions: {
│ ───────             │ loadPermission-       │   "Read",        │              allow: [...],
│ allow: [Read, Grep] │ ─Groups()──────────▶  │   "Grep",        │              deny:  [...]
│ deny:  [Write]      │ concat per group      │   "Bash(git *)"  │            }}
│                     │                       │ ],               │
│ git-safe.yaml       │                       │ deny: [          │          OpenCode (TOML):
│ ───────             │                       │   "Write"        │          [permission]
│ allow: [Bash(git *)]│                       │ ],               │          [permission.bash]
│                     │                       │ additional-      │          "git *" = "allow"
│ 99-deny.yaml ──────▶│ rules go to deny      │   Directories:   │          "rm *" = "deny"
│ allow: [Bash(rm *)] │ (naming convention)   │   [...]          │
└─────────────────────┘                       └──────────────────┘          Codex (Starlark file):
                                                                            agents-deny.rules
                                                                            (generated text)
```

Group-to-permission-set is concatenation with one naming convention:
groups ending in `-deny` (e.g. `99-deny.yaml`) contribute to `deny` even
though their YAML lists appear under `allow`
(`permissions.ts:230-235`).

Per-agent conversion is lossy in both directions:

- Claude's native format is closest to canonical — near 1:1 passthrough
  (`permissions.ts:362-369`).
- OpenCode maps `Bash(pattern)` rules into a pattern → `allow`/`deny` map
  (`permissions.ts:385-405`). Non-bash rules are dropped.
- Codex emits Starlark deny rules to a generated `agents-deny.rules` file
  (`permissions.ts:38-56`). Allow rules aren't expressed; Codex defaults to
  deny-unless-allowed elsewhere.

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
