import { describe, it, expect } from 'vitest';

import { generateShimScript, SHIM_SCHEMA_VERSION } from '../shims.js';

describe('SHIM_SCHEMA_VERSION', () => {
  it('is 5', () => {
    expect(SHIM_SCHEMA_VERSION).toBe(5);
  });
});

describe('generateShimScript — config-dir env vars', () => {
  it('exports CLAUDE_CONFIG_DIR for claude', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('export CLAUDE_CONFIG_DIR=');
    expect(script).not.toContain('export CODEX_HOME=');
  });

  it('exports CODEX_HOME for codex so the versioned config/rules are read', () => {
    const script = generateShimScript('codex');
    expect(script).toContain('export CODEX_HOME=');
    expect(script).toContain('"$VERSION_DIR/home/.codex"');
    expect(script).not.toContain('export CLAUDE_CONFIG_DIR=');
  });

  it('does not export a managed config-dir var for other agents', () => {
    const script = generateShimScript('opencode');
    expect(script).not.toContain('export CLAUDE_CONFIG_DIR=');
    expect(script).not.toContain('export CODEX_HOME=');
  });
});

describe('generateShimScript', () => {
  it('contains no reference to .agents-version', () => {
    const script = generateShimScript('claude');
    expect(script).not.toContain('.agents-version');
  });

  it('embeds the shim schema version marker matching SHIM_SCHEMA_VERSION', () => {
    const script = generateShimScript('claude');
    expect(script).toContain(`agents-shim-version: ${SHIM_SCHEMA_VERSION}`);
  });

  it('walks up looking for agents.yaml (not .agents-version)', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('agents.yaml');
  });

  it('skips $HOME/.agents/agents.yaml when walking up', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('user_agents_yaml');
    expect(script).toContain('"$candidate" != "$user_agents_yaml"');
  });

  it('error message references agents.yaml not .agents-version', () => {
    const script = generateShimScript('claude');
    expect(script).toContain('required by agents.yaml but not installed');
    expect(script).not.toContain('required by .agents-version');
  });

  it('find_project_agents_dir stops at agents.yaml or .git', () => {
    const script = generateShimScript('claude');
    // Boundary detection should check agents.yaml
    expect(script).toContain('[ -f "$dir/agents.yaml" ]');
    // And should NOT check .agents-version as a boundary
    expect(script).not.toContain('[ -f "$dir/.agents-version" ]');
  });
});
