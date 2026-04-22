/**
 * Memory file compilation -- resolving @-imports into a single flat file.
 *
 * Agents that do not natively resolve `@path/to/file` imports (Codex, Gemini)
 * need a pre-compiled memory file with all imports inlined. This module
 * handles that expansion.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { AGENTS } from './agents.js';
import type { AgentId } from './types.js';
import { getMemoryDir, getVersionsDir } from './state.js';

// Match `@path` preceded by start-of-string or whitespace. This avoids
// matching emails ("foo@bar.com") and the middle of words. The leading
// whitespace (if any) is captured so we can preserve it in the output.
const IMPORT_RE = /(^|\s)@(\S+)/g;
const MAX_DEPTH = 5;
const COMPILED_HEADER =
  '<!-- Auto-compiled by agents-cli from ~/.agents/memory/AGENTS.md + imports.\n' +
  '     Edit the source files under ~/.agents/memory/ — edits to this file will be overwritten on next sync. -->\n\n';

/** Sidecar manifest recording source file hashes for staleness detection. */
export interface CompileManifest {
  compiledAt: string;
  sources: { path: string; sha256: string }[];
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Replace fenced code blocks (```...```) and inline code spans (`...`) with
 * placeholders. Claude Code's @-import parser ignores these regions, so we
 * must too.
 */
function protectCodeRegions(content: string): { protectedText: string; fences: string[]; inlines: string[] } {
  const fences: string[] = [];
  let withFences = content.replace(/```[\s\S]*?```/g, (match) => {
    fences.push(match);
    return `\x00FENCE_${fences.length - 1}\x00`;
  });
  const inlines: string[] = [];
  withFences = withFences.replace(/`[^`\n]+`/g, (match) => {
    inlines.push(match);
    return `\x00INLINE_${inlines.length - 1}\x00`;
  });
  return { protectedText: withFences, fences, inlines };
}

function restoreCodeRegions(content: string, fences: string[], inlines: string[]): string {
  let restored = content.replace(/\x00INLINE_(\d+)\x00/g, (_, i) => inlines[Number(i)]);
  restored = restored.replace(/\x00FENCE_(\d+)\x00/g, (_, i) => fences[Number(i)]);
  return restored;
}

/** Result of resolving @-imports in a memory file. */
export interface ResolveResult {
  /** Fully-inlined content. */
  content: string;
  /** Absolute paths of every file read during resolution (including the root). */
  sources: string[];
}

/**
 * Expand all `@path/to/file` imports in `content`, recursively up to
 * MAX_DEPTH. Imports inside fenced code blocks and inline code spans are
 * left alone, matching Claude Code's parser. Missing files are left as-is
 * (silent skip), matching the documented behavior.
 *
 * Relative paths resolve against `baseDir`; absolute and tilde-prefixed
 * paths resolve against the filesystem root / home directory.
 */
export function resolveImports(content: string, baseDir: string): ResolveResult {
  const sources: string[] = [];
  const seen = new Set<string>();

  function expand(text: string, currentDir: string, depth: number): string {
    if (depth > MAX_DEPTH) return text;

    const { protectedText, fences, inlines } = protectCodeRegions(text);

    const expanded = protectedText.replace(IMPORT_RE, (match, lead: string, rawPath: string) => {
      const tildeExpanded = expandTilde(rawPath);
      const resolved = path.isAbsolute(tildeExpanded)
        ? tildeExpanded
        : path.resolve(currentDir, tildeExpanded);

      if (seen.has(resolved)) return lead; // cycle break — keep leading whitespace
      if (!fs.existsSync(resolved)) return match; // preserve literal including lead

      seen.add(resolved);
      sources.push(resolved);
      const body = fs.readFileSync(resolved, 'utf8');
      return lead + expand(body, path.dirname(resolved), depth + 1);
    });

    return restoreCodeRegions(expanded, fences, inlines);
  }

  const result = expand(content, baseDir, 0);
  return { content: result, sources };
}

/** True if the agent's native runtime resolves `@path` imports in its memory file. */
export function supportsMemoryImports(agentId: AgentId): boolean {
  return !!AGENTS[agentId].capabilities.memoryImports;
}

function getCompiledMemoryPath(agentId: AgentId, version: string): string {
  const agentConfig = AGENTS[agentId];
  const versionHome = path.join(getVersionsDir(), agentId, version, 'home');
  return path.join(versionHome, `.${agentId}`, agentConfig.instructionsFile);
}

function getManifestPath(compiledPath: string): string {
  return compiledPath + '.manifest.json';
}

/**
 * Fast staleness check. Returns true when:
 *  - the compiled file or its manifest is missing
 *  - any recorded source file is missing
 *  - any recorded source's sha256 no longer matches
 *
 * For agents that support @-imports natively, always returns false — there's
 * nothing to compile.
 */
export function isMemoryStale(agentId: AgentId, version: string): boolean {
  if (supportsMemoryImports(agentId)) return false;

  const compiledPath = getCompiledMemoryPath(agentId, version);
  const manifestPath = getManifestPath(compiledPath);
  if (!fs.existsSync(compiledPath) || !fs.existsSync(manifestPath)) return true;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CompileManifest;
    for (const src of manifest.sources) {
      if (!fs.existsSync(src.path)) return true;
      if (sha256(fs.readFileSync(src.path, 'utf8')) !== src.sha256) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Resolve the source `memory/AGENTS.md` (with all @-imports expanded) and
 * write the result into the version home, alongside a sidecar manifest that
 * records source file hashes for staleness detection.
 *
 * Agents that natively resolve @-imports are skipped (no-op) — their sync
 * uses the standard copyFileSync path in `syncResourcesToVersion`.
 */
export function compileMemoryForAgent(
  agentId: AgentId,
  version: string
): { compiled: boolean; compiledPath: string; sources: number } {
  if (supportsMemoryImports(agentId)) {
    return { compiled: false, compiledPath: '', sources: 0 };
  }

  const memoryDir = getMemoryDir();
  const sourceAgents = path.join(memoryDir, 'AGENTS.md');
  if (!fs.existsSync(sourceAgents)) {
    return { compiled: false, compiledPath: '', sources: 0 };
  }

  const rootContent = fs.readFileSync(sourceAgents, 'utf8');
  const { content, sources } = resolveImports(rootContent, memoryDir);

  const compiledPath = getCompiledMemoryPath(agentId, version);
  fs.mkdirSync(path.dirname(compiledPath), { recursive: true });
  fs.writeFileSync(compiledPath, COMPILED_HEADER + content);

  const allSources = [sourceAgents, ...sources];
  const manifest: CompileManifest = {
    compiledAt: new Date().toISOString(),
    sources: allSources.map(p => ({ path: p, sha256: sha256(fs.readFileSync(p, 'utf8')) })),
  };
  fs.writeFileSync(getManifestPath(compiledPath), JSON.stringify(manifest, null, 2));

  return { compiled: true, compiledPath, sources: allSources.length };
}

/**
 * Recompile memory if stale. Safe to call on every agent invocation — the
 * staleness check is fast (sha256 of 8-10 small files, ~10-20ms). Returns
 * true if a recompile happened, false otherwise.
 */
export function ensureMemoryFresh(agentId: AgentId, version: string): boolean {
  if (supportsMemoryImports(agentId)) return false;
  if (!isMemoryStale(agentId, version)) return false;
  const result = compileMemoryForAgent(agentId, version);
  return result.compiled;
}
