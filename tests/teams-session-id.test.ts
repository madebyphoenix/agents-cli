import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  AgentManager,
  AgentProcess,
  AgentStatus,
  type AgentType,
} from '../src/lib/teams/agents.js';

const FIXTURES = path.resolve(__dirname, 'fixtures/teams');

/**
 * Create an AgentProcess pointing at a temp base dir, seed its stdout.log with
 * the given fixture content, then call readNewEvents() so the in-memory
 * `remoteSessionId` gets populated from the first init-style event.
 */
async function runAgainstFixture(
  agentType: AgentType,
  fixtureName: string,
  baseDir: string
): Promise<AgentProcess> {
  const agentId = randomUUID();
  const agent = new AgentProcess(
    agentId,
    'test-team',
    agentType,
    'irrelevant',
    null,             // cwd
    'plan',           // mode
    null,             // pid
    AgentStatus.RUNNING,
    new Date(),
    null,             // completedAt
    baseDir           // baseDir — keeps the test off real ~/.agents
  );

  const agentDir = await agent.getAgentDir();
  await fs.mkdir(agentDir, { recursive: true });
  const stdoutPath = await agent.getStdoutPath();
  const fixture = await fs.readFile(path.join(FIXTURES, fixtureName), 'utf-8');
  await fs.writeFile(stdoutPath, fixture);

  await agent.readNewEvents();
  return agent;
}

