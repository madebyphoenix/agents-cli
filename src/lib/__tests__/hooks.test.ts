import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We need to stub getAgentsDir before importing hooks
vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return {
    ...actual,
    getAgentsDir: () => agentsDir,
    getHooksDir: () => path.join(agentsDir, 'hooks'),
  };
});

let agentsDir: string;
let tmpDir: string;

import { registerHooksToSettings, parseHookManifest } from '../hooks.js';
import { CODEX_HOOKS_MIN_VERSION } from '../agents.js';
import { compareVersions } from '../versions.js';
import type { ManifestHook } from '../types.js';

describe('registerHooksToSettings - Codex', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeScript(name: string): string {
    const scriptPath = path.join(agentsDir, 'hooks', name);
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho hello\n', 'utf-8');
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  function makeVersionHome(): string {
    const home = path.join(tmpDir, 'version-home');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    return home;
  }

  it('writes hooks.json with correct event entries', () => {
    const versionHome = makeVersionHome();
    const scriptPath = makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit'],
        timeout: 30,
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest);

    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> UserPromptSubmit');

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    expect(hooksJson.UserPromptSubmit).toHaveLength(1);
    expect(hooksJson.UserPromptSubmit[0].command).toBe(scriptPath);
    expect(hooksJson.UserPromptSubmit[0].timeout).toBe(30);
    expect(hooksJson.UserPromptSubmit[0].type).toBe('command');
  });

  it('writes [features] codex_hooks = true to config.toml', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest);

    const configPath = path.join(versionHome, '.codex', 'config.toml');
    expect(fs.existsSync(configPath)).toBe(true);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('codex_hooks = true');
  });

  it('preserves existing config.toml entries when enabling feature flag', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    // Pre-seed config.toml with unrelated content
    const configPath = path.join(versionHome, '.codex', 'config.toml');
    fs.writeFileSync(configPath, 'approval_policy = "suggest"\n', 'utf-8');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest);

    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('codex_hooks = true');
    expect(content).toContain('approval_policy');
  });

  it('does not duplicate managed hook entries on repeated calls', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest);
    registerHooksToSettings('codex', versionHome, manifest);

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    expect(hooksJson.UserPromptSubmit).toHaveLength(1);
  });

  it('never touches user-authored entries (managed-prefix guard)', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    // Pre-seed hooks.json with a user-authored hook (not under agentsDir)
    const hooksPath = path.join(versionHome, '.codex', 'hooks.json');
    const userHook = { type: 'command', command: '/usr/local/bin/my-hook.sh', timeout: 10 };
    fs.writeFileSync(hooksPath, JSON.stringify({ UserPromptSubmit: [userHook] }, null, 2));

    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };

    registerHooksToSettings('codex', versionHome, manifest);

    const hooksJson = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    // Should have 2 entries: user hook unchanged + new managed hook
    expect(hooksJson.UserPromptSubmit).toHaveLength(2);
    expect(hooksJson.UserPromptSubmit[0]).toEqual(userHook);
  });

  it('skips hooks agent-filtered to other agents', () => {
    const versionHome = makeVersionHome();
    makeScript('claude-only.sh');

    const manifest: Record<string, ManifestHook> = {
      'claude-only': {
        script: 'claude-only.sh',
        events: ['UserPromptSubmit'],
        agents: ['claude'],
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest);

    expect(result.registered).toHaveLength(0);
    expect(fs.existsSync(path.join(versionHome, '.codex', 'hooks.json'))).toBe(false);
  });

  it('handles matcher-less events (Codex does not use matchers)', () => {
    const versionHome = makeVersionHome();
    makeScript('on-prompt.sh');

    // Manifest has a matcher (Claude-style) — Codex should still write the entry without it
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': {
        script: 'on-prompt.sh',
        events: ['UserPromptSubmit'],
        matcher: 'some-pattern',
      },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest);
    expect(result.errors).toHaveLength(0);
    expect(result.registered).toContain('on-prompt -> UserPromptSubmit');

    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8')
    );
    // Entry written without a matcher field
    expect(hooksJson.UserPromptSubmit[0]).not.toHaveProperty('matcher');
  });

  it('returns error when script file does not exist', () => {
    const versionHome = makeVersionHome();

    const manifest: Record<string, ManifestHook> = {
      'missing-hook': { script: 'does-not-exist.sh', events: ['UserPromptSubmit'] },
    };

    const result = registerHooksToSettings('codex', versionHome, manifest);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('missing-hook');
  });
});

describe('CODEX_HOOKS_MIN_VERSION constant', () => {
  it('is set to 0.116.0', () => {
    expect(CODEX_HOOKS_MIN_VERSION).toBe('0.116.0');
  });

  it('correctly gates versions below floor', () => {
    expect(compareVersions('0.113.0', CODEX_HOOKS_MIN_VERSION)).toBeLessThan(0);
    expect(compareVersions('0.115.9', CODEX_HOOKS_MIN_VERSION)).toBeLessThan(0);
  });

  it('correctly passes versions at or above floor', () => {
    expect(compareVersions('0.116.0', CODEX_HOOKS_MIN_VERSION)).toBe(0);
    expect(compareVersions('0.117.0', CODEX_HOOKS_MIN_VERSION)).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', CODEX_HOOKS_MIN_VERSION)).toBeGreaterThan(0);
  });
});

describe('registerHooksToSettings - returns empty for unsupported agents', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
    agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(path.join(agentsDir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns no-op for agents other than claude/codex', () => {
    const manifest: Record<string, ManifestHook> = {
      'on-prompt': { script: 'on-prompt.sh', events: ['UserPromptSubmit'] },
    };
    const result = registerHooksToSettings('gemini', path.join(tmpDir, 'home'), manifest);
    expect(result.registered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
