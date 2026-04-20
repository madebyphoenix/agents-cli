import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
} from './types.js';

const SHIMS_DIR = path.join(os.homedir(), '.agents', 'shims');

/** Map Codex Cloud status strings to our canonical status. */
function mapStatus(s: string): CloudTaskStatus {
  const lower = s.toLowerCase();
  if (lower.includes('queued') || lower.includes('pending')) return 'queued';
  if (lower.includes('running') || lower.includes('in_progress')) return 'running';
  if (lower.includes('completed') || lower.includes('succeeded') || lower.includes('success')) return 'completed';
  if (lower.includes('failed') || lower.includes('error')) return 'failed';
  if (lower.includes('cancelled') || lower.includes('canceled')) return 'cancelled';
  return 'running';
}

function findCodexBinary(): string | null {
  // Check agents-cli shims first
  const shim = path.join(SHIMS_DIR, 'codex');
  if (fs.existsSync(shim)) return shim;

  // Check PATH via which
  try {
    return execFileSync('which', ['codex'], { stdio: 'pipe' }).toString().trim() || null;
  } catch {
    return null;
  }
}

function codexAvailable(): boolean {
  return findCodexBinary() !== null;
}

function runCodex(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const bin = findCodexBinary();
  if (!bin) return Promise.resolve({ stdout: '', stderr: 'codex not found', code: 127 });

  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function parseTaskFromText(text: string): Partial<CloudTask> {
  // Codex cloud list/status output varies. Try JSON first, then parse text.
  try {
    return JSON.parse(text);
  } catch {
    // Parse text output line by line for key: value patterns
    const result: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*(\w[\w\s]*\w)\s*[:=]\s*(.+)\s*$/);
      if (match) {
        result[match[1].toLowerCase().replace(/\s+/g, '_')] = match[2].trim();
      }
    }
    return {
      id: result.id || result.task_id,
      status: result.status ? mapStatus(result.status) : undefined,
      summary: result.summary || result.output,
    };
  }
}

export class CodexCloudProvider implements CloudProvider {
  id = 'codex' as const;
  name = 'Codex Cloud';

  private defaultEnv?: string;

  constructor(config?: { env?: string }) {
    this.defaultEnv = config?.env;
  }

  supports(_options: DispatchOptions): boolean {
    return codexAvailable();
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const env = options.providerOptions?.env ?? this.defaultEnv;
    if (!env) {
      throw new Error('Codex Cloud requires --env <id>. Set a default in ~/.agents/agents.yaml under cloud.providers.codex.env.');
    }

    const args = ['cloud', 'exec', '--env', env];
    if (options.branch) args.push('--branch', options.branch);
    args.push(options.prompt);

    const { stdout, stderr, code } = await runCodex(args);
    if (code !== 0) {
      throw new Error(`codex cloud exec failed: ${stderr || stdout}`);
    }

    // Parse task ID from output. Codex typically prints the task ID.
    const taskId = extractTaskId(stdout) ?? `codex-${Date.now()}`;
    const now = new Date().toISOString();

    return {
      id: taskId,
      provider: 'codex',
      status: 'queued',
      agent: 'codex',
      prompt: options.prompt,
      branch: options.branch,
      createdAt: now,
      updatedAt: now,
    };
  }

  async status(taskId: string): Promise<CloudTask> {
    const { stdout, stderr, code } = await runCodex(['cloud', 'status', taskId]);
    if (code !== 0) {
      throw new Error(`codex cloud status failed: ${stderr || stdout}`);
    }

    const parsed = parseTaskFromText(stdout);
    const now = new Date().toISOString();

    return {
      id: taskId,
      provider: 'codex',
      status: parsed.status ?? 'running',
      agent: 'codex',
      prompt: parsed.prompt ?? '',
      summary: parsed.summary,
      createdAt: parsed.createdAt ?? now,
      updatedAt: now,
    };
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const args = ['cloud', 'list', '--json', '--limit', '20'];
    if (this.defaultEnv) args.push('--env', this.defaultEnv);

    const { stdout, stderr, code } = await runCodex(args);
    if (code !== 0) {
      throw new Error(`codex cloud list failed: ${stderr || stdout}`);
    }

    try {
      const data = JSON.parse(stdout);
      const tasks: CloudTask[] = (data.tasks ?? data ?? []).map((t: Record<string, unknown>) => ({
        id: (t.id || t.task_id) as string,
        provider: 'codex' as const,
        status: mapStatus((t.status as string) ?? ''),
        agent: 'codex',
        prompt: (t.prompt || t.query || '') as string,
        branch: (t.branch as string) || undefined,
        summary: (t.summary as string) || undefined,
        createdAt: (t.created_at as string) || '',
        updatedAt: (t.updated_at as string) || '',
      }));

      if (filter?.status) {
        return tasks.filter((t) => t.status === filter.status);
      }
      return tasks;
    } catch {
      return [];
    }
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    // Codex Cloud doesn't have SSE streaming. Poll status until terminal.
    const terminalStatuses = new Set<CloudTaskStatus>(['completed', 'failed', 'cancelled']);
    let lastStatus = '';

    while (true) {
      try {
        const task = await this.status(taskId);
        if (task.status !== lastStatus) {
          lastStatus = task.status;
          yield {
            type: terminalStatuses.has(task.status) ? 'done' : 'status',
            data: JSON.stringify({ status: task.status, summary: task.summary }),
            timestamp: new Date().toISOString(),
          };
        }
        if (terminalStatuses.has(task.status)) break;
      } catch (err) {
        yield {
          type: 'error',
          data: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        };
        break;
      }

      // Poll every 5 seconds
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  async cancel(_taskId: string): Promise<void> {
    // Codex Cloud doesn't expose a cancel command via CLI.
    throw new Error('Cancel is not supported for Codex Cloud tasks via CLI.');
  }

  async message(_taskId: string, _content: string): Promise<void> {
    throw new Error('Follow-up messages are not supported for Codex Cloud tasks.');
  }
}

function extractTaskId(output: string): string | undefined {
  // Try JSON first
  try {
    const data = JSON.parse(output);
    return data.id || data.task_id;
  } catch {
    // Look for UUID-like patterns or task IDs in the text
    const match = output.match(/(?:task[_\s]?id|id)\s*[:=]\s*["']?([a-zA-Z0-9_-]+)/i)
      || output.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      || output.match(/(task_[a-zA-Z0-9]+)/i);
    return match?.[1];
  }
}
