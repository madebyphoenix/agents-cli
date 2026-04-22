import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  AgentManager,
  AgentProcess,
  AgentStatus,
  type AgentType,
} from '../agents.js';
import { maybeFileBugfix } from '../oracle.js';

let tmpBase: string;
let mgr: AgentManager;

beforeEach(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-test-'));
  // Use the ctor's agentsDir override so this test never touches ~/.agents.
  mgr = new AgentManager(50, 10, tmpBase);
  // Force init to finish before we start poking the internal state.
  await mgr.listAll();
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/**
 * Register a pre-built agent with the manager by writing its meta.json to
 * disk and calling registerAgent. This bypasses the cli-availability check
 * in spawn(), which is exactly what we want for a unit test.
 */
async function plantAgent(overrides: Partial<{
  agentId: string;
  taskName: string;
  agentType: AgentType;
  prompt: string;
  status: AgentStatus;
  name: string | null;
  after: string[];
  taskType: 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs' | null;
}>): Promise<AgentProcess> {
  const agent = new AgentProcess(
    overrides.agentId ?? `agent-${Math.random().toString(36).slice(2, 10)}`,
    overrides.taskName ?? 'team-1',
    overrides.agentType ?? 'claude',
    overrides.prompt ?? 'prompt',
    null, 'edit', null,
    overrides.status ?? AgentStatus.FAILED,
    new Date(), new Date(),
    tmpBase,
    null, null, null, null, null, null, null,
    overrides.name ?? null,
    overrides.after ?? [],
    'medium', null, null,
    overrides.taskType ?? null
  );
  await agent.saveMeta();
  mgr.registerAgent(agent);
  return agent;
}

describe('test oracle loop', () => {
  it('files a bugfix teammate when a test-type teammate fails', async () => {
    await plantAgent({
      name: 'impl-auth',
      taskType: 'implement',
      status: AgentStatus.COMPLETED,
    });
    const testAgent = await plantAgent({
      name: 'test-auth',
      taskType: 'test',
      status: AgentStatus.FAILED,
      after: ['impl-auth'],
    });

    const bugfixId = await maybeFileBugfix(testAgent, mgr);
    expect(bugfixId).not.toBeNull();

    const all = await mgr.listByTask('team-1');
    const bugfix = all.find((a) => a.taskType === 'bugfix');
    expect(bugfix).toBeDefined();
    expect(bugfix?.name).toBe('bugfix-test-auth');
    expect(bugfix?.after).toContain('test-auth');
    expect(bugfix?.prompt).toContain('test-auth');
    expect(bugfix?.prompt).toContain(testAgent.agentId);
  });

  it('does nothing when the failed teammate is not a test', async () => {
    const impl = await plantAgent({
      name: 'impl-auth',
      taskType: 'implement',
      status: AgentStatus.FAILED,
    });
    const bugfixId = await maybeFileBugfix(impl, mgr);
    expect(bugfixId).toBeNull();
    const all = await mgr.listByTask('team-1');
    expect(all.every((a) => a.taskType !== 'bugfix')).toBe(true);
  });

  it('does nothing when the test passed', async () => {
    const t = await plantAgent({
      name: 'test-auth',
      taskType: 'test',
      status: AgentStatus.COMPLETED,
    });
    const bugfixId = await maybeFileBugfix(t, mgr);
    expect(bugfixId).toBeNull();
  });

  it('deduplicates: running twice does not file two bugfixes', async () => {
    await plantAgent({ name: 'impl', taskType: 'implement', status: AgentStatus.COMPLETED });
    const t = await plantAgent({
      name: 'test',
      taskType: 'test',
      status: AgentStatus.FAILED,
      after: ['impl'],
    });

    const first = await maybeFileBugfix(t, mgr);
    const second = await maybeFileBugfix(t, mgr);
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const bugfixes = (await mgr.listByTask('team-1')).filter((a) => a.taskType === 'bugfix');
    expect(bugfixes.length).toBe(1);
  });
});
