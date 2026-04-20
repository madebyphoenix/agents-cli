import { describe, it, expect } from 'vitest';
import { pickRotateCandidate, type RotateCandidate } from '../rotate.js';

function cand(overrides: Partial<RotateCandidate>): RotateCandidate {
  return {
    agent: 'claude',
    version: '0.0.0',
    email: 'a@b.com',
    usageStatus: 'available',
    authValid: true,
    lastActive: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('pickRotateCandidate', () => {
  it('returns null when nothing is signed in', () => {
    const result = pickRotateCandidate([
      cand({ version: '1.0.0', email: null }),
      cand({ version: '2.0.0', email: null }),
    ]);
    expect(result).toBeNull();
  });

  it('returns null when every signed-in account is out of credits', () => {
    const result = pickRotateCandidate([
      cand({ version: '1.0.0', usageStatus: 'out_of_credits' }),
      cand({ version: '2.0.0', usageStatus: 'out_of_credits' }),
    ]);
    expect(result).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(pickRotateCandidate([])).toBeNull();
  });

  it('picks the least-recently-active healthy candidate', () => {
    const newest = cand({ version: '2.1.113', lastActive: new Date('2026-04-20T10:00:00Z') });
    const middle = cand({ version: '2.1.112', lastActive: new Date('2026-04-20T05:00:00Z') });
    const oldest = cand({ version: '2.1.92', lastActive: new Date('2026-04-16T00:00:00Z') });

    const result = pickRotateCandidate([newest, middle, oldest]);
    expect(result).not.toBeNull();
    expect(result!.picked.version).toBe('2.1.92');
    expect(result!.healthy.map((c) => c.version)).toEqual(['2.1.92', '2.1.112', '2.1.113']);
  });

  it('treats never-used versions (null lastActive) as oldest', () => {
    const used = cand({ version: '2.1.113', lastActive: new Date('2026-04-20T10:00:00Z') });
    const fresh = cand({ version: '2.1.120', lastActive: null });

    const result = pickRotateCandidate([used, fresh]);
    expect(result!.picked.version).toBe('2.1.120');
  });

  it('excludes out-of-credits but keeps them reported', () => {
    const healthy = cand({ version: '2.1.113', lastActive: new Date('2026-04-20T10:00:00Z') });
    const dead = cand({ version: '2.1.85', usageStatus: 'out_of_credits', lastActive: new Date('2026-04-15T00:00:00Z') });

    const result = pickRotateCandidate([healthy, dead]);
    expect(result!.picked.version).toBe('2.1.113');
    expect(result!.healthy).toHaveLength(1);
    expect(result!.excluded).toHaveLength(1);
    expect(result!.excluded[0].version).toBe('2.1.85');
  });

  it('excludes not-signed-in versions (fresh installs with no auth)', () => {
    const healthy = cand({ version: '2.1.113' });
    const notAuthed = cand({ version: '2.1.120', email: null, lastActive: null });

    const result = pickRotateCandidate([healthy, notAuthed]);
    expect(result!.picked.version).toBe('2.1.113');
    expect(result!.excluded).toHaveLength(1);
  });

  it('excludes accounts with invalid auth tokens', () => {
    const valid = cand({ version: '2.1.110', lastActive: new Date('2026-04-20T10:00:00Z') });
    const expired = cand({ version: '2.1.112', authValid: false, lastActive: new Date('2026-04-15T00:00:00Z') });

    const result = pickRotateCandidate([valid, expired]);
    expect(result!.picked.version).toBe('2.1.110');
    expect(result!.healthy).toHaveLength(1);
    expect(result!.excluded).toHaveLength(1);
    expect(result!.excluded[0].version).toBe('2.1.112');
  });

  it('treats rate_limited as healthy (transient, not exhausted)', () => {
    const rateLimited = cand({ version: '2.1.113', usageStatus: 'rate_limited', lastActive: new Date('2026-04-15T00:00:00Z') });
    const newer = cand({ version: '2.1.112', lastActive: new Date('2026-04-20T10:00:00Z') });

    const result = pickRotateCandidate([rateLimited, newer]);
    expect(result!.picked.version).toBe('2.1.113');
    expect(result!.healthy).toHaveLength(2);
  });
});
