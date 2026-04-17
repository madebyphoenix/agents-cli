import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { SessionAgentId, SessionEvent } from './types.js';

/**
 * Auto-detect agent type from file path and parse the session.
 */
export function parseSession(filePath: string, agent?: SessionAgentId): SessionEvent[] {
  const detected = agent || detectAgent(filePath);
  if (!detected) {
    throw new Error(`Cannot detect agent type from path: ${filePath}`);
  }

  switch (detected) {
    case 'claude': return parseClaude(filePath);
    case 'codex': return parseCodex(filePath);
    case 'gemini': return parseGemini(filePath);
    case 'opencode': return parseOpenCode(filePath);
    case 'openclaw': return []; // OpenClaw sessions don't have parseable files yet
  }
}

export function detectAgent(filePath: string): SessionAgentId | null {
  if (filePath.includes('/.claude/') || filePath.includes('\\.claude\\')) return 'claude';
  if (filePath.includes('/.codex/') || filePath.includes('\\.codex\\')) return 'codex';
  if (filePath.includes('/.gemini/') || filePath.includes('\\.gemini\\')) return 'gemini';
  if (filePath.includes('opencode.db')) return 'opencode';

  // Try file extension + content heuristic
  if (filePath.endsWith('.json')) return 'gemini';
  return null;
}

/**
 * Summarize a tool_use into a one-liner string.
 */
export function summarizeToolUse(tool: string, args?: Record<string, any>): string {
  if (!args) return tool;

  switch (tool) {
    case 'Bash':
      return `Bash: ${truncate(String(args.command || '').replace(/\n/g, ' ').trim(), 120)}`;
    case 'Read':
      return `Read ${shortenPath(args.file_path || '')}`;
    case 'Write':
      return `Write ${shortenPath(args.file_path || '')}`;
    case 'Edit':
      return `Edit ${shortenPath(args.file_path || '')}`;
    case 'Glob':
      return `Glob ${args.pattern || ''}`;
    case 'Grep':
      return `Grep ${args.pattern || ''} ${args.path || ''}`.trim();
    case 'Agent':
      return `Agent: ${truncate(args.description || args.prompt || '', 80)}`;
    case 'WebSearch':
    case 'WebFetch':
      return `${tool}: ${truncate(args.query || args.url || '', 80)}`;
    // Codex tools
    case 'exec_command':
      return `Bash: ${truncate(String(args.command || args.cmd || '').replace(/\n/g, ' ').trim(), 120)}`;
    case 'read_file':
      return `Read ${shortenPath(args.file_path || args.path || '')}`;
    case 'write_file':
    case 'create_file':
      return `Write ${shortenPath(args.file_path || args.path || '')}`;
    case 'edit_file':
      return `Edit ${shortenPath(args.file_path || args.path || '')}`;
    // Gemini tools
    case 'run_shell_command':
      return `Bash: ${truncate(String(args.command || '').replace(/\n/g, ' ').trim(), 120)}`;
    case 'search_file_content':
      return `Search ${args.pattern || ''}`;
    default: {
      // Generic: show first meaningful arg
      for (const key of ['file_path', 'path', 'pattern', 'command', 'prompt', 'query', 'url']) {
        if (args[key]) return `${tool}: ${truncate(String(args[key]), 80)}`;
      }
      return tool;
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}

function shortenPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

// ---------------------------------------------------------------------------
// Claude parser
// ---------------------------------------------------------------------------

export function parseClaude(filePath: string): SessionEvent[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Map tool_use id -> {tool, args} for correlating with tool_result
  const toolUseMap = new Map<string, { tool: string; args: Record<string, any> }>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    const type = raw.type;
    const timestamp = raw.timestamp || new Date().toISOString();

    if (type === 'assistant') {
      const contentBlocks = raw.message?.content || [];
      for (const block of contentBlocks) {
        if (block.type === 'thinking') {
          // Thinking content -- may be encrypted (has .signature field)
          const thinkingText = block.thinking || '';
          if (thinkingText) {
            events.push({
              type: 'thinking',
              agent: 'claude',
              timestamp,
              content: thinkingText,
            });
          }
        } else if (block.type === 'text') {
          const text = (block.text || '').trim();
          if (text) {
            events.push({
              type: 'message',
              agent: 'claude',
              timestamp,
              role: 'assistant',
              content: text,
            });
          }
        } else if (block.type === 'tool_use') {
          const toolName = block.name || 'unknown';
          const toolInput = block.input || {};
          const toolId = block.id;

          if (toolId) {
            toolUseMap.set(toolId, { tool: toolName, args: toolInput });
          }

          events.push({
            type: 'tool_use',
            agent: 'claude',
            timestamp,
            tool: toolName,
            args: toolInput,
            path: toolInput.file_path || undefined,
            command: toolName === 'Bash' ? toolInput.command : undefined,
          });
        }
      }
    } else if (type === 'user') {
      const contentBlocks = raw.message?.content;

      if (typeof contentBlocks === 'string') {
        // Simple user text
        const text = contentBlocks.trim();
        if (text) {
          events.push({
            type: 'message',
            agent: 'claude',
            timestamp,
            role: 'user',
            content: text,
          });
        }
      } else if (Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
          if (block.type === 'text') {
            const text = (block.text || '').trim();
            if (text && !text.startsWith('[Request interrupted')) {
              events.push({
                type: 'message',
                agent: 'claude',
                timestamp,
                role: 'user',
                content: text,
              });
            }
          } else if (block.type === 'tool_result') {
            const toolId = block.tool_use_id;
            const toolInfo = toolId ? toolUseMap.get(toolId) : undefined;
            const isError = block.is_error === true;

            // Extract output text from tool result
            let output = '';
            if (typeof block.content === 'string') {
              output = block.content;
            } else if (Array.isArray(block.content)) {
              output = block.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text || '')
                .join('\n');
            }

            if (isError) {
              events.push({
                type: 'error',
                agent: 'claude',
                timestamp,
                tool: toolInfo?.tool,
                content: output || 'Tool execution failed',
              });
            } else {
              events.push({
                type: 'tool_result',
                agent: 'claude',
                timestamp,
                tool: toolInfo?.tool,
                success: true,
                output: output.length > 500 ? output.slice(0, 497) + '...' : output,
              });
            }

            if (toolId) toolUseMap.delete(toolId);
          }
        }
      }
    } else if (type === 'result') {
      events.push({
        type: 'result',
        agent: 'claude',
        timestamp,
        content: raw.subtype || 'success',
      });
    }
    // Skip: permission-mode, attachment, and other line types
  }

  return events;
}

