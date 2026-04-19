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

No unified interface. Switching providers means learning a new workflow,
different auth, different result formats. `agents` already unifies local agent
management (versions, sessions, config). Cloud dispatch is the natural next
layer.

## Vision

```
agents cloud run "fix the flaky test in auth.test.ts" --agent codex
agents cloud run "add rate limiting to /api/upload" --agent claude --branch feat/rate-limit
agents cloud status abc123
agents cloud list
agents cloud diff abc123
agents cloud apply abc123
agents cloud logs abc123 --follow
```

One command, any cloud agent backend. The developer stays in their terminal.
Results come back as diffs they can review and apply — or as PRs they can
merge.

Long-term: A2A protocol support so `agents cloud run` can dispatch to any
A2A-compatible agent endpoint, not just first-party integrations.

## Landscape & Protocols

### A2A (Agent-to-Agent Protocol)

Google's open protocol (v1.0.0, Linux Foundation). The right abstraction for
cloud dispatch:

- **Agent Cards** — JSON metadata at well-known URLs describing capabilities,
  auth requirements, and endpoints. Perfect for discovery.
- **Tasks** — Stateful work units with lifecycle:
  `working -> input_required | auth_required | completed | failed | canceled`
- **Artifacts** — Named outputs (diffs, files, structured data) composed of
  typed Parts.
- **Streaming** — SSE-based real-time updates via TaskStatusUpdateEvent.
- **Push Notifications** — Webhook-based async updates for long-running tasks.
- **Human-in-the-loop** — `input_required` state lets agents escalate to
  humans mid-task. This is critical — agents working for hours will get stuck.

A2A is agent-to-agent, complementing MCP (agent-to-tool). An agent discovered
via A2A still uses MCP internally to access repos, APIs, etc.

### MCP Evolution

MCP is adding remote-first features: streamable HTTP transport, `.well-known`
discovery, experimental Tasks primitive with retry/expiry. But MCP is for
tool access, not agent delegation. A cloud coding agent is a peer, not a tool.

### IETF/W3C

Early stage. IETF working group forming (post IETF 123/124). Drafts cover
agent identity via DIDs/Verifiable Credentials, agent context protocols. Years
from maturity. Not blocking — build on A2A now, adopt standards later.

## Architecture

```
agents cloud run <prompt>
       |
       v
  +-----------+
  |  Dispatch  |  Resolves --agent flag to a CloudProvider
  |   Layer    |  Normalizes prompt + repo context into provider-specific format
  +-----------+
       |
       +---> CodexCloudProvider   (codex cloud exec --env ...)
       +---> ClaudeCloudProvider  (API routines / remote sessions)
       +---> CopilotProvider      (GitHub API: assign issue to Copilot)
       +---> A2AProvider          (generic A2A endpoint — any compliant agent)
       +---> DevinProvider        (Devin API when available)
       |
       v
  +-----------+
  |   Task     |  Polls/streams status, handles escalation,
  |  Tracker   |  stores results locally
  +-----------+
       |
       v
  +-----------+
  |  Result    |  Normalizes provider output to unified format:
  |  Layer     |  diff, PR URL, artifacts, logs
  +-----------+
```

### Provider Interface

```typescript
interface CloudProvider {
  id: string;                          // "codex", "claude", "copilot", "a2a"
  name: string;                        // "Codex Cloud", "Claude Routines", etc.

  // Can this provider handle the request?
  supports(options: DispatchOptions): boolean;

  // Submit a task. Returns a task ID for tracking.
  dispatch(options: DispatchOptions): Promise<CloudTask>;

  // Poll or stream task status.
  status(taskId: string): Promise<CloudTaskStatus>;

  // Get the result (diff, artifacts, PR URL).
  result(taskId: string): Promise<CloudResult>;

  // Cancel a running task.
  cancel(taskId: string): Promise<void>;

  // Stream logs/output in real-time.
  stream(taskId: string): AsyncIterable<CloudEvent>;
}

interface DispatchOptions {
  prompt: string;
  repo?: string;                       // Git remote URL
  branch?: string;                     // Target branch
  cwd?: string;                        // Local working directory for context
  files?: string[];                    // Specific files to focus on
  env?: Record<string, string>;        // Environment variables
  budget?: { maxTokens?: number; maxMinutes?: number; maxDollars?: number };
}

interface CloudTask {
  id: string;
  provider: string;
  status: 'queued' | 'working' | 'input_required' | 'completed' | 'failed' | 'canceled';
  createdAt: string;
  prompt: string;
}

interface CloudResult {
  diff?: string;                       // Unified diff
  prUrl?: string;                      // Pull request URL if created
  artifacts?: CloudArtifact[];         // Named outputs
  logs?: string;                       // Execution logs
  summary?: string;                    // Agent's summary of what it did
}

interface CloudArtifact {
  name: string;
  mimeType: string;
  content: string | Buffer;
}

type CloudEvent =
  | { type: 'status'; status: CloudTaskStatus['status']; message?: string }
  | { type: 'log'; content: string }
  | { type: 'artifact'; artifact: CloudArtifact }
  | { type: 'escalation'; question: string; taskId: string }
  | { type: 'done'; result: CloudResult };
```

