# Plan: Harness-Managed Git Lifecycle for Cloud Dispatches

## Problem

Cloud dispatches currently trust the agent to commit and push its own work. When the agent forgets — or exits cleanly without pushing — the work is **permanently lost**: the pod's `emptyDir` is destroyed on TTL, `cloud_executions.output` is truncated to 50KB, and `cloud_executions.branch` / `pr_url` stay null.

This burned us on the `agents env` dispatch (RUSH-393). The agent did ~11 minutes of focused work, created 6 files, landed 37 passing tests, wrote a final summary, and exited 0. The sandbox marked the run `needs_review`. No branch. No PR. Nothing to review.

We can't fix this by tightening prompts. "Don't forget to push" is a soft constraint on a stochastic process — it will fail again. The harness must own the git lifecycle; the agent owns the narrative.

## Current State

### The wrapper (`infra/sandbox/service/src/rivet.ts:100-124`)

```bash
mkdir -p /workspace
if [ ! -d /workspace/.git ]; then
  git clone --depth=50 ...
  cp -a ...
fi
cd /workspace
export PATH="$HOME/.agents/shims:$PATH"
(agents pull gh:muqsitnawaz/.agents --yes >/dev/null 2>&1 &)
git config user.name "Prix Cloud Agent"
git config user.email "bot@getrush.ai"
git remote set-url origin "https://x-access-token:...@..." 2>/dev/null || true
exec "$@"   # ← relinquishes control, cannot enforce anything after agent exits
```

No branch created upfront. Agent works on `main`. `exec` replaces the shell with the agent process, so no post-exit hook is possible. Wrapper ends when agent exits — the pod runs out the TTL doing nothing.

### The poller (`infra/sandbox/service/src/router.ts:646-670`)

```typescript
if (proc.status === "exited") {
  const logs = await getProcessLogs(...)
  const gitInfo = extractGitInfo(logs.raw)   // regex over log output
  updateTask(taskId, {
    status: proc.exitCode === 0 ? "needs_review" : "failed",
    branch: gitInfo.branch || current.branch,
    prUrl: gitInfo.prUrl || current.prUrl,
  })
}
```

`extractGitInfo` at `router.ts:627` regex-parses the agent's stdout for branch/PR URLs. If the agent never pushed, both are `undefined` — and the task is still marked `needs_review` because exit code was 0. There is no read-back of repo state from the pod before finalizing.

### Rush CLI side (`halo/proxy/src/cloud-runs.ts`)

Accepts `prompt` from `rush cloud run` verbatim. No injection of delivery requirements. The prompt reaches the agent as-is, with no standard protocol for how "done" is reported.

## Vision

```
┌───────────────────────────┐
│ rush cloud run <prompt>   │
└────────────┬──────────────┘
             │   prompt
             ▼
┌───────────────────────────┐        original prompt
│ halo/proxy/cloud-runs.ts  │  +  DELIVERY PROTOCOL (appended)
└────────────┬──────────────┘
             │   injected prompt
             ▼
┌───────────────────────────┐
│ router.ts (dispatch)      │ ─► allocate pod, call rivet.ts
└────────────┬──────────────┘
             │
             ▼
┌───────────────────────────┐
│ rivet.ts wrapper:         │
│   clone + config          │
│   git checkout -b agent/X │  ← branch upfront
│   "$@"  (agent runs)      │  ← no exec, wrapper retains control
└────────────┬──────────────┘
             │   agent exits
             ▼
┌───────────────────────────┐         dirty OR unpushed?
│ router.ts pollCompletion  │ ──────► yes → spawnFollowup()
│   read git status via pod │ ──────► no  → extract branch/pr, mark needs_review
└────────────┬──────────────┘
             │   followup (resume_count < 1)
             ▼
┌───────────────────────────┐
│ same agent, same pod      │  ← cheap: pod still allocated
│ prompt: "You left work    │
│ uncommitted. Commit, PR,  │  ← agent writes the narrative
│ push, report URL."        │
└───────────────────────────┘
```

The wrapper enforces a branch. The router verifies the repo state after exit. The agent is asked — in its own voice — to finish the job. One resume cap; no infinite loops.

## Changes

### 1. Prompt injection (`halo/proxy/src/cloud-runs.ts`)

Before forwarding the prompt to router dispatch, append:

```
---
DELIVERY PROTOCOL (required): When you finish the work:
  1. Commit with a descriptive message — what changed, why, key decisions.
  2. Open a PR with a rich description — summary, files touched, how it
     was tested, proof where possible (test output, screenshots for UI
     changes, before/after diffs).
  3. Push the branch.
  4. Report the PR URL in your final message.

Your branch is pre-created. Your git remote is pre-authed. You do not
need to set up anything — just commit, push, and open the PR.
```

Every agent sees the same delivery expectation. No per-ticket prompt suffix.

### 2. Wrapper: branch upfront + retain control (`infra/sandbox/service/src/rivet.ts`)

Replace the `exec "$@"` wrapper block. After the existing clone + config:

```bash
# Branch upfront — agent never has to pick a name
BRANCH="agent/${TASK_ID}"
git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"

# Agent runs (no exec — wrapper stays alive)
"$@"
AGENT_EXIT=$?

# Wrapper exits with agent's code; router reads pod git state separately
exit $AGENT_EXIT
```

`TASK_ID` must be passed through as an env var in `startProcess()`'s request body.

### 3. Router: post-exit repo inspection (`infra/sandbox/service/src/router.ts`)

