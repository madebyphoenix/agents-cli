import * as fs from 'fs';
import * as path from 'path';
import type { SessionMeta, SessionArtifact } from './types.js';
import { parseSession } from './parse.js';

const WRITE_TOOLS = new Set([
  'Write', 'Edit', 'write_file', 'edit_file', 'create_file', 'replace', 'patch',
]);

export function discoverArtifacts(meta: SessionMeta): SessionArtifact[] {
  let events;
  try {
    events = parseSession(meta.filePath, meta.agent);
  } catch {
    return [];
  }

  // Map path -> last write event (later occurrence wins for dedup)
  const latestByPath = new Map<string, { tool: string; timestamp: string }>();

  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    const tool = event.tool || '';
    if (!WRITE_TOOLS.has(tool)) continue;

    const p = event.path
      || event.args?.file_path
      || event.args?.path
      || event.args?.filePath
      || '';
    if (!p) continue;

    latestByPath.set(p, { tool, timestamp: event.timestamp });
  }

  const artifacts: SessionArtifact[] = [];
  for (const [p, { tool, timestamp }] of latestByPath) {
    let exists = false;
    let sizeBytes: number | undefined;
    try {
      const stat = fs.statSync(p);
      exists = true;
      sizeBytes = stat.size;
    } catch {
      // file gone or inaccessible
    }

    artifacts.push({
      path: p,
      tool,
      timestamp,
      exists,
      sizeBytes: exists ? sizeBytes : undefined,
      sessionId: meta.id,
    });
  }

  return artifacts;
}

export function readArtifact(artifact: SessionArtifact): string {
  return fs.readFileSync(artifact.path, 'utf-8');
}

export function resolveArtifact(
  artifacts: SessionArtifact[],
  name: string,
): SessionArtifact | null {
  // Exact path match
  const exact = artifacts.find(a => a.path === name);
  if (exact) return exact;

  // Basename match
  const byBase = artifacts.filter(a => path.basename(a.path) === name);
  if (byBase.length === 1) return byBase[0];
  if (byBase.length > 1) return byBase[0];

  // Path suffix match (e.g. "src/foo.ts")
  const bySuffix = artifacts.filter(a => a.path.endsWith('/' + name) || a.path === name);
  if (bySuffix.length >= 1) return bySuffix[0];

  return null;
}
