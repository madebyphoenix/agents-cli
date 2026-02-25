# agents

**One CLI for every AI coding agent.** Version manager, config sync, package manager, and automation daemon for Claude, Codex, Gemini CLI, Cursor, and OpenCode.

[![npm](https://img.shields.io/npm/v/@swarmify/agents-cli)](https://www.npmjs.com/package/@swarmify/agents-cli) [![license](https://img.shields.io/npm/l/@swarmify/agents-cli)](LICENSE) [![node](https://img.shields.io/node/v/@swarmify/agents-cli)](package.json)

```bash
npm install -g @swarmify/agents-cli
```

[Quick Start](#quick-start) | [Why](#why) | [Version Control](#version-control) | [Config Sync](#config-sync) | [Package Management](#package-management) | [MCP Servers](#mcp-servers) | [Skills & Commands](#skills--commands) | [Jobs & Sandboxing](#jobs--sandboxing) | [Compatibility](#compatibility) | [All Commands](#all-commands)

---

## Quick Start

```bash
npm install -g @swarmify/agents-cli
agents pull       # Syncs config from default repo on first run
agents status     # Shows what got installed
```

Point it at your own config repo:

```bash
agents repo add gh:yourname/.agents
agents pull
```

> Also available as `ag` -- every command above works with `ag pull`, `ag status`, etc.

## Why

Every agent works differently. Installing an MCP server in Claude is `claude mcp add`. In Codex it's `codex mcp add` with different flags. In OpenCode it's interactive. Gemini wants a config file edit. Skills, commands, memory files -- same story, different formats, different locations, different procedures for each agent.

If you use more than one agent, you're doing everything N times. New machine? Do it all again. Teammate wants your setup? Good luck explaining five different config systems.

`agents` is one CLI that handles all of it:

- **Version manager** -- install, pin, and switch agent CLI versions per project, like `nvm` for Node
- **Config sync** -- back up commands, skills, MCPs, memory files, and hooks to a single Git repo. `agents pull` on a new machine and everything is configured across every agent
- **Package manager** -- `agents search notion` finds MCP servers across registries, `agents install mcp:com.notion/mcp` installs and registers it with every agent in one step
- **Automation daemon** -- schedule agents to run on cron with sandboxed permissions, like `systemctl` for AI agents

## Version Control

Install, pin, and switch between agent CLI versions -- like `nvm` for Node.js.

```bash
agents add claude@1.5.0       # Install a specific version
agents add claude@latest       # Install the latest
agents add claude@1.5.0 -p    # Install and pin to this project
agents use claude@1.5.0       # Set global default
agents use claude@1.5.0 -p    # Pin version in project manifest
agents list                    # Show all installed versions
agents list claude             # Show versions for one agent
agents remove claude@1.5.0    # Remove a specific version
agents remove claude           # Remove all versions
```

Per-project pinning lives in `.agents/agents.yaml`:

```yaml
agents:
  claude: "1.5.0"
  codex: "0.1.2"
  gemini: latest
```

When a shim is in your PATH, running `claude` resolves to the version pinned in the nearest `.agents/agents.yaml`, falling back to the global default.

<details>
<summary>How version isolation works</summary>

Each version is installed to `~/.agents/versions/{agent}/{version}/` with its own isolated HOME at `~/.agents/versions/{agent}/{version}/home/`. Shims in `~/.agents/shims/` set HOME and delegate to the correct binary. The isolated HOME symlinks everything from your real HOME except agent config directories (`.claude`, `.codex`, `.gemini`, `.cursor`, `.opencode`, `.agents`), so auth tokens stay per-version while your filesystem remains intact.

</details>

## Config Sync

A `.agents` repo holds your entire multi-agent configuration. `pull` distributes it; `push` exports local changes back.

```bash
agents pull              # Sync everything
agents pull claude       # Sync one agent
agents push              # Export local config to your repo
```

Repo structure:

```
.agents/
  agents.yaml              # Pinned versions + defaults
  commands/                # Slash commands (*.md)
  skills/                  # Skills (SKILL.md + rules/)
  hooks/                   # Hook scripts
  memory/                  # Memory files (*.md)
  mcp/                     # MCP server configs (*.yaml)
  permissions/
    groups/                # Permission groups (*.yaml)
```

Resources exist at two scopes:

| Scope | Location | When to use |
|-------|----------|-------------|
| **User** | `~/.{agent}/` | Available everywhere |
| **Project** | `./.{agent}/` | Committed to a specific repo |

Use `add` subcommands to install resources from repos or local paths (`agents commands add`, `agents skills add`, etc.).

## Package Management

Search and install MCP servers and skills like `apt` or `brew`. Registries are searched automatically.

```bash
agents search notion
```

```
Found 3 packages

  MCP Servers
    ai.smithery/smithery-notion - A Notion workspace is a collaborative environment...
      Registry: official  Install: agents install mcp:ai.smithery/smithery-notion
    com.notion/mcp - Official Notion MCP server
      Registry: official  Install: agents install mcp:com.notion/mcp
```

Install with one command -- the server gets registered with every agent automatically:

```bash
agents install mcp:com.notion/mcp       # MCP server from registry
agents install skill:muqsitnawaz/mq     # Skill from GitHub
agents install gh:user/repo             # Any .agents-compatible repo
```

Identifier prefixes:

| Prefix | What it installs | Source |
|--------|------------------|--------|
| `mcp:` | MCP server | Registry lookup, then `npx`/`uvx` |
| `skill:` | Skill (SKILL.md + rules/) | GitHub repo |
| `gh:` | Full package (skills, commands, MCPs) | GitHub repo |

## MCP Servers

Search registries, install servers, and register them with every agent in one step.

```bash
agents search filesystem           # Search MCP registries
agents install mcp:filesystem      # Install and register with all agents
agents mcp add myserver npx ...    # Add a custom MCP server
agents mcp list                    # Show servers and registration status
agents mcp register                # Register all servers with agent CLIs
agents mcp remove myserver         # Remove from all agents
```

MCP servers are stored as YAML in `~/.agents/mcp/`:

```yaml
# ~/.agents/mcp/Swarm.yaml
name: Swarm
transport: stdio
command: npx
args:
  - -y
  - '@swarmify/agents-mcp@latest'
```

During `agents use` or `agents pull`, you select which MCPs to sync to each agent version.

## Permissions

Permissions are organized into groups in `~/.agents/permissions/groups/`. Each group contains related permission rules:

```
permissions/groups/
  00-header.yaml      # Metadata
  01-core.yaml        # Core shell utilities
  02-node.yaml        # Node.js ecosystem (60 rules)
  03-python.yaml      # Python ecosystem (47 rules)
  04-go.yaml          # Go ecosystem
  ...
  20-webfetch-dev.yaml    # WebFetch for dev docs
  30-paths.yaml           # File system paths
  99-deny.yaml            # Explicit denials
```

During `agents use`, you can select which groups to sync:

```
? Which resources from ~/.agents/ would you like to sync?
  Commands (21 available), Skills (7 available), MCPs (1 available),
  Permissions (19 groups, 3132 rules)
```

Permission groups are combined and applied to each agent's native format:
- **Claude**: `~/.claude/settings.json` (`permissions.allow/deny`)
- **Codex**: `~/.codex/config.toml` (`approval_policy`, `sandbox_mode`)
- **OpenCode**: `~/.opencode/opencode.jsonc` (`permission.bash`)

## Skills & Commands

### Slash Commands

Slash commands are markdown (or TOML for Gemini) files that appear in the agent's command palette.

```bash
agents commands list               # List installed commands
agents commands add <source>       # Install from a repo or local path
agents commands view <name>        # Show command contents
agents commands remove <name>      # Remove a command
```

Commands in `commands/` are distributed to every agent. Markdown commands are auto-converted to TOML when installed for Gemini.

### Skills

Skills bundle a `SKILL.md` file with optional `rules/` for deeper agent guidance.

```bash
agents skills list                 # List installed skills
agents skills add <source>         # Install from a repo or local path
agents skills view <name>          # Show skill contents
agents skills remove <name>        # Remove a skill
```

## Cron Jobs & Sandboxing

Schedule agents to run autonomously on cron. Define a job in YAML or inline, and the daemon handles execution.

```yaml
name: daily-pr-digest
schedule: "0 9 * * 1-5"
agent: claude
mode: plan
timeout: 15m
timezone: America/Los_Angeles
prompt: |
  Today is {date}. Review all PRs I merged since 5 PM yesterday
  across every repo in ~/src/. Summarize what shipped, flag
  anything that looks risky, and write the digest to the report.

variables:
  repo_path: ~/src

allow:
  tools: [bash, read, glob, grep]
  dirs: [~/src]

config:
  model: claude-sonnet-4-5
```

```bash
# Add jobs from YAML or inline
agents cron add job.yaml                                    # From YAML file
agents cron add my-job -s "0 9 * * *" -a claude -p "..."    # Inline with flags
agents cron add reminder --at "14:30" -a claude -p "..."    # One-shot job

# Manage jobs (all commands show picker when name omitted)
agents cron list                   # Show all jobs and status
agents cron view                   # View job config (interactive picker)
agents cron edit                   # Edit in $EDITOR (interactive picker)
agents cron remove                 # Remove a job (interactive picker)

# Run and monitor
agents cron run                    # Run immediately (interactive picker)
agents cron runs                   # Show execution history
agents cron logs                   # Show output from latest run
agents cron report                 # Show report from latest run

# Enable/disable
agents cron pause                  # Pause a job (shows only enabled jobs)
agents cron resume                 # Resume a job (shows only paused jobs)

# Daemon
agents daemon start                # Start the cron scheduler
agents daemon stop                 # Stop the daemon
agents daemon status               # Check daemon status
```

Template variables: `{day}`, `{date}`, `{time}`, `{job_name}`, `{last_report}`, plus custom `variables`.

## Unified Execution

Run any agent with a consistent interface using `agents exec`:

```bash
agents exec claude "Review this PR"              # Default mode (plan)
agents exec codex "Fix the bug" --mode edit      # Edit mode
agents exec gemini "Analyze code" --effort fast  # Fast model
agents exec claude@2.0.0 "Task" --cwd ./project  # Specific version + cwd
```

Options:
- `--mode <plan|edit>` - Read-only analysis or allow edits
- `--effort <fast|default|detailed>` - Model selection (maps to haiku/sonnet/opus, etc.)
- `--model <model>` - Override model directly
- `--cwd <dir>` - Working directory
- `--add-dir <dir>` - Add directory access (Claude only, repeatable)

### Sandbox Isolation

Each job runs in an isolated environment. The agent never sees your real HOME -- it gets an overlay recreated fresh before every run.

```
~/.agents/jobs/daily-pr-digest/home/     <-- agent sees this as $HOME
  .claude/
    settings.json                        <-- generated from allow.tools
  src/ -> ~/src                          <-- symlink from allow.dirs
```

Three layers of enforcement, none relying on prompt injection:

| Layer | What it does | How |
|-------|-------------|-----|
| **Tool allowlist** | Restricts available tools | Agent CLI reads generated config; disallowed tools are blocked |
| **HOME overlay** | Filesystem isolation | Only `allow.dirs` entries are symlinked in; everything else is invisible |
| **Env sanitization** | Prevents credential leakage | Only safe env vars (`PATH`, `SHELL`, `LANG`, etc.) pass through |

The agent cannot access `~/.ssh`, `~/.aws`, `~/.gitconfig`, API keys in env vars, or anything else not explicitly allowed.

## Compatibility

| Agent | Commands | MCP | Hooks | Skills | Memory | Permissions | Jobs |
|-------|----------|-----|-------|--------|--------|-------------|------|
| Claude | yes | yes | yes | yes | yes | yes | yes |
| Codex | yes | yes | -- | yes | yes | yes | yes |
| Gemini CLI | yes | yes | yes | yes | yes | -- | yes |
| Cursor | yes | yes | -- | yes | yes | -- | -- |
| OpenCode | yes | yes | -- | yes | yes | yes | -- |

## All Commands

```
Env
  status [agent]                  Show installed agents and sync status
  pull [source] [agent]           Sync from .agents repo
  push                            Push config to your .agents repo

Agents
  add <agent>[@version]           Install agent CLI version
  remove <agent>[@version]        Remove agent CLI version
  use <agent>@<version>           Set default version (-p for project)
  list [agent]                    List installed versions

Packages
  search <query>                  Search MCP and skill registries
  install <identifier>            Install mcp:<name>, skill:<name>, or gh:<user/repo>

Resources
  memory list|view|remove
  commands list|add|remove|view
  mcp list|add|remove|register|view
  skills list|add|view|remove
  hooks list|add|remove|view
  permissions list|add|remove|view

Automation
  exec <agent> <prompt>           Run agent with unified interface
  cron list|add|view|edit|remove|run|runs|logs|report|pause|resume
  daemon start|stop|status|logs

Sources
  repo list|add|remove
  registry list|add|remove|enable|disable|config
```

## License

MIT
