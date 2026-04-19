# Plan: `agents cloud` — Multi-Provider Cloud Agent Dispatch

## Problem

Coding agents are shifting from local-only to cloud-first execution. Today each
provider ships its own CLI and workflow:

| Provider | Dispatch | Result | Escalation |
|----------|----------|--------|------------|
| Codex Cloud | `codex cloud exec --env <id>` | Diff, apply locally | None (async poll) |
| Claude Code | Remote session toggle, Routines | PR / inline | None yet |
| GitHub Copilot | Assign issue to Copilot | Draft PR | None |
| Devin | Web UI / Slack | PR | Slack thread |
| Factory | Web UI | PR | Web UI |

No unified interface. No standard work order format. No protocol for the
factory itself — A2A handles agent-to-agent communication, MCP handles
agent-to-tool access, but nobody has specced the production facility that takes
a work order and autonomously produces verified software.

Closest existing work:
- **StrongDM Attractor** — NLSpec (no code) defining a pipeline runner as DOT
  graphs. 1K stars. The blueprint.
- **Fabro** — working Rust implementation of the dark factory pattern. DOT
  pipelines, model routing, git-branch checkpoints, build/test gates. The
  building.
- Neither defines a standard work order format or resource model.

`agents` already unifies local agent management (versions, sessions, config).
Cloud dispatch is the natural next layer. `agents teams` already handles
multi-agent orchestration locally — extend that to cloud.

## Vision

```
agents cloud run task.md --agent codex
agents cloud run "fix the flaky test" --agent claude --branch feat/fix
agents cloud run ./tasks/migrate-auth/ --agent codex
agents cloud status abc123
agents cloud list
agents cloud apply abc123
agents cloud logs abc123 --follow
agents cloud respond abc123 "use the internal auth package"
```

## Work Order Format

A task is a markdown file. Optionally a folder with assets. Nothing more.

### Simple: single file

```markdown
# Fix flaky auth test

The test `auth.test.ts` in `src/__tests__/` fails intermittently on CI.
The failure is a race condition in the token refresh mock.

Fix the test so it passes reliably. Run the test suite to verify.
```

That's it. `agents cloud run task.md` sends this as the prompt.

### With assets: folder

```
migrate-auth/
  task.md              # The prompt / spec
  assets/              # Optional: screenshots, data, reference code
    error-log.txt
    expected-schema.sql
  resources.yaml       # Optional: resource requirements
```

If assets aren't bundled, declare how to fetch them in the task:

```markdown
# Implement new dashboard

Reference the Figma design at: https://figma.com/file/abc123
Pull the API schema from: https://api.example.com/openapi.json

The agent should fetch these before starting.
```

The agent grabs what it needs. Doesn't need to be complicated.

### Inline (no file)

```
agents cloud run "fix the flaky test in auth.test.ts" --agent codex
```

A string prompt becomes a work order implicitly.

## Resource Model (k8s-style)

Follow Kubernetes: defaults and limits. Battle-tested, everyone understands it.

### Per-task resources

```yaml
# resources.yaml (in task folder) or inline in agents.yaml
resources:
  defaults:
    timeout: 30m
    tokens: 500k
    cost: $2
  limits:
    timeout: 4h
    tokens: 5M
    cost: $10
```

### Global defaults in config

```yaml
# ~/.agents/agents.yaml
cloud:
  default_agent: codex
  resources:
    defaults:
      timeout: 30m
      tokens: 500k
      cost: $2
    limits:
      timeout: 4h
      tokens: 5M
      cost: $20
  agents:
    codex:
      env: env_abc123
    claude:
      model: claude-sonnet-4-6
    custom-agent:
      endpoint: https://agent.example.com
      type: a2a
```

Task-level resources override global defaults but cannot exceed global limits.
Same as k8s: `requests <= limits`, always.

### Secrets

Agents need access to repos, APIs, databases. Each provider handles this
differently today. Our model:

```yaml
# resources.yaml
secrets:
  - name: DATABASE_URL
    from: keychain          # System keychain
  - name: GITHUB_TOKEN
    from: gh                # Infer from `gh auth token`
  - name: OPENAI_API_KEY
    from: env               # From local environment
```

Provider-specific secret injection is the provider's problem. We normalize the
declaration.

## Output Model

Agents don't produce "outputs" in the traditional sense. They do work.

- **PRs, deployments, file changes** — these are tool_calls the agent makes
  during execution, not results we collect after. A PR is a side effect of the
  agent calling `gh pr create`, not an artifact we extract.
- **Summary** — the agent's last message is markdown describing what it did.
  That's the output. `agents cloud status <id>` shows it.
