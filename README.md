# agents

**One CLI for all your AI coding agents.**

```bash
npm install -g @swarmify/agents-cli
```

## The Problem

You use Claude, Codex, Gemini, Cursor. Each has its own:
- Config location (`~/.claude/`, `~/.codex/`, `~/.gemini/`...)
- MCP registration (`claude mcp add` vs `codex mcp add` vs config file edits)
- Command format (markdown vs TOML)
- Version management (none)

New machine? Redo everything. Teammate wants your setup? Good luck.

## The Solution

```bash
agents pull gh:yourname/.agents    # One command. Every agent configured.
```

That's it. Your MCP servers, commands, skills, memory files, and permissions - synced to Claude, Codex, Gemini, Cursor, and OpenCode in one step.

---

## What You Can Do

### Install MCP servers everywhere at once

```bash
agents search notion                    # Find MCP servers
agents install mcp:com.notion/mcp       # Install + register with ALL agents
```

No more running `claude mcp add`, then `codex mcp add`, then editing Gemini's config file.

### Version-lock agents per project

```bash
agents add claude@2.0.0           # Install specific version
agents use claude@2.0.0 -p        # Pin to this project
```

Like `nvm` for Node - different projects can use different agent versions.

### Sync your entire setup

```bash
agents push                       # Export your config to git
agents pull                       # Restore on any machine
```

Your `~/.agents/` repo holds commands, skills, MCPs, memory files, hooks, and permissions. One `pull` configures everything.

### Schedule agents on cron

```bash
agents cron add daily-digest -s "0 9 * * *" -a claude -p "Review yesterday's PRs..."
agents daemon start
```

Agents run sandboxed - they only see directories and tools you explicitly allow.

---

## Quick Reference

```bash
# Versions
agents add claude@latest          # Install
agents use claude@2.0.0           # Set default
agents list                       # Show installed

# Packages
agents search <query>             # Find MCP servers/skills
agents install mcp:<name>         # Install MCP server
agents install skill:<name>       # Install skill

# Sync
agents pull                       # Sync from your repo
agents push                       # Push changes back

# Resources
agents mcp list                   # Show MCP servers
agents commands list              # Show slash commands
agents skills list                # Show skills

# Automation
agents exec claude "prompt"       # Run agent
agents cron add job.yaml          # Schedule job
agents daemon start               # Start scheduler
```

Also available as `ag` - all commands work with `ag pull`, `ag list`, etc.

---

## Compatibility

| Agent | MCP | Commands | Skills | Memory | Permissions | Jobs |
|-------|-----|----------|--------|--------|-------------|------|
| Claude | yes | yes | yes | yes | yes | yes |
| Codex | yes | yes | yes | yes | yes | yes |
| Gemini | yes | yes | yes | yes | -- | yes |
| Cursor | yes | yes | yes | yes | -- | -- |
| OpenCode | yes | yes | yes | yes | yes | -- |

## License

MIT
