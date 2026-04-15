import type { SessionEvent } from './types.js';
import { summarizeToolUse } from './parse.js';

/**
 * Render session as a conversation transcript.
 * Shows user messages, assistant text, and tool calls as one-liners.
 */
export function renderTranscript(events: SessionEvent[]): string {
  const lines: string[] = [];
  let lastRole: string | null = null;

  for (const event of events) {
    if (event.type === 'message') {
      // Add separator between turns
      if (lastRole && lastRole !== event.role) {
        lines.push('');
      }

      if (event.role === 'user') {
        lines.push(`> ${event.content}`);
        lines.push('');
      } else {
        lines.push(event.content || '');
      }
      lastRole = event.role || null;
    } else if (event.type === 'tool_use') {
      const summary = summarizeToolUse(event.tool || 'unknown', event.args);
      lines.push(`  [${summary}]`);
      lastRole = 'tool';
    } else if (event.type === 'error') {
      lines.push(`  [ERROR: ${event.content || event.tool || 'unknown'}]`);
      lastRole = 'error';
    }
    // Skip: thinking, tool_result, init, result (too noisy for transcript)
  }

  return lines.join('\n');
}

/**
 * Render session as an activity summary (fingerprint).
 * Shows files touched, commands run, and the final message.
 */
export function renderSummary(events: SessionEvent[]): string {
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  const commands: string[] = [];
  let firstUserMessage = '';
  let lastAssistantMessage = '';

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user' && !firstUserMessage) {
        firstUserMessage = event.content || '';
      }
      if (event.role === 'assistant' && event.content) {
        lastAssistantMessage = event.content;
      }
    } else if (event.type === 'tool_use') {
      const tool = event.tool || '';
      const p = event.path || event.args?.file_path || event.args?.path || '';

      // Classify file operations
      if (['Read', 'read_file', 'view_file', 'cat_file', 'get_file'].includes(tool)) {
        if (p) filesRead.add(shortenPath(p));
      } else if (['Write', 'Edit', 'write_file', 'edit_file', 'create_file', 'replace', 'patch'].includes(tool)) {
        if (p) filesModified.add(shortenPath(p));
      }

      // Collect commands
      if (event.command) {
        const cmd = event.command.replace(/\n/g, ' ').trim();
        if (cmd.length <= 120) {
          commands.push(cmd);
        } else {
          commands.push(cmd.slice(0, 117) + '...');
        }
      }
    }
  }

  const sections: string[] = [];

  if (firstUserMessage) {
    const truncated = firstUserMessage.length > 200
      ? firstUserMessage.slice(0, 197) + '...'
      : firstUserMessage;
    sections.push(`Prompt: ${truncated}`);
  }

  if (filesRead.size > 0) {
    sections.push(`\nFiles read: ${filesRead.size}`);
    for (const f of filesRead) {
      sections.push(`  ${f}`);
    }
  }

  if (filesModified.size > 0) {
    sections.push(`\nFiles modified: ${filesModified.size}`);
    for (const f of filesModified) {
      sections.push(`  ${f}`);
    }
  }

  if (commands.length > 0) {
    sections.push(`\nCommands: ${commands.length}`);
    for (const cmd of commands) {
      sections.push(`  ${cmd}`);
    }
  }

  if (lastAssistantMessage) {
    const truncated = lastAssistantMessage.length > 300
      ? lastAssistantMessage.slice(0, 297) + '...'
      : lastAssistantMessage;
    sections.push(`\nFinal message:\n${truncated}`);
  }

  return sections.join('\n');
}

/**
 * Render session as a markdown trace (for GitHub gist uploads).
 * Structure: Agent Reasoning section + Full Conversation section.
 */
export function renderTrace(events: SessionEvent[]): string {
  const reasoning: string[] = [];
  const conversation: string[] = [];

  for (const event of events) {
    if (event.type === 'thinking' && event.content) {
      reasoning.push(event.content);
    }

    if (event.type === 'message') {
      if (event.role === 'user') {
        conversation.push(`## User\n\n${event.content}`);
      } else if (event.role === 'assistant' && event.content) {
        conversation.push(`## Agent\n\n${event.content}`);
      }
    } else if (event.type === 'tool_use') {
      const tool = event.tool || 'unknown';
      if (event.command) {
        conversation.push(`## Tool: ${tool}\n\n\`\`\`bash\n${event.command}\n\`\`\``);
      } else if (event.path) {
        conversation.push(`## Tool: ${tool}\n\n\`${shortenPath(event.path)}\``);
      } else {
        const summary = summarizeToolUse(tool, event.args);
        conversation.push(`## Tool: ${tool}\n\n${summary}`);
      }
    } else if (event.type === 'error') {
      conversation.push(`## Error\n\n${event.content || 'Unknown error'}`);
    }
  }

  const parts: string[] = [];

  if (reasoning.length > 0) {
    parts.push('# Agent Reasoning\n');
    parts.push(reasoning.join('\n\n---\n\n'));
  }

  parts.push('\n\n# Full Conversation\n');
  parts.push(conversation.join('\n\n'));

  return parts.join('\n');
}

/**
 * Render session as JSON (normalized events).
 */
export function renderJson(events: SessionEvent[]): string {
  return JSON.stringify(events, null, 2);
}

function shortenPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}
