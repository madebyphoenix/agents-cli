import { describe, it, expect } from 'vitest';
import {
  buildExecCommand,
  buildExecEnv,
  AGENT_COMMANDS,
  EFFORT_MODELS,
  parseExecEnv,
  type ExecOptions,
  type ExecMode,
} from '../exec.js';
import type { AgentId } from '../types.js';

function opts(overrides: Partial<ExecOptions>): ExecOptions {
  return {
    agent: 'claude',
    prompt: 'do the thing',
    mode: 'plan',
    effort: 'default',
    ...overrides,
  };
}

const ALL_AGENTS = Object.keys(AGENT_COMMANDS) as AgentId[];
const ALL_MODES: ExecMode[] = ['plan', 'edit', 'full'];

describe('buildExecCommand', () => {
  // --- Mode flags per agent ---

  describe('mode flags', () => {
    it('claude plan produces --permission-mode plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'plan' }));
      expect(cmd).toContain('--permission-mode');
      expect(cmd[cmd.indexOf('--permission-mode') + 1]).toBe('plan');
    });

    it('claude edit produces --permission-mode acceptEdits', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'edit' }));
      expect(cmd).toContain('--permission-mode');
      expect(cmd[cmd.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    });

    it('claude full produces --dangerously-skip-permissions', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'full' }));
      expect(cmd).toContain('--dangerously-skip-permissions');
      expect(cmd).not.toContain('--permission-mode');
    });

    it('codex plan produces --sandbox workspace-write', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'plan' }));
      expect(cmd).toContain('--sandbox');
      expect(cmd[cmd.indexOf('--sandbox') + 1]).toBe('workspace-write');
      expect(cmd).not.toContain('--full-auto');
    });

    it('codex edit produces --sandbox workspace-write --full-auto', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'edit' }));
      expect(cmd).toContain('--sandbox');
      expect(cmd).toContain('--full-auto');
    });

    it('codex full produces --full-auto without --sandbox', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', mode: 'full' }));
      expect(cmd).toContain('--full-auto');
      expect(cmd).not.toContain('--sandbox');
    });

    it('gemini plan has no mode flags', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', mode: 'plan' }));
      expect(cmd).not.toContain('--yolo');
    });

    it('gemini edit produces --yolo', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', mode: 'edit' }));
      expect(cmd).toContain('--yolo');
    });

    it('gemini full produces --yolo', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', mode: 'full' }));
      expect(cmd).toContain('--yolo');
    });

    it('cursor plan has no mode flags', () => {
      const cmd = buildExecCommand(opts({ agent: 'cursor', mode: 'plan' }));
      expect(cmd).not.toContain('-f');
    });

    it('cursor edit produces -f', () => {
      const cmd = buildExecCommand(opts({ agent: 'cursor', mode: 'edit' }));
      expect(cmd).toContain('-f');
    });

    it('cursor full produces -f', () => {
      const cmd = buildExecCommand(opts({ agent: 'cursor', mode: 'full' }));
      expect(cmd).toContain('-f');
    });

    it('opencode plan produces --agent plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'opencode', mode: 'plan' }));
      expect(cmd).toContain('--agent');
      expect(cmd[cmd.indexOf('--agent') + 1]).toBe('plan');
    });

    it('opencode edit produces --agent build', () => {
      const cmd = buildExecCommand(opts({ agent: 'opencode', mode: 'edit' }));
      expect(cmd[cmd.indexOf('--agent') + 1]).toBe('build');
    });

    it('opencode full produces --agent build', () => {
      const cmd = buildExecCommand(opts({ agent: 'opencode', mode: 'full' }));
      expect(cmd[cmd.indexOf('--agent') + 1]).toBe('build');
    });

    it('openclaw plan produces --mode plan', () => {
      const cmd = buildExecCommand(opts({ agent: 'openclaw', mode: 'plan' }));
      expect(cmd).toContain('--mode');
      expect(cmd[cmd.indexOf('--mode') + 1]).toBe('plan');
    });

    it('openclaw edit produces --mode edit', () => {
      const cmd = buildExecCommand(opts({ agent: 'openclaw', mode: 'edit' }));
      expect(cmd[cmd.indexOf('--mode') + 1]).toBe('edit');
    });

    it('openclaw full produces --mode full', () => {
      const cmd = buildExecCommand(opts({ agent: 'openclaw', mode: 'full' }));
      expect(cmd[cmd.indexOf('--mode') + 1]).toBe('full');
    });

    it('every agent has all three mode entries', () => {
      for (const agent of ALL_AGENTS) {
        const template = AGENT_COMMANDS[agent];
        for (const mode of ALL_MODES) {
          expect(template.modeFlags[mode]).toBeDefined();
          expect(Array.isArray(template.modeFlags[mode])).toBe(true);
        }
      }
    });
  });

  // --- Print / headless ---

  describe('print/headless flags', () => {
    it('claude headless adds --print', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', headless: true }));
      expect(cmd).toContain('--print');
    });

    it('claude headless=false omits --print', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', headless: false }));
      expect(cmd).not.toContain('--print');
    });

    it('codex headless adds nothing (no printFlags)', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', headless: true }));
      expect(cmd).not.toContain('--print');
    });

    it('gemini headless adds nothing', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', headless: true }));
      expect(cmd).not.toContain('--print');
    });
  });

  // --- Session ID ---

  describe('session ID', () => {
    it('claude with sessionId adds --session-id', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', sessionId: 'abc-123' }));
      const idx = cmd.indexOf('--session-id');
      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe('abc-123');
    });

    it('codex ignores sessionId', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', sessionId: 'abc-123' }));
      expect(cmd).not.toContain('--session-id');
    });

    it('gemini ignores sessionId', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', sessionId: 'abc-123' }));
      expect(cmd).not.toContain('--session-id');
    });

    it('omits --session-id when not provided', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude' }));
      expect(cmd).not.toContain('--session-id');
    });
  });

  // --- Verbose ---

  describe('verbose flag', () => {
    it('claude verbose adds --verbose', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', verbose: true }));
      expect(cmd).toContain('--verbose');
    });

    it('claude verbose + json does not duplicate --verbose', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', verbose: true, json: true }));
      const count = cmd.filter((f) => f === '--verbose').length;
      expect(count).toBe(1);
    });

    it('codex verbose adds nothing (no verboseFlag)', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', verbose: true }));
      expect(cmd).not.toContain('--verbose');
    });

    it('claude json without verbose still includes --verbose from jsonFlags', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', json: true, verbose: false }));
      expect(cmd).toContain('--verbose');
    });
  });

  // --- JSON flags ---

  describe('JSON flags', () => {
    it('claude json adds --output-format stream-json --verbose', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', json: true }));
      expect(cmd).toContain('--output-format');
      expect(cmd).toContain('stream-json');
      expect(cmd).toContain('--verbose');
    });

    it('codex json adds --json', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', json: true }));
      expect(cmd).toContain('--json');
    });

    it('json=false adds no json flags', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', json: false }));
      expect(cmd).not.toContain('--output-format');
      expect(cmd).not.toContain('stream-json');
    });
  });

  // --- Model selection ---

  describe('model selection', () => {
    it('explicit model overrides effort mapping', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', model: 'custom-model', effort: 'fast' }));
      expect(cmd).toContain('--model');
      expect(cmd[cmd.indexOf('--model') + 1]).toBe('custom-model');
    });

    it('effort fast maps to correct claude model', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', effort: 'fast' }));
      expect(cmd[cmd.indexOf('--model') + 1]).toBe(EFFORT_MODELS.claude.fast);
    });

    it('effort detailed maps to correct claude model', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', effort: 'detailed' }));
      expect(cmd[cmd.indexOf('--model') + 1]).toBe(EFFORT_MODELS.claude.detailed);
    });

    it('effort default maps to correct codex model', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', effort: 'default' }));
      expect(cmd[cmd.indexOf('--model') + 1]).toBe(EFFORT_MODELS.codex.default);
    });
  });

  // --- Prompt positioning ---

  describe('prompt positioning', () => {
    it('claude uses -p flag for prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', prompt: 'hello world' }));
      const idx = cmd.indexOf('-p');
      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe('hello world');
    });

    it('codex uses positional prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', prompt: 'hello world' }));
      expect(cmd).not.toContain('-p');
      expect(cmd).toContain('hello world');
    });

    it('gemini uses positional prompt', () => {
      const cmd = buildExecCommand(opts({ agent: 'gemini', prompt: 'hello world' }));
      expect(cmd).not.toContain('-p');
      expect(cmd).toContain('hello world');
    });
  });

  // --- Add dirs ---

  describe('add dirs', () => {
    it('claude addDirs adds --add-dir for each directory', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', addDirs: ['/a', '/b'] }));
      const indices = cmd.reduce<number[]>((acc, v, i) => (v === '--add-dir' ? [...acc, i] : acc), []);
      expect(indices).toHaveLength(2);
      expect(cmd[indices[0] + 1]).toBe('/a');
      expect(cmd[indices[1] + 1]).toBe('/b');
    });

    it('codex ignores addDirs', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', addDirs: ['/a'] }));
      expect(cmd).not.toContain('--add-dir');
    });
  });

  describe('exec env', () => {
    it('parses repeated KEY=VALUE entries', () => {
      expect(parseExecEnv(['ANTHROPIC_BASE_URL=https://ollama.example.com', 'ANTHROPIC_MODEL=qwen3.6:35b'])).toEqual({
        ANTHROPIC_BASE_URL: 'https://ollama.example.com',
        ANTHROPIC_MODEL: 'qwen3.6:35b',
      });
    });

    it('preserves equals signs in values', () => {
      expect(parseExecEnv(['AUTH_HEADER=Bearer abc=123'])).toEqual({
        AUTH_HEADER: 'Bearer abc=123',
      });
    });

    it('rejects malformed entries', () => {
      expect(() => parseExecEnv(['NOT_VALID'])).toThrow('Invalid --env value "NOT_VALID". Use KEY=VALUE.');
    });

    it('merges explicit env over process env', () => {
      const previous = process.env.ANTHROPIC_MODEL;
      process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5';

      try {
        const env = buildExecEnv(opts({ env: { ANTHROPIC_MODEL: 'qwen3.6:35b', ANTHROPIC_BASE_URL: 'https://ollama.example.com' } }));
        expect(env.ANTHROPIC_MODEL).toBe('qwen3.6:35b');
        expect(env.ANTHROPIC_BASE_URL).toBe('https://ollama.example.com');
      } finally {
        if (previous === undefined) {
          delete process.env.ANTHROPIC_MODEL;
        } else {
          process.env.ANTHROPIC_MODEL = previous;
        }
      }
    });

    it('injects Claude config dir for pinned Claude versions', () => {
      const env = buildExecEnv(opts({ agent: 'claude', version: '2.1.98' }));
      expect(env.CLAUDE_CONFIG_DIR).toBe(
        `${process.env.HOME}/.agents/versions/claude/2.1.98/home/.claude`
      );
    });

    it('lets explicit env override injected Claude config dir', () => {
      const env = buildExecEnv(opts({
        agent: 'claude',
        version: '2.1.98',
        env: { CLAUDE_CONFIG_DIR: '/tmp/custom-claude-config' },
      }));
      expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/custom-claude-config');
    });

    it('does not inject Claude config dir for non-Claude agents', () => {
      const env = buildExecEnv(opts({ agent: 'codex', version: '0.98.0' }));
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });
  });

  // --- Version pinning ---

  describe('version pinning', () => {
    it('appends @version to base command when version is set', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', version: '2.1.98', mode: 'full' }));
      expect(cmd[0]).toBe('claude@2.1.98');
    });

    it('does not append @version when version is undefined', () => {
      const cmd = buildExecCommand(opts({ agent: 'claude', mode: 'full' }));
      expect(cmd[0]).toBe('claude');
    });

    it('works for codex with version', () => {
      const cmd = buildExecCommand(opts({ agent: 'codex', version: '0.98.0', mode: 'full' }));
      expect(cmd[0]).toBe('codex@0.98.0');
      expect(cmd[1]).toBe('exec');
    });
  });

  // --- Snapshot: agent-runner.sh patterns ---

  describe('agent-runner.sh compatibility', () => {
    it('produces claude command matching agent-runner pattern', () => {
      const cmd = buildExecCommand(opts({
        agent: 'claude',
        mode: 'full',
        headless: true,
        sessionId: 'sess-123',
        verbose: true,
        prompt: 'fix the bug',
      }));
      expect(cmd).toEqual([
        'claude',
        '--dangerously-skip-permissions',
        '--print',
        '--session-id', 'sess-123',
        '--model', EFFORT_MODELS.claude.default,
        '--verbose',
        '-p', 'fix the bug',
      ]);
    });

    it('produces codex command matching agent-runner pattern', () => {
      const cmd = buildExecCommand(opts({
        agent: 'codex',
        mode: 'full',
        prompt: 'fix the bug',
      }));
      expect(cmd).toEqual([
        'codex', 'exec',
        '--full-auto',
        '--model', EFFORT_MODELS.codex.default,
        'fix the bug',
      ]);
    });
  });
});
