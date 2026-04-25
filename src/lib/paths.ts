import path from 'path';

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Join base + name, rejecting names that escape the base directory or contain
 * path traversal sequences. Throws on invalid input.
 */
export function safeJoin(base: string, name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid name: ${name}`);
  const resolved = path.resolve(base, name);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error(`Path escape: ${name}`);
  return resolved;
}
