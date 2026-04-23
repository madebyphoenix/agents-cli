/**
 * macOS Keychain integration for secure credential storage.
 *
 * Wraps the `security` command to store and retrieve API keys and tokens
 * in the system keychain rather than environment variables or plaintext files.
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SERVICE_PREFIX = 'agents-cli';

/** Supported secret resolution backends. */
export type SecretProvider = 'keychain' | 'env' | 'file' | 'exec';

/** A typed reference to a secret, consisting of a provider and a provider-specific value. */
export interface SecretRef {
  provider: SecretProvider;
  value: string;
}

const REF_PATTERN = /^(keychain|env|file|exec):(.+)$/s;

/**
 * A bundle YAML value: either a string (literal or provider-prefixed ref) or
 * an object `{value: string}` used to escape a literal that would otherwise
 * be parsed as a ref (e.g. a URL that happens to start with 'env:').
 */
export type BundleValue = string | { value: string };

/** Parse a bundle YAML value into either a literal string or a typed secret ref. */
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

/** Serialize a secret ref back to its `provider:value` string form. */
export function serializeRef(ref: SecretRef): string {
  return `${ref.provider}:${ref.value}`;
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Keychain auth is macOS-only for now. Linux/Windows support is planned.');
  }
}

/** Build the keychain item name for a profile provider token. */
export function profileKeychainItem(provider: string): string {
  return `${SERVICE_PREFIX}.${provider}.token`;
}

/** Build the keychain item name for a secrets-bundle key. */
export function secretsKeychainItem(bundle: string, key: string): string {
  return `${SERVICE_PREFIX}.secrets.${bundle}.${key}`;
}

/** Check if a keychain item exists (macOS only). */
export function hasKeychainToken(item: string): boolean {
  assertMacOS();
  const result = spawnSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', item, '-w'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

/** Retrieve a secret value from the macOS Keychain. Throws if not found. */
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

/** Store or update a secret value in the macOS Keychain. */
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
    throw new Error(`Failed to write keychain item '${item}' (exit ${result.status}).`);
  }
}

/** Delete a keychain item. Returns true if it existed. */
export function deleteKeychainToken(item: string): boolean {
  assertMacOS();
  const result = spawnSync(
    'security',
    ['delete-generic-password', '-a', os.userInfo().username, '-s', item],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return result.status === 0;
}

/** Options controlling how secret refs are resolved. */
export interface ResolveOptions {
  /** Translate a short keychain ID to a fully namespaced item name. */
  keychainItemFor?: (shortId: string) => string;
  /** Allow exec: refs. When false (default), exec refs throw. */
  allowExec?: boolean;
  /** Restrict env: refs to this allowlist. When undefined, any env var may be read. */
  envAllowlist?: string[];
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Resolve a secret ref to its plaintext value using the appropriate provider. */
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
