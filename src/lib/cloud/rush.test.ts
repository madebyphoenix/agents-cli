import { describe, it, expect } from 'vitest';
import { buildDispatchBody } from './rush.js';

describe('buildDispatchBody', () => {
  it('single repo sends both singular fields and repos[] for back-compat', () => {
    const body = buildDispatchBody({
      agent: 'claude',
      prompt: 'fix the bug',
      resolvedRepos: [
        { installation_id: 42, repo_owner: 'muqsitnawaz', repo_name: 'agents' },
      ],
    });
    expect(body).toMatchObject({
      agent: 'claude',
      prompt: 'fix the bug',
      installation_id: 42,
      repo_owner: 'muqsitnawaz',
      repo_name: 'agents',
      repos: [
        { installation_id: 42, repo_owner: 'muqsitnawaz', repo_name: 'agents' },
      ],
    });
  });

  it('multi-repo omits singular fields so old halo/proxy rejects cleanly', () => {
    const body = buildDispatchBody({
      agent: 'claude',
      prompt: 'refactor',
      resolvedRepos: [
        { installation_id: 1, repo_owner: 'muqsitnawaz', repo_name: 'rush' },
        { installation_id: 1, repo_owner: 'muqsitnawaz', repo_name: 'agents' },
      ],
    });
    expect(body.installation_id).toBeUndefined();
    expect(body.repo_owner).toBeUndefined();
    expect(body.repo_name).toBeUndefined();
    expect(body.repos).toEqual([
      { installation_id: 1, repo_owner: 'muqsitnawaz', repo_name: 'rush' },
      { installation_id: 1, repo_owner: 'muqsitnawaz', repo_name: 'agents' },
    ]);
  });

  it('defaults agent to claude when unspecified', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [
        { installation_id: 1, repo_owner: 'a', repo_name: 'b' },
      ],
    });
    expect(body.agent).toBe('claude');
  });

  it('forwards mode when set', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      mode: 'plan',
      resolvedRepos: [
        { installation_id: 1, repo_owner: 'a', repo_name: 'b' },
      ],
    });
    expect(body.mode).toBe('plan');
  });

  it('throws when resolvedRepos is empty (guard against programmer error)', () => {
    expect(() =>
      buildDispatchBody({ prompt: 'x', resolvedRepos: [] }),
    ).toThrow(/at least one entry/);
  });
});
