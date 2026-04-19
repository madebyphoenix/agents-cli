import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentId } from './types.js';
import { getVersionDir } from './versions.js';

export interface ModelPerCloud {
  firstParty: string;
  bedrock?: string;
  vertex?: string;
  foundry?: string;
  anthropicAws?: string;
  mantle?: string | null;
}

export interface ReasoningLevel {
  effort: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  description?: string;
  /** alias label (e.g. "opus", "sonnet", "haiku") that resolves to this id */
  alias?: string;
  /** true if this is the agent's default model */
  isDefault?: boolean;
  /** Per-cloud routing IDs (claude only) */
  perCloud?: ModelPerCloud;
  /** Reasoning levels (codex; claude exposes via --effort with global levels) */
  reasoningLevels?: ReasoningLevel[];
  /** Default reasoning level if applicable */
  defaultReasoningLevel?: string;
}

export interface ModelCatalog {
  agent: AgentId;
  version: string;
  source: 'bundle' | 'binary';
  sourcePath: string;
  models: ModelInfo[];
  /** Aliases from the CLI's alias map (claude only): { opus: "claude-opus-4-7", ... } */
  aliases: Record<string, string>;
}

const CACHE_PATH = path.join(os.homedir(), '.agents', '.models-cache.json');

interface CacheEntry {
  sourcePath: string;
  mtime: number;
  catalog: ModelCatalog;
}

let memoryCache: Record<string, CacheEntry> | null = null;

function cacheKey(agent: AgentId, version: string): string {
  return `${agent}@${version}`;
}

function loadCache(): Record<string, CacheEntry> {
  if (memoryCache) return memoryCache;
  try {
    memoryCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    memoryCache = {};
  }
  return memoryCache!;
}

function saveCache(): void {
  if (!memoryCache) return;
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(memoryCache));
  } catch {
    /* best-effort */
  }
}

/**
 * Locate the bundle (cli.js) or native binary that holds the installed model
 * catalog for a given (agent, version). Returns null if not found.
 */
export function locateModelSource(
  agent: AgentId,
  version: string
): { path: string; kind: 'bundle' | 'binary' } | null {
  const versionDir = getVersionDir(agent, version);

  if (agent === 'claude') {
    const bundle = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(bundle)) return { path: bundle, kind: 'bundle' };
    // 2.1.113+ ships a native Mach-O binary
    const bin = path.join(versionDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(bin)) return { path: bin, kind: 'binary' };
    return null;
  }

  if (agent === 'codex') {
    const triple = currentTargetTriple();
    if (triple) {
      const platformPkg = path.join(
        versionDir,
        'node_modules',
        '@openai',
        `codex-${triple.includes('apple') ? 'darwin' : triple.includes('linux') ? 'linux' : 'win32'}-${triple.includes('aarch64') ? 'arm64' : 'x64'}`,
        'vendor',
        triple,
        'codex',
        'codex'
      );
      if (fs.existsSync(platformPkg)) return { path: platformPkg, kind: 'binary' };
    }
    // 0.98 layout: binary inside @openai/codex itself
    const triples = ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl'];
    for (const t of triples) {
      const p = path.join(versionDir, 'node_modules', '@openai', 'codex', 'vendor', t, 'codex', 'codex');
      if (fs.existsSync(p)) return { path: p, kind: 'binary' };
    }
    return null;
  }

  return null;
}

function currentTargetTriple(): string | null {
  switch (`${process.platform}-${process.arch}`) {
    case 'darwin-arm64': return 'aarch64-apple-darwin';
    case 'darwin-x64': return 'x86_64-apple-darwin';
    case 'linux-x64': return 'x86_64-unknown-linux-musl';
    case 'linux-arm64': return 'aarch64-unknown-linux-musl';
    case 'win32-x64': return 'x86_64-pc-windows-msvc';
    case 'win32-arm64': return 'aarch64-pc-windows-msvc';
    default: return null;
  }
}

/**
 * Read a file and return only the printable ASCII runs of length >= minLen,
 * joined with newlines. Mirrors `strings(1)` for portability.
 */
function extractStrings(filePath: string, minLen = 6): string {
  const buf = fs.readFileSync(filePath);
  const out: string[] = [];
  let run: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // printable ASCII (incl. tab, newline)
    if ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a) {
      run.push(b);
    } else {
      if (run.length >= minLen) out.push(Buffer.from(run).toString('utf8'));
      run = [];
    }
  }
  if (run.length >= minLen) out.push(Buffer.from(run).toString('utf8'));
  return out.join('\n');
}

