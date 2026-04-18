import type { SessionEvent } from './types.js';
import { summarizeToolUse } from './parse.js';
import { cleanSessionPrompt, extractSessionTopic } from './prompt.js';

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
 * Render session as a markdown activity summary.
 * Groups files by directory, shows commands in a code block,
 * and gives the final message room to breathe.
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
        const topic = extractSessionTopic(event.content || '');
        if (topic) {
          firstUserMessage = event.content || '';
        }
      }
      if (event.role === 'assistant' && event.content) {
        lastAssistantMessage = event.content;
      }
    } else if (event.type === 'tool_use') {
      const tool = event.tool || '';
      const p = event.path || event.args?.file_path || event.args?.path || '';

      if (['Read', 'read_file', 'view_file', 'cat_file', 'get_file'].includes(tool)) {
        if (p) filesRead.add(p);
      } else if (['Write', 'Edit', 'write_file', 'edit_file', 'create_file', 'replace', 'patch'].includes(tool)) {
        if (p) filesModified.add(p);
      }

      if (event.command) {
        const cmd = event.command.replace(/\n/g, ' ').trim();
        if (cmd) commands.push(cmd.length <= 80 ? cmd : cmd.slice(0, 77) + '...');
      }
    }
  }

  const md: string[] = [];

  // Prompt -- clean up agent preambles, show the human-written part
  if (firstUserMessage) {
    const cleaned = cleanSessionPrompt(firstUserMessage);
    if (cleaned) {
      const promptText = cleaned.length > 300 ? cleaned.slice(0, 297) + '...' : cleaned;
      md.push(`**Prompt:** ${promptText.split('\n')[0]}`);
      const secondLine = promptText.split('\n')[1]?.trim();
      if (secondLine) md.push(secondLine);
      md.push('');
    }
  }

  const hasActivity = filesModified.size > 0 || filesRead.size > 0 || commands.length > 0;

  // Files modified (most important -- what changed)
  if (filesModified.size > 0) {
    md.push(`**Modified** (${filesModified.size})`);
    const grouped = groupByDirectory(filesModified);
    formatFileGroups(md, grouped);
    md.push('');
  }

  // Files read -- compact, just show count + dirs
  if (filesRead.size > 0) {
    if (filesRead.size <= 5) {
      md.push(`**Read** (${filesRead.size})`);
      const grouped = groupByDirectory(filesRead);
      formatFileGroups(md, grouped);
    } else {
      // For many files, just list the directories
      const grouped = groupByDirectory(filesRead);
      const dirList = Array.from(grouped.keys()).map(d => `\`${d}/\``).join(', ');
      md.push(`**Read** ${filesRead.size} files across ${dirList}`);
    }
    md.push('');
  }

  // Commands -- compact code block
  if (commands.length > 0) {
    md.push(`**Commands** (${commands.length})`);
    md.push('```');
    const shown = commands.slice(0, 10);
    for (const cmd of shown) md.push(cmd);
    if (commands.length > 10) md.push(`# ... +${commands.length - 10} more`);
    md.push('```');
    md.push('');
  }

  // Final message -- the most important part
  if (lastAssistantMessage) {
    if (hasActivity) md.push('---');
    md.push('');
    const truncated = lastAssistantMessage.length > 600
      ? lastAssistantMessage.slice(0, 597) + '...'
      : lastAssistantMessage;
    md.push(truncated);
    md.push('');
  } else if (!hasActivity) {
    md.push('*No activity recorded in this session.*');
    md.push('');
  }

  return md.join('\n');
}

function formatFileGroups(md: string[], grouped: Map<string, string[]>): void {
  if (grouped.size === 1) {
    // Single directory -- inline list
    const [dir, files] = Array.from(grouped.entries())[0];
    for (const f of files) md.push(`- \`${dir}/${f}\``);
  } else {
    // Multiple directories -- group with bold headers
    grouped.forEach((files, dir) => {
      md.push(`  **${dir}/** ${files.map(f => '\`' + f + '\`').join(', ')}`);
    });
  }
}

/**
 * Group file paths by their parent directory.
 * Returns Map<shortDir, basename[]> sorted by most files first.
 */
function groupByDirectory(paths: Set<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const home = process.env.HOME || '';

  paths.forEach(p => {
    // Find a meaningful short directory name
    const dir = extractShortDir(p, home);
    const basename = p.split('/').pop() || p;
    const existing = groups.get(dir) || [];
    existing.push(basename);
    groups.set(dir, existing);
  });

  // Sort by count descending
  const sorted = new Map(
    Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length)
  );

  return sorted;
}

/**
 * Extract a short, meaningful directory label from a full path.
 * Uses the session's cwd (project root) to strip the prefix, falling back
 * to heuristics if cwd isn't available.
 *
 * /Users/me/src/github.com/user/project/src/lib/session/types.ts
 *  with cwd=/Users/me/src/github.com/user/project -> src/lib/session
 */
function extractShortDir(fullPath: string, home: string): string {
  let p = fullPath;

  // Strip home prefix
  if (home && p.startsWith(home + '/')) p = p.slice(home.length + 1);

  const parts = p.split('/');
  parts.pop(); // remove filename

  // Walk from the end to find a code-structure directory (src/, lib/, tests/, etc.)
  // Skip the outermost 'src' if it's a Go-style path (src/github.com/...)
  const codeMarkers = new Set(['src', 'lib', 'tests', 'test', 'cmd', 'pkg', 'internal', 'app', 'components', 'scripts']);

  for (let i = parts.length - 1; i >= 0; i--) {
    if (!codeMarkers.has(parts[i])) continue;
    // Skip if next segment looks like a domain (github.com, golang.org, etc.)
    if (i + 1 < parts.length && parts[i + 1].includes('.')) continue;
    return parts.slice(i).join('/');
  }

  // No code marker found -- show just the last dir (project name)
  return parts.length > 0 ? parts[parts.length - 1] : '.';
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