// ---------------------------------------------------------------------------
// Codex parser
// ---------------------------------------------------------------------------

export function parseCodex(filePath: string): SessionEvent[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];

  // Track function_call id -> name for correlating with function_call_output
  const callMap = new Map<string, { name: string; args: any }>();

  for (const line of lines) {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }

    const lineType = raw.type;
    const timestamp = raw.timestamp || new Date().toISOString();
    const payload = raw.payload || {};

    if (lineType === 'session_meta') {
      events.push({
        type: 'init',
        agent: 'codex',
        timestamp,
        content: `Codex ${payload.cli_version || ''} session in ${payload.cwd || ''}`.trim(),
      });
      continue;
    }

    if (lineType === 'response_item') {
      const ptype = payload.type;

      if (ptype === 'message') {
        const contentBlocks = payload.content || [];
        const role = payload.role === 'user' || payload.role === 'developer' ? 'user' : 'assistant';

        for (const block of contentBlocks) {
          if (block.type === 'output_text') {
            const text = (block.text || '').trim();
            if (text) {
              events.push({
                type: 'message',
                agent: 'codex',
                timestamp,
                role: 'assistant',
                content: text,
              });
            }
          } else if (block.type === 'input_text') {
            // Developer/user input messages -- only include actual prompts, not system instructions
            const text = (block.text || '').trim();
            if (text && text.length < 2000 && !text.includes('<permissions instructions>')) {
              events.push({
                type: 'message',
                agent: 'codex',
                timestamp,
                role: 'user',
                content: text,
              });
            }
          }
        }
      } else if (ptype === 'function_call') {
        const name = payload.name || 'unknown';
        let args: any = {};
        try {
          args = typeof payload.arguments === 'string'
            ? JSON.parse(payload.arguments)
            : (payload.arguments || {});
        } catch {
          args = { raw: payload.arguments };
        }

        const callId = payload.call_id || payload.id;
        if (callId) {
          callMap.set(callId, { name, args });
        }

        events.push({
          type: 'tool_use',
          agent: 'codex',
          timestamp,
          tool: name,
          args,
          command: name === 'exec_command' ? (args.command || args.cmd) : undefined,
          path: args.file_path || args.path || undefined,
        });
      } else if (ptype === 'function_call_output') {
        const callId = payload.call_id || payload.id;
        const callInfo = callId ? callMap.get(callId) : undefined;
        const output = String(payload.output || '');

        events.push({
          type: 'tool_result',
          agent: 'codex',
          timestamp,
          tool: callInfo?.name,
          success: true,
          output: output.length > 500 ? output.slice(0, 497) + '...' : output,
        });

        if (callId) callMap.delete(callId);
      } else if (ptype === 'reasoning') {
        // Codex reasoning -- try to get the readable summary
        const summaries = payload.summary || [];
        const text = summaries.length > 0
          ? summaries.map((s: any) => s.text || '').join('\n')
          : (payload.text || '');
        if (text.trim()) {
          events.push({
            type: 'thinking',
            agent: 'codex',
            timestamp,
            content: text.trim(),
          });
        }
      }
    }
    // Skip: event_msg (token_count, etc.), turn_context
  }

  return events;
}

