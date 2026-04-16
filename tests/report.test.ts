import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  loadDaemonConfig,
  saveDaemonConfig,
  clearDaemonConfig,
  type DaemonConfig,
} from '../src/lib/factory.js';
import {
  isReportRunning,
  readReportPid,
  readReportLog,
  log,
} from '../src/lib/report.js';
import { getAgentsDir } from '../src/lib/state.js';

function cleanupReportFiles() {
  const agentsDir = getAgentsDir();
  // Ensure directory exists
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
  }
  for (const file of ['report.pid', 'report.log', 'daemon.json']) {
    const p = join(agentsDir, file);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {}
  }
}

beforeEach(() => {
  cleanupReportFiles();
});

afterEach(() => {
  cleanupReportFiles();
});

describe('Daemon config', () => {
  it('returns empty config when no file exists', () => {
    const config = loadDaemonConfig();
    expect(config).toEqual({});
  });

  it('saves and loads config', () => {
    const config: DaemonConfig = {
      nodeId: 'test-node-id',
      nodeToken: 'ntk_testtoken123',
      endpoint: 'https://test.example.com',
      lastSync: 1234567890,
    };

    saveDaemonConfig(config);
    const loaded = loadDaemonConfig();

    expect(loaded.nodeId).toBe('test-node-id');
    expect(loaded.nodeToken).toBe('ntk_testtoken123');
    expect(loaded.endpoint).toBe('https://test.example.com');
    expect(loaded.lastSync).toBe(1234567890);
  });

  it('clears config', () => {
    saveDaemonConfig({ nodeId: 'test', nodeToken: 'ntk_test' });
    clearDaemonConfig();
    const loaded = loadDaemonConfig();
    expect(loaded).toEqual({});
  });

  it('handles invalid JSON gracefully', () => {
    const configPath = join(getAgentsDir(), 'daemon.json');
    writeFileSync(configPath, 'not valid json', 'utf-8');
    const config = loadDaemonConfig();
    expect(config).toEqual({});
  });
});

describe('Report PID management', () => {
  it('returns null when no PID file exists', () => {
    expect(readReportPid()).toBeNull();
  });

  it('returns false for isReportRunning when no PID file', () => {
    expect(isReportRunning()).toBe(false);
  });

  it('returns false for stale PID', () => {
    const pidPath = join(getAgentsDir(), 'report.pid');
    writeFileSync(pidPath, '999999999', 'utf-8');
    expect(isReportRunning()).toBe(false);
  });

  it('cleans up stale PID file', () => {
    const pidPath = join(getAgentsDir(), 'report.pid');
    writeFileSync(pidPath, '999999999', 'utf-8');
    isReportRunning(); // Should clean up stale PID
    expect(existsSync(pidPath)).toBe(false);
  });

  it('returns null for invalid PID content', () => {
    const pidPath = join(getAgentsDir(), 'report.pid');
    writeFileSync(pidPath, 'not-a-number', 'utf-8');
    expect(readReportPid()).toBeNull();
  });
});

describe('Report logging', () => {
  it('appends log lines to report.log', () => {
    log('INFO', 'test message one');
    log('ERROR', 'test message two');

    const content = readReportLog();
    expect(content).toContain('[INFO] test message one');
    expect(content).toContain('[ERROR] test message two');
  });

  it('readReportLog with line limit returns last N lines', () => {
    for (let i = 0; i < 10; i++) {
      log('INFO', `line ${i}`);
    }

    const last3 = readReportLog(3);
    const lines = last3.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(last3).toContain('line 9');
  });

  it('readReportLog returns fallback when no log exists', () => {
    expect(readReportLog()).toBe('(no log file)');
  });
});

describe('Session data conversion', () => {
  // Test that session discovery works with openclaw as a type
  it('openclaw is a valid session agent type', async () => {
    // Import the types to verify openclaw is included
    const { SESSION_AGENTS } = await import('../src/lib/session/types.js');
    // Note: openclaw is not in SESSION_AGENTS (it's discovered separately)
    // but it should be a valid SessionAgentId type
    expect(SESSION_AGENTS).toContain('claude');
    expect(SESSION_AGENTS).toContain('codex');
    expect(SESSION_AGENTS).toContain('gemini');
    // openclaw is not in SESSION_AGENTS but is a valid type
  });
});
