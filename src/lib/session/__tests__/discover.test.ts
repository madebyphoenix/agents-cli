import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../types.js';
import { buildBM25Index, scoreBM25, computeSessionsHash } from '../discover.js';

function session(id: string, topic: string, userText?: string): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-04-17T19:00:00.000Z',
    filePath: `/tmp/${id}.jsonl`,
    topic,
    _userTerms: userText ? [userText] : undefined,
  };
}

describe('buildBM25Index', () => {
  it('captures term frequencies and per-doc lengths', () => {
    const docs = [
      session('doc-a', 'auth middleware bug', 'fix the auth auth middleware'),
      session('doc-b', 'payment refund', 'handle refund edge case'),
    ];
    const index = buildBM25Index(docs);

    expect(index.N).toBe(2);
    // doc-a: "auth middleware bug fix the auth auth middleware" -> 8 tokens
    expect(index.docLengths.get('doc-a')).toBe(8);
    // doc-b: "payment refund handle refund edge case" -> 6 tokens
    expect(index.docLengths.get('doc-b')).toBe(6);
    expect(index.avgdl).toBe(7);

    // "auth" appears 3 times in doc-a, 0 in doc-b
    expect(index.postings.get('auth')?.get('doc-a')).toBe(3);
    expect(index.postings.get('auth')?.has('doc-b')).toBe(false);
    // "refund" appears twice in doc-b
    expect(index.postings.get('refund')?.get('doc-b')).toBe(2);
  });

  it('skips tokens shorter than 2 characters', () => {
    const docs = [session('short', 'a b ab')];
    const index = buildBM25Index(docs);
    expect(index.postings.has('a')).toBe(false);
    expect(index.postings.has('b')).toBe(false);
    expect(index.postings.get('ab')?.get('short')).toBe(1);
  });
});

describe('scoreBM25', () => {
  it('ranks a rare term higher than a common one via IDF', () => {
    // "bug" in 1 doc, "session" in all 4 — rare term should dominate
    const docs = [
      session('doc-0', 'session bug', 'the bug'),
      session('doc-1', 'session notes', 'session notes'),
      session('doc-2', 'session thoughts', 'session thoughts'),
      session('doc-3', 'session plan', 'session plan'),
    ];
    const index = buildBM25Index(docs);

    const rareHit = scoreBM25(index, 'bug');
    const commonHit = scoreBM25(index, 'session');

    const bugScore = rareHit.get('doc-0')!.score;
    const sessionScore = commonHit.get('doc-0')!.score;
    expect(bugScore).toBeGreaterThan(sessionScore);
  });

  it('ranks shorter docs above longer docs at equal term frequency', () => {
    // Both docs mention "widget" once, but one is much longer.
    const docs = [
      session('short-doc', 'widget', 'widget'),
      session('long-doc', 'widget', 'widget ' + 'padding '.repeat(50).trim()),
    ];
    const index = buildBM25Index(docs);
    const results = scoreBM25(index, 'widget');
    const ids = [...results.keys()];
    expect(ids[0]).toBe('short-doc');
    expect(ids[1]).toBe('long-doc');
  });

  it('accumulates scores across multiple query terms', () => {
    const docs = [
      session('both', 'auth token', 'auth token handling'),
      session('one', 'auth only', 'auth only'),
      session('none', 'unrelated', 'unrelated notes'),
    ];
    const index = buildBM25Index(docs);
    const results = scoreBM25(index, 'auth token');

    expect(results.get('both')!.matchedTerms.sort()).toEqual(['auth', 'token']);
    expect(results.get('one')!.matchedTerms).toEqual(['auth']);
    expect(results.has('none')).toBe(false);
    expect(results.get('both')!.score).toBeGreaterThan(results.get('one')!.score);
  });

  it('returns an empty map for queries with no indexed terms', () => {
    const docs = [session('doc-0', 'hello world')];
    const index = buildBM25Index(docs);

    expect(scoreBM25(index, '').size).toBe(0);
    expect(scoreBM25(index, 'nonexistent').size).toBe(0);
  });

  it('orders results by score descending (Map insertion order)', () => {
    const docs = [
      session('low', 'apple', 'apple'),
      session('mid', 'apple apple', 'apple apple'),
      session('high', 'apple apple apple', 'apple apple apple'),
    ];
    const index = buildBM25Index(docs);
    const results = scoreBM25(index, 'apple');
    const ordered = [...results.keys()];
    expect(ordered).toEqual(['high', 'mid', 'low']);
  });
});

describe('computeSessionsHash', () => {
  it('returns the same hash regardless of session order', () => {
    const a = session('alpha', 'topic-a');
    const b = session('beta', 'topic-b');
    expect(computeSessionsHash([a, b])).toBe(computeSessionsHash([b, a]));
  });

  it('returns different hashes when sessions are added', () => {
    const a = session('alpha', 'topic-a');
    const b = session('beta', 'topic-b');
    expect(computeSessionsHash([a])).not.toBe(computeSessionsHash([a, b]));
  });

  it('returns different hashes when a session timestamp changes', () => {
    const base: SessionMeta = {
      id: 'alpha',
      shortId: 'alpha',
      agent: 'claude',
      timestamp: '2026-01-01T00:00:00.000Z',
      filePath: '/tmp/alpha.jsonl',
    };
    const updated = { ...base, timestamp: '2026-01-02T00:00:00.000Z' };
    expect(computeSessionsHash([base])).not.toBe(computeSessionsHash([updated]));
  });

  it('returns a non-empty string for an empty session list', () => {
    const h = computeSessionsHash([]);
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });

  it('rebuild is skipped when hash matches stored value', () => {
    const sessions = [session('a', 'auth bug'), session('b', 'payment fix')];
    const hash = computeSessionsHash(sessions);
    // Simulate the check performed in discoverSessions
    expect(hash !== computeSessionsHash([])).toBe(true);
    expect(hash === computeSessionsHash([...sessions].reverse())).toBe(true);
    expect(hash !== computeSessionsHash([sessions[0]])).toBe(true);
  });
});
