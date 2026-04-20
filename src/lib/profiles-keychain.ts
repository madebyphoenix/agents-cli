import { execFileSync, spawnSync } from 'child_process';
import * as os from 'os';

const SERVICE_PREFIX = 'agents-cli';

export function keychainItemName(provider: string): string {
  return `${SERVICE_PREFIX}.${provider}.token`;
}

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Keychain auth is macOS-only for now. Linux/Windows support is planned.');
  }
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
      throw new Error(`Keychain item '${item}' not found. Run: agents profiles login <profile>`);
    }
    throw new Error(`Failed to read keychain item '${item}': ${err.message}`);
  }
}

export function setKeychainToken(item: string, value: string): void {
  assertMacOS();
  if (!value || !value.trim()) {
    throw new Error('Token is empty.');
  }
  const user = os.userInfo().username;
  // -U upserts (update if exists, add if not). -w sets the password from arg.
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
