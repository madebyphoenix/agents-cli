export type CloudProviderId = 'rush' | 'codex' | 'factory';

export type CloudTaskStatus =
  | 'queued'
  | 'allocating'
  | 'running'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CloudTask {
  id: string;
  provider: CloudProviderId;
  status: CloudTaskStatus;
  agent?: string;
  prompt: string;
  repo?: string;
  branch?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

export interface CloudEvent {
  type: 'status' | 'output' | 'done' | 'error';
  data: string;
  timestamp?: string;
}

export interface DispatchOptions {
  prompt: string;
  agent?: string;
  repo?: string;
  branch?: string;
  timeout?: string;
  model?: string;
  /** Provider-specific options (e.g., codex env ID, factory computer name). */
  providerOptions?: Record<string, string>;
}

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

export interface CloudProviderConfig {
  rush?: Record<string, string>;
  codex?: { env?: string };
  factory?: { computer?: string };
}

export interface CloudConfig {
  default_provider?: CloudProviderId;
  providers?: CloudProviderConfig;
}
