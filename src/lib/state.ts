/**
 * Filesystem layout and persistent state for agents-cli.
 *
 * Owns the canonical paths under ~/.agents/, the agents.yaml metadata file,
 * and the per-version resource tracking that survives across CLI invocations.
 * Every module that needs a path or reads/writes agents.yaml goes through here.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import type { Meta } from './types.js';

const HOME = os.homedir();
const AGENTS_DIR = path.join(HOME, '.agents');
const META_FILE = path.join(AGENTS_DIR, 'agents.yaml');
const COMMANDS_DIR = path.join(AGENTS_DIR, 'commands');
const HOOKS_DIR = path.join(AGENTS_DIR, 'hooks');
const SKILLS_DIR = path.join(AGENTS_DIR, 'skills');
const MEMORY_DIR = path.join(AGENTS_DIR, 'memory');
const INSTRUCTIONS_FILE = path.join(AGENTS_DIR, 'instructions.md');
const PROMPTCUTS_FILE = path.join(AGENTS_DIR, 'promptcuts.yaml');
const MCP_CONFIG_FILE = path.join(AGENTS_DIR, 'mcp.json');
const PACKAGES_DIR = path.join(AGENTS_DIR, 'packages');
const ROUTINES_DIR = path.join(AGENTS_DIR, 'routines');
const RUNS_DIR = path.join(AGENTS_DIR, 'runs');
const VERSIONS_DIR = path.join(AGENTS_DIR, 'versions');
const SHIMS_DIR = path.join(AGENTS_DIR, 'shims');
const PERMISSIONS_DIR = path.join(AGENTS_DIR, 'permissions');
const MCP_DIR = path.join(AGENTS_DIR, 'mcp');
const BACKUPS_DIR = path.join(AGENTS_DIR, 'backups');
const SUBAGENTS_DIR = path.join(AGENTS_DIR, 'subagents');
const PLUGINS_DIR = path.join(AGENTS_DIR, 'plugins');
const DRIVE_DIR = path.join(AGENTS_DIR, 'drive');
const SECRETS_DIR = path.join(AGENTS_DIR, 'secrets');

const META_HEADER = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/muqsitnawaz/agents-cli

`;

/** Root of the agents-cli data directory (~/.agents/). */
export function getAgentsDir(): string {
  return AGENTS_DIR;
}

/** Walk up from startPath to find a project-scoped .agents/ directory (skipping ~/.agents/). */
export function getProjectAgentsDir(startPath: string = process.cwd()): string | null {
  let dir = path.resolve(startPath);

  while (true) {
    const agentsPath = path.join(dir, '.agents');
    if (fs.existsSync(agentsPath) && fs.statSync(agentsPath).isDirectory()) {
      // Skip if this is ~/.agents (user scope, not project scope)
      if (agentsPath !== AGENTS_DIR) {
        return agentsPath;
      }
    }

    const isProjectBoundary = fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'agents.yaml'));
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    if (isProjectBoundary) {
      // Check this boundary dir but don't go further
      break;
    }
    dir = parent;
  }

  return null;
}

/** Return all .agents/ directories in scope, project first then user. */
export function getScopedAgentsDirs(startPath: string = process.cwd()): Array<{ scope: 'project' | 'user'; path: string }> {
  const dirs: Array<{ scope: 'project' | 'user'; path: string }> = [];
  const projectDir = getProjectAgentsDir(startPath);
  if (projectDir) {
    dirs.push({ scope: 'project', path: projectDir });
  }
  dirs.push({ scope: 'user', path: AGENTS_DIR });
  return dirs;
}

/** Path to cloned packages (~/.agents/packages/). */
export function getPackagesDir(): string {
  return PACKAGES_DIR;
}

/** Path to routine YAML definitions (~/.agents/routines/). */
export function getRoutinesDir(): string {
  return ROUTINES_DIR;
}

/** Path to routine execution logs (~/.agents/runs/). */
export function getRunsDir(): string {
  return RUNS_DIR;
}

/** Path to installed agent CLI binaries (~/.agents/versions/). */
export function getVersionsDir(): string {
  return VERSIONS_DIR;
}

/** Path to version-switching shim scripts (~/.agents/shims/). */
export function getShimsDir(): string {
  return SHIMS_DIR;
}

