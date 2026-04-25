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

  it('includes account_manifest when supplied', () => {
    const manifest = {
      fp: 'aaaa',
      versions: [
        { version: '2.1.110', email: 'a@b.com', cred_fp: 'h1' },
        { version: '2.1.112', email: 'c@d.com', cred_fp: 'h2' },
      ],
    };
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      accountManifest: manifest,
    });
    expect(body.account_manifest).toEqual(manifest);
    expect(body.account_tokens).toBeUndefined();
  });

  it('omits account_manifest when null (no signed-in claude versions)', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      accountManifest: null,
    });
    expect(body.account_manifest).toBeUndefined();
  });

  it('passes through account_tokens verbatim when supplied (retry path)', () => {
    const tokens = [
      { version: '2.1.110', credentials_json: '{"accessToken":"abc"}' },
    ];
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      accountTokens: tokens,
    });
    expect(body.account_tokens).toEqual(tokens);
  });

  it('omits account_tokens when array is empty', () => {
    const body = buildDispatchBody({
      prompt: 'x',
      resolvedRepos: [{ installation_id: 1, repo_owner: 'a', repo_name: 'b' }],
      accountTokens: [],
    });
    expect(body.account_tokens).toBeUndefined();
  });
});
