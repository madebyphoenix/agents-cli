import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { AccountInfo } from '../agents.js';
import {
  buildCanonicalUsageContext,
  formatUsageSummary,
  getClaudeKeychainService,
  readClaudeUsageCache,
  isClaudeUsageOrgMatch,
  writeClaudeUsageCache,
  type UsageSnapshot,
} from '../usage.js';

function makeAccountInfo(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    accountKey: null,
    usageKey: null,
    accountId: null,
    organizationId: null,
    userId: null,
    email: null,
    plan: null,
    usageStatus: null,
    overageCredits: null,
    lastActive: null,
    ...overrides,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('usage formatting', () => {
  it('renders compact S:/W: bars and skips the sonnet-only window', () => {
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-04-17T12:00:00Z'),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 40,
          resetsAt: null,
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 80,
          resetsAt: null,
          windowMinutes: 10080,
        },
        {
          key: 'sonnet_week',
          label: 'Current week (Sonnet only)',
          shortLabel: 'So',
          usedPercent: 55,
          resetsAt: null,
          windowMinutes: 10080,
        },
      ],
    };

    const summary = stripAnsi(formatUsageSummary(null, snapshot));

    expect(summary).toContain('S:');
    expect(summary).toContain('W:');
    expect(summary).not.toContain('So:');
  });
});

describe('usage identity deduping', () => {
  it('keeps only the freshest version home per usage identity', () => {
    const older = makeAccountInfo({
      usageKey: 'claude:org=shared',
      accountKey: 'claude:account=one',
      organizationId: 'org-old',
      plan: 'Pro',
      lastActive: new Date('2026-04-17T10:00:00Z'),
    });
    const newer = makeAccountInfo({
      usageKey: 'claude:org=shared',
      accountKey: 'claude:account=two',
      organizationId: 'org-new',
      plan: 'Max',
      lastActive: new Date('2026-04-17T11:00:00Z'),
    });
    const fallback = makeAccountInfo({
      usageKey: null,
      accountKey: 'codex:account=fallback',
      organizationId: 'org-codex',
      lastActive: new Date('2026-04-17T09:00:00Z'),
    });

    const { canonicalByUsageKey, usageFetchInputs } = buildCanonicalUsageContext([
      {
        agentId: 'claude',
        home: '/tmp/old',
        cliVersion: '2.1.80',
        info: older,
      },
      {
        agentId: 'claude',
        home: '/tmp/new',
        cliVersion: '2.1.98',
        info: newer,
      },
      {
        agentId: 'codex',
        home: '/tmp/codex',
        cliVersion: '0.113.0',
        info: fallback,
      },
    ]);

    expect(canonicalByUsageKey.size).toBe(2);
    expect(canonicalByUsageKey.get('claude:org=shared')).toEqual(newer);
    expect(canonicalByUsageKey.get('codex:account=fallback')).toEqual(fallback);
    expect(usageFetchInputs.get('claude:org=shared')).toEqual({
      agentId: 'claude',
      home: '/tmp/new',
      cliVersion: '2.1.98',
      organizationId: 'org-new',
    });
    expect(usageFetchInputs.get('codex:account=fallback')).toEqual({
      agentId: 'codex',
      home: '/tmp/codex',
      cliVersion: '0.113.0',
      organizationId: 'org-codex',
    });
  });
});

describe('Claude usage scoping', () => {
  it('uses the shared keychain service without a managed home', () => {
    expect(getClaudeKeychainService()).toBe('Claude Code-credentials');
  });

  it('derives distinct keychain services for distinct Claude homes', () => {
    const first = getClaudeKeychainService('/tmp/claude-a');
    const second = getClaudeKeychainService('/tmp/claude-b');

    expect(first).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(second).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it('does not reuse the shared keychain service for managed Claude homes', () => {
    expect(getClaudeKeychainService('/tmp/claude-a')).not.toBe('Claude Code-credentials');
  });

  it('keeps usage eligible when the live org is missing', () => {
    expect(isClaudeUsageOrgMatch('org-requested', null)).toBe(true);
  });

  it('rejects usage only when both org ids exist and mismatch', () => {
    expect(isClaudeUsageOrgMatch('org-requested', 'org-live')).toBe(false);
    expect(isClaudeUsageOrgMatch('org-requested', 'org-requested')).toBe(true);
  });
});

describe('Claude usage cache', () => {
  it('persists and reloads the last seen live snapshot by usage key', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-cache-'));
    const cachePath = path.join(tempDir, 'claude-usage.json');
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-04-17T12:00:00Z'),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 40,
          resetsAt: new Date('2026-04-17T16:00:00Z'),
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 80,
          resetsAt: new Date('2026-04-23T12:00:00Z'),
          windowMinutes: 10080,
        },
      ],
    };

    try {
      writeClaudeUsageCache('claude:org=shared', snapshot, cachePath);
      const cached = readClaudeUsageCache(
        'claude:org=shared',
        cachePath,
        new Date('2026-04-17T13:00:00Z')
      );

      expect(cached?.source).toBe('last_seen');
      expect(cached?.sourceLabel).toBe('last seen live account data');
      expect(cached?.windows.map((window) => window.shortLabel)).toEqual(['S', 'W']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resets expired cached windows to 0%', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-cache-'));
    const cachePath = path.join(tempDir, 'claude-usage.json');
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-04-17T12:00:00Z'),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 40,
          resetsAt: new Date('2026-04-17T13:00:00Z'),
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 80,
          resetsAt: new Date('2026-04-23T12:00:00Z'),
          windowMinutes: 10080,
        },
      ],
    };

    try {
      writeClaudeUsageCache('claude:org=shared', snapshot, cachePath);
      const cached = readClaudeUsageCache(
        'claude:org=shared',
        cachePath,
        new Date('2026-04-17T14:00:00Z')
      );

      expect(cached?.windows.map((window) => window.shortLabel)).toEqual(['S', 'W']);
      expect(cached?.windows.find((w) => w.shortLabel === 'S')?.usedPercent).toBe(0);
      expect(cached?.windows.find((w) => w.shortLabel === 'W')?.usedPercent).toBe(80);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
