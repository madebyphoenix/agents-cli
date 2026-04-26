/**
 * agents.yaml manifest reading, writing, and serialization.
 *
 * The manifest file (agents.yaml) is the central configuration for version defaults,
 * repository overrides, dependencies, and MCP server declarations.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { Manifest } from './types.js';
import { safeJoin } from './paths.js';

/** Canonical filename for the manifest in any agents repo or project root. */
export const MANIFEST_FILENAME = 'agents.yaml';

/** Parse a YAML string into a typed Manifest object. */
export function parseManifest(content: string): Manifest {
  return yaml.parse(content) as Manifest;
}

/** Serialize a Manifest object to a YAML string with 2-space indentation. */
export function serializeManifest(manifest: Manifest): string {
  return yaml.stringify(manifest, { indent: 2 });
}

/** Read and parse agents.yaml from a directory. Returns null if the file does not exist. */
export function readManifest(repoPath: string): Manifest | null {
  const manifestPath = safeJoin(repoPath, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const content = fs.readFileSync(manifestPath, 'utf-8');
  return parseManifest(content);
}

/** Write a Manifest object to agents.yaml in the given directory. */
export function writeManifest(repoPath: string, manifest: Manifest): void {
  const manifestPath = safeJoin(repoPath, MANIFEST_FILENAME);
  const content = serializeManifest(manifest);
  fs.writeFileSync(manifestPath, content, 'utf-8');
}

/** Create a Manifest with sensible defaults for a fresh agents repo. */
export function createDefaultManifest(): Manifest {
  return {
    agents: {},
    dependencies: {},
    mcp: {},
    defaults: {
      method: 'symlink',
      scope: 'global',
      agents: ['claude', 'codex', 'gemini', 'cursor', 'opencode'],
    },
  };
}
