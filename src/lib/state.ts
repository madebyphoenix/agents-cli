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
const MCP_CONFIG_FILE = path.join(AGENTS_DIR, 'mcp.json');
const PACKAGES_DIR = path.join(AGENTS_DIR, 'packages');
const CRON_DIR = path.join(AGENTS_DIR, 'cron');
const RUNS_DIR = path.join(AGENTS_DIR, 'runs');
const DRIVES_DIR = path.join(AGENTS_DIR, 'drives');
const VERSIONS_DIR = path.join(AGENTS_DIR, 'versions');
const SHIMS_DIR = path.join(AGENTS_DIR, 'shims');
const PERMISSIONS_DIR = path.join(AGENTS_DIR, 'permissions');
const MCP_DIR = path.join(AGENTS_DIR, 'mcp');
const BACKUPS_DIR = path.join(AGENTS_DIR, 'backups');
const SUBAGENTS_DIR = path.join(AGENTS_DIR, 'subagents');

const META_HEADER = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/muqsitnawaz/agents-cli

`;

export function getAgentsDir(): string {
  return AGENTS_DIR;
}

export function getPackagesDir(): string {
  return PACKAGES_DIR;
}

export function getCronDir(): string {
  return CRON_DIR;
}

export function getRunsDir(): string {
  return RUNS_DIR;
}

export function getDrivesDir(): string {
  return DRIVES_DIR;
}

export function getVersionsDir(): string {
  return VERSIONS_DIR;
}

export function getShimsDir(): string {
  return SHIMS_DIR;
}

export function getPermissionsDir(): string {
  return PERMISSIONS_DIR;
}

export function getMcpDir(): string {
  return MCP_DIR;
}

export function getBackupsDir(): string {
  return BACKUPS_DIR;
}

export function getSubagentsDir(): string {
  return SUBAGENTS_DIR;
}

export function getCommandsDir(): string {
  return COMMANDS_DIR;
}

export function getHooksDir(): string {
  return HOOKS_DIR;
}

export function getSkillsDir(): string {
  return SKILLS_DIR;
}

export function getMemoryDir(): string {
  return MEMORY_DIR;
}

export function getInstructionsPath(): string {
  return INSTRUCTIONS_FILE;
}

export function getMcpConfigPath(): string {
  return MCP_CONFIG_FILE;
}

export function ensureAgentsDir(): void {
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
  if (!fs.existsSync(PACKAGES_DIR)) {
    fs.mkdirSync(PACKAGES_DIR, { recursive: true });
  }
  if (!fs.existsSync(CRON_DIR)) {
    fs.mkdirSync(CRON_DIR, { recursive: true });
  }
  if (!fs.existsSync(RUNS_DIR)) {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
  }
  if (!fs.existsSync(DRIVES_DIR)) {
    fs.mkdirSync(DRIVES_DIR, { recursive: true });
  }
  if (!fs.existsSync(VERSIONS_DIR)) {
    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  }
  if (!fs.existsSync(SHIMS_DIR)) {
    fs.mkdirSync(SHIMS_DIR, { recursive: true });
  }
  if (!fs.existsSync(COMMANDS_DIR)) {
    fs.mkdirSync(COMMANDS_DIR, { recursive: true });
  }
  if (!fs.existsSync(HOOKS_DIR)) {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
  }
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
  if (!fs.existsSync(PERMISSIONS_DIR)) {
    fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });
  }
  if (!fs.existsSync(SUBAGENTS_DIR)) {
    fs.mkdirSync(SUBAGENTS_DIR, { recursive: true });
  }
}


export function createDefaultMeta(): Meta {
  return {};
}

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
      try { fs.unlinkSync(oldMetaFile); } catch {}
      return meta;
    } catch {
      // Ignore migration errors
    }
  }

  if (fs.existsSync(META_FILE)) {
    try {
      const content = fs.readFileSync(META_FILE, 'utf-8');
      const parsed = yaml.parse(content) as Meta;
      return parsed || createDefaultMeta();
    } catch {
      return createDefaultMeta();
    }
  }

  return createDefaultMeta();
}

export function writeMeta(meta: Meta): void {
  ensureAgentsDir();
  const content = META_HEADER + yaml.stringify(meta);
  fs.writeFileSync(META_FILE, content, 'utf-8');
}

export function updateMeta(updates: Partial<Meta>): Meta {
  const meta = readMeta();
  const newMeta = { ...meta, ...updates };
  writeMeta(newMeta);
  return newMeta;
}

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