### A2A Provider (Generic)

The A2A provider is the long-term play. Any agent that publishes an Agent Card
at a well-known URL can be used:

```typescript
class A2AProvider implements CloudProvider {
  // Discover agent capabilities from Agent Card
  async discover(endpoint: string): Promise<AgentCard>;

  // Map DispatchOptions to A2A SendMessage
  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    // 1. Fetch Agent Card from endpoint/.well-known/agent.json
    // 2. Check capabilities match the request
    // 3. SendMessage with prompt + repo context as Parts
    // 4. Return task ID from A2A Task response
  }

  // Map A2A Task states to CloudTaskStatus
  async status(taskId: string): Promise<CloudTaskStatus> {
    // GetTask -> map A2A lifecycle states
    // input_required -> escalation event
  }

  // Extract Artifacts from completed A2A Task
  async result(taskId: string): Promise<CloudResult> {
    // Map A2A Artifacts to CloudResult
    // Look for diff-type artifacts, PR URLs in structured data
  }

  // SSE streaming via A2A SendStreamingMessage
  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    // Subscribe to TaskStatusUpdateEvent + TaskArtifactUpdateEvent
    // Yield normalized CloudEvents
  }
}
```

### Task Persistence

Cloud tasks are long-running (minutes to hours). Need local persistence:

```
~/.agents/cloud/
  tasks.jsonl          # Task metadata index (id, provider, status, timestamps)
  tasks/
    <task-id>/
      prompt.md        # Original prompt
      result.diff      # Unified diff (if completed)
      artifacts/       # Named outputs
      logs.txt         # Execution logs
      escalations.jsonl # Human-in-the-loop interactions
```

SQLite could replace JSONL if the task volume warrants it. Start simple.

### Escalation (Human-in-the-Loop)

When a cloud agent gets stuck, it needs to ask the human. This is the hardest
UX problem. The agent is remote and async — the human might not be at their
terminal.

**Phase 1 — Terminal polling:**
```
$ agents cloud status abc123
Status: input_required
Agent asks: "The auth.test.ts file imports from @auth/core but I can't find
that package. Should I install it, or is there an internal alternative?"

$ agents cloud respond abc123 "Install @auth/core from npm"
```

**Phase 2 — Push notifications:**
- Desktop notification when agent needs input
- Optional webhook to Slack/Discord/email
- `agents cloud watch` — live tail that blocks until escalation or completion

**Phase 3 — Bidirectional streaming:**
- `agents cloud attach abc123` — interactive session with the cloud agent
- Real-time conversation, like SSH-ing into the agent's thought process

### Auth & Secrets

Each provider needs different credentials:

| Provider | Auth mechanism |
|----------|---------------|
| Codex Cloud | OpenAI API key or OAuth session |
| Claude Routines | Anthropic API key |
| GitHub Copilot | GitHub PAT or OAuth app |
| Devin | API key |
| A2A generic | Per-agent (Agent Card declares auth requirements) |

Store in system keychain via `agents cloud login <provider>`. Never env vars.

For repo access, cloud agents need:
- Git remote URL (inferred from local repo)
- Branch to work on (inferred or specified)
- Secrets the agent needs (API keys, DB credentials) — this is provider-specific
  and the biggest unsolved problem across the industry

## Unsolved Problems (Industry-Wide)

These aren't blockers for Phase 1 but shape the long-term design:

### Agent Identity & Authorization
91% of orgs use AI agents in production, 10% have identity strategies. Bearer
tokens don't verify the entity presenting them. Legacy IAM is built for humans.
HashiCorp Vault is exploring agent-specific identity. IETF drafts propose
W3C DIDs + Verifiable Credentials. No standard exists today.

**Our approach:** Don't try to solve this. Use each provider's existing auth.
For A2A, support whatever the Agent Card declares. Revisit when IETF/W3C
standards mature.

### Result Verification
48% of developers distrust AI-generated code. The bottleneck shifted from
writing to reviewing. Cloud agents that produce 7 hours of code create a
review backlog.

**Our approach:** Show clear diffs. Integrate with existing review tools
(CodeRabbit, Copilot review). Don't auto-merge. The human reviews and applies.

### Cost Management
No protocol includes cost reporting. Cloud containers + LLM inference add up
fast. Provider billing is opaque.

**Our approach:** Track per-task cost where providers expose it. Set budget
limits in dispatch options. Show cost in `agents cloud list` output.

### Multi-Agent Orchestration
Gartner reports 1,445% surge in multi-agent inquiries. No standard
orchestrator protocol. A2A is peer-to-peer, not hub-and-spoke.

