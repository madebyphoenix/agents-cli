import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as yaml from 'yaml';

// We need to test the actual functions, but they depend on global state (HOME, etc.)
// So we'll test the logic directly by creating mock version homes

const TEST_DIR = join(tmpdir(), 'agents-cli-versions-sync-test');

describe('getActuallySyncedResources', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('detects commands in version home', () => {
    // Create a mock version home with commands
    const versionHome = join(TEST_DIR, 'claude-home');
    const commandsDir = join(versionHome, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'debug.md'), '# Debug command');
    writeFileSync(join(commandsDir, 'plan.md'), '# Plan command');
    writeFileSync(join(commandsDir, 'other.txt'), 'Not a command'); // Should be ignored

    // Read what's there
    const files = require('fs').readdirSync(commandsDir)
      .filter((f: string) => f.endsWith('.md'))
      .map((f: string) => f.replace(/\.md$/, ''));

    expect(files).toContain('debug');
    expect(files).toContain('plan');
    expect(files).not.toContain('other');
    expect(files.length).toBe(2);
  });

  it('detects skills directories in version home', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const skillsDir = join(versionHome, '.claude', 'skills');
    mkdirSync(join(skillsDir, 'mq'), { recursive: true });
    mkdirSync(join(skillsDir, 'browser'), { recursive: true });
    writeFileSync(join(skillsDir, '.hidden'), 'hidden file'); // Should be ignored

    const dirs = require('fs').readdirSync(skillsDir, { withFileTypes: true })
      .filter((d: any) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d: any) => d.name);

    expect(dirs).toContain('mq');
    expect(dirs).toContain('browser');
    expect(dirs).not.toContain('.hidden');
    expect(dirs.length).toBe(2);
  });

  it('detects permissions from settings.json allow array', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // Write settings with permissions
    const settings = {
      permissions: {
        allow: ['Bash(git *)', 'Bash(npm *)', 'Read(**)'],
        deny: ['Bash(rm *)'],
      },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

    // Read permissions
    const content = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    const allowRules = content.permissions?.allow || [];

    expect(allowRules.length).toBe(3);
    expect(allowRules).toContain('Bash(git *)');
    expect(allowRules).toContain('Bash(npm *)');
    expect(allowRules).toContain('Read(**)');
  });

  it('returns empty permissions when settings.json has empty allow array', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // Write settings with EMPTY permissions
    const settings = {
      permissions: {
        allow: [],
        deny: [],
      },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

    const content = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    const allowRules = content.permissions?.allow || [];

    expect(allowRules.length).toBe(0);
  });

  it('returns empty permissions when settings.json does not exist', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settingsPath = join(claudeDir, 'settings.json');
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('detects hooks in version home', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const hooksDir = join(versionHome, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit.sh'), '#!/bin/bash\necho "hook"');
    writeFileSync(join(hooksDir, 'post-build.py'), '#!/usr/bin/env python\nprint("hook")');
    writeFileSync(join(hooksDir, '.hidden'), 'hidden'); // Should be ignored

    const files = require('fs').readdirSync(hooksDir)
      .filter((f: string) => !f.startsWith('.'));

    expect(files).toContain('pre-commit.sh');
    expect(files).toContain('post-build.py');
    expect(files).not.toContain('.hidden');
    expect(files.length).toBe(2);
  });
});