describe('AgentProcess: remoteSessionId extraction', () => {
  let tmpBase: string;

  beforeAll(() => {
    tmpBase = mkdtempSync(path.join(tmpdir(), 'teams-session-id-'));
  });
  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  // These three use real captured sessions from the agents-mcp testdata —
  // byte-for-byte what the actual CLIs emit.
  it('picks up session_id from a real Claude stream-json session', async () => {
    const agent = await runAgainstFixture('claude', 'claude-session.jsonl', tmpBase);
    expect(agent.remoteSessionId).toBe('a4e64f3a-4c59-4796-adb3-1ae2e89facdd');
  });

  it('picks up thread_id (→ session_id) from a real Codex session', async () => {
    // Codex emits {"type":"thread.started","thread_id":"..."} as its first event.
    // The parser maps thread_id → session_id so the extraction hook catches it.
    const agent = await runAgainstFixture('codex', 'codex-session.jsonl', tmpBase);
    expect(agent.remoteSessionId).toBe('019b2dd8-bf15-7420-ae8b-62151c4f8198');
  });

  it('picks up session_id from a real Cursor session', async () => {
    const agent = await runAgainstFixture('cursor', 'cursor-session.jsonl', tmpBase);
    expect(agent.remoteSessionId).toBe('4ef5cf27-f5be-4bc0-bae4-9082783b803a');
  });

  // These two use synthetic fixtures shaped to match what the parsers declare
  // they expect (see src/lib/teams/parsers.ts normalizeGemini / normalizeOpencode).
  // No real live-session fixtures existed in the upstream repo for these agents.
  it('picks up session_id from a Gemini init event (synthetic fixture)', async () => {
    const agent = await runAgainstFixture('gemini', 'gemini-session.jsonl', tmpBase);
    expect(agent.remoteSessionId).toBe('7b9d3c2e-4a1f-4e85-91c2-8f4a6c3d2e1b');
  });

  it('picks up part.sessionID from an OpenCode step_start event (synthetic fixture)', async () => {
    // OpenCode's parser maps part.sessionID (camelCase) → session_id (snake_case).
    const agent = await runAgainstFixture('opencode', 'opencode-session.jsonl', tmpBase);
    expect(agent.remoteSessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('remoteSessionId stays pinned to the FIRST session_id seen', async () => {
    // If the agent for some reason emits a later event with a different
    // session_id (shouldn't happen in practice, but guard against it), we keep
    // the original so identity is stable.
    const agentId = randomUUID();
    const agent = new AgentProcess(
      agentId,
      'test-team',
      'gemini',
      'irrelevant',
      null,
      'plan',
      null,
      AgentStatus.RUNNING,
      new Date(),
      null,
      tmpBase
    );
    const agentDir = await agent.getAgentDir();
    await fs.mkdir(agentDir, { recursive: true });
    const stdoutPath = await agent.getStdoutPath();
    await fs.writeFile(
      stdoutPath,
      [
        '{"type":"init","model":"gemini-3-flash","session_id":"first-session"}',
        '{"type":"init","model":"gemini-3-flash","session_id":"second-session"}',
      ].join('\n') + '\n'
    );
    await agent.readNewEvents();
    expect(agent.remoteSessionId).toBe('first-session');
  });

  it('remoteSessionId stays null if no init event is emitted', async () => {
    // If the log only contains post-init events (e.g. partial truncated file),
    // we should NOT crash and remoteSessionId should stay null.
    const agentId = randomUUID();
    const agent = new AgentProcess(
      agentId,
      'test-team',
      'codex',
      'irrelevant',
      null,
      'plan',
      null,
      AgentStatus.RUNNING,
      new Date(),
      null,
      tmpBase
    );
    const agentDir = await agent.getAgentDir();
    await fs.mkdir(agentDir, { recursive: true });
    const stdoutPath = await agent.getStdoutPath();
    await fs.writeFile(stdoutPath, '{"type":"turn.started"}\n');
    await agent.readNewEvents();
    expect(agent.remoteSessionId).toBeNull();
  });

  // Note: these tests reach into the buildCommand private method to assert the
  // exact shape of the spawned command. This is load-bearing: a regression here
  // means teammates stop inheriting agents-cli-synced config correctly.
  describe('buildCommand', () => {
    it('does NOT pass --settings for Claude (CLAUDE_CONFIG_DIR handles config)', () => {
      const mgr = new AgentManager(50, 10, tmpBase);
      // @ts-expect-error — exercising private method
      const cmd: string[] = mgr.buildCommand('claude', 'hi', 'edit', 'some-model', null, 'session-uuid');
      expect(cmd).not.toContain('--settings');
    });

    it('does pass --session-id for Claude when given (identity pinning)', () => {
      const mgr = new AgentManager(50, 10, tmpBase);
      // @ts-expect-error — private
      const cmd: string[] = mgr.buildCommand('claude', 'hi', 'edit', 'some-model', null, 'the-uuid');
      const idx = cmd.indexOf('--session-id');
      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe('the-uuid');
    });

    it('does pass --add-dir for Claude when cwd is given (directory access)', () => {
      const mgr = new AgentManager(50, 10, tmpBase);
      // @ts-expect-error — private
      const cmd: string[] = mgr.buildCommand('claude', 'hi', 'edit', 'some-model', '/tmp/work', null);
      const idx = cmd.indexOf('--add-dir');
      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe('/tmp/work');
    });

    it('non-Claude agents (Codex) get no --settings / --add-dir / --session-id', () => {
      const mgr = new AgentManager(50, 10, tmpBase);
      // @ts-expect-error — private
      const cmd: string[] = mgr.buildCommand('codex', 'hi', 'edit', 'some-model', '/tmp', 'uuid');
      expect(cmd).not.toContain('--settings');
      expect(cmd).not.toContain('--add-dir');
      expect(cmd).not.toContain('--session-id');
    });
  });

  it('persists remote_session_id through saveMeta / loadFromDisk', async () => {
    const agentId = randomUUID();
    const agent = new AgentProcess(
      agentId,
      'persist-team',
      'codex',
      'irrelevant',
      null,
      'plan',
      null,
      AgentStatus.RUNNING,
      new Date(),
      null,
      tmpBase
    );
    const agentDir = await agent.getAgentDir();
    await fs.mkdir(agentDir, { recursive: true });
    const stdoutPath = await agent.getStdoutPath();
    const fixture = await fs.readFile(path.join(FIXTURES, 'codex-session.jsonl'), 'utf-8');
    await fs.writeFile(stdoutPath, fixture);
    await agent.readNewEvents();
    await agent.saveMeta();

    const reloaded = await AgentProcess.loadFromDisk(agentId, tmpBase);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.remoteSessionId).toBe('019b2dd8-bf15-7420-ae8b-62151c4f8198');
  });
});
