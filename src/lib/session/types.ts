export type SessionAgentId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw';

export const SESSION_AGENTS: SessionAgentId[] = ['claude', 'codex', 'gemini', 'opencode', 'openclaw'];

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
  /** Internal: marks tool_use events from local commands */
  _local?: boolean;
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
  tokenCount?: number;
  version?: string;
  account?: string;
  topic?: string;
  /** Terms that matched the current search query */
  _matchedTerms?: string[];
  /** BM25 relevance score from the most recent content-index search */
  _bm25Score?: number;
}

export type ViewMode = 'transcript' | 'summary' | 'trace' | 'json';
