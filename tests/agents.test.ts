import { describe, it, expect } from 'vitest';
import { AGENTS, COMMANDS_CAPABLE_AGENTS, ALL_AGENT_IDS } from '../src/lib/agents.js';

describe('COMMANDS_CAPABLE_AGENTS', () => {
  it('excludes openclaw since it uses Gateway-based slash commands', () => {
    expect(COMMANDS_CAPABLE_AGENTS).not.toContain('openclaw');
  });

  it('includes all other agents that support file-based commands', () => {
    const expected = ['claude', 'codex', 'gemini', 'cursor', 'opencode'];
    for (const agent of expected) {
      expect(COMMANDS_CAPABLE_AGENTS).toContain(agent);
    }
  });

  it('is derived from capabilities.commands', () => {
    const fromCapabilities = ALL_AGENT_IDS.filter(id => AGENTS[id].capabilities.commands);
    expect(COMMANDS_CAPABLE_AGENTS).toEqual(fromCapabilities);
  });

  it('openclaw has empty commandsDir and commands:false', () => {
    expect(AGENTS['openclaw'].commandsDir).toBe('');
    expect(AGENTS['openclaw'].capabilities.commands).toBe(false);
  });

  it('all non-openclaw agents have non-empty commandsDir', () => {
    for (const id of ALL_AGENT_IDS) {
      if (id === 'openclaw') continue;
      expect(AGENTS[id].commandsDir).not.toBe('');
    }
  });
});