- **Diff** — for providers that produce diffs (Codex Cloud), we store and
  expose them via `agents cloud diff <id>` and `agents cloud apply <id>`.
- **Session** — the full execution history is a session, readable via
  `agents sessions`. Cloud sessions are just remote sessions.

No special artifact format needed. The agent's conversation IS the record.

## Orchestration via Teams

`agents teams` already exists for multi-agent work. A cloud factory is a team
with a work queue. No new orchestration primitive needed.

```yaml
# team.yaml
name: backend-factory
agents:
  - name: implementer
    provider: codex
    role: "Implement the task per spec. Write tests."
  - name: reviewer
    provider: claude
    role: "Review the implementer's changes. Check for bugs, security issues."

workflow:
  - agent: implementer
    then: reviewer
```

`agents cloud run task.md --team backend-factory` dispatches through the team.
The team handles sequencing, parallel fan-out, etc.

For simple single-agent dispatch, `--agent codex` is sufficient. Teams are for
when you want multi-agent pipelines.

## Escalation

When a cloud agent gets stuck, it escalates to the human. Like a remote
employee asking their manager for help — otherwise keeps working.

### Phase 1 — Terminal polling

```
$ agents cloud status abc123
Status: input_required
Agent asks: "The auth.test.ts file imports from @auth/core but I can't find
that package. Should I install it, or is there an internal alternative?"

$ agents cloud respond abc123 "Install @auth/core from npm"
```

### Phase 2 — Push notifications

- Desktop notification when agent needs input
- Optional webhook to Slack/Discord
- `agents cloud watch <id>` — live tail, blocks until escalation or completion

### Phase 3 — Interactive attach

- `agents cloud attach <id>` — SSH into the agent's thought process
- Real-time bidirectional conversation

## Feedback Loops

Every completed task produces a retrospective:

```markdown
# Retro: task abc123

## What happened
Fixed the flaky auth test. Root cause was a race condition in the token
refresh mock — the mock resolved synchronously while the real implementation
is async.

## Metrics
- Duration: 12 minutes
- Tokens: 340k (input 280k, output 60k)
- Cost: $1.40
- Tool calls: 23 (8 read, 6 edit, 5 bash, 4 grep)
- Iterations: 2 (first attempt failed test, second fixed it)

## What could improve
- The test file had no comments explaining the async requirement
- A project-level testing guide would have saved one iteration
```

Retros accumulate. Patterns emerge:
- "Agent X spends 40% of tokens reading files it doesn't end up modifying"
- "Tasks in src/auth/ take 3x longer than average — context is fragmented"
- "Claude completes review tasks 2x faster than Codex but costs 1.5x more"

`agents cloud retro --since 30d` summarizes patterns across recent tasks.
This feeds back into task authoring, agent selection, and resource tuning.

## Landscape & Protocols

### A2A (Agent-to-Agent Protocol)

Google's open protocol (v1.0.0, Linux Foundation). The right abstraction for
talking to cloud agents:

- **Agent Cards** — JSON metadata describing capabilities, auth, endpoints
- **Tasks** — stateful work units:
  `working -> input_required | auth_required | completed | failed | canceled`
- **Streaming** — SSE-based real-time updates
- **Push Notifications** — webhook-based async updates
- **Human-in-the-loop** — `input_required` state is first-class

A2A is how we talk to generic cloud agents. First-party integrations (Codex,
Claude) use provider APIs directly but map to the same internal model.

### What's Missing in Existing Protocols

| Layer | Protocol | Status |
|-------|----------|--------|
| Agent-to-tool | MCP | Mature |
| Agent-to-agent | A2A | v1.0, maturing |
| Work order format | None | Gap |
| Resource model | None | Gap |
| Factory lifecycle | None | Gap |
| Feedback/retro | None | Gap |

We don't need to solve all of these as formal protocols. But our implementation
becomes a de facto format that others can adopt if it's clean enough.

## Architecture

```
agents cloud run <prompt|file|folder>
       |
       v
  +-----------+
  |  Work Order|  Normalize input to { prompt, assets, resources }
  |  Parser    |  task.md -> prompt, folder -> prompt + assets
  +-----------+
       |
       v
  +-----------+
  |  Dispatch  |  Resolve --agent to a CloudProvider
  |   Layer    |  Apply resource defaults/limits
  +-----------+
       |
       +---> CodexCloudProvider   (codex cloud exec)
       +---> ClaudeCloudProvider  (API routines / remote sessions)
       +---> CopilotProvider      (GitHub API)
       +---> A2AProvider          (generic endpoint)
       |
       v
  +-----------+
  |   Task     |  Poll/stream status, handle escalation,
  |  Tracker   |  persist locally, generate retro on completion
  +-----------+
```