/**
 * Extract Claude's model catalog from its bundle/binary.
 *
 * Bundle/binary contains:
 *   - alias map: {opus:"claude-opus-4-7",sonnet:"claude-sonnet-4-6",haiku:"..."}
 *   - per-cloud maps: {firstParty:"claude-opus-4-5-...",bedrock:"...",vertex:"...",...}
 *   - constants: {OPUS_ID:"...",OPUS_NAME:"...",SONNET_ID:"...",...}
 */
function extractClaudeCatalog(text: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  const aliases: Record<string, string> = {};

  const aliasMapMatch = text.match(/\{opus:"(claude-[^"]+)",sonnet:"(claude-[^"]+)",haiku:"(claude-[^"]+)"\}/);
  if (aliasMapMatch) {
    aliases.opus = aliasMapMatch[1];
    aliases.sonnet = aliasMapMatch[2];
    aliases.haiku = aliasMapMatch[3];
  }

  const constMatch = text.match(/\{OPUS_ID:"([^"]+)",OPUS_NAME:"([^"]+)",SONNET_ID:"([^"]+)",SONNET_NAME:"([^"]+)",HAIKU_ID:"([^"]+)",HAIKU_NAME:"([^"]+)"/);
  const displayNames: Record<string, string> = {};
  if (constMatch) {
    displayNames[constMatch[1]] = constMatch[2];
    displayNames[constMatch[3]] = constMatch[4];
    displayNames[constMatch[5]] = constMatch[6];
  }

  const perCloud: Record<string, ModelPerCloud> = {};
  const perCloudRe = /\{firstParty:"(claude-[^"]+)",bedrock:"([^"]+)"(?:,vertex:"([^"]+)")?(?:,foundry:"([^"]+)")?(?:,anthropicAws:"([^"]+)")?(?:,mantle:(?:null|"([^"]*)"))?\}/g;
  let m: RegExpExecArray | null;
  while ((m = perCloudRe.exec(text)) !== null) {
    const id = m[1];
    if (perCloud[id]) continue;
    perCloud[id] = {
      firstParty: id,
      bedrock: m[2],
      vertex: m[3],
      foundry: m[4],
      anthropicAws: m[5],
      mantle: m[6] ?? null,
    };
  }

  const allIds = new Set<string>([
    ...Object.values(aliases),
    ...Object.keys(displayNames),
    ...Object.keys(perCloud),
  ]);

  const aliasReverse: Record<string, string> = {};
  for (const [a, id] of Object.entries(aliases)) aliasReverse[id] = a;

  const defaults = new Set(Object.values(aliases));

  const models: ModelInfo[] = Array.from(allIds)
    .filter((id) => /^claude-(opus|sonnet|haiku)-/.test(id))
    .sort()
    .map((id) => ({
      id,
      displayName: displayNames[id],
      alias: aliasReverse[id],
      isDefault: defaults.has(id),
      perCloud: perCloud[id],
    }));

  return { models, aliases };
}

/**
 * Extract Codex's model catalog. Catalog is embedded as JSON-ish records:
 *   "slug": "...", "display_name": "...", "description": "...",
 *   "default_reasoning_level": "...", "supported_reasoning_levels": [...]
 */
function extractCodexCatalog(text: string): { models: ModelInfo[]; aliases: Record<string, string> } {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  // Anchor on each "slug" then walk forward for the related fields within ~1500 chars
  const slugRe = /"slug":\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = slugRe.exec(text)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const window = text.slice(Math.max(0, m.index - 200), m.index + 1500);

    const displayMatch = window.match(/"display_name":\s*"([^"]+)"/);
    const descMatch = window.match(/"description":\s*"([^"]+)"/);
    const defaultLevelMatch = window.match(/"default_reasoning_level":\s*"([^"]+)"/);

    const reasoningLevels: ReasoningLevel[] = [];
    const levelsBlock = window.match(/"supported_reasoning_levels":\s*\[([\s\S]*?)\]/);
    if (levelsBlock) {
      const levelRe = /\{\s*"effort":\s*"([^"]+)"(?:,\s*"description":\s*"([^"]+)")?\s*\}/g;
      let lm: RegExpExecArray | null;
      while ((lm = levelRe.exec(levelsBlock[1])) !== null) {
        reasoningLevels.push({ effort: lm[1], description: lm[2] });
      }
    }

    models.push({
      id: slug,
      displayName: displayMatch?.[1],
      description: descMatch?.[1],
      defaultReasoningLevel: defaultLevelMatch?.[1],
      reasoningLevels: reasoningLevels.length > 0 ? reasoningLevels : undefined,
    });
  }

  return { models, aliases: {} };
}

