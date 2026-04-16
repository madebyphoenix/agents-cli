# agents

**The package manager and runtime for AI coding agents.**

Install versions. Install skills. Run any agent through one interface. Build pipelines across Claude, Codex, Gemini, Cursor, OpenCode, and more.

```bash
npm install -g @swarmify/agents-cli
```

Also available as `ag` -- all commands work with both `agents` and `ag`.

---

## Run any agent. Same interface.

```bash
agents exec claude "Find all auth vulnerabilities in src/"
agents exec codex "Fix the issues Claude found"
agents exec gemini "Write tests for the fixed code"
```

Each agent resolves to the project-pinned version, with the right skills, MCP servers, and permissions already synced. No setup between steps -- just run.

This makes agent pipelines possible. Chain agents by strength, swap one for another, script them in CI -- the interface stays the same:

```bash
# Friday night code review
agents exec claude "Review all PRs merged this week, summarize risks" \
  | agents exec codex "Write regression tests for the top 3 risks"

# Same pipeline, different project -- different agent versions, same commands
cd ../other-project
agents exec claude "Review all PRs merged this week, summarize risks"
# ^ resolves to claude@2.0.0 here instead of claude@2.1.89
```

Supports plan (read-only) and edit modes, effort levels that map to the right model per agent, and JSON output for scripting.

---

## Pin agent versions per project

```bash
agents add claude@2.0.0             # Install specific version
agents use claude@2.0.0 -p          # Pin to this project
```

Like `.nvmrc` for Node -- different projects use different agent versions. A shim system reads `.agents-version` and routes to the right binary automatically. No other tool does this for AI agents.

When you switch versions, configs are backed up and resources are re-synced. Each version gets its own isolated home directory with the right skills, commands, and permissions already in place.

---

## Install skills, MCP servers, and commands once -- every agent gets them

### Skills

Skills are reusable knowledge packs -- rules, patterns, and expertise that make your agents better at specific tasks. Install once, available everywhere.

```bash
agents skills add gh:yourname/python-expert     # Install from GitHub
agents skills add ./my-skills                    # Install from local path
agents skills list                               # See what's installed
agents skills view python-expert                 # View skill details and rules
```

A skill is a directory with a `SKILL.md` and optional rule files:

```
python-expert/
  SKILL.md              # Metadata + description
  rules/
    type-hints.md       # Individual rules your agents follow
    error-handling.md
    testing.md
```

Skills are stored centrally in `~/.agents/skills/` and distributed to each agent's native skill directory. Write once, every agent gets it.

### Install MCP servers everywhere at once

```bash
agents search notion                    # Find MCP servers
agents install mcp:com.notion/mcp       # Install + register with ALL agents
agents mcp list                         # See what's registered
```

No more running `claude mcp add`, then `codex mcp add`, then editing Gemini's config file.

### Manage slash commands

```bash
agents commands add gh:yourname/commands    # Install from repo
agents commands list                        # See all commands
agents commands view review-pr              # View command content
```

Commands are markdown files with a description. The CLI handles format conversion automatically -- markdown for Claude/Gemini/Cursor, TOML for Codex.

### Sync your entire setup

```bash
agents push                       # Snapshot your config to git
agents pull                       # Restore on any machine
```

`push` captures your current agent versions and MCP registrations into `~/.agents/`. `pull` does the real work -- it installs agent CLIs, registers MCP servers, syncs resources (commands, skills, rules, hooks, permissions) into each agent's config directory, sets up PATH shims, and configures defaults. One command, fully configured machine.

```bash
agents fork                       # Fork the default repo to your GitHub
agents pull --upstream             # Merge updates from upstream
```

### Schedule agents as routines

```bash
agents routines add daily-digest \
  --schedule "0 9 * * 1-5" \
  --agent claude \
  --prompt "Review yesterday's PRs and summarize key changes"

agents daemon start                    # Start the scheduler
agents routines list                   # See all jobs
agents routines logs daily-digest      # Check execution logs
```

Jobs run sandboxed -- agents only see directories and tools you explicitly allow.

### Manage rules/instructions, hooks, and permissions

Each agent has its own instruction file format -- Claude uses `CLAUDE.md`, Codex uses `AGENTS.md`, Cursor uses `.cursorrules`. The CLI manages all of them under one command.

```bash
agents rules list                 # Show what's installed per agent
agents rules add gh:team/rules    # Install and sync to all agents
agents rules view claude          # View rule file content
```

Write one `AGENTS.md`, and it gets renamed and synced to each agent's native format automatically.

```bash
agents hooks list                 # Show lifecycle hooks
agents hooks add gh:team/hooks    # Install hook scripts

agents permissions list           # Show permission sets
agents permissions add ./perms    # Install permission groups
```

Hooks trigger on agent lifecycle events. Permissions are auto-converted between agent-specific formats (Claude's allow/deny, Codex's approval policies, OpenCode's patterns).

---

## Quick Reference

```bash
# Agent versions
agents add claude@latest          # Install agent CLI
agents remove codex@0.5.0        # Remove specific version
agents use claude@2.0.0           # Set global default
agents use claude@2.0.0 -p        # Pin to this project
agents list                       # Show all installed versions
agents view claude                # Show version details + resources

# Skills
agents skills list                # List installed skills
agents skills add <source>        # Install from git/local
agents skills remove <name>       # Remove a skill
agents skills view <name>         # View skill details

# Commands
agents commands list              # List slash commands
agents commands add <source>      # Install commands
agents commands view <name>       # View command content

# Rules / Instructions
agents rules list                 # List per-agent instruction files
agents rules add <source>         # Install from git/local
agents rules remove <agent>       # Remove rule file
agents rules view <agent>         # View rule file content

# MCP servers
agents search <query>             # Find in registry
agents install mcp:<name>         # Install + register
agents mcp list                   # Show registered servers
agents mcp add <name> <cmd>       # Register manually

# Sync
agents pull [source]              # Sync from repo
agents push                       # Push changes back
agents fork                       # Fork to your GitHub

# Drive
agents drive remote <user@host>   # Set sync target
agents drive pull                  # Pull sessions from remote
agents drive push                  # Push sessions to remote
agents drive attach                # Use drive as active agent home
agents drive detach                # Restore to version home
agents drive status                # Show drive state

# Execution
agents exec <agent> <prompt>      # Run agent
agents routines add <name>        # Schedule a job
agents routines list              # Show all jobs
agents daemon start               # Start scheduler
```

---

## Skill Format

Create a `SKILL.md` with YAML frontmatter:

```markdown
---
name: python-expert
description: Python code analysis, type hints, and testing patterns
author: Your Name
version: 1.0.0
keywords: [python, testing, types]
---

# Python Expert

High-level description of what this skill teaches your agents.
```

Add rule files in a `rules/` subdirectory -- each rule is a markdown file with specific guidance your agents follow during conversations.

---

## Compatibility

| Agent | Versions | MCP | Commands | Skills | Rules | Hooks | Permissions | Routines |
|-------|----------|-----|----------|--------|-------|-------|-------------|----------|
| Claude | yes | yes | yes | yes | CLAUDE.md | yes | yes | yes |
| Codex | yes | yes | yes | yes | AGENTS.md | yes | yes | yes |
| Gemini | yes | yes | yes | yes | GEMINI.md | yes | -- | yes |
| Cursor | yes | yes | yes | yes | .cursorrules | -- | -- | -- |
| OpenCode | yes | yes | yes | yes | AGENTS.md | yes | yes | -- |
| OpenClaw | yes | yes | -- | yes | workspace/AGENTS.md | yes | -- | -- |

## License

MIT
