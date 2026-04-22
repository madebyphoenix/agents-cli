/**
 * Secret bundles -- named sets of keychain-backed environment variables.
 *
 * Each bundle is a YAML file in ~/.agents/secrets/ declaring key names.
 * Values live in the macOS Keychain and are injected into the agent's
 * environment at spawn time via `agents run --secrets <bundle>`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getSecretsDir } from './state.js';
import {
  parseBundleValue,
  resolveRef,
  secretsKeychainItem,
  type BundleValue,
  type SecretRef,
} from './secrets.js';

/** A named set of environment variable definitions backed by various secret providers. */
export interface SecretsBundle {
  name: string;
  description?: string;
  allow_exec?: boolean;
  vars: Record<string, BundleValue>;
}

const BUNDLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,48}$/i;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a bundle name against the allowed pattern. Throws on invalid input. */
export function validateBundleName(name: string): void {
  if (!BUNDLE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid bundle name '${name}'. Use letters, digits, dash, underscore (max 48 chars).`);
  }
}

export function validateEnvKey(key: string): void {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid environment variable name '${key}'. Must match [A-Za-z_][A-Za-z0-9_]*.`);
  }
}

function bundlePath(name: string): string {
  return path.join(getSecretsDir(), `${name}.yml`);
}

export function bundleExists(name: string): boolean {
  return fs.existsSync(bundlePath(name));
}

export function readBundle(name: string): SecretsBundle {
  validateBundleName(name);
  const file = bundlePath(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Secrets bundle '${name}' not found.`);
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = yaml.parse(raw) as Partial<SecretsBundle>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Bundle '${name}' is malformed.`);
  }
  const bundle: SecretsBundle = {
    name: parsed.name || name,
    description: parsed.description,
    allow_exec: Boolean(parsed.allow_exec),
    vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
  };
  for (const key of Object.keys(bundle.vars)) {
    validateEnvKey(key);
  }
  return bundle;
}

export function writeBundle(bundle: SecretsBundle): void {
  validateBundleName(bundle.name);
  for (const key of Object.keys(bundle.vars)) {
    validateEnvKey(key);
  }
  const dir = getSecretsDir();
  fs.mkdirSync(dir, { recursive: true });
  const body = yaml.stringify({
    name: bundle.name,
    description: bundle.description,
    allow_exec: bundle.allow_exec ? true : undefined,
    vars: bundle.vars,
  });
  const file = bundlePath(bundle.name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);
}

export function deleteBundle(name: string): boolean {
  validateBundleName(name);
  const file = bundlePath(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

export function listBundles(): SecretsBundle[] {
  const dir = getSecretsDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const bundles: SecretsBundle[] = [];
  for (const entry of entries) {
    const name = entry.replace(/\.(yml|yaml)$/, '');
    try {
      bundles.push(readBundle(name));
    } catch {
      // Skip malformed bundles; surfaced via `agents secrets view <name>`.
    }
  }
  return bundles.sort((a, b) => a.name.localeCompare(b.name));
}

// Classify each var for UI rendering.
export interface BundleEntryInfo {
  key: string;
  kind: 'literal' | 'keychain' | 'env' | 'file' | 'exec';
  detail: string; // ref target, or empty for literal
}

export function describeBundle(bundle: SecretsBundle): BundleEntryInfo[] {
  const out: BundleEntryInfo[] = [];
  for (const [key, raw] of Object.entries(bundle.vars)) {
    const parsed = parseBundleValue(raw);
    if ('literal' in parsed) {
      out.push({ key, kind: 'literal', detail: '' });
    } else {
      out.push({ key, kind: parsed.ref.provider, detail: parsed.ref.value });
    }
  }
  return out;
}

// Walk the bundle and produce a flat env map. Keychain refs are translated via
// the bundle-scoped naming scheme so two bundles with the same short ID never
// collide. Throws on the first missing secret so `agents run` fails loudly
// rather than silently injecting empty strings.
export function resolveBundleEnv(bundle: SecretsBundle): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(bundle.vars)) {
    const parsed = parseBundleValue(raw);
    if ('literal' in parsed) {
      env[key] = parsed.literal;
      continue;
    }
    try {
      env[key] = resolveRef(parsed.ref, {
        allowExec: bundle.allow_exec,
        keychainItemFor: (shortId: string) => secretsKeychainItem(bundle.name, shortId),
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (parsed.ref.provider === 'keychain' && /not found/.test(msg)) {
        throw new Error(
          `${msg} Run: agents secrets set ${bundle.name} ${key}`
        );
      }
      throw new Error(`Bundle '${bundle.name}' key '${key}': ${msg}`);
    }
  }
  return env;
}

// Build a keychain ref expression from a bundle+key pair, for storage in YAML.
export function keychainRef(key: string): string {
  return `keychain:${key}`;
}

// Iterate all keychain-backed keys in a bundle for cleanup on rm/unset.
export function keychainItemsForBundle(bundle: SecretsBundle): Array<{ key: string; item: string }> {
  const items: Array<{ key: string; item: string }> = [];
  for (const [key, raw] of Object.entries(bundle.vars)) {
    const parsed = parseBundleValue(raw);
    if ('ref' in parsed && parsed.ref.provider === 'keychain') {
      items.push({ key, item: secretsKeychainItem(bundle.name, parsed.ref.value) });
    }
  }
  return items;
}

// Parse a dotenv string into key=value pairs, preserving last-wins on duplicates.
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (ENV_KEY_PATTERN.test(key)) {
      out[key] = value;
    }
  }
  return out;
}

export type { SecretRef };
