<p align="center">
  <img src="assets/logo.png" alt="agents" width="120" />
</p>

<h1 align="center">agents</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@swarmify/agents-cli"><img src="https://img.shields.io/npm/v/@swarmify/agents-cli.svg?style=flat-square" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@swarmify/agents-cli.svg?style=flat-square" alt="license" /></a>
  <a href="https://www.npmjs.com/package/@swarmify/agents-cli"><img src="https://img.shields.io/npm/dm/@swarmify/agents-cli.svg?style=flat-square" alt="downloads" /></a>
  <a href="https://github.com/swarmify/agents-cli"><img src="https://img.shields.io/badge/github-swarmify%2Fagents--cli-blue?style=flat-square" alt="github" /></a>
</p>

**The missing toolchain for CLI coding agents.** Pin versions per project. Share config across Claude Code, Codex, Gemini CLI, and Cursor. Stop setting up the same MCP server three times.

<p align="center">
  <a href="https://github.com/anthropics/claude-code" title="Claude Code"><img src="assets/harnesses/anthropic.svg" height="32" alt="Claude Code" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/openai/codex" title="Codex CLI"><img src="assets/harnesses/openai.svg" height="32" alt="Codex CLI" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/google-gemini/gemini-cli" title="Gemini CLI"><img src="assets/harnesses/google.svg" height="32" alt="Gemini CLI" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://cursor.com" title="Cursor"><img src="assets/harnesses/cursor.svg" height="32" alt="Cursor" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/sst/opencode" title="OpenCode"><img src="assets/harnesses/opencode.png" height="32" alt="OpenCode" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/openclaw/openclaw" title="OpenClaw"><img src="assets/harnesses/openclaw.svg" height="36" alt="OpenClaw" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://getrush.ai" title="Rush"><img src="assets/harnesses/rush.png" height="32" alt="Rush" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://github.com/NousResearch/hermes-agent" title="Hermes Agent"><img src="assets/harnesses/hermes.png" height="32" alt="Hermes Agent" /></a>
</p>

https://github.com/user-attachments/assets/cf0b2248-6672-4458-8027-b88525572f3e

```bash
npm install -g @swarmify/agents-cli
# or
bun install -g @swarmify/agents-cli
```

