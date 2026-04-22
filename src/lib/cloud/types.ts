/**
 * Cloud dispatch type definitions.
 *
 * Defines the provider-agnostic interface that all cloud backends (Rush, Codex,
 * Factory) implement, plus the shared task and event types that flow through
 * the dispatch pipeline.
 */

/** Identifier for a supported cloud dispatch backend. */
export type CloudProviderId = 'rush' | 'codex' | 'factory';

/** Lifecycle state of a cloud-dispatched task. */
export type CloudTaskStatus =
  | 'queued'
  | 'allocating'
  | 'running'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Snapshot of a dispatched task, stored locally and refreshed from the provider. */
export interface CloudTask {
  id: string;
  provider: CloudProviderId;
  status: CloudTaskStatus;
  agent?: string;
  prompt: string;
  /**
   * First (or only) repo the task targets. Kept for back-compat with callers
   * that treat one task as one repo. For multi-repo dispatches, see `repos`.
   */
  repo?: string;
  /**
   * All repos the task targets, in dispatch order. Populated for multi-repo
   * dispatches (Rush Cloud, and any provider that supports it). `repo`
   * mirrors `repos[0]` when both are set.
   */
  repos?: string[];
  branch?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

/** A single event emitted by a running cloud task (status change, output line, completion, or error). */
export interface CloudEvent {
  type: 'status' | 'output' | 'done' | 'error';
  data: string;
  timestamp?: string;
}

/** Parameters for dispatching a new cloud task. */
export interface DispatchOptions {
  prompt: string;
  agent?: string;
  /**
   * Legacy single-repo target. Still honored: if `repos` is empty, this
   * becomes the only repo. Providers that support multi-repo treat
   * `repos = [repo]` and `repo` as equivalent.
   */
  repo?: string;
  /**
   * One or more repos the dispatch targets. Repeatable on the CLI via
   * `--repo`. Providers handle multi-repo differently:
   *   - Rush Cloud clones each into /workspace/<owner>/<name>/
   *   - Codex Cloud rejects (multi-repo requires an env that bundles them)
   *   - Factory (local) clones each into the workspace before dispatch
   */
  repos?: string[];
  branch?: string;
  timeout?: string;
  model?: string;
  /** Provider-specific options (e.g., codex env ID, factory computer name). */
  providerOptions?: Record<string, string>;
}

/**
 * Collapse `repo` + `repos` into a single deduped list. Exported so callers,
 * tests, and every provider share the same resolution — one source of truth
 * for "which repos does this dispatch target?".
 */
export function resolveDispatchRepos(options: DispatchOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  if (options.repos) candidates.push(...options.repos);
  if (options.repo) candidates.push(options.repo);
  for (const raw of candidates) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Contract that every cloud backend must implement.
 *
 * Each provider translates between the unified dispatch interface and its
 * backend-specific API (Rush Factory Floor, Codex Cloud CLI, Droid daemon).
 */
export interface CloudProvider {
  id: CloudProviderId;
  name: string;

  /** Whether the provider is configured and can handle this dispatch. */
  supports(options: DispatchOptions): boolean;

  dispatch(options: DispatchOptions): Promise<CloudTask>;
  status(taskId: string): Promise<CloudTask>;
  list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]>;

  /** Stream live output. Yields events until task completes or caller breaks. */
  stream(taskId: string): AsyncIterable<CloudEvent>;

  cancel(taskId: string): Promise<void>;

  /** Send a follow-up message to a finished/needs_review task. */
  message(taskId: string, content: string): Promise<void>;
}

/** Per-provider configuration stored in the `cloud.providers` section of agents.yaml. */
export interface CloudProviderConfig {
  rush?: Record<string, string>;
  codex?: { env?: string };
  factory?: { computer?: string };
}

/** Top-level `cloud` section of agents.yaml. */
export interface CloudConfig {
  default_provider?: CloudProviderId;
  providers?: CloudProviderConfig;
}
