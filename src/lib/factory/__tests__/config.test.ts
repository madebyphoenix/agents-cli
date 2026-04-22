import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

import {
  factoryConfigPath,
  readFactoryConfig,
  writeFactoryConfig,
  detectGitHubRepo,
  resolveDispatch,
} from '../config.js';

// Tests point at a fake HOME so we never clobber the user's real config.
let fakeHome: string;
let origHome: string | undefined;
let cwd: string;

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-cfg-'));
  origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-cwd-'));
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('FactoryConfig — read/write', () => {
  it('returns defaults when no file exists', async () => {
    const cfg = await readFactoryConfig();
    expect(cfg.cloud_priority).toEqual(['rush', 'codex', 'local']);
    expect(cfg.auto_detect_repo).toBe(true);
    expect(cfg.default_planner_agent).toBe('codex');
    expect(cfg.supervisor_interval_seconds).toBe(8);
  });

  it('persists + reloads overrides, merging with defaults', async () => {
    await writeFactoryConfig({ cloud_priority: ['codex', 'local'], supervisor_interval_seconds: 12 });
    const cfg = await readFactoryConfig();
    expect(cfg.cloud_priority).toEqual(['codex', 'local']);
    expect(cfg.supervisor_interval_seconds).toBe(12);
    // Untouched fields fall back to defaults.
    expect(cfg.default_planner_agent).toBe('codex');
  });

  it('rejects bogus priority entries silently', async () => {
    const p = factoryConfigPath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify({ cloud_priority: ['hamster', 'rush'], supervisor_interval_seconds: 0 }));
    const cfg = await readFactoryConfig();
    // 'hamster' dropped, 'rush' kept. Interval 0 → falls back to default.
    expect(cfg.cloud_priority).toEqual(['rush']);
    expect(cfg.supervisor_interval_seconds).toBe(8);
  });

  it('falls back to defaults when the file is corrupt', async () => {
    const p = factoryConfigPath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, '{{not json');
    const cfg = await readFactoryConfig();
    expect(cfg.cloud_priority).toEqual(['rush', 'codex', 'local']);
  });
});

describe('detectGitHubRepo', () => {
  it('parses https remotes', () => {
    execSync('git init -q', { cwd });
    execSync('git remote add origin https://github.com/acme/widgets.git', { cwd });
    expect(detectGitHubRepo(cwd)).toBe('acme/widgets');
  });

  it('parses ssh remotes', () => {
    execSync('git init -q', { cwd });
    execSync('git remote add origin git@github.com:acme/widgets.git', { cwd });
    expect(detectGitHubRepo(cwd)).toBe('acme/widgets');
  });

  it('returns null when not a git repo', () => {
    expect(detectGitHubRepo(cwd)).toBeNull();
  });

  it('returns null when no origin remote', () => {
    execSync('git init -q', { cwd });
    expect(detectGitHubRepo(cwd)).toBeNull();
  });
});

describe('resolveDispatch', () => {
  beforeEach(() => {
    // Make cwd a git repo with a detectable origin for the rush-path tests.
    execSync('git init -q', { cwd });
    execSync('git remote add origin https://github.com/acme/widgets.git', { cwd });
  });

  it('CLI --local wins over config', async () => {
    await writeFactoryConfig({ cloud_priority: ['rush'] });
    const r = await resolveDispatch(cwd, undefined, true, undefined);
    expect(r.provider).toBe('local');
  });

  it('CLI --cloud wins over config and auto-detects repo for rush', async () => {
    const r = await resolveDispatch(cwd, 'rush', false, undefined);
    expect(r.provider).toBe('rush');
    expect(r.repo).toBe('acme/widgets');
  });

  it('config priority picks the first viable provider', async () => {
    await writeFactoryConfig({ cloud_priority: ['codex', 'local'] });
    const r = await resolveDispatch(cwd, undefined, false, undefined);
    expect(r.provider).toBe('codex');
  });

  it('rush priority skips to next when no repo can be detected', async () => {
    // Use a non-git cwd to force rush to skip.
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
    try {
      await writeFactoryConfig({ cloud_priority: ['rush', 'codex'] });
      const r = await resolveDispatch(noGit, undefined, false, undefined);
      expect(r.considered).toEqual(['rush', 'codex']);
      expect(r.provider).toBe('codex');
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  it('falls through to local when everything else skips', async () => {
    await writeFactoryConfig({ cloud_priority: ['rush'] });
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
    try {
      const r = await resolveDispatch(noGit, undefined, false, undefined);
      expect(r.provider).toBe('local');
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  it('explicit --repo wins over auto-detect', async () => {
    const r = await resolveDispatch(cwd, 'rush', false, 'other/repo');
    expect(r.repo).toBe('other/repo');
  });
});