Source: [github.com/swarmify/agents-cli](https://github.com/swarmify/agents-cli)

Also available as `ag` -- all commands work with both `agents` and `ag`.

- [Pin versions per project](#pin-versions-per-project)
- [One config, every agent](#one-config-every-agent)
- [Run any agent](#run-any-agent)
- [Sessions across agents](#sessions-across-agents)
- [Run open models through Claude Code](#run-open-models-through-claude-code)
- [Teams](#teams)
- [Secrets](#secrets)
- [Routines](#routines)
- [PTY](#pty)
- [Portable setup](#portable-setup)
- [Private skills](#private-skills)
- [Compatibility](#compatibility)
- [FAQ](#faq)

---

## Pin versions per project

```bash
# This project needs claude@2.0.65 -- newer versions changed tool calling.
agents use claude@2.0.65 -p

# The monorepo uses codex@0.116.0 across the team.
agents use codex@0.116.0 -p
```

Like `.nvmrc` for Node. A shim reads `agents.yaml` from the project root and routes `claude` / `codex` / `gemini` to the right version automatically. Each version gets its own isolated home -- switching backs up config and re-syncs resources.

```bash
agents add claude@2.0.65     # Install a specific version
agents add codex@latest       # Install latest
agents view                   # See everything installed
```

---

## One config, every agent

```bash
# Set up the Notion MCP server once.
agents install mcp:com.notion/mcp

# It's now registered with Claude Code, Codex, Gemini CLI, and Cursor.
agents mcp list
```

Skills, slash commands, rules, hooks, and permissions work the same way -- install once in `~/.agents/`, synced to every agent's native format automatically.

```bash
agents skills add gh:yourteam/python-expert     # Knowledge pack -> all agents
agents commands add gh:yourteam/commands         # Slash commands -> all agents
agents rules add gh:team/rules                   # AGENTS.md -> CLAUDE.md, GEMINI.md, .cursorrules
agents permissions add ./perms                   # Permissions -> auto-converted per agent
```

Write one `AGENTS.md`. It becomes `CLAUDE.md` for Claude Code, `GEMINI.md` for Gemini CLI, `.cursorrules` for Cursor.

---

## Run any agent

```bash
agents run claude "Find all auth vulnerabilities in src/"
agents run codex "Fix the issues Claude found"
agents run gemini "Write tests for the fixed code"
```

Each resolves to the project-pinned version with skills, MCP servers, and permissions already synced.

### Rate-limited? Keep working.

```bash
# Claude Code hits a rate limit -> Codex picks up automatically. Same project, same config.
agents run claude "refactor auth module" --mode edit --fallback codex,gemini
```

### Multiple accounts? Spread the load.

```bash
# Picks the signed-in account you haven't used recently.
agents run claude "summarize recent commits" --rotate
```

`--rotate` cycles across installed versions of the same agent -- useful when you have multiple accounts and want to spread usage instead of burning through one.

### Chain agents

```bash
agents run claude "Review PRs merged this week, summarize risks" \
  | agents run codex "Write regression tests for the top 3 risks"
```

Supports plan (read-only) and edit modes, effort levels, JSON output for scripting, and timeout limits.

### One protocol, every harness

```bash
# Typed event stream instead of raw stdout. Same command, any supported agent.
agents run claude "review this diff" --acp --json
```

`--acp` routes through the [Agent Client Protocol](https://agentclientprotocol.com/) so you get a unified event stream -- `agent_message_chunk`, `tool_call`, `plan_update`, `stop_reason` -- instead of writing a parser per CLI. File writes and shell commands flow through agents-cli, which means `--mode plan` becomes a real sandbox: the write RPC is denied, not just unused.

Works today with claude, codex, gemini, cursor, opencode, openclaw. Other harnesses keep running on the direct-exec path.

---

## Sessions across agents

```bash
# Where was that auth conversation? Search Claude Code, Codex, Gemini CLI, OpenCode at once.
agents sessions "auth middleware"

# Filter by agent, project, or time window
agents sessions --agent codex --since 7d
agents sessions --project my-app

# Read a full conversation
agents sessions a1b2c3d4 --markdown

# Just the last 3 turns, user messages only
agents sessions a1b2c3d4 --last 3 --include user
```

Interactive picker when you're in a terminal. Structured output (`--json`, `--markdown`, filtered by role or turn count) when piped.

Backed by a SQLite + FTS5 index at `~/.agents/sessions/sessions.db` with incremental scanning -- warm reads in ~100ms. External tools can consume `--json` output as a programmatic observability layer; see [docs/05-sessions.md](docs/05-sessions.md) for the schema and [docs/06-observability.md](docs/06-observability.md) for the consumption patterns.

---

## Run open models through Claude Code

```bash
# Kimi K2.5 responding inside Claude Code's UI, tools, and skills.
# No proxy server. No LiteLLM. One OpenRouter key, stored in Keychain.
agents profiles add kimi
agents run kimi "refactor this file"
```

Built-in presets (all via OpenRouter, one shared key):

| Preset | Model | Notes |
|---|---|---|
| `kimi` | Kimi K2.5 | #1 HumanEval. Reasoning -- interactive only. |
| `minimax` | MiniMax M2.5 | #1 SWE-bench Verified. Reasoning. |
| `glm` | GLM 5 | #1 Chatbot Arena (open-weight). |
| `qwen` | Qwen3 Coder Next | Latest coding Qwen. Print-safe. |
| `deepseek` | DeepSeek Chat V3 | Latest non-reasoning. Print-safe. |

A profile swaps the model while keeping Claude Code as the agent runtime -- same UI, slash commands, skills, MCP tools. Under the hood: `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL`, auth from Keychain at spawn time.

Custom endpoints (Ollama, vLLM) work too -- drop a YAML in `~/.agents/profiles/`:

```yaml
name: local-qwen
host: { agent: claude }
env:
  ANTHROPIC_BASE_URL: https://ollama.internal
  ANTHROPIC_MODEL: qwen3.6:35b
auth:
  envVar: ANTHROPIC_AUTH_TOKEN
  keychainItem: agents-cli.ollama.token
```

Profile YAML has no secrets -- safe to `agents push` to a shared repo. `agents profiles presets` lists the full catalog.

---

## Teams

```bash
agents teams create auth-feature

# Research first, then implement, then test.
agents teams add auth-feature claude "Research auth libraries"       --name researcher
agents teams add auth-feature codex  "Draft the migration"           --name migrator --after researcher
agents teams add auth-feature claude "Write tests for the new code"  --name tester   --after migrator

agents teams start auth-feature     # Fires teammates whose deps are done
agents teams status auth-feature    # Who's working, what they changed, what they said
```

Teammates run detached -- close your terminal, they keep working. Check in with `teams status`, read full output with `teams logs <name>`, clean up with `teams disband`.

Team state is observable via `agents teams list --json` / `agents teams status --json`. External tools join it with `sessions --json` (teammates get `isTeamOrigin: true`) and `cloud list --json` (for `--cloud` teammates) to build a unified fleet view. See [docs/06-observability.md](docs/06-observability.md).

---

## Secrets

```bash
# API keys in Keychain, not in .env files.
agents secrets create prod-stripe
agents secrets add prod-stripe STRIPE_SECRET_KEY     # Prompts, stores in Keychain
agents secrets add prod-stripe TEST_CARD --value "4242..."

# Injected at run time. The YAML on disk has only refs.
agents run claude "charge a test card" --secrets prod-stripe
```

<p align="center">
  <img src="assets/secrets.svg" alt="How agents-cli secrets work: stripe.yml holds a pointer, the macOS Keychain holds the value, agents-cli resolves at runtime and injects the env into the child process" width="100%" />
</p>

Merge order: profile env < `--secrets` < `--env K=V`. A missing keychain item aborts before the child starts.

---

## Routines

```bash
# Claude Code reviews PRs every weekday at 9 AM. Scheduler auto-starts.
agents routines add daily-digest \
  --schedule "0 9 * * 1-5" \
  --agent claude \
  --prompt "Review yesterday's PRs and summarize key changes"

agents routines list                   # All jobs + next run times
agents routines run daily-digest       # Test it now, ignore the schedule
agents routines logs daily-digest      # Check last execution
```

Jobs run sandboxed -- agents only see directories and tools you explicitly allow.

---

## PTY

```bash
# Give agents a real terminal for REPLs, TUIs, interactive programs.
SID=$(agents pty start)
agents pty exec $SID "python3"
agents pty screen $SID                # Clean text, no ANSI -- what a human sees
agents pty write $SID "print('hello')\n"
agents pty stop $SID
```

A sidecar server holds sessions alive between CLI calls. `screen` renders via xterm-headless. Sessions auto-clean after 30 minutes idle.

---

## Portable setup

```bash
# New machine? One command.
agents pull

# Installs CLIs, registers MCP servers, syncs skills/commands/rules/hooks,
# sets up shims, configures defaults. Done.

agents push     # Snapshot your config to git
```

---

## Private skills

Keep work or personal skills in a separate repo — public ones in `~/.agents/`, private ones in an extra repo that merges in at sync time.

```bash
# Add a private repo for work-only skills
agents repo add gh:yourname/.agents-work

# Add with a custom alias
agents repo add git@github.com:acme/team-skills.git --as acme

agents repo list          # Primary + every registered extra
agents repo pull          # Pull updates for all enabled extras
agents repo disable acme  # Stop merging without deleting
agents repo remove acme   # Unregister and delete the clone
```

Extras clone into `~/.agents/.repos/<alias>/` and ship the same layout as the primary (`skills/`, `commands/`, `hooks/`, `memory/`). Their contents merge into agent version homes after the primary's — so `~/.agents/` always wins on name collisions. `agents skills list` shows which repo each skill came from.

---

## Compatibility

| Agent | Versions | MCP | Commands | Skills | Rules | Hooks | Permissions | Routines | Teams |
|-------|----------|-----|----------|--------|-------|-------|-------------|----------|-------|
| Claude Code | yes | yes | yes | yes | CLAUDE.md | yes | yes | yes | yes |
| Codex CLI | yes | yes | yes | yes | AGENTS.md | yes | yes | yes | yes |
| Gemini CLI | yes | yes | yes | yes | GEMINI.md | yes | -- | yes | yes |
| Cursor | yes | yes | yes | yes | .cursorrules | -- | -- | -- | yes |
| OpenCode | yes | yes | yes | yes | AGENTS.md | yes | yes | -- | yes |
| OpenClaw | yes | yes | -- | yes | workspace/AGENTS.md | yes | -- | -- | -- |

## FAQ

### Why use `agents` instead of `claude` / `codex` / `gemini` directly?

Claude Code, Codex CLI, and Gemini CLI each have their own config format, MCP setup, version management, and skill system. If you use more than one, you maintain N copies of everything. `agents` gives you one interface, one config source, and one place to pin versions -- plus features the individual CLIs don't ship: cross-agent pipelines, shared teams, unified session search, and project-pinned versions like `.nvmrc`.

### Is this like `nvm` / `mise` / `asdf` for AI agents?

For version management, yes. `agents-cli` reads `agents.yaml` from the project root, walks up the directory tree, and routes to the correct binary per project. But it also manages agent-native resources (skills, MCP servers, commands, hooks, permissions) that language version managers don't touch.

### Does it store my API keys or send telemetry?

No. API keys come from your shell environment or each agent CLI's existing auth. No telemetry, no phone-home. All state lives in `~/.agents/`.

### Which platforms?

macOS and Linux. Windows via WSL works but isn't first-class yet.

### Do I need Node.js?

The installer tries Bun first (faster), falls back to npm. Node 18+ required at runtime.

### Can I use it in CI?

Yes -- `agents run` is non-interactive by default. `--yes` auto-accepts prompts, `--json` for structured output. Pass explicit names and IDs instead of relying on interactive pickers.

### Can I add support for a new agent?

Agents are defined in [src/lib/agents.ts](src/lib/agents.ts) -- each is a config object declaring commands dir, memory file, and capabilities. PRs welcome.

### What's the relationship to Phoenix Labs / Rush?

`agents-cli` is an open client maintained by Phoenix Labs. Rush is a separate product. No Rush account required, no upsell.

## Contributing

```bash
git clone https://github.com/swarmify/agents-cli
cd agents-cli
bun install && bun run build && bun test
```

Commands in [src/commands/](src/commands/), libraries in [src/lib/](src/lib/), tests as `*.test.ts` under vitest. [CLAUDE.md](CLAUDE.md) has the full style guide. [docs/04-landscape.md](docs/04-landscape.md) covers the competitive landscape.

## License

MIT -- see [LICENSE](./LICENSE).