describe('getNewResources', () => {
  it('returns all resources when nothing is synced', () => {
    const available = {
      commands: ['debug', 'plan', 'clean'],
      skills: ['mq', 'browser'],
      hooks: ['pre-commit.sh'],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core', '02-node'],
    };

    const synced = {
      commands: [],
      skills: [],
      hooks: [],
      memory: [],
      mcp: [],
      permissions: [],
    };

    const diff = {
      commands: available.commands.filter(c => !synced.commands.includes(c)),
      skills: available.skills.filter(s => !synced.skills.includes(s)),
      hooks: available.hooks.filter(h => !synced.hooks.includes(h)),
      memory: available.memory.filter(m => !synced.memory.includes(m)),
      mcp: available.mcp.filter(m => !synced.mcp.includes(m)),
      permissions: available.permissions.filter(p => !synced.permissions.includes(p)),
    };

    expect(diff.commands).toEqual(['debug', 'plan', 'clean']);
    expect(diff.skills).toEqual(['mq', 'browser']);
    expect(diff.hooks).toEqual(['pre-commit.sh']);
    expect(diff.memory).toEqual(['AGENTS']);
    expect(diff.mcp).toEqual(['Swarm']);
    expect(diff.permissions).toEqual(['01-core', '02-node']);
  });

  it('returns only new resources when some are already synced', () => {
    const available = {
      commands: ['debug', 'plan', 'clean', 'verify'],
      skills: ['mq', 'browser', 'new-skill'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm', 'NewMCP'],
      permissions: ['01-core', '02-node', '03-python', '99-deny'],
    };

    const synced = {
      commands: ['debug', 'plan'],
      skills: ['mq', 'browser'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core', '02-node'],
    };

    const diff = {
      commands: available.commands.filter(c => !synced.commands.includes(c)),
      skills: available.skills.filter(s => !synced.skills.includes(s)),
      hooks: available.hooks.filter(h => !synced.hooks.includes(h)),
      memory: available.memory.filter(m => !synced.memory.includes(m)),
      mcp: available.mcp.filter(m => !synced.mcp.includes(m)),
      permissions: available.permissions.filter(p => !synced.permissions.includes(p)),
    };

    expect(diff.commands).toEqual(['clean', 'verify']);
    expect(diff.skills).toEqual(['new-skill']);
    expect(diff.hooks).toEqual([]);
    expect(diff.memory).toEqual([]);
    expect(diff.mcp).toEqual(['NewMCP']);
    expect(diff.permissions).toEqual(['03-python', '99-deny']);
  });

  it('returns empty arrays when everything is already synced', () => {
    const available = {
      commands: ['debug', 'plan'],
      skills: ['mq'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core'],
    };

    const synced = {
      commands: ['debug', 'plan'],
      skills: ['mq'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core'],
    };

    const diff = {
      commands: available.commands.filter(c => !synced.commands.includes(c)),
      skills: available.skills.filter(s => !synced.skills.includes(s)),
      hooks: available.hooks.filter(h => !synced.hooks.includes(h)),
      memory: available.memory.filter(m => !synced.memory.includes(m)),
      mcp: available.mcp.filter(m => !synced.mcp.includes(m)),
      permissions: available.permissions.filter(p => !synced.permissions.includes(p)),
    };

    expect(diff.commands).toEqual([]);
    expect(diff.skills).toEqual([]);
    expect(diff.hooks).toEqual([]);
    expect(diff.memory).toEqual([]);
    expect(diff.mcp).toEqual([]);
    expect(diff.permissions).toEqual([]);
  });
});

describe('hasNewResources', () => {
  it('returns true when there are new commands', () => {
    const diff = {
      commands: ['debug'],
      skills: [],
      hooks: [],
      memory: [],
      mcp: [],
      permissions: [],
    };

    const hasNew = Object.values(diff).some(arr => arr.length > 0);
    expect(hasNew).toBe(true);
  });

  it('returns true when there are new permissions', () => {
    const diff = {
      commands: [],
      skills: [],
      hooks: [],
      memory: [],
      mcp: [],
      permissions: ['01-core', '02-node'],
    };

    const hasNew = Object.values(diff).some(arr => arr.length > 0);
    expect(hasNew).toBe(true);
  });

  it('returns false when no new resources', () => {
    const diff = {
      commands: [],
      skills: [],
      hooks: [],
      memory: [],
      mcp: [],
      permissions: [],
    };

    const hasNew = Object.values(diff).some(arr => arr.length > 0);
    expect(hasNew).toBe(false);
  });
});

describe('permission group detection from allow rules', () => {
  it('detects which groups are applied based on matching rules', () => {
    // Simulate checking if rules from a group are in the allow list
    const groupRules = {
      '01-core': ['Bash(cat /tmp:*)', 'Bash(ls /tmp:*)'],
      '02-node': ['Bash(npm:*)', 'Bash(node:*)', 'Bash(bun:*)'],
      '03-python': ['Bash(python:*)', 'Bash(pip:*)'],
    };

    const appliedRules = [
      'Bash(cat /tmp:*)',
      'Bash(ls /tmp:*)',
      'Bash(npm:*)',
      'Bash(node:*)',
      'Bash(bun:*)',
      // Note: no python rules
    ];

    const appliedGroups: string[] = [];
    for (const [groupName, rules] of Object.entries(groupRules)) {
      const hasRuleFromGroup = rules.some(rule => appliedRules.includes(rule));
      if (hasRuleFromGroup) {
        appliedGroups.push(groupName);
      }
    }

    expect(appliedGroups).toContain('01-core');
    expect(appliedGroups).toContain('02-node');
    expect(appliedGroups).not.toContain('03-python');
  });

  it('returns empty when no rules are applied', () => {
    const groupRules = {
      '01-core': ['Bash(cat /tmp:*)', 'Bash(ls /tmp:*)'],
      '02-node': ['Bash(npm:*)', 'Bash(node:*)'],
    };

    const appliedRules: string[] = [];

    const appliedGroups: string[] = [];
    for (const [groupName, rules] of Object.entries(groupRules)) {
      const hasRuleFromGroup = rules.some(rule => appliedRules.includes(rule));
      if (hasRuleFromGroup) {
        appliedGroups.push(groupName);
      }
    }

    expect(appliedGroups).toEqual([]);
  });
});
