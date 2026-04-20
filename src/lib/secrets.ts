import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SERVICE_PREFIX = 'agents-cli';

export type SecretProvider = 'keychain' | 'env' | 'file' | 'exec';

export interface SecretRef {
  provider: SecretProvider;
  value: string;
}

const REF_PATTERN = /^(keychain|env|file|exec):(.+)$/s;

// A bundle YAML value is either a string (literal OR provider-prefixed ref) or
// an object of shape {value: string} used to escape a literal that would
// otherwise be parsed as a ref (e.g. a URL that happens to start with 'env:').
export type BundleValue = string | { value: string };

export function parseBundleValue(raw: BundleValue): { literal: string } | { ref: SecretRef } {
  if (typeof raw === 'object' && raw !== null && typeof (raw as any).value === 'string') {
    return { literal: (raw as { value: string }).value };
  }
  if (typeof raw !== 'string') {
    throw new Error(`Invalid bundle value (expected string or {value: string}): ${JSON.stringify(raw)}`);
  }
  const match = REF_PATTERN.exec(raw);
  if (!match) return { literal: raw };
  return { ref: { provider: match[1] as SecretProvider, value: match[2] } };
}

export function serializeRef(ref: SecretRef): string {
  return `${ref.provider}:${ref.value}`;
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Keychain auth is macOS-only for now. Linux/Windows support is planned.');
  }
}

// Keychain items for profile tokens: agents-cli.<provider>.token
export function profileKeychainItem(provider: string): string {
  return `${SERVICE_PREFIX}.${provider}.token`;
}

// Keychain items for secrets bundles: agents-cli.secrets.<bundle>.<KEY>
export function secretsKeychainItem(bundle: string, key: string): string {
  return `${SERVICE_PREFIX}.secrets.${bundle}.${key}`;
}

export function hasKeychainToken(item: string): boolean {
  assertMacOS();
  const result = spawnSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', item, '-w'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

export function getKeychainToken(item: string): string {
  assertMacOS();
  try {
    const token = execFileSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', item, '-w'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!token) {
      throw new Error(`Keychain item '${item}' exists but is empty.`);
    }
    return token;
  } catch (err: any) {
    if (err.status === 44 || /could not be found/i.test(err.stderr?.toString() || '')) {
      throw new Error(`Keychain item '${item}' not found.`);
    }
    throw new Error(`Failed to read keychain item '${item}': ${err.message}`);
  }
}

export function setKeychainToken(item: string, value: string): void {
  assertMacOS();
  if (!value || !value.trim()) {
    throw new Error('Secret value is empty.');
  }
  const user = os.userInfo().username;
  const result = spawnSync(
    'security',
    ['add-generic-password', '-a', user, '-s', item, '-w', value, '-U'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (result.status !== 0) {
    throw new Error(`Failed to write keychain item '${item}': ${result.stderr.toString()}`);
  }
}

export function deleteKeychainToken(item: string): boolean {
  assertMacOS();
  const result = spawnSync(
    'security',
    ['delete-generic-password', '-a', os.userInfo().username, '-s', item],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return result.status === 0;
}

export interface ResolveOptions {
  // When resolving a bundle's keychain ref, we translate the short identifier
  // into the fully namespaced item name. Callers that don't resolve bundle
  // refs (e.g. profiles) pass through with keychainItemFor=undefined.
  keychainItemFor?: (shortId: string) => string;
  // Bundle-level opt-in for exec refs. Off means exec refs throw.
  allowExec?: boolean;
  // Allowlist of parent process env vars that env: refs may read. When
  // undefined, any env var may be read. When set, reads outside the list
  // throw to prevent accidental inheritance of unrelated secrets.
  envAllowlist?: string[];
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function resolveRef(ref: SecretRef, opts: ResolveOptions = {}): string {
  switch (ref.provider) {
    case 'keychain': {
      const item = opts.keychainItemFor ? opts.keychainItemFor(ref.value) : ref.value;
      return getKeychainToken(item);
    }
    case 'env': {
      const name = ref.value;
      if (opts.envAllowlist && !opts.envAllowlist.includes(name)) {
        throw new Error(`env: ref '${name}' not in allowlist.`);
      }
      const val = process.env[name];
      if (val === undefined) {
        throw new Error(`env: ref '${name}' not set in parent environment.`);
      }
      return val;
    }
    case 'file': {
      const target = expandHome(ref.value);
      if (!fs.existsSync(target)) {
        throw new Error(`file: ref '${ref.value}' does not exist.`);
      }
      return fs.readFileSync(target, 'utf-8').trim();
    }
    case 'exec': {
      if (!opts.allowExec) {
        throw new Error(
          `exec: ref '${ref.value}' blocked. Set 'allow_exec: true' in the bundle to enable.`
        );
      }
      // shell: false — the bundle author controls the command; no injection
      // from secret identifiers. Parse a simple space-separated command.
      const parts = ref.value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, '')) || [];
      if (parts.length === 0) {
        throw new Error(`exec: ref '${ref.value}' is empty.`);
      }
      const [cmd, ...args] = parts;
      try {
        return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (err: any) {
        throw new Error(`exec: ref '${ref.value}' failed: ${err.message}`);
      }
    }
  }
}
