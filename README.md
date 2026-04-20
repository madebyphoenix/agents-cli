# agents

[![npm version](https://img.shields.io/npm/v/@phnx-labs/agents-cli.svg?style=flat-square)](https://www.npmjs.com/package/@phnx-labs/agents-cli)
[![license](https://img.shields.io/npm/l/@phnx-labs/agents-cli.svg?style=flat-square)](./LICENSE)
[![downloads](https://img.shields.io/npm/dm/@phnx-labs/agents-cli.svg?style=flat-square)](https://www.npmjs.com/package/@phnx-labs/agents-cli)
[![homepage](https://img.shields.io/badge/homepage-agents--cli.sh-blue?style=flat-square)](https://agents-cli.sh)

**The open client for AI coding agents.** Run Claude, Codex, Gemini, Cursor — same interface, on your machine.

Pin versions per project. Install skills, MCP servers, and slash commands once — every agent gets them. Chain agents in pipelines. Put agents on a team to work a shared task in parallel.

```bash
curl -fsSL agents-cli.sh | sh
# or
npm install -g @phnx-labs/agents-cli
```

Also available as `ag` — all commands work with both `agents` and `ag`.

## Table of contents

- [Run any agent, same interface](#run-any-agent-same-interface)
- [Run open-source models through Claude Code](#run-open-source-models-through-claude-code)
- [Keep secrets out of plaintext env files](#keep-secrets-out-of-plaintext-env-files)
- [Put agents on a team](#put-agents-on-a-team)
- [Non-interactive usage](#non-interactive-usage)
- [Search sessions fast](#search-sessions-fast)
- [Pin agent versions per project](#pin-agent-versions-per-project)
- [Install skills, MCP servers, and commands once](#install-skills-mcp-servers-and-commands-once--every-agent-gets-them)
- [Quick reference](#quick-reference)
- [Skill format](#skill-format)
- [Compatibility](#compatibility)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## Run any agent, same interface

```bash
agents run claude "Find all auth vulnerabilities in src/"
agents run codex "Fix the issues Claude found"
agents run gemini "Write tests for the fixed code"
```

Each agent resolves to the project-pinned version, with the right skills, MCP servers, and permissions already synced. No setup between steps -- just run.

`agents run` also passes environment overrides to the spawned CLI. For one-off flags this looks like `--env KEY=VALUE`; for repeatable provider setups see [profiles](#run-open-source-models-through-claude-code) below.

Chain agents by strength, swap one for another, script them in CI -- the interface stays the same:

```bash
# Friday night code review
agents run claude "Review all PRs merged this week, summarize risks" \
  | agents run codex "Write regression tests for the top 3 risks"

# Same pipeline, different project -- different agent versions, same commands
cd ../other-project
agents run claude "Review all PRs merged this week, summarize risks"
# ^ resolves to claude@2.0.0 here instead of claude@2.1.89
```

Supports plan (read-only) and edit modes, effort levels that map to the right model per agent, and JSON output for scripting.

---

## Run open-source models through Claude Code

`agents profiles` saves a named bundle of (host CLI, endpoint, model, keychain-backed auth). Ship a preset, paste the API key once, then invoke any open-source model as a first-class agent — no shell function, no plaintext token, no proxy.

```bash
agents profiles add kimi                # prompts for OpenRouter key, stores in Keychain
agents run kimi "refactor this file"    # Claude Code UI, Kimi K2.5 responses
```

Built-in presets (all via OpenRouter, one shared key):

| Preset | Model | Notes |
|---|---|---|
| `kimi` | `moonshotai/kimi-k2.5` | #1 HumanEval (99%), top Kimi. Reasoning — interactive only. |
| `kimi-chat` | `moonshotai/kimi-k2-0905` | Non-reasoning, print-safe for `agents run`. |
| `minimax` | `minimax/minimax-m2.5` | #1 SWE-bench Verified (80.2%). Reasoning. |
| `glm` | `z-ai/glm-5` | #1 Chatbot Arena among open-weight (1451 ELO). |
| `qwen` | `qwen/qwen3-coder-next` | Latest coding Qwen, sparse MoE 80B/3B active. Print-safe. |
| `deepseek` | `deepseek/deepseek-chat-v3-0324` | Latest non-reasoning DeepSeek Chat. Print-safe. |

`agents profiles presets` lists the catalog. `agents profiles view <name>` shows the env, model, and keychain status.

**How it works:** a profile swaps the *model* while keeping Claude Code as the *agent runtime* — same UI, slash commands, skills, MCP tools, permission system. Under the hood it sets `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL` and pulls `ANTHROPIC_AUTH_TOKEN` from Keychain at spawn time.

Profile YAML lives in `~/.agents/profiles/<name>.yml` with no secrets — safe to `agents push` to a shared repo. Keys live only in macOS Keychain; rotate with `agents profiles login <provider>`.

**Custom endpoints** — for self-hosted models (Ollama, vLLM) or other aggregators, drop a YAML file directly:

```yaml
# ~/.agents/profiles/local-qwen.yml
name: local-qwen
host: { agent: claude }
env:
  ANTHROPIC_BASE_URL: https://ollama.internal
  ANTHROPIC_MODEL: qwen3.6:35b
  ANTHROPIC_SMALL_FAST_MODEL: qwen3.6:35b
auth:
  envVar: ANTHROPIC_AUTH_TOKEN
  keychainItem: agents-cli.ollama.token
```

Then `agents profiles login ollama` to store the token, and `agents run local-qwen "..."` works.

**Note on `--print` and reasoning models:** Claude Code's `--print` mode consolidates response text, but returns empty when the response contains `thinking` blocks. Models flagged REASONING in the preset descriptions work fine interactively (plain `claude` launch with the same env) but not with `agents run --print`. Use the non-reasoning `-chat` variant for scripting.

---

## Keep secrets out of plaintext env files

`agents secrets` stores sensitive values (API keys, tokens, even a test credit card number) in the macOS Keychain and injects them into agents at run time. Bundle files on disk contain only references — safe to `agents push` to a shared repo.

```bash
agents secrets add prod-stripe --description "Stripe prod + test card"
agents secrets set prod-stripe STRIPE_SECRET_KEY          # prompts, stores in keychain
agents secrets set prod-stripe TEST_CARD_NUMBER           # prompts, stores in keychain
agents secrets set prod-stripe STRIPE_API_VERSION --value "2024-06-20"
agents secrets set prod-stripe GITHUB_TOKEN --env GH_TOKEN   # read from parent shell
agents secrets set prod-stripe GCP_CREDS --file ~/.config/gcloud/creds.json

agents run claude "charge a test card" --secrets prod-stripe
```

The resulting `~/.agents/secrets/prod-stripe.yml` holds only refs:

```yaml
name: prod-stripe
vars:
  STRIPE_SECRET_KEY: keychain:STRIPE_SECRET_KEY
  TEST_CARD_NUMBER:  keychain:TEST_CARD_NUMBER
  STRIPE_API_VERSION: { value: "2024-06-20" }
  GITHUB_TOKEN: env:GH_TOKEN
  GCP_CREDS: file:~/.config/gcloud/creds.json
```

Merge order on `agents run` is **profile env < `--secrets <bundle>` < `--env K=V`** — a profile carries provider auth, bundles carry user-defined values, `--env` is the per-invocation override. Resolution happens right before `spawn`; a missing keychain item aborts the run before the child starts.

---

## Put agents on a team

`agents run` runs one agent synchronously. **Teams** run many agents on the same task, in the background, with coordination.

```bash
agents teams create auth-feature

agents teams add auth-feature claude "Research auth libraries"         --name researcher
agents teams add auth-feature codex  "Draft the migration"             --name migrator --after researcher
agents teams add auth-feature claude "Write tests for the new code"    --name tester   --after migrator

agents teams start auth-feature    # launches teammates whose --after deps are done
agents teams status auth-feature   # who's working, what they've changed, what they said
agents teams disband auth-feature  # stop everyone, clean up
```

Each teammate runs detached. Close your terminal; they keep working. Check in whenever.

- `--name alice` gives a teammate a handle. Refer to them by name everywhere (`teams rm auth alice`, `teams logs alice`).
- `--after name1,name2` stages a teammate as pending. `teams start` fires the ones whose blockers are `completed`. Cycles rejected at add time; a failed blocker keeps its dependents pending so you decide what to do.
- For Claude teammates, `agent_id` IS the Claude session UUID -- `agents sessions <agent_id> --markdown` opens the full conversation.
- Modes match `exec`: `plan | edit | full`. `--model`, `--env KEY=VALUE`, `--cwd` all passthroughs too.
- `teams ls` filters: substring query, `--agent claude[@version]`, `--status working|done|failed|empty`, `--since 2h --until 30d`.
- Non-TTY output is valid JSON by default, with a `cursor` field in every `status` response for efficient delta polling (`--since <cursor>`).

State lives in `~/.agents/teams/`. Teammates survive terminal restarts. Synced config (commands, skills, rules, MCP servers, hooks, permissions) applies to teammates the same way it applies to `agents run` -- one config, both flows.

---

## Non-interactive usage

Other coding agents usually run in non-TTY shells. `agents` now supports that mode directly:

```bash
agents add codex@latest --yes
agents use claude@2.1.79 --yes
agents commands add --names review-pr,debug --agents codex@0.113.0
agents skills add --names agents-cli --agents claude@default
agents install ./team-agent-pack --agents codex@0.113.0
agents mcp add postgres --agents claude@2.1.79 -- npx -y @modelcontextprotocol/server-postgres
agents mcp register postgres
agents sessions <session-id> --markdown
agents routines view <job-name>
```

Rules for automation:

- Pass explicit names or IDs instead of relying on pickers.
- Use `--yes` when a command would otherwise ask for default sync or confirmation choices.
- Use `--names` with `commands`, `skills`, `hooks`, `rules`, and `permissions` to install from central storage without a checkbox prompt.
- Use `agent@version` or `agent@default` with `--agents` when you need an exact managed version.
- Long `view` commands print directly in non-interactive shells instead of opening `less`.

If a command still needs a human-only picker, it now exits with a plain-text hint that shows the matching non-interactive form.

---

## Search sessions fast

Interactive terminals now get a live-search picker for sessions:

```bash
agents sessions
agents sessions --agent codex
agents sessions --project agents-cli
agents sessions --agent gemini "session discovery"
```

What you can type into the picker:

- Session ID or short ID
- Prompt text / topic text
- Project name
- Account email
- Agent name or version

The shared `Agent` column also shows the resolved agent version when it is known, so filtered lists read like `claude@2.1.110`, `codex@0.113.0`, `gemini@0.29.5`, and `opencode@1.2.6`.

Pass `<id>` (with `--markdown`, `--json`, or filter flags like `--include`, `--exclude`, `--first`, `--last`) in non-interactive shells when you already know the session you want.

---

## Pin agent versions per project

```bash
agents add claude@2.0.0             # Install specific version
agents use claude@2.0.0 -p          # Pin to this project
```

Like `.nvmrc` for Node -- different projects use different agent versions. A shim system reads a project-root `agents.yaml` and routes to the right binary automatically. No other tool does this for AI agents.

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

`push` captures your current agent versions and MCP registrations into `~/.agents/`. `pull` does the real work — it installs agent CLIs, registers MCP servers, syncs resources (commands, skills, rules, hooks, permissions) into each agent's config directory, sets up PATH shims, and configures defaults. One command, fully configured machine.

### Interactive PTY sessions

Give your agents the ability to interact with full-screen terminal programs -- REPLs, TUIs, interactive installers, anything that needs a real terminal.

```bash
SID=$(agents pty start)                              # Start a session
agents pty exec $SID "python3"                       # Launch Python REPL
agents pty screen $SID                               # See what's on screen
agents pty write $SID "print('hello')\n"             # Type into it
agents pty screen $SID                               # See the result
agents pty write $SID "exit()\n"                     # Quit
agents pty stop $SID                                 # Clean up
```

A sidecar server holds PTY sessions alive between CLI calls. `screen` renders the terminal as clean text (no ANSI codes) using xterm-headless -- so agents see exactly what a human would see. Sessions auto-clean after 30 minutes of idle.

### Schedule agents as routines

```bash
agents routines add daily-digest \
  --schedule "0 9 * * 1-5" \
  --agent claude \
  --prompt "Review yesterday's PRs and summarize key changes"
# The scheduler auto-starts on first add — no separate daemon command needed.

agents routines list                   # See all jobs
agents routines status                 # Check scheduler and upcoming runs
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

# Secrets (keychain-backed env bundles, injected at run time)
agents secrets list                       # Show all bundles
agents secrets add <name>                 # Create an empty bundle
agents secrets set <bundle> <KEY>         # Prompt, store in keychain, write ref
agents secrets set <bundle> <KEY> --value <v>      # Store as YAML literal
agents secrets set <bundle> <KEY> --env <VAR>      # Inherit from parent shell
agents secrets set <bundle> <KEY> --file <path>    # Read from a file at run time
agents secrets view <name> [--reveal]     # Show bundle (masked by default)
agents secrets import <name> --from .env  # Import a dotenv file into keychain
agents secrets rm <name>                  # Delete bundle and purge keychain
agents run <agent> "..." --secrets <name> # Inject a bundle (repeatable)

# Sync
agents pull [source]              # Sync from repo
agents push                       # Push changes back

# Drive
agents drive remote <user@host>   # Set sync target
agents drive pull                  # Pull sessions from remote
agents drive push                  # Push sessions to remote
agents drive attach                # Use drive as active agent home
agents drive detach                # Restore to version home
agents drive status                # Show drive state

# Execution
agents run <agent> <prompt>      # Run agent
agents sessions <id> --markdown   # Read a session by exact ID
agents sessions --agent codex     # Interactive filtered session search
agents sessions --project agents  # Interactive project-scoped session search
agents routines add <name>        # Schedule a job (scheduler auto-starts)
agents routines list              # Show all jobs
agents routines status            # Check scheduler status + upcoming runs

# Teams (orchestrate multiple agents on a shared task)
agents teams create <team>             # Start a new team
agents teams add <team> <agent> <task> # Add a teammate (runs immediately)
  --name alice                         #   give them a handle
  --after alice,bob                    #   stage as pending until deps complete
  --mode plan|edit|full                #   permissions
  --model <model> --env K=V            #   same passthroughs as exec
agents teams start <team>              # Launch pending teammates whose deps are done
agents teams status <team>             # Team standup (pass --since <cursor> for deltas)
agents teams ls                        # List teams (--agent, --status, --since filters)
agents teams remove <team> <teammate>  # Let one teammate go (name or UUID prefix)
agents teams disband <team>            # Stop everyone, remove the team
agents teams logs <teammate>           # Read their raw log
agents teams doctor                    # Check which agents can join a team

# PTY sessions
agents pty start                  # Start a PTY session (returns ID)
agents pty exec <id> <command>    # Run a command in the session
agents pty screen <id>            # Render terminal as clean text
agents pty write <id> <input>     # Send keystrokes (\n \t \e \xHH)
agents pty read <id>              # Read raw output
agents pty signal <id> INT        # Send signal
agents pty list                   # Show active sessions
agents pty stop <id>              # Kill a session
agents pty server status          # Check sidecar server
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

| Agent | Versions | MCP | Commands | Skills | Rules | Hooks | Permissions | Routines | Teams |
|-------|----------|-----|----------|--------|-------|-------|-------------|----------|-------|
| Claude | yes | yes | yes | yes | CLAUDE.md | yes | yes | yes | yes |
| Codex | yes | yes | yes | yes | AGENTS.md | yes | yes | yes | yes |
| Gemini | yes | yes | yes | yes | GEMINI.md | yes | -- | yes | yes |
| Cursor | yes | yes | yes | yes | .cursorrules | -- | -- | -- | yes |
| OpenCode | yes | yes | yes | yes | AGENTS.md | yes | yes | -- | yes |
| OpenClaw | yes | yes | -- | yes | workspace/AGENTS.md | yes | -- | -- | -- |

## FAQ

### Why use `agents` instead of `claude` / `codex` / `gemini` directly?

Each agent CLI has its own config format, its own MCP setup, its own version management, its own skill system. If you use more than one, you end up maintaining N copies of everything. `agents` gives you one interface, one config source, and one place to pin versions — plus features the individual CLIs don't ship: cross-agent pipelines, shared teams, session discovery across all of them, and project-pinned versions like `.nvmrc`.

### Is this like `nvm` / `mise` / `asdf` but for AI agents?

For version management, yes — that's the closest analogue. `agents-cli` reads a project-root `agents.yaml`, walks up the directory tree, and routes `claude` / `codex` / `gemini` to the correct installed binary per project. But `agents` also manages agent-native resources (skills, MCP servers, slash commands, hooks, permissions) that language version managers don't touch.

### How is this different from Vercel's Open Agents?

Open Agents is a hosted cloud product. `agents-cli` is a local-first open client — your agents run on your machine against your API keys, no SaaS layer in between. Part of an open stack for AI coding agents; cloud runner coming separately.

### Does it store my API keys or send telemetry?

No. `agents-cli` reads API keys from your shell environment or each agent CLI's existing auth (it never writes a credential file, never reads one you didn't already set up). No telemetry, no phone-home. All state lives in `~/.agents/` and each agent's own config dir.

### Do I need Node.js? Bun?

Either works. The installer tries Bun first (faster), falls back to npm. Node 18+ is required at runtime. No other build tools needed.

### Which platforms are supported?

macOS and Linux today. Windows via WSL works but isn't first-class. Native Windows support is on the roadmap.

### Can I use `agents` in CI?

Yes — `agents run` is non-interactive by default with `--yes` flags for every prompt and JSON output for parsing. The [non-interactive usage](#non-interactive-usage) section covers the automation-friendly flags.

### Can I add support for a new agent CLI?

Yes. Agents are defined in [src/lib/agents.ts](src/lib/agents.ts) — each is a config object declaring commands dir, memory file format, and capabilities. Open an issue or PR.

### What's the relationship to Phoenix Labs / Rush?

`agents-cli` is an open client maintained by Phoenix Labs. Rush is a separate product that builds on top of the same runtime. You can use `agents-cli` on its own — no Rush account required, no upsell.

## Contributing

PRs and issues welcome. To develop locally:

```bash
git clone https://github.com/phnx-labs/agents-cli
cd agents-cli
bun install
bun run build
bun test
```

The CLI entry is [src/index.ts](src/index.ts). Commands live in [src/commands/](src/commands/); shared libraries in [src/lib/](src/lib/). Tests sit next to source as `*.test.ts` and run under `vitest` (see [CLAUDE.md](CLAUDE.md) for the full style guide).

For a full comparison with other tools in the ecosystem — Rivet, Agentloom, mise, skills.sh, cass, Microsoft APM — see [docs/04-landscape.md](docs/04-landscape.md).

## License

MIT — see [LICENSE](./LICENSE).