// ---------------------------------------------------------------------------
// Gemini parser
// ---------------------------------------------------------------------------

export function parseGemini(filePath: string): SessionEvent[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  let session: any;
  try {
    session = JSON.parse(content);
  } catch {
    throw new Error(`Failed to parse Gemini session: ${filePath}`);
  }

  const messages = session.messages || [];
  const events: SessionEvent[] = [];

  events.push({
    type: 'init',
    agent: 'gemini',
    timestamp: session.startTime || new Date().toISOString(),
    content: `Gemini session ${session.sessionId || ''}`.trim(),
  });

  for (const msg of messages) {
    const timestamp = msg.timestamp || session.startTime || new Date().toISOString();

    if (msg.type === 'user') {
      const text = extractGeminiContent(msg.content);
      if (text) {
        events.push({
          type: 'message',
          agent: 'gemini',
          timestamp,
          role: 'user',
          content: text,
        });
      }
    } else if (msg.type === 'gemini') {
      // Reasoning thoughts
      if (Array.isArray(msg.thoughts)) {
        for (const thought of msg.thoughts) {
          const text = thought.description || thought.subject || '';
          if (text.trim()) {
            const subject = thought.subject ? `**${thought.subject}**: ` : '';
            events.push({
              type: 'thinking',
              agent: 'gemini',
              timestamp: thought.timestamp || timestamp,
              content: `${subject}${thought.description || ''}`.trim(),
            });
          }
        }
      }

      // Assistant text
      const text = extractGeminiContent(msg.content);
      if (text) {
        events.push({
          type: 'message',
          agent: 'gemini',
          timestamp,
          role: 'assistant',
          content: text,
        });
      }

      // Tool calls (Gemini inlines call + result on the same message)
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const toolName = tc.name || 'unknown';
          const args = tc.args || {};

          events.push({
            type: 'tool_use',
            agent: 'gemini',
            timestamp: tc.timestamp || timestamp,
            tool: toolName,
            args,
            command: ['run_shell_command', 'shell', 'bash'].includes(toolName) ? args.command : undefined,
            path: args.file_path || args.path || undefined,
          });

          // Inline result
          if (tc.result || tc.status) {
            let output = '';
            if (Array.isArray(tc.result)) {
              for (const r of tc.result) {
                const resp = r?.functionResponse?.response;
                if (resp?.output) {
                  output += String(resp.output);
                }
              }
            } else if (typeof tc.result === 'string') {
              output = tc.result;
            }

            events.push({
              type: 'tool_result',
              agent: 'gemini',
              timestamp: tc.timestamp || timestamp,
              tool: toolName,
              success: tc.status === 'success',
              output: output.length > 500 ? output.slice(0, 497) + '...' : output,
            });
          }
        }
      }
    }
  }

  return events;
}