/** Path to permission group YAML files (~/.agents/permissions/). */
export function getPermissionsDir(): string {
  return PERMISSIONS_DIR;
}

/** Path to MCP server YAML configs (~/.agents/mcp/). */
export function getMcpDir(): string {
  return MCP_DIR;
}

/** Path to config backups created during version switches (~/.agents/backups/). */
export function getBackupsDir(): string {
  return BACKUPS_DIR;
}

/** Path to subagent definition directories (~/.agents/subagents/). */
export function getSubagentsDir(): string {
  return SUBAGENTS_DIR;
}

/** Path to plugin bundles (~/.agents/plugins/). */
export function getPluginsDir(): string {
  return PLUGINS_DIR;
}

/** Path to synced remote session data (~/.agents/drive/). */
export function getDriveDir(): string {
  return DRIVE_DIR;
}

/** Path to encrypted secret bundles (~/.agents/secrets/). */
export function getSecretsDir(): string {
  return SECRETS_DIR;
}

/** Path to slash command markdown files (~/.agents/commands/). */
export function getCommandsDir(): string {
  return COMMANDS_DIR;
}

/** Path to hook script directories (~/.agents/hooks/). */
export function getHooksDir(): string {
  return HOOKS_DIR;
}

/** Path to skill bundles (~/.agents/skills/). */
export function getSkillsDir(): string {
  return SKILLS_DIR;
}

/** Path to memory/rules files (~/.agents/memory/). */
export function getMemoryDir(): string {
  return MEMORY_DIR;
}

/** Path to the global instructions file (~/.agents/instructions.md). */
export function getInstructionsPath(): string {
  return INSTRUCTIONS_FILE;
}

/**
 * Path to ~/.agents/promptcuts.yaml — the canonical, version-independent
 * source for prompt shortcuts. The expand-promptcuts hook reads directly
 * from this file, so it survives agent-version upgrades without any sync.
 */
export function getPromptcutsPath(): string {
  return PROMPTCUTS_FILE;
}

/** Path to the legacy MCP config JSON (~/.agents/mcp.json). */
export function getMcpConfigPath(): string {
  return MCP_CONFIG_FILE;
}

/** Create the ~/.agents/ directory tree if any subdirectories are missing. */
export function ensureAgentsDir(): void {
  const opts = { recursive: true, mode: 0o700 } as const;
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, opts);
  }
  if (!fs.existsSync(PACKAGES_DIR)) {
    fs.mkdirSync(PACKAGES_DIR, opts);
  }
  if (!fs.existsSync(ROUTINES_DIR)) {
    fs.mkdirSync(ROUTINES_DIR, opts);
  }
  if (!fs.existsSync(RUNS_DIR)) {
    fs.mkdirSync(RUNS_DIR, opts);
  }
  if (!fs.existsSync(VERSIONS_DIR)) {
    fs.mkdirSync(VERSIONS_DIR, opts);
  }
  if (!fs.existsSync(SHIMS_DIR)) {
    fs.mkdirSync(SHIMS_DIR, opts);
  }
  if (!fs.existsSync(COMMANDS_DIR)) {
    fs.mkdirSync(COMMANDS_DIR, opts);
  }
  if (!fs.existsSync(HOOKS_DIR)) {
    fs.mkdirSync(HOOKS_DIR, opts);
  }
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, opts);
  }
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, opts);
  }
  if (!fs.existsSync(PERMISSIONS_DIR)) {
    fs.mkdirSync(PERMISSIONS_DIR, opts);
  }
  if (!fs.existsSync(SUBAGENTS_DIR)) {
    fs.mkdirSync(SUBAGENTS_DIR, opts);
  }
  if (!fs.existsSync(DRIVE_DIR)) {
    fs.mkdirSync(DRIVE_DIR, opts);
  }
  try { fs.chmodSync(AGENTS_DIR, 0o700); } catch {}
}


/** Return an empty Meta object used when no agents.yaml exists yet. */
export function createDefaultMeta(): Meta {
  return {};
}

let metaCache: { mtime: number; meta: Meta } | null = null;

