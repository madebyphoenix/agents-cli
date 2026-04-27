/**
 * Contract tests for the per-agent command builders in src/lib/teams/agents.ts.
 *
 * The critical invariant: a teammate launched with --mode plan MUST receive
 * the read-only / no-write flag for its CLI. If this contract breaks, an
 * audit-only teammate can silently write to the workspace (the codex regression
 * we caught: --sandbox workspace-write on a plan-mode launch).
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_COMMANDS,
  applyEditMode,
  applyFullMode,
} from '../agents.js';
import type { AgentType } from '../parsers.js';

describe('AGENT_COMMANDS (plan mode = read-only)', () => {
  it('codex plan mode launches with --sandbox read-only', () => {
    const cmd = AGENT_COMMANDS.codex;
    const sandboxIndex = cmd.indexOf('--sandbox');
    expect(sandboxIndex).toBeGreaterThanOrEqual(0);
    expect(cmd[sandboxIndex + 1]).toBe('read-only');
    expect(cmd).not.toContain('--full-auto');
    expect(cmd).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(cmd).not.toContain('workspace-write');
    expect(cmd).not.toContain('danger-full-access');
  });

  it('claude plan mode launches with --permission-mode plan', () => {
    const cmd = AGENT_COMMANDS.claude;
    const permIndex = cmd.indexOf('--permission-mode');
    expect(permIndex).toBeGreaterThanOrEqual(0);
    expect(cmd[permIndex + 1]).toBe('plan');
    expect(cmd).not.toContain('acceptEdits');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  it('gemini plan mode launches with --approval-mode plan', () => {
    const cmd = AGENT_COMMANDS.gemini;
    const approvalIndex = cmd.indexOf('--approval-mode');
    expect(approvalIndex).toBeGreaterThanOrEqual(0);
    expect(cmd[approvalIndex + 1]).toBe('plan');
    expect(cmd).not.toContain('--yolo');
  });
});

describe('applyEditMode (writes inside cwd allowed)', () => {
  it('codex: swaps sandbox to workspace-write and adds --full-auto', () => {
    const cmd = applyEditMode('codex', AGENT_COMMANDS.codex);
    const sandboxIndex = cmd.indexOf('--sandbox');
    expect(cmd[sandboxIndex + 1]).toBe('workspace-write');
    expect(cmd).toContain('--full-auto');
    // The read-only literal must be gone — no leftover from plan mode.
    expect(cmd).not.toContain('read-only');
  });

  it('claude: rewrites --permission-mode to acceptEdits', () => {
    const cmd = applyEditMode('claude', AGENT_COMMANDS.claude);
    const permIndex = cmd.indexOf('--permission-mode');
    expect(cmd[permIndex + 1]).toBe('acceptEdits');
    expect(cmd).not.toContain('plan');
  });

  it('gemini: removes --approval-mode plan and adds --yolo', () => {
    const cmd = applyEditMode('gemini', AGENT_COMMANDS.gemini);
    expect(cmd).not.toContain('--approval-mode');
    expect(cmd).toContain('--yolo');
  });

  it('cursor: adds -f', () => {
    const cmd = applyEditMode('cursor', AGENT_COMMANDS.cursor);
    expect(cmd).toContain('-f');
  });
});

describe('applyFullMode (writes + approval gates bypassed)', () => {
  it('codex: workspace-write + --full-auto', () => {
    const cmd = applyFullMode('codex', AGENT_COMMANDS.codex);
    const sandboxIndex = cmd.indexOf('--sandbox');
    expect(cmd[sandboxIndex + 1]).toBe('workspace-write');
    expect(cmd).toContain('--full-auto');
    expect(cmd).not.toContain('read-only');
  });

  it('claude: drops --permission-mode and adds --dangerously-skip-permissions', () => {
    const cmd = applyFullMode('claude', AGENT_COMMANDS.claude);
    expect(cmd).not.toContain('--permission-mode');
    expect(cmd).not.toContain('plan');
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  it('gemini: removes --approval-mode and adds --yolo', () => {
    const cmd = applyFullMode('gemini', AGENT_COMMANDS.gemini);
    expect(cmd).not.toContain('--approval-mode');
    expect(cmd).toContain('--yolo');
  });
});

describe('plan-mode read-only contract (the regression that started this)', () => {
  // Agents whose CLI exposes a true read-only flag. cursor and opencode have
  // no native read-only sandbox, so they're excluded — those gaps should be
  // surfaced separately (see tracking ticket).
  const AGENTS_WITH_READONLY: AgentType[] = ['codex', 'claude', 'gemini'];

  it.each(AGENTS_WITH_READONLY)(
    '%s: plan-mode command does not contain any write-enabling flag',
    (agentType) => {
      const cmd = AGENT_COMMANDS[agentType];
      // Catch every escape hatch we know about.
      const writeFlags = [
        '--full-auto',
        '--yolo',
        '--dangerously-skip-permissions',
        '--dangerously-bypass-approvals-and-sandbox',
        'acceptEdits',
        'workspace-write',
        'danger-full-access',
        'bypassPermissions',
      ];
      for (const flag of writeFlags) {
        expect(cmd).not.toContain(flag);
      }
    },
  );
});