/**
 * Extract text content from Gemini's content field,
 * which can be a string or an array of {text: string} parts.
 */
function extractGeminiContent(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// OpenCode parser
// ---------------------------------------------------------------------------

/**
 * Parse an OpenCode session from its SQLite database.
 * filePath format: "/path/to/opencode.db#session_id"
 *
 * Data model: session -> message -> part
 * Messages have role (user/assistant) and metadata.
 * Parts contain the actual content: text, tool, reasoning, patch, step-start/finish.
 */
export function parseOpenCode(filePath: string): SessionEvent[] {
  const [dbPath, sessionId] = filePath.split('#');
  if (!dbPath || !sessionId) return [];

  const events: SessionEvent[] = [];

  try {
    // Query messages with their parts, ordered chronologically.
    // Each row: msg_role ||| part_type ||| part_data (truncated for tool output) ||| msg_time
    const query = `
      SELECT
        json_extract(m.data, '$.role'),
        json_extract(p.data, '$.type'),
        CASE
          WHEN json_extract(p.data, '$.type') = 'tool'
          THEN substr(p.data, 1, 2000)
          ELSE p.data
        END,
        m.time_created
      FROM message m
      JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
      WHERE m.session_id = '${sessionId.replace(/'/g, "''")}'
      ORDER BY m.time_created ASC, p.time_created ASC;
    `.replace(/\n/g, ' ');

    const out = execSync(
      `sqlite3 -separator '|||' "${dbPath}"`,
      { encoding: 'utf-8', input: query, stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 },
    );

    for (const line of out.split('\n')) {
      if (!line.trim()) continue;

      const sepIdx1 = line.indexOf('|||');
      if (sepIdx1 === -1) continue;
      const sepIdx2 = line.indexOf('|||', sepIdx1 + 3);
      if (sepIdx2 === -1) continue;
      const sepIdx3 = line.lastIndexOf('|||');

      const role = line.slice(0, sepIdx1);
      const partType = line.slice(sepIdx1 + 3, sepIdx2);
      const partDataStr = line.slice(sepIdx2 + 3, sepIdx3);
      const timeStr = line.slice(sepIdx3 + 3);

      const timeMs = parseInt(timeStr, 10);
      const timestamp = isNaN(timeMs) ? new Date().toISOString() : new Date(timeMs).toISOString();

      let partData: any;
      try {
        partData = JSON.parse(partDataStr);
      } catch {
        continue;
      }

      switch (partType) {
        case 'text': {
          const text = (partData.text || '').trim();
          if (text) {
            events.push({
              type: 'message',
              agent: 'opencode',
              timestamp,
              role: role === 'user' ? 'user' : 'assistant',
              content: text,
            });
          }
          break;
        }
        case 'reasoning': {
          const text = (partData.text || '').trim();
          if (text) {
            events.push({
              type: 'thinking',
              agent: 'opencode',
              timestamp,
              content: text,
            });
          }
          break;
        }
        case 'tool': {
          const toolName = partData.tool || 'unknown';
          const state = partData.state || {};
          const input = state.input || {};
          const output = state.output || '';

          events.push({
            type: 'tool_use',
            agent: 'opencode',
            timestamp,
            tool: toolName,
            args: input,
            command: toolName === 'shell' ? input.command : undefined,
            path: input.filePath || input.path || undefined,
          });

          if (state.status === 'completed' || state.status === 'error') {
            const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
            events.push({
              type: state.status === 'error' ? 'error' : 'tool_result',
              agent: 'opencode',
              timestamp,
              tool: toolName,
              success: state.status === 'completed',
              output: outputStr.length > 500 ? outputStr.slice(0, 497) + '...' : outputStr,
            });
          }
          break;
        }
        // Skip step-start, step-finish, patch, file — not needed for transcript/trace
      }
    }
  } catch {
    // DB not accessible or query failed
  }

  return events;
}