/** Read and cache ~/.agents/agents.yaml, migrating from the legacy meta.yaml format if needed. */
export function readMeta(): Meta {
  ensureAgentsDir();

  // Migration: check for old meta.yaml
  const oldMetaFile = path.join(AGENTS_DIR, 'meta.yaml');
  if (fs.existsSync(oldMetaFile) && !fs.existsSync(META_FILE)) {
    try {
      const content = fs.readFileSync(oldMetaFile, 'utf-8');
      const parsed = yaml.parse(content) as any;
      const meta: Meta = {};

      // Migrate versions.*.default -> agents.*
      if (parsed.versions) {
        meta.agents = {};
        for (const [agent, state] of Object.entries(parsed.versions)) {
          const s = state as any;
          if (s?.default) {
            (meta.agents as Record<string, string>)[agent] = s.default;
          }
        }
      }

      // Migrate registries
      if (parsed.registries) {
        meta.registries = parsed.registries;
      }

      writeMeta(meta);
      // Remove old meta.yaml to prevent stale reads by shims
      try { fs.unlinkSync(oldMetaFile); } catch { /* old meta file cleanup, non-critical */ }
      return meta;
    } catch {
      /* meta.yaml migration failed, continue with fresh state */
    }
  }

  if (fs.existsSync(META_FILE)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(META_FILE).mtimeMs;
    } catch {
      /* file vanished between existsSync and statSync */
    }

    if (metaCache && metaCache.mtime === mtime) {
      return metaCache.meta;
    }

    try {
      const content = fs.readFileSync(META_FILE, 'utf-8');
      const parsed = yaml.parse(content) as Meta;
      const meta = parsed || createDefaultMeta();
      metaCache = { mtime, meta };
      return meta;
    } catch {
      /* agents.yaml corrupt or unreadable, use defaults */
      return createDefaultMeta();
    }
  }

  return createDefaultMeta();
}

/** Serialize and write agents.yaml, invalidating the in-memory cache. */
export function writeMeta(meta: Meta): void {
  ensureAgentsDir();
  const content = META_HEADER + yaml.stringify(meta);
  fs.writeFileSync(META_FILE, content, 'utf-8');
  metaCache = null;
}

/** Shallow-merge updates into agents.yaml and return the new state. */
export function updateMeta(updates: Partial<Meta>): Meta {
  const meta = readMeta();
  const newMeta = { ...meta, ...updates };
  writeMeta(newMeta);
  return newMeta;
}

/** Derive a filesystem-safe local clone path for a package source URL. */
export function getPackageLocalPath(source: string): string {
  const sanitized = source
    .replace(/^gh:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\//g, '-');
  return path.join(PACKAGES_DIR, sanitized);
}

// Version resource tracking helpers

import type { AgentId, ResourceType, VersionResources } from './types.js';

/**
 * Record that resources were synced to a specific version.
 * Creates nested entries if they don't exist (handles existing installs gracefully).
 * Merges with existing resources (uses Set for deduplication).
 */
export function recordVersionResources(
  agent: AgentId,
  version: string,
  resourceType: ResourceType,
  resources: string[]
): void {
  if (resources.length === 0) return;

  const meta = readMeta();
  if (!meta.versions) meta.versions = {};
  if (!meta.versions[agent]) meta.versions[agent] = {};
  if (!meta.versions[agent]![version]) meta.versions[agent]![version] = {};

  const existing = meta.versions[agent]![version][resourceType] || [];
  const merged = [...new Set([...existing, ...resources])];
  meta.versions[agent]![version][resourceType] = merged;

  writeMeta(meta);
}

/**
 * Get tracked resources for a specific version.
 */
export function getVersionResources(
  agent: AgentId,
  version: string
): VersionResources | null {
  const meta = readMeta();
  return meta.versions?.[agent]?.[version] || null;
}

/**
 * Clear resource tracking when a version is removed.
 */
export function clearVersionResources(
  agent: AgentId,
  version: string
): void {
  const meta = readMeta();
  if (meta.versions?.[agent]?.[version]) {
    delete meta.versions[agent]![version];
    // Clean up empty agent entry
    if (Object.keys(meta.versions[agent]!).length === 0) {
      delete meta.versions[agent];
    }
    // Clean up empty versions section
    if (Object.keys(meta.versions).length === 0) {
      delete meta.versions;
    }
    writeMeta(meta);
  }
}
