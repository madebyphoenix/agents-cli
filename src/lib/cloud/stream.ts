/**
 * Server-Sent Events parser and terminal renderer for cloud task output.
 *
 * Used by `agents cloud logs -f` to stream live output from a running task
 * and by the post-dispatch follow mode to show progress inline.
 */

import chalk from 'chalk';
import type { CloudEvent } from './types.js';

/**
 * Parse a Server-Sent Events stream into CloudEvents.
 * Handles `event:`, `data:`, keepalive comments, and multi-line data.
 */
export async function* parseSSE(response: Response): AsyncIterable<CloudEvent> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        // Keepalive comment
        if (line.startsWith(':')) continue;

        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData += (currentData ? '\n' : '') + line.slice(6);
        } else if (line === '') {
          // Empty line = end of event
          if (currentEvent || currentData) {
            yield {
              type: (currentEvent || 'output') as CloudEvent['type'],
              data: currentData,
              timestamp: new Date().toISOString(),
            };
            currentEvent = '';
            currentData = '';
          }
        }
      }
    }

    // Flush remaining
    if (currentEvent || currentData) {
      yield {
        type: (currentEvent || 'output') as CloudEvent['type'],
        data: currentData,
        timestamp: new Date().toISOString(),
      };
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Render a stream of CloudEvents to the terminal.
 * Returns the final status and summary when the stream ends.
 */
export async function renderStream(
  events: AsyncIterable<CloudEvent>,
  options?: { json?: boolean },
): Promise<{ status: string; summary?: string; prUrl?: string }> {
  let lastStatus = 'running';
  let summary: string | undefined;
  let prUrl: string | undefined;

  for await (const event of events) {
    if (options?.json) {
      process.stdout.write(JSON.stringify(event) + '\n');
      continue;
    }

    switch (event.type) {
      case 'status': {
        try {
          const parsed = JSON.parse(event.data);
          lastStatus = parsed.status ?? lastStatus;
          const label = statusLabel(lastStatus);
          process.stderr.write(`${label}\n`);
        } catch {
          process.stderr.write(chalk.dim(`[status] ${event.data}\n`));
        }
        break;
      }
      case 'output': {
        try {
          const parsed = JSON.parse(event.data);
          process.stdout.write(parsed.content ?? event.data);
        } catch {
          process.stdout.write(event.data);
        }
        break;
      }
      case 'done': {
        try {
          const parsed = JSON.parse(event.data);
          lastStatus = parsed.status ?? 'completed';
          summary = parsed.output?.slice(0, 2000);
          prUrl = parsed.prUrl;
        } catch {
          lastStatus = 'completed';
        }
        const label = statusLabel(lastStatus);
        process.stderr.write(`\n${label}\n`);
        break;
      }
      case 'error': {
        process.stderr.write(chalk.red(`Error: ${event.data}\n`));
        lastStatus = 'failed';
        break;
      }
    }
  }

  return { status: lastStatus, summary, prUrl };
}

/** Map a task status string to a colored terminal label. */
function statusLabel(status: string): string {
  switch (status) {
    case 'queued':
    case 'allocating':
      return chalk.blue(`[${status}]`);
    case 'running':
      return chalk.yellow(`[${status}]`);
    case 'completed':
      return chalk.green('[completed]');
    case 'needs_review':
    case 'input_required':
      return chalk.magenta('[needs review]');
    case 'failed':
      return chalk.red('[failed]');
    case 'cancelled':
      return chalk.gray('[cancelled]');
    default:
      return chalk.dim(`[${status}]`);
  }
}
