import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import type { Meta, RepoConfig, RepoName } from './types.js';
import { REPO_PRIORITIES, DEFAULT_SYSTEM_REPO } from './types.js';

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
const REPOS_DIR = path.join(AGENTS_DIR, 'repos');
const JOBS_DIR = path.join(AGENTS_DIR, 'jobs');
const RUNS_DIR = path.join(AGENTS_DIR, 'runs');
const DRIVES_DIR = path.join(AGENTS_DIR, 'drives');
const VERSIONS_DIR = path.join(AGENTS_DIR, 'versions');
const SHIMS_DIR = path.join(AGENTS_DIR, 'shims');
const PERMISSIONS_DIR = path.join(AGENTS_DIR, 'permissions');

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

export function getReposDir(): string {
  return REPOS_DIR;
}

export function getJobsDir(): string {
  return JOBS_DIR;
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
  if (!fs.existsSync(REPOS_DIR)) {
    fs.mkdirSync(REPOS_DIR, { recursive: true });
  }
  if (!fs.existsSync(JOBS_DIR)) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
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
}

const GITIGNORE_CONTENT = `# Local-only directories (not synced to repo)
versions/
shims/
repos/
runs/
jobs/
drives/
packages/
swarm/
agents/

# Local state files
*.json
*.log
*.pid
meta.yaml
`;

/**
 * Ensure .gitignore exists in ~/.agents/ with correct content.
 */
export function ensureGitignore(): void {
  const gitignorePath = path.join(AGENTS_DIR, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
  }
}

export function createDefaultMeta(): Meta {
  return {
    repos: {},
  };
}

export function readMeta(): Meta {
  ensureAgentsDir();

  // Migration: check for old meta.yaml
  const oldMetaFile = path.join(AGENTS_DIR, 'meta.yaml');
  if (fs.existsSync(oldMetaFile) && !fs.existsSync(META_FILE)) {
    try {
      const content = fs.readFileSync(oldMetaFile, 'utf-8');
      const parsed = yaml.parse(content) as any;
      const meta: Meta = { repos: {} };

      // Migrate scopes -> repos
      if (parsed.scopes) {
        meta.repos = parsed.scopes;
      } else if (parsed.repo) {
        meta.repos.user = {
          source: parsed.repo.source,
          branch: parsed.repo.branch || 'main',
          commit: parsed.repo.commit || 'unknown',
          lastSync: parsed.repo.lastSync || new Date().toISOString(),
          priority: REPO_PRIORITIES.user,
        };
      }

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
      return meta;
    } catch {
      // Ignore migration errors
    }
  }

  // Migration: check for old state.json
  const oldStateFile = path.join(AGENTS_DIR, 'state.json');
  if (fs.existsSync(oldStateFile) && !fs.existsSync(META_FILE)) {
    try {
      const oldContent = fs.readFileSync(oldStateFile, 'utf-8');
      const oldState = JSON.parse(oldContent);
      const meta: Meta = { repos: {} };

      if (oldState.source) {
        meta.repos.user = {
          source: oldState.source,
          branch: 'main',
          commit: 'unknown',
          lastSync: oldState.lastSync || new Date().toISOString(),
          priority: REPO_PRIORITIES.user,
        };
      }

      writeMeta(meta);
      fs.unlinkSync(oldStateFile);
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

export function getRepoLocalPath(source: string): string {
  // Use 'default' for the system repo to keep paths clean
  if (source === DEFAULT_SYSTEM_REPO) {
    return path.join(REPOS_DIR, 'default');
  }

  const sanitized = source
    .replace(/^gh:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\//g, '-');
  return path.join(REPOS_DIR, sanitized);
}

export function getPackageLocalPath(source: string): string {
  const sanitized = source
    .replace(/^gh:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\//g, '-');
  return path.join(PACKAGES_DIR, sanitized);
}

// Repo management helpers

export function getRepo(repoName: RepoName): RepoConfig | null {
  const meta = readMeta();
  return meta.repos[repoName] || null;
}

export function setRepo(repoName: RepoName, config: RepoConfig): void {
  const meta = readMeta();
  meta.repos[repoName] = config;
  writeMeta(meta);
}

export function removeRepo(repoName: RepoName): boolean {
  const meta = readMeta();
  if (meta.repos[repoName]) {
    delete meta.repos[repoName];
    writeMeta(meta);
    return true;
  }
  return false;
}

export function getReposByPriority(): Array<{ name: RepoName; config: RepoConfig }> {
  const meta = readMeta();
  return Object.entries(meta.repos)
    .map(([name, config]) => ({ name, config }))
    .sort((a, b) => a.config.priority - b.config.priority);
}

export function getHighestPriorityRepo(): { name: RepoName; config: RepoConfig } | null {
  const repos = getReposByPriority();
  return repos.length > 0 ? repos[repos.length - 1] : null;
}

export function getRepoPriority(repoName: RepoName): number {
  if (repoName in REPO_PRIORITIES) {
    return REPO_PRIORITIES[repoName as keyof typeof REPO_PRIORITIES];
  }
  // Custom repos get priority 20 + order added
  const meta = readMeta();
  const customRepos = Object.keys(meta.repos).filter(
    (s) => !['system', 'user', 'project'].includes(s)
  );
  const index = customRepos.indexOf(repoName);
  return index >= 0 ? 20 + index : 25;
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
