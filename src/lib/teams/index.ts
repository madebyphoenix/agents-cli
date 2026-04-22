/**
 * Public library surface for the teams subsystem.
 *
 * Consumers (e.g. @swarmify/agents-mcp) import from '@phnx-labs/agents-cli/teams'
 * to reuse the same agent lifecycle, parsing, summarization, and persistence
 * layer that powers the `agents teams` CLI.
 */

export {
  AgentManager,
  AgentProcess,
  AgentStatus,
  VALID_TASK_TYPES,
  AGENT_COMMANDS,
  computePathLCA,
  checkAllClis,
  checkCliAvailable,
  ensureGeminiPlanMode,
  getAgentsDir,
  resolveMode,
  type TaskType,
  type CloudDispatchFn,
  type CompletionHook,
} from './agents.js';

export { type AgentType } from './parsers.js';
export { normalizeEvents, normalizeEvent, parseEvent } from './parsers.js';

export {
  handleSpawn,
  handleStatus,
  handleStop,
  handleTasks,
  type SpawnResult,
  type AgentStatusDetail,
  type TaskStatusResult,
  type StopResult,
  type TaskInfo,
  type TasksResult,
} from './api.js';

export {
  readConfig,
  resolveAgentsDir,
  resolveBaseDir,
  type EffortLevel,
  type ModelOverrides,
  type ProviderConfig,
  type AgentConfig,
  type SwarmConfig,
  type ReadConfigResult,
} from './persistence.js';

export {
  collapseEvents,
  getToolBreakdown,
  groupAndFlattenEvents,
  summarizeEvents,
  getDelta,
  filterEventsByPriority,
  getLastTool,
  getToolUses,
  getLastMessages,
  getQuickStatus,
  getStatusSummary,
  AgentSummary,
  PRIORITY,
  type QuickStatus,
} from './summarizer.js';

export { extractFileOpsFromBash } from './file_ops.js';
export { debug } from './debug.js';