Before `updateTask(... status: needs_review)`, shell out to the pod (still allocated) to read repo state:

```typescript
async function readRepoState(podIp: string): Promise<{dirty: boolean; ahead: number}> {
  const status = await runOnPod(podIp, 'cd /workspace && git status --porcelain')
  const ahead = await runOnPod(podIp, 'cd /workspace && git rev-list --count origin/main..HEAD 2>/dev/null || echo 0')
  return { dirty: status.trim().length > 0, ahead: parseInt(ahead.trim()) || 0 }
}
```

In `pollCompletion`:

```typescript
if (proc.status === "exited" && proc.exitCode === 0) {
  const { dirty, ahead } = await readRepoState(podIp)

  if (dirty || ahead === 0 && !extractGitInfo(logs.raw).prUrl) {
    const resumeCount = current.resumeCount ?? 0
    if (resumeCount >= 1) {
      updateTask(taskId, {
        status: "failed",
        exitCode: 1,
        output: logs.raw + "\n\n[HARNESS] Agent did not commit/push after resume.",
      })
      return
    }

    const statusOutput = await runOnPod(podIp, 'cd /workspace && git status && git diff --stat')
    const followupPrompt = buildResumePrompt(statusOutput)
    await spawnFollowup(podIp, current.agent, followupPrompt)
    updateTask(taskId, { resumeCount: resumeCount + 1 })
    return // continue polling the new process
  }

  // Happy path: dirty=false, ahead>0, PR URL found
  const gitInfo = extractGitInfo(logs.raw)
  updateTask(taskId, {
    status: "needs_review",
    exitCode: proc.exitCode,
    output: logs.raw,
    branch: gitInfo.branch || `agent/${taskId}`,
    prUrl: gitInfo.prUrl,
  })
}
```

### 4. Resume prompt builder

```typescript
function buildResumePrompt(gitStatus: string): string {
  return `
You exited with uncommitted or unpushed changes. Current state:

\`\`\`
${gitStatus}
\`\`\`

Please:
  1. Review what you did.
  2. Commit with a descriptive message — what changed, why, key decisions.
  3. Open a PR with a rich description:
     - Summary of what was built
     - Files touched and why
     - How it was tested (test output, if applicable)
     - Proof where possible (screenshots for UI work; test results for libraries)
  4. Push the branch.
  5. Report the PR URL in your final message.

Your branch is already created. Your git remote is pre-authed. Just commit, push, open the PR.
`.trim()
}
```

### 5. Schema: `resume_count` (`infra/sandbox/service/src/db.ts`)

Add `resume_count INTEGER NOT NULL DEFAULT 0` to the `tasks` table. Migration in the same `ALTER TABLE` block pattern as existing `branch` / `pr_url` migrations at `db.ts:122-130`.

### 6. `spawnFollowup` helper (`infra/sandbox/service/src/rivet.ts`)

```typescript
export async function spawnFollowup(
  podIp: string,
  agent: string,
  prompt: string,
): Promise<{ processId: string }> {
  // Invoke same agent binary in the existing pod with the followup prompt.
  // Pod TTL is still valid; no re-allocation needed.
  // Re-uses the same command shape as startProcess() minus the clone/setup
  // (already done on the first dispatch).
  ...
}
```

Router polls this new process the same way as the first one. On its exit, run the same dirty/ahead check — but since `resumeCount` is now 1, a still-dirty state marks the task failed instead of recursing.

## Files

| Path | Change |
|------|--------|
| `infra/sandbox/service/src/rivet.ts` | Branch upfront, no `exec`, new `spawnFollowup()` |
| `infra/sandbox/service/src/router.ts` | `readRepoState()`, resume logic, `resumeCount` tracking |
| `infra/sandbox/service/src/db.ts` | `resume_count` column + migration |
| `halo/proxy/src/cloud-runs.ts` | Append DELIVERY PROTOCOL to every prompt |

## Acceptance

1. **Dispatch a prompt that doesn't push.** Expect: agent exits, router detects dirty state, spawns followup, agent commits + opens PR + pushes, task marked `needs_review` with `branch=agent/<id>` and `pr_url` populated.

2. **Dispatch a prompt that pushes cleanly.** Expect: no resume, task marked `needs_review` on first exit (same as today, with branch and PR URL set).

3. **Simulate a broken agent that ignores the resume.** Expect: after one resume attempt, task marked `failed` with explanatory output; no infinite loop.

4. **Re-dispatch RUSH-393** (the ticket that lost work). Expect: recovered — pushed branch `agent/RUSH-393`, open PR with rich description generated by the agent.

## Out of Scope

- **Multi-resume (>1).** If one resume doesn't fix it, the agent is broken — escalate to failure, don't loop.
- **Screenshot automation.** Playwright + chromium are already pre-installed; agents handle proof themselves per the delivery protocol.
- **Partial-commit recovery.** If the agent committed some files but left others dirty, treat as dirty and re-prompt to complete.
- **Streaming the followup to the CLI.** The `rush cloud run` SSE stream already relays pod output; the followup's output flows through the same channel with no extra wiring.

## Related

- **Blocker for recovering RUSH-393** (the `agents env` command). The lost work can't be re-dispatched reliably until this lands.
- **Companion to `.agents/plans/cloud-agents.md`.** That plan describes the `agents cloud` CLI surface (client side); this plan describes the harness contract that CLI dispatches rely on (server side).
