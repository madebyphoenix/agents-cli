/**
 * Test oracle loop.
 *
 * When a teammate with task_type='test' finishes in a failed state, the oracle
 * automatically enqueues a `bugfix` teammate. The bugfix teammate inherits
 * the same agent type + cwd, reads the test task's diff and test-output from
 * the Ledger, and is wired up with an --after dependency on the failed test.
 *
 * Shipping the loop as a pure function (not baked into AgentManager) keeps
 * the MCP package's copy of agents.ts free of any CLI-only behavior.
 */
import { AgentStatus, type AgentProcess, type AgentManager, VALID_TASK_TYPES } from './agents.js';

/**
 * If `agent` is a test-type teammate that just failed, spawn a bugfix teammate
 * for it. Returns the new teammate's id on success, null when no action was
 * needed or the spawn failed (errors are logged, not thrown — the oracle
 * must never break status polling).
 */
export async function maybeFileBugfix(
  agent: AgentProcess,
  manager: AgentManager
): Promise<string | null> {
  // Only act on freshly-failed tests.
  if (agent.taskType !== 'test') return null;
  if (agent.status !== AgentStatus.FAILED) return null;

  // Deduplicate: if a bugfix for this test already exists, do nothing.
  const siblings = await manager.listByTask(agent.taskName);
  const existingFix = siblings.find(
    (s) =>
      s.taskType === 'bugfix' &&
      s.after.includes(agent.name ?? '__nameless__')
  );
  if (existingFix) return null;

  // Name and prompt for the bugfix teammate. The prompt points explicitly at
  // the failing test's agent_id so the worker can LedgerRead the test-output
  // + diff, rather than re-discovering what broke.
  const testName = agent.name ?? agent.agentId.slice(0, 8);
  const bugfixName = `bugfix-${testName}`;
  const prompt =
    `Tests filed by teammate '${testName}' (agent_id=${agent.agentId}) failed.\n\n` +
    `Read the failure context from the Team Ledger via MCP:\n` +
    `  - LedgerRead(team_id='${agent.taskName}', task_id='${agent.agentId}', kind='test-output')\n` +
    `  - LedgerRead(team_id='${agent.taskName}', task_id='${agent.agentId}', kind='diff')\n` +
    `  - LedgerRead(team_id='${agent.taskName}', task_id='${agent.agentId}', kind='notes')\n\n` +
    `Find the root cause in the implementer's diff, fix it, and re-run the tests. ` +
    `Record what failed and why in notes.md via LedgerNote so the next teammate doesn't ` +
    `re-learn the same dead ends.`;

  if (!(VALID_TASK_TYPES as readonly string[]).includes('bugfix')) {
    // Defensive — should never happen since bugfix is in VALID_TASK_TYPES.
    return null;
  }

  try {
    const bug = await manager.spawn(
      agent.taskName,
      agent.agentType,
      prompt,
      agent.cwd,
      agent.mode,
      agent.effort ?? 'medium',
      agent.parentSessionId,
      agent.workspaceDir,
      agent.version,
      bugfixName,
      agent.name ? [agent.name] : [],
      agent.model,
      agent.envOverrides,
      'bugfix',
      agent.cloudProvider,
      null,               // fresh cloud session — don't re-use the failed test's
      agent.cloudRepo,
      agent.cloudBranch
    );
    console.log(
      `[oracle] ${agent.taskName}: test '${testName}' failed — auto-filed bugfix teammate '${bugfixName}' (${bug.agentId.slice(0, 8)})`
    );
    return bug.agentId;
  } catch (err) {
    console.warn(
      `[oracle] Could not auto-file bugfix for failed test '${testName}':`,
      (err as Error).message
    );
    return null;
  }
}
