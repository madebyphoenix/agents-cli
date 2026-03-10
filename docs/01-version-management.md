# Version Management

How agents-cli installs, switches, and isolates multiple versions of agent CLIs.

## Architecture

```
~/.agents/
  agents.yaml                           # Global defaults: agents.claude = "2.0.65"
  versions/
    claude/
      2.0.65/
        node_modules/.bin/claude        # Installed CLI binary
        home/
          .claude/                      # Isolated config for this version
            commands/  -> ~/.agents/commands/   (symlink)
            skills/    -> ~/.agents/skills/     (symlink)
            CLAUDE.md  -> ~/.agents/memory/AGENTS.md (symlink)
      2.0.70/
        node_modules/.bin/claude
        home/.claude/
    codex/
      0.98.0/
        ...
  shims/
    claude                              # Version-resolving wrapper script
    codex
  backups/
    claude/
      1709856000000/                    # Timestamped backup of original ~/.claude/
```

## Version Resolution

```
User runs: claude --help
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ~/.agents/shims/claude (bash script)                               │
│                                                                     │
│  1. Walk up from $PWD looking for .agents-version file              │
│     └─ Parse YAML: claude: "2.0.70"                                 │
│                                                                     │
│  2. If not found, read ~/.agents/agents.yaml                        │
│     └─ Parse: agents.claude = "2.0.65"                              │
│                                                                     │
│  3. If version not installed, auto-install (project versions only)  │
│                                                                     │
│  4. exec ~/.agents/versions/claude/{version}/node_modules/.bin/claude │
└─────────────────────────────────────────────────────────────────────┘
```

## Installation Flow

```
agents add claude@2.0.65
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  installVersion(agent, version)                                     │
│  src/lib/versions.ts:installVersion()                               │
│                                                                     │
│  1. Create ~/.agents/versions/claude/2.0.65/                        │
│  2. npm install @anthropic-ai/claude-code@2.0.65                    │
│  3. Create home dir: versions/claude/2.0.65/home/.claude/           │
│  4. syncResourcesToVersion() - symlink central resources            │
│  5. createShim() - generate ~/.agents/shims/claude                  │
│  6. createVersionedAlias() - generate ~/.agents/shims/claude@2.0.65 │
└─────────────────────────────────────────────────────────────────────┘
```

## Config Symlink Switching

When `agents use claude@2.0.65` runs, the user's `~/.claude/` becomes a symlink:

```
BEFORE (first use):
~/.claude/                    # Real directory with user's config
  settings.json
  commands/
  CLAUDE.md

AFTER:
~/.claude/ -> ~/.agents/versions/claude/2.0.65/home/.claude/   (symlink)
~/.agents/backups/claude/1709856000000/                        (backup)
  settings.json
  commands/
  CLAUDE.md
```

Key behaviors:
- Only `agents use` can set the global default (via `setGlobalDefault()`)
- Real directories are backed up before being replaced with symlinks
- Subsequent switches just update the symlink target (no new backups)
- Each version has isolated auth in its `home/` directory

## Resource Syncing

`syncResourcesToVersion()` links central `~/.agents/` resources into version homes:

```
~/.agents/commands/foo.md  ──symlink──▶  ~/.agents/versions/claude/2.0.65/home/.claude/commands/foo.md
~/.agents/skills/bar/      ──symlink──▶  ~/.agents/versions/claude/2.0.65/home/.claude/skills/bar/
~/.agents/memory/AGENTS.md ──symlink──▶  ~/.agents/versions/claude/2.0.65/home/.claude/CLAUDE.md
```

Special case: Gemini requires TOML format, so commands are converted (not symlinked).

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `installVersion()` | versions.ts | Install agent CLI version |
| `removeVersion()` | versions.ts | Remove installed version |
| `resolveVersion()` | versions.ts | Find version from project/global config |
| `syncResourcesToVersion()` | versions.ts | Symlink resources into version home |
| `switchConfigSymlink()` | shims.ts | Replace ~/.{agent} with symlink |
| `createShim()` | shims.ts | Generate version-resolving wrapper |
| `setGlobalDefault()` | versions.ts | Set default in agents.yaml |
