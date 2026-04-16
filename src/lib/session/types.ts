export type SessionAgentId = 'claude' | 'codex' | 'gemini' | 'openclaw';

export const SESSION_AGENTS: SessionAgentId[] = ['claude', 'codex', 'gemini'];
// Note: 'openclaw' is discovered separately via CLI commands, not filesystem scanning

export interface SessionEvent {
  type: 'message' | 'tool_use' | 'tool_result' | 'thinking' | 'error' | 'init' | 'result';
  agent: SessionAgentId;
  timestamp: string;
  role?: 'user' | 'assistant';
  content?: string;
  tool?: string;
  args?: Record<string, any>;
  path?: string;
  command?: string;
  success?: boolean;
  output?: string;
}

export interface SessionMeta {
  id: string;
  shortId: string;
  agent: SessionAgentId;
  timestamp: string;
  project?: string;
  cwd?: string;
  filePath: string;
  gitBranch?: string;
  messageCount?: number;
  version?: string;
  account?: string;
  topic?: string;
}

export type ViewMode = 'transcript' | 'summary' | 'trace' | 'json';
