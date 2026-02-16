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
  permissions/             # Permission sets (*.yml)
```

Resources exist at two scopes:

| Scope | Location | When to use |
|-------|----------|-------------|
| **User** | `~/.{agent}/` | Available everywhere |
| **Project** | `./.{agent}/` | Committed to a specific repo |

Promote project-scope resources to user-scope with `push` subcommands (`agents commands push`, `agents skills push`, etc.).

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

During `agents pull`, MCP servers defined in the repo are automatically registered with each agent that supports them.

## Skills & Commands

### Slash Commands

Slash commands are markdown (or TOML for Gemini) files that appear in the agent's command palette.

```bash
agents commands list               # List installed commands
agents commands add <source>       # Install from a repo or local path
agents commands remove <name>      # Remove a command
agents commands push <name>        # Promote project -> user scope
```

Commands in `commands/` are distributed to every agent. Markdown commands are auto-converted to TOML when installed for Gemini.

### Skills

Skills bundle a `SKILL.md` file with optional `rules/` for deeper agent guidance.

```bash
agents skills list                 # List installed skills
agents skills add <source>        # Install from a repo or local path
agents skills view <name>         # Show skill contents
agents skills remove <name>       # Remove a skill
agents skills push <name>         # Promote project -> user scope
```

## Jobs & Sandboxing

Schedule agents to run autonomously on cron. Define a job in YAML, and the daemon handles execution.

```yaml
name: daily-pr-digest
schedule: "0 9 * * 1-5"
agent: claude
mode: plan
timeout: 15m
prompt: |
  Today is {date}. Review all PRs I merged since 5 PM yesterday
  across every repo in ~/src/. Summarize what shipped, flag
  anything that looks risky, and write the digest to the report.

allow:
  tools: [bash, read, glob, grep]
  dirs: [~/src]

config:
  model: claude-sonnet-4-5
```

```bash
agents jobs add job.yaml           # Register a job
agents jobs run my-job             # Run immediately in foreground
agents daemon start                # Start the cron scheduler
agents jobs list                   # Show all jobs and status
agents jobs logs my-job            # Show output from latest run
agents jobs report my-job          # Show report from latest run
agents jobs enable my-job          # Enable a disabled job
agents jobs disable my-job         # Disable without removing
```

Template variables available in `prompt`: `{day}`, `{date}`, `{time}`, `{job_name}`, `{last_report}`.

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

| Agent | Commands | MCP | Hooks | Skills | Memory | Jobs |
|-------|----------|-----|-------|--------|-------------|------|
| Claude | yes | yes | yes | yes | yes | yes |
| Codex | yes | yes | -- | yes | yes | yes |
| Gemini CLI | yes | yes | yes | yes | yes | yes |
| Cursor | yes | yes | -- | yes | yes | -- |
| OpenCode | yes | yes | -- | yes | yes | -- |

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
  memory list|view|diff|push|remove
  commands list|add|remove|push
  mcp list|add|remove|register|push
  skills list|add|view|remove|push
  hooks list|add|remove|push

Automation
  jobs list|add|run|logs|report|enable|disable
  daemon start|stop|status|logs

Sources
  repo list|add|remove
  registry list|add|remove|enable|disable|config
```

## License

MIT
