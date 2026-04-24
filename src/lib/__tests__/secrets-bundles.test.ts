import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bundleExists,
  describeBundle,
  keychainItemsForBundle,
  listBundles,
  parseDotenv,
  readBundle,
  resolveBundleEnv,
  validateBundleName,
  validateEnvKey,
  writeBundle,
  deleteBundle,
  type SecretsBundle,
} from '../secrets-bundles.js';

// Redirect the secrets dir into a per-test tmp path so nothing touches the
// real ~/.agents/secrets. The state module reads HOME at import time, so we
// shim getSecretsDir via a mock-friendly env override.
const originalHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-test-'));
  process.env.HOME = tmpHome;
  // state.ts captured HOME at module load; reset its module cache so
  // getSecretsDir picks up the new HOME for every test run.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('validation', () => {
  it('validateBundleName accepts lowercase letters, digits, dash, underscore', () => {
    expect(() => validateBundleName('prod-stripe_1')).not.toThrow();
    expect(() => validateBundleName('A')).not.toThrow();
  });

  it('validateBundleName rejects names starting with a special char', () => {
    expect(() => validateBundleName('-bad')).toThrow();
    expect(() => validateBundleName('_bad')).toThrow();
  });

  it('validateEnvKey matches parseExecEnv conventions', () => {
    expect(() => validateEnvKey('MY_KEY')).not.toThrow();
    expect(() => validateEnvKey('_private')).not.toThrow();
    expect(() => validateEnvKey('1starts_with_digit')).toThrow();
    expect(() => validateEnvKey('KEY-WITH-DASH')).toThrow();
  });
});

describe('parseDotenv', () => {
  it('parses simple KEY=VALUE lines', () => {
    expect(parseDotenv('A=1\nB=two')).toEqual({ A: '1', B: 'two' });
  });

  it('skips comments and blank lines', () => {
    expect(parseDotenv('# comment\n\nA=1\n')).toEqual({ A: '1' });
  });

  it('strips matching quotes around values', () => {
    expect(parseDotenv('A="quoted"\nB=\'quoted2\'')).toEqual({ A: 'quoted', B: 'quoted2' });
  });

  it('accepts `export` prefix', () => {
    expect(parseDotenv('export GH_TOKEN=abc')).toEqual({ GH_TOKEN: 'abc' });
  });

  it('last-wins on duplicate keys', () => {
    expect(parseDotenv('A=1\nA=2')).toEqual({ A: '2' });
  });

  it('ignores invalid key names', () => {
    expect(parseDotenv('1BAD=x\nA=1')).toEqual({ A: '1' });
  });
});

describe('describeBundle + resolveBundleEnv', () => {
  function b(vars: Record<string, any>, extra: Partial<SecretsBundle> = {}): SecretsBundle {
    return { name: 'unit', vars, ...extra };
  }

  it('classifies each var by kind', () => {
    const bundle = b({
      A: 'literal-val',
      B: 'keychain:MY_KEY',
      C: 'env:HOME',
      D: 'file:/tmp/x',
      E: 'exec:echo hi',
      F: { value: 'keychain:escaped' },
    });
    const info = describeBundle(bundle);
    const byKey = Object.fromEntries(info.map((e) => [e.key, e.kind]));
    expect(byKey).toEqual({
      A: 'literal',
      B: 'keychain',
      C: 'env',
      D: 'file',
      E: 'exec',
      F: 'literal',
    });
  });

  it('resolveBundleEnv inlines literals and resolves env: refs', () => {
    process.env.__AGENTS_RESOLVE_TEST = 'resolved-value';
    const bundle = b({ STATIC: 'x', DYN: 'env:__AGENTS_RESOLVE_TEST' });
    expect(resolveBundleEnv(bundle)).toEqual({ STATIC: 'x', DYN: 'resolved-value' });
  });

  it('resolveBundleEnv wraps missing-keychain errors with the remediation hint', () => {
    const bundle = b({ MISSING: 'keychain:NEVER_SET' });
    expect(() => resolveBundleEnv(bundle)).toThrow(/agents secrets add unit MISSING/);
  });

  it('keychainItemsForBundle enumerates keychain-backed keys only', () => {
    const bundle = b({
      A: 'literal',
      B: 'keychain:KEY_B',
      C: 'env:SHELL',
      D: 'keychain:KEY_D',
    });
    const items = keychainItemsForBundle(bundle);
    expect(items.map((i) => i.key).sort()).toEqual(['B', 'D']);
    expect(items.find((i) => i.key === 'B')?.item).toBe('agents-cli.secrets.unit.KEY_B');
  });
});
