export type SessionAgentId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw';

export const SESSION_AGENTS: SessionAgentId[] = ['claude', 'codex', 'gemini', 'opencode', 'openclaw'];

export interface SessionEvent {
  type: 'message' | 'tool_use' | 'tool_result' | 'thinking' | 'error' | 'init' | 'result' | 'usage' | 'attachment';
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
  // Fields for usage events (type === 'usage')
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  // Fields for attachment events (type === 'attachment')
  mediaType?: string;
  sizeBytes?: number;
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
  /** Custom name the user gave the session (e.g. Claude Code /rename). */
  label?: string;
  /** Terms that matched the current search query */
  _matchedTerms?: string[];
  /** BM25 relevance score from the most recent content-index search */
  _bm25Score?: number;
}

export type ViewMode = 'transcript' | 'summary' | 'timeline' | 'trace' | 'json';
