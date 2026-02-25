## Agent Spawning

When asked to spawn agents or perform multi-agent tasks, use the Swarm MCP extension:

- `mcp__Swarm__Spawn` - Spawn agents (codex, cursor, gemini, claude)
- `mcp__Swarm__Status` - Check agent status
- `mcp__Swarm__Read` - Read agent output
- `mcp__Swarm__Stop` - Stop agents

Do NOT use built-in Claude Code agents (Task tool with Explore/Plan subagent_type) when Swarm agents are requested.

# agents-cli Development Guide

## Purpose

agents-cli manages AI coding agent CLIs (Claude, Codex, Gemini, Cursor, OpenCode) with two core goals:

1. **Version Management** - Install and switch between multiple versions of agent CLIs, similar to `nvm` for Node.js
2. **Config Backup & Sync** - Back up agent configuration (commands, skills, hooks, memory) to a git repo and restore across machines

### The Source of Truth

`~/.agents/` IS the user's git repo. It contains:
- `commands/` - Slash commands (git-tracked)
- `skills/` - Agent skills (git-tracked)
- `hooks/` - Event hooks (git-tracked)
- `memory/` - Memory/instruction files (git-tracked)
- `mcp/` - MCP server configs as YAML (git-tracked)
- `permissions/groups/` - Permission groups as YAML (git-tracked)
- `versions/` - Installed CLI versions (local-only, .gitignore'd)
- `shims/` - Version switching scripts (local-only, .gitignore'd)

### Push/Pull Flow

**`agents pull <source>`** - Restore config FROM remote repo
- Clones/pulls the repo directly into `~/.agents/`
- Remote repo is source of truth - overwrites local
- Then syncs resources to installed version homes via symlinks

**`agents push`** - Backup config TO remote repo
- Commits and pushes `~/.agents/` to remote
- Local config is source of truth - overwrites remote

### Version Isolation

Each installed version has isolated config at `~/.agents/versions/{agent}/{version}/home/.{agent}/`. Resources from `~/.agents/` are symlinked into version homes.

The user's `~/.{agent}/` directory is a symlink to the active version's config dir. When running `agents use {agent}@{version}`:
- If `~/.{agent}/` is a real directory, migrate its contents to the version home (user's current config takes precedence)
- Then replace with symlink to version home

## Architecture

```
src/
  index.ts              # CLI entry point, all commands
  lib/
    types.ts            # Core types (AgentId, Manifest, Meta, Registry)
    agents.ts           # Agent configs, CLI detection, MCP ops
    manifest.ts         # agents.yaml parsing/serialization
    state.ts            # ~/.agents/agents.yaml state management
    versions.ts         # Version management (install, remove, resolve)
    shims.ts            # Shim generation for version switching
    git.ts              # Git clone/pull operations
    hooks.ts            # Hook discovery and installation
    commands.ts         # Slash command discovery and installation
    skills.ts           # Agent Skills (SKILL.md + rules/) management
    instructions.ts     # Agent memory files (CLAUDE.md, AGENTS.md, etc.) management
    permissions.ts      # Permission set discovery and installation
    convert.ts          # Markdown <-> TOML conversion
    registry.ts         # Package registry client (MCP, skills)
    jobs.ts             # Job config YAML parsing and management
    runner.ts           # Job execution (spawn agent processes)
    scheduler.ts        # Cron scheduling for jobs
    daemon.ts           # Background daemon process management
    sandbox.ts          # HOME overlay sandbox for job isolation
```

## Key Types

```typescript
type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';

interface Manifest {
  agents?: Partial<Record<AgentId, string>>;
  dependencies?: Record<string, string>;
  mcp?: Record<string, McpServerConfig>;
  defaults?: { method?: 'symlink' | 'copy'; scope?: 'global' | 'project'; agents?: AgentId[] };
}

interface Meta {
  agents?: Partial<Record<AgentId, string>>;
  repos: Record<RepoName, RepoConfig>;
  registries?: Record<RegistryType, Record<string, RegistryConfig>>;
}

interface JobConfig {
  name: string;
  schedule: string;
  agent: AgentId;
  mode: 'plan' | 'edit';
  effort: 'fast' | 'default' | 'detailed';
  timeout: string;
  enabled: boolean;
  prompt: string;
  allow?: JobAllowConfig;
  config?: Record<string, unknown>;
  version?: string;
}
```

## Agent Configuration

Each agent has different paths and formats. See `AGENTS` object in `lib/agents.ts`:

| Agent | Commands Dir | Format | Memory File | MCP Support |
|-------|--------------|--------|-------------------|-------------|
| Claude | `~/.claude/commands/` | markdown | `CLAUDE.md` | Yes |
| Codex | `~/.codex/prompts/` | markdown | `AGENTS.md` | Yes |
| Gemini | `~/.gemini/commands/` | toml | `GEMINI.md` | Yes |
| Cursor | `~/.cursor/commands/` | markdown | `.cursorrules` | Yes |
| OpenCode | `~/.opencode/commands/` | markdown | `OPENCODE.md` | Yes |

## Version Management

The CLI manages multiple versions of agent CLIs (Claude, Codex, Gemini, etc.) similar to `nvm` for Node.js.

### Commands

```bash
agents add claude@1.5.0        # Install specific version
agents add claude@latest       # Install latest version
agents add claude@1.5.0 -p     # Install + pin to project manifest

agents remove claude@1.5.0     # Remove specific version
agents remove claude           # Remove all versions

agents use claude@1.5.0        # Set global default version
agents use claude@1.5.0 -p     # Pin version in project manifest

agents list                    # Show all installed versions
agents upgrade                 # Upgrade all to latest
agents upgrade claude          # Upgrade specific agent

```

### HARD RULE: Default Version

`setGlobalDefault()` MUST only be called from `agents use`. No other code path may set or change the global default version. Not on first install. Not on sync. Not on upgrade. Not ever.

When removing the current default version, clear it and print a hint telling the user to run `agents use`. Do not auto-select a replacement.

### How It Works

1. **Version Storage**: Versions installed to `~/.agents/versions/{agent}/{version}/`
2. **Config Isolation**: Each version has isolated HOME at `~/.agents/versions/{agent}/{version}/home/` for auth.
3. **Resource Linking**: `syncResourcesToVersion()` symlinks central resources (`~/.agents/commands/`, `skills/`, `hooks/`, `memory/`) into the version's config dir at install time. For Gemini, commands are converted from markdown to TOML.
4. **Shims**: Wrapper scripts in `~/.agents/shims/` do HOME overlay and exec -- nothing else. They isolate `.{agent}` and `.agents` dirs, symlink everything else from real HOME.
5. **Resolution**: Project manifest (`.agents/agents.yaml`) overrides global default
6. **Automatic Switching**: When shims are in PATH, running `claude` uses the resolved version

### Key Files

- `lib/versions.ts` - `installVersion()`, `removeVersion()`, `resolveVersion()`, `syncResourcesToVersion()`
- `lib/shims.ts` - `createShim()`, `generateShimScript()`

### Version Resolution Order

1. Check `.agents/agents.yaml` in current directory (walk up to root)
2. Fall back to global default in `~/.agents/agents.yaml`

## Critical Patterns

### Installation Scope

Commands, skills, hooks, MCPs, and memory files can exist at two scopes:

| Scope | Location | Use Case |
|-------|----------|----------|
| User | `~/.{agent}/` | Available globally, all projects |
| Project | `./.{agent}/` | Project-specific, committed to repo |

### Manifest Format

The manifest uses a flat agent-version mapping:

```yaml
agents:
  claude: "1.5.0"
  codex: "0.1.2"
  gemini: latest
```

No `package` field - npm package names are derived from the `AGENTS` config in `lib/agents.ts`.

### Jobs & Daemon

Jobs are YAML files in `~/.agents/jobs/`. The daemon runs in the background and executes jobs on their cron schedules.

**HOME overlay sandbox:** Each job runs with `HOME` set to an overlay directory (`~/.agents/jobs/{name}/home/`). This overlay contains:
- Agent-specific config files with permissions from `allow.tools`
- Symlinks to directories from `allow.dirs`
- Nothing else - agent can't see `~/.ssh`, `~/.gitconfig`, etc.

This provides real permission enforcement via the agent CLI's own config system, replacing prompt injection.

**Key files:**
- `lib/sandbox.ts` - overlay creation, config generation, dir symlinking
- `lib/runner.ts` - job execution with sandbox integration
- `lib/scheduler.ts` - cron scheduling via croner
- `lib/daemon.ts` - background daemon lifecycle

### Command Discovery

Commands are discovered from `commands/*.md` in the repo.

### Format Conversion

Gemini requires TOML format. When installing a markdown skill to Gemini:

```typescript
// lib/convert.ts
markdownToToml(skillName, markdownContent) -> tomlContent
```

### MCP Registration

Each agent has different MCP registration commands:

```typescript
// lib/agents.ts
registerMcp(agentId, serverName, command, scope)
unregisterMcp(agentId, serverName)
isMcpRegistered(agentId, serverName)
```

Claude/Codex use `claude mcp add` / `codex mcp add`.
Gemini uses config file modification.

### Git Source Parsing

Sources can be specified as:
- `gh:user/repo` - GitHub shorthand
- `https://github.com/user/repo` - Full URL
- `/path/to/local` - Local directory

### Package Registries

Registries are URL-based indexes for discovering MCP servers and skills.

Package identifier prefixes:
- `mcp:name` - Search MCP registries
- `skill:user/repo` - Skill (falls back to git)
- `gh:user/repo` - Git source directly

## State Management

State is persisted to `~/.agents/agents.yaml`:

```typescript
// lib/state.ts
readMeta() -> Meta
writeMeta(meta)
updateMeta(partial) -> Meta
```

The Meta type is minimal:
- `agents` - global default versions (flat mapping, e.g. `claude: "1.5.0"`)
- `repos` - configured source repositories with sync state
- `registries` - package registry URLs and API keys

Installed versions are derived from filesystem (`~/.agents/versions/{agent}/`), not tracked in state.

Always use these functions - they handle directory creation, defaults, and migration from old formats.

## Adding a New Agent

1. Add to `AgentId` type in `lib/types.ts`
2. Add config to `AGENTS` object in `lib/agents.ts`
3. Add to `ALL_AGENT_IDS` array
4. If MCP capable, add to `MCP_CAPABLE_AGENTS`
5. Implement any custom detection in `isCliInstalled()`

## Adding a New Command

Commands are defined in `index.ts` using Commander.js:

```typescript
program
  .command('mycommand <arg>')
  .description('What it does')
  .option('-f, --flag', 'Description')
  .action(async (arg, options) => {
    // Implementation
  });
```

For subcommands:

```typescript
const myCmd = program.command('my').description('Parent command');
myCmd.command('sub').action(() => { ... });
```

## UX Design Guidelines

Follow these patterns when adding new commands to ensure consistent user experience.

### Color Conventions (chalk)

| Color | Usage |
|-------|-------|
| `chalk.red()` | Errors, failures, invalid input |
| `chalk.green()` | Success messages, positive actions, synced resources |
| `chalk.yellow()` | Warnings, cautions, hints for user action needed |
| `chalk.gray()` | Secondary info, hints, explanations, file paths |
| `chalk.cyan()` | Highlighted items, user values, user-scope resources |
| `chalk.blue()` | Local-only/new resources (not yet synced) |

### Progress Indicators (ora)

Use spinners for operations that may take >500ms:

```typescript
const spinner = ora(`Installing ${name}...`).start();
spinner.text = 'Downloading...';  // Update during operation
spinner.succeed(`Installed ${name}`);  // Success
spinner.fail(`Failed: ${error}`);      // Error
spinner.warn(`Warning message`);       // Non-blocking issue
```

Suppress spinners in non-TTY environments:
```typescript
const spinner = ora({ text: 'Working...', isSilent: !process.stdout.isTTY }).start();
```

### Error Handling

Always provide actionable feedback:

```typescript
// Single-line error + gray hint with fix command
console.log(chalk.red(`Invalid agent: ${spec}`));
console.log(chalk.gray(`Format: <agent>[@version]. Available: ${ALL_AGENT_IDS.join(', ')}`));

// Or via spinner
spinner.fail(`Failed to install ${name}`);
console.log(chalk.gray('\nTry: agents add claude@latest'));
```

### Interactive Prompts (@inquirer/prompts)

```typescript
import { select, checkbox, confirm } from '@inquirer/prompts';

// Single choice
const version = await select({
  message: 'Select version:',
  choices: versions.map(v => ({ name: v, value: v })),
});

// Multiple selection
const selected = await checkbox({
  message: 'Select items:',
  choices: items.map(i => ({ name: i, value: i })),
});

// Always handle cancellation
try {
  const answer = await select({ ... });
} catch (err) {
  if (isPromptCancelled(err)) return;
  throw err;
}
```

### Output Formatting

Use consistent indentation and alignment:

```typescript
// Section headers
console.log(chalk.bold('Installed Agent CLIs\n'));

// Hierarchical display (2-space indent per level)
console.log(`  ${agentName}`);
console.log(`    ${version} ${chalk.green('(default)')}`);

// Aligned columns with padding
const maxLen = Math.max(...items.map(i => i.name.length));
for (const item of items) {
  console.log(`  ${item.name.padEnd(maxLen)}  ${chalk.gray(item.path)}`);
}

// Scope-separated lists
console.log(`  ${chalk.gray('User:')}`);
for (const item of userItems) console.log(`    ${chalk.cyan(item)}`);
console.log(`  ${chalk.gray('Project:')}`);
for (const item of projectItems) console.log(`    ${chalk.yellow(item)}`);
```

### Path Display

Always use `formatPath()` to normalize paths for display:

```typescript
import { formatPath } from './lib/utils';
console.log(chalk.gray(formatPath(fullPath)));  // Shows ~/... or relative
```

## Build & Test

```bash
bun install
bun run build    # Compiles to dist/
bun test         # Run vitest
```

## Dependencies

- `commander` - CLI framework
- `chalk` - Terminal colors
- `ora` - Spinners
- `@inquirer/prompts` - Interactive prompts
- `simple-git` - Git operations
- `yaml` - YAML parsing
- `semver` - Version comparison
- `croner` - Cron scheduling

## File Locations

### Global State

| Item | Path |
|------|------|
| Config/State | `~/.agents/agents.yaml` |
| Cloned repos | `~/.agents/repos/` |
| External packages | `~/.agents/packages/` |
| Shared skills | `~/.agents/skills/` |
| Shared commands | `~/.agents/commands/` |
| Shared hooks | `~/.agents/hooks/` |
| Shared memory | `~/.agents/memory/` |
| Shared permissions | `~/.agents/permissions/` |
| CLI versions | `~/.agents/versions/{agent}/{version}/` |
| Version HOME | `~/.agents/versions/{agent}/{version}/home/` |
| Shims | `~/.agents/shims/` |
| Jobs | `~/.agents/jobs/` |
| Job runs | `~/.agents/runs/` |
| Daemon log | `~/.agents/daemon.log` |
| Daemon PID | `~/.agents/daemon.pid` |

### User Scope (global)

| Item | Path |
|------|------|
| Claude commands | `~/.claude/commands/` |
| Claude skills | `~/.claude/skills/` |
| Claude memory | `~/.claude/CLAUDE.md` |
| Claude MCP config | `~/.claude/settings.json` |
| Codex prompts | `~/.codex/prompts/` |
| Codex skills | `~/.codex/skills/` |
| Codex memory | `~/.codex/AGENTS.md` |
| Codex MCP config | `~/.codex/config.json` |
| Gemini commands | `~/.gemini/commands/` |
| Gemini skills | `~/.gemini/skills/` |
| Gemini memory | `~/.gemini/GEMINI.md` |
| Gemini MCP config | `~/.gemini/settings.json` |

### Project Scope (per-directory)

| Item | Path |
|------|------|
| Claude commands | `./.claude/commands/` |
| Claude skills | `./.claude/skills/` |
| Claude memory | `./.claude/CLAUDE.md` |
| Claude MCP config | `./.claude/settings.json` |
| Codex prompts | `./.codex/prompts/` |
| Codex skills | `./.codex/skills/` |
| Codex memory | `./.codex/AGENTS.md` |
| Codex MCP config | `./.codex/config.json` |
| Gemini commands | `./.gemini/commands/` |
| Gemini skills | `./.gemini/skills/` |
| Gemini memory | `./.gemini/GEMINI.md` |
| Gemini MCP config | `./.gemini/settings.json` |
