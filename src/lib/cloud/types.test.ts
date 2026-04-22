import { describe, it, expect } from 'vitest';
import { resolveDispatchRepos } from './types.js';

describe('resolveDispatchRepos', () => {
  it('returns [] when neither repo nor repos is set', () => {
    expect(resolveDispatchRepos({ prompt: 'do' })).toEqual([]);
  });

  it('falls back to singular repo when repos is absent', () => {
    expect(resolveDispatchRepos({ prompt: 'do', repo: 'muqsitnawaz/agents' }))
      .toEqual(['muqsitnawaz/agents']);
  });

  it('uses repos[] when provided', () => {
    expect(
      resolveDispatchRepos({ prompt: 'do', repos: ['a/b', 'c/d'] }),
    ).toEqual(['a/b', 'c/d']);
  });

  it('merges repo + repos, deduping', () => {
    expect(
      resolveDispatchRepos({
        prompt: 'do',
        repo: 'a/b',
        repos: ['a/b', 'c/d'],
      }),
    ).toEqual(['a/b', 'c/d']);
  });

  it('dedupes case-insensitively', () => {
    expect(
      resolveDispatchRepos({
        prompt: 'do',
        repos: ['Muqsitnawaz/Agents', 'muqsitnawaz/agents', 'MUQSITNAWAZ/AGENTS'],
      }),
    ).toEqual(['Muqsitnawaz/Agents']);
  });

  it('trims whitespace', () => {
    expect(
      resolveDispatchRepos({ prompt: 'do', repos: ['  a/b  ', 'c/d'] }),
    ).toEqual(['a/b', 'c/d']);
  });

  it('ignores empty and whitespace-only entries', () => {
    expect(
      resolveDispatchRepos({ prompt: 'do', repos: ['', '   ', 'a/b'] }),
    ).toEqual(['a/b']);
  });

  it('preserves dispatch order (repos first, then singular repo)', () => {
    expect(
      resolveDispatchRepos({
        prompt: 'do',
        repos: ['second/one', 'third/one'],
        repo: 'fourth/one',
      }),
    ).toEqual(['second/one', 'third/one', 'fourth/one']);
  });
});
