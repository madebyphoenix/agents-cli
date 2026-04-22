/**
 * Sync hooks between teammate process state (on disk at ~/.agents/teams/) and
 * the team Ledger (LocalDiskLedger by default, R2Ledger in cloud pods).
 *
 * Callers:
 * - `teams add/start` on teammate completion → syncTeammate()
 * - `agents factory evict` (runs in a pod's preStop hook) → syncOnEviction()
 *
 * The sync is deliberately idempotent: safe to run multiple times, safe to
 * run mid-flight (captures whatever's there now). The ledger layout mirrors
 * the on-disk layout so the same data is queryable via MCP tools from any
 * other teammate.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync } from 'child_process';
import { resolveLedger } from './index.js';
import type { LedgerStore, LedgerRegistry } from './types.js';

export interface TeammateSnapshot {
  agent_id: string;
  team_id: string;
  teammate_name: string | null;
  agent_type: string;
  task_type: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  after: string[];
  cloud_provider: string | null;
  cloud_session_id: string | null;
  cloud_repo: string | null;
  cloud_branch: string | null;
  /** Absolute path to the teammate's on-disk agent dir (stdout.log + meta.json). */
  agent_dir: string;
  /** Working dir the agent ran in — used to collect a git diff. */
  cwd: string | null;
}

/**
 * Push a teammate's outputs to the ledger: session transcript, git diff (if
 * any), and a registry update. Test output is written separately via
 * `putArtifact(..., 'test-output', ...)` by the caller that runs the tests.
 */
export async function syncTeammate(
  snap: TeammateSnapshot,
  ledger: LedgerStore = resolveLedger()
): Promise<void> {
  const teammate = snap.teammate_name ?? snap.agent_id.slice(0, 8);

  // 1. Session transcript (replace whole file each sync — simple and correct).
  const stdoutPath = path.join(snap.agent_dir, 'stdout.log');
  const raw = await readSafe(stdoutPath);
  if (raw !== null && raw.length > 0) {
    // Use putArtifact with a custom kind so R2 doesn't need append semantics.
    // For a local ledger this still round-trips cleanly — read() picks it up
    // under artifacts/<task_id>/session.txt.
    await ledger.putArtifact(
      snap.team_id, snap.agent_id, 'session-log', raw, teammate
    );
  }

  // 2. Git diff in the teammate's cwd, if it's a git repo. Best-effort — a
  // missing git binary or a non-repo cwd should not fail the whole sync.
  if (snap.cwd) {
    const diff = safeGitDiff(snap.cwd);
    if (diff) {
      await ledger.putArtifact(snap.team_id, snap.agent_id, 'diff', diff, teammate);
    }
  }

  // 3. Registry upsert — merge this teammate into whatever's already there.
  const existing = await ledger.getRegistry(snap.team_id);
  const entry: LedgerRegistry['teammates'][number] = {
    agent_id: snap.agent_id,
    name: snap.teammate_name,
    agent_type: snap.agent_type,
    task_type: snap.task_type,
    dispatch: snap.cloud_provider
      ? { cloud: snap.cloud_provider, repo: snap.cloud_repo ?? undefined, branch: snap.cloud_branch ?? undefined }
      : 'local',
    after: snap.after,
    status: snap.status,
    started_at: snap.started_at,
    completed_at: snap.completed_at,
  };
  const next: LedgerRegistry = existing
    ? {
        team_id: snap.team_id,
        updated_at: new Date().toISOString(),
        teammates: [
          ...existing.teammates.filter((t) => t.agent_id !== snap.agent_id),
          entry,
        ],
      }
    : {
        team_id: snap.team_id,
        updated_at: new Date().toISOString(),
        teammates: [entry],
      };
  await ledger.putRegistry(next);
}

/**
 * Called from a pod's preStop hook right before SIGTERM. Same as syncTeammate
 * but tolerates a still-running status. The remote orchestrator will re-sync
 * once the workload finishes in its replacement.
 */
export async function syncOnEviction(
  snap: TeammateSnapshot,
  ledger: LedgerStore = resolveLedger()
): Promise<void> {
  await syncTeammate(
    { ...snap, status: snap.status === 'running' ? 'evicted' : snap.status },
    ledger
  );
  const note =
    `Pod evicted at ${new Date().toISOString()} — status=${snap.status}, ` +
    `cloud=${snap.cloud_provider ?? 'local'} session=${snap.cloud_session_id ?? '-'}`;
  await ledger.note(
    snap.team_id,
    snap.agent_id,
    snap.teammate_name ?? snap.agent_id.slice(0, 8),
    note
  );
}

async function readSafe(p: string): Promise<string | null> {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

function safeGitDiff(cwd: string): string | null {
  try {
    const diff = execSync('git diff --no-color HEAD', {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return diff.length > 0 ? diff : null;
  } catch {
    return null;
  }
}