### Provider Interface

```typescript
interface CloudProvider {
  id: string;
  name: string;
  supports(options: DispatchOptions): boolean;
  dispatch(options: DispatchOptions): Promise<CloudTask>;
  status(taskId: string): Promise<CloudTaskStatus>;
  cancel(taskId: string): Promise<void>;
  stream(taskId: string): AsyncIterable<CloudEvent>;
  respond(taskId: string, message: string): Promise<void>;
}

interface DispatchOptions {
  prompt: string;
  assets?: { name: string; content: string | Buffer }[];
  repo?: string;
  branch?: string;
  cwd?: string;
  resources?: ResourceSpec;
  secrets?: SecretRef[];
}

interface ResourceSpec {
  timeout?: string;         // "30m", "4h"
  tokens?: string;          // "500k", "5M"
  cost?: string;            // "$2", "$10"
}

interface CloudTask {
  id: string;
  provider: string;
  status: 'queued' | 'working' | 'input_required' | 'completed' | 'failed' | 'canceled';
  createdAt: string;
  prompt: string;
  summary?: string;         // Agent's last message (the output)
  diff?: string;            // If provider produces diffs
}

type CloudEvent =
  | { type: 'status'; status: string; message?: string }
  | { type: 'log'; content: string }
  | { type: 'escalation'; question: string }
  | { type: 'done'; summary: string };
```

### Task Persistence

```
~/.agents/cloud/
  tasks.jsonl            # Task index (id, provider, status, timestamps)
  tasks/
    <task-id>/
      task.md            # Original work order
      assets/            # Bundled assets (if any)
      summary.md         # Agent's summary of what it did
      diff.patch         # Unified diff (if applicable)
      retro.md           # Auto-generated retrospective
      escalations.jsonl  # Human-in-the-loop exchanges
```

## Phased Rollout

### Phase 1: Codex Cloud + Work Order Format (2-3 weeks)

```
agents cloud run <prompt|file|folder> [--agent codex] [--branch <branch>]
agents cloud status <task-id>
agents cloud list [--agent codex] [--since 7d]
agents cloud diff <task-id>
agents cloud apply <task-id>
agents cloud cancel <task-id>
```

Files:
```
src/commands/cloud.ts          # Command registration + actions
src/lib/cloud/types.ts         # Interfaces
src/lib/cloud/codex.ts         # CodexCloudProvider (wraps codex CLI)
src/lib/cloud/store.ts         # Local task persistence
src/lib/cloud/workorder.ts     # Parse task.md / folder / string into DispatchOptions
```

### Phase 2: Claude + Escalation + Retros (3-4 weeks)

```
agents cloud run <prompt> --agent claude
agents cloud respond <task-id> "answer"
agents cloud watch <task-id>
agents cloud retro <task-id>
agents cloud retro --since 30d
agents cloud login <provider>
```

Files:
```
src/lib/cloud/claude.ts        # ClaudeCloudProvider
src/lib/cloud/escalation.ts    # Escalation handling
src/lib/cloud/retro.ts         # Retrospective generation + aggregation
```

### Phase 3: A2A + Teams Integration (4-6 weeks)

```
agents cloud run <prompt> --endpoint https://agent.example.com
agents cloud run task.md --team backend-factory
agents cloud discover <url>
agents cloud agents
agents cloud agents add <url> [--name myagent]
```

Files:
```
src/lib/cloud/a2a.ts           # A2AProvider
src/lib/cloud/discovery.ts     # Agent Card fetching
src/lib/cloud/teams.ts         # Teams integration for cloud dispatch
```

### Phase 4: Multi-Agent Strategies (6-8 weeks)

```
agents cloud run <prompt> --agents codex,claude --strategy best-of
agents cloud run <prompt> --agents codex,claude --strategy first-wins
```

Depends on learnings from Phases 1-3.

## Success Criteria

**Phase 1 done when:**
- `agents cloud run task.md --agent codex` dispatches and returns a task ID
- `agents cloud run "fix the test"` works with inline prompts
- `agents cloud run ./tasks/migrate-auth/` works with folders + assets
- Resource defaults/limits apply from config
- `agents cloud list` shows tasks with status, duration, cost
- `agents cloud apply <id>` applies the diff cleanly

**Long-term done when:**
- One CLI dispatches to any cloud agent
- Work orders are just files — sharable, versionable, reviewable
- Escalations surface without manual polling
- Retros accumulate and show cost/quality patterns
- Teams orchestrate multi-agent cloud pipelines
- A2A support means any new agent platform works on day one