**Our approach:** Phase 1 is single-agent dispatch. Multi-agent (fan-out a task
to multiple agents, pick best result) is Phase 3+.

## Phased Rollout

### Phase 1: Codex Cloud Integration (2-3 weeks)

Codex Cloud is the most mature CLI-accessible cloud agent. Start here.

**Commands:**
```
agents cloud run <prompt> [--agent codex] [--branch <branch>] [--env <id>]
agents cloud status <task-id>
agents cloud list [--agent codex] [--since 7d]
agents cloud diff <task-id>
agents cloud apply <task-id>
agents cloud cancel <task-id>
```

**Files:**
```
src/commands/cloud.ts          # Command registration + actions
src/lib/cloud/types.ts         # CloudProvider, CloudTask, CloudResult interfaces
src/lib/cloud/codex.ts         # CodexCloudProvider implementation
src/lib/cloud/store.ts         # Local task persistence (~/.agents/cloud/)
```

**Implementation:**
1. `CodexCloudProvider` wraps `codex cloud exec/status/list/diff` CLI commands
2. Local task store tracks dispatched tasks across providers
3. `agents cloud list` shows tasks from all providers with unified columns
4. `agents cloud apply` runs `git apply` with the provider's diff

**What we learn:** Real usage patterns, what information users need during
async wait, whether the provider interface abstraction holds.

### Phase 2: Claude Routines + Escalation (3-4 weeks)

Add Claude as a second provider. Build escalation UX.

**New:**
```
agents cloud run <prompt> --agent claude [--routine] [--schedule "0 9 * * MON"]
agents cloud respond <task-id> "answer to agent's question"
agents cloud watch <task-id>
agents cloud login <provider>
```

**Files:**
```
src/lib/cloud/claude.ts        # ClaudeCloudProvider (API routines)
src/lib/cloud/escalation.ts    # Escalation handling + notification
```

**Implementation:**
1. `ClaudeCloudProvider` uses Anthropic API for remote sessions / routines
2. Escalation: poll for `input_required`, display question, accept response
3. `agents cloud watch` — live tail with escalation handling
4. Keychain-based credential storage via `agents cloud login`

### Phase 3: A2A Generic Provider + GitHub Copilot (4-6 weeks)

The A2A provider makes `agents cloud` extensible to any compliant agent.

**New:**
```
agents cloud run <prompt> --endpoint https://agent.example.com
agents cloud discover https://agent.example.com
agents cloud agents                    # List known agent endpoints
agents cloud agents add <url> [--name myagent]
```

**Files:**
```
src/lib/cloud/a2a.ts           # A2AProvider — generic A2A client
src/lib/cloud/copilot.ts       # CopilotProvider (GitHub API)
src/lib/cloud/discovery.ts     # Agent Card fetching + caching
```

**Implementation:**
1. `A2AProvider` implements the full A2A client: Agent Card discovery,
   SendMessage, GetTask, streaming, push notifications
2. `CopilotProvider` uses GitHub API to assign issues to Copilot agent
3. Agent registry in `~/.agents/cloud/agents.yaml` — named endpoints
4. `agents cloud discover` fetches and displays Agent Card capabilities

### Phase 4: Multi-Agent + Orchestration (6-8 weeks)

Fan-out tasks to multiple agents. Compare results. Build pipelines.

**New:**
```
agents cloud run <prompt> --agents codex,claude --strategy best-of
agents cloud run <prompt> --agents codex,claude --strategy first-wins
agents cloud pipeline run <pipeline.yaml>
```

**Concepts:**
- **best-of-N:** Dispatch to N agents, compare diffs, pick best
- **first-wins:** Dispatch to N agents, use first completion
- **pipeline:** YAML-defined multi-step workflows (research -> implement -> test -> review)

This phase depends heavily on how Phases 1-3 play out in practice.

## Configuration

```yaml
# ~/.agents/agents.yaml (existing config file)
cloud:
  default_agent: codex
  agents:
    codex:
      env: env_abc123                  # Default Codex Cloud environment
    claude:
      model: claude-sonnet-4-6         # Default model for routines
    custom-agent:
      endpoint: https://agent.example.com
      type: a2a                        # Protocol type
  budget:
    max_minutes: 60                    # Default per-task time limit
    max_dollars: 5.00                  # Default per-task cost limit
```

## Success Criteria

**Phase 1 done when:**
- `agents cloud run "fix the test" --agent codex` dispatches and returns a task ID
- `agents cloud list` shows tasks across sessions (persistent)
- `agents cloud diff <id>` shows the result
- `agents cloud apply <id>` applies the diff cleanly
- Works from any repo with Codex Cloud configured

**Long-term done when:**
- A developer can dispatch work to any cloud agent from one CLI
- Escalations surface in the terminal without polling manually
- `agents cloud` is how teams manage their fleet of cloud coding agents
- A2A endpoint support means any new agent platform works on day one