/**
 * Build (or load from cache) the model catalog for a specific (agent, version).
 * Cache is keyed on binary mtime, so re-extracts automatically when the user
 * upgrades or reinstalls a version.
 */
export function getModelCatalog(agent: AgentId, version: string): ModelCatalog | null {
  const src = locateModelSource(agent, version);
  if (!src) return null;

  let mtime = 0;
  try {
    mtime = fs.statSync(src.path).mtimeMs;
  } catch {
    return null;
  }

  const cache = loadCache();
  const key = cacheKey(agent, version);
  const cached = cache[key];
  if (cached && cached.sourcePath === src.path && cached.mtime === mtime) {
    return cached.catalog;
  }

  const text = extractStrings(src.path);
  const { models, aliases } =
    agent === 'claude' ? extractClaudeCatalog(text)
    : agent === 'codex' ? extractCodexCatalog(text)
    : { models: [], aliases: {} };

  const catalog: ModelCatalog = {
    agent,
    version,
    source: src.kind,
    sourcePath: src.path,
    models,
    aliases,
  };

  cache[key] = { sourcePath: src.path, mtime, catalog };
  saveCache();
  return catalog;
}

export interface ResolvedModel {
  /** The model string to forward to the CLI (canonical id when we can resolve, else passed through unchanged). */
  forwarded: string;
  /** The canonical id, when we could resolve the input through the alias map. */
  canonical?: string;
  /** Warning to surface to the user (e.g. "model X not in known catalog for v Y"). */
  warning?: string;
}

/**
 * Resolve a user-supplied model string for a specific (agent, version).
 *
 * Pass-through semantics: we never block. If the input doesn't match anything
 * we know about, we forward it as-is and return a warning the caller can log.
 *
 * - If `requested` matches an alias in the catalog (e.g. "opus"), we still
 *   forward the alias (the CLI accepts both), but we report the canonical id
 *   so logs/metadata can record the concrete model.
 * - If `requested` matches a known canonical id, no warning.
 * - If `requested` is unknown to our extractor, we forward it and warn.
 */
export function resolveModel(agent: AgentId, version: string, requested: string): ResolvedModel {
  const catalog = getModelCatalog(agent, version);
  if (!catalog) {
    return { forwarded: requested };
  }

  const aliasTarget = catalog.aliases[requested];
  if (aliasTarget) {
    return { forwarded: requested, canonical: aliasTarget };
  }

  const knownIds = new Set(catalog.models.map((m) => m.id));
  if (knownIds.has(requested)) {
    return { forwarded: requested, canonical: requested };
  }

  // Strip [1m] context-window suffix before checking (Claude appends at runtime)
  const stripped = requested.replace(/\[[^\]]+\]$/, '');
  if (knownIds.has(stripped)) {
    return { forwarded: requested, canonical: requested };
  }

  const suggestions = pickSuggestions(requested, catalog);
  const hint = suggestions.length > 0 ? ` (closest: ${suggestions.join(', ')})` : '';
  return {
    forwarded: requested,
    warning: `model "${requested}" not in known catalog for ${agent}@${version}; forwarding as-is${hint}`,
  };
}

function pickSuggestions(requested: string, catalog: ModelCatalog): string[] {
  const all = [...catalog.models.map((m) => m.id), ...Object.keys(catalog.aliases)];
  return all
    .map((id) => ({ id, score: similarity(requested, id) }))
    .filter((s) => s.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.id);
}

function similarity(a: string, b: string): number {
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;
  const distance = levenshtein(longer, shorter);
  return (longer.length - distance) / longer.length;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Build the per-agent CLI flags for a unified reasoning effort knob.
 *
 * Both Claude (`--effort`) and Codex (`-c model_reasoning_effort=...`) expose a
 * reasoning intensity dial. Inputs accepted: low | medium | high | xhigh | max.
 * Codex only supports low/medium/high; xhigh and max are clamped to high.
 */
export function buildReasoningFlags(agent: AgentId, level: string): string[] {
  const normalized = level.toLowerCase();
  if (agent === 'claude') {
    return ['--effort', normalized];
  }
  if (agent === 'codex') {
    const codexLevel = (normalized === 'xhigh' || normalized === 'max') ? 'high' : normalized;
    return ['-c', `model_reasoning_effort=${codexLevel}`];
  }
  return [];
}
