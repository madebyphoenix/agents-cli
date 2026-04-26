import * as path from 'path';

const SAFE_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/**
 * Resolve base + name while preventing path-traversal attacks.
 * Throws if name contains separators, starts with a dot, or escapes base.
 */
export function safeJoin(base: string, name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid name: ${name}`);
  const resolved = path.resolve(base, name);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error(`Path escape: ${name}`);
  return resolved;
}
