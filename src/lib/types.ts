export type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'openclaw';

export interface AgentConfig {
  id: AgentId;
  name: string;
  cliCommand: string;
  npmPackage: string;
  installScript?: string;
  configDir: string;
  homeFiles?: string[]; // Files at $HOME level that need per-version symlink switching (e.g., '.claude.json')
  commandsDir: string;
  commandsSubdir: string;
  skillsDir: string;
  hooksDir: string;
  instructionsFile: string;
  format: 'markdown' | 'toml';
  variableSyntax: string;
  supportsHooks: boolean;
  nativeAgentsSkillsDir?: boolean;
  capabilities: {
    hooks: boolean;
    mcp: boolean;
    allowlist: boolean;
    skills: boolean;
    commands: boolean;
    plugins: boolean;
  };
}

export interface McpServerConfig {
  command?: string;
  url?: string;
  transport: 'stdio' | 'http' | 'sse';
  scope: 'user' | 'project';
  agents?: AgentId[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface HookConfig {
  name: string;
  script: string;
  dataFile?: string;
}

export interface ManifestHook {
  script: string;
  events: string[];
  timeout?: number;
  matcher?: string;
  agents?: AgentId[];
}

export interface HookResourceEntry {
  name: string;
  events: string[];
  timeout?: number;
  matcher?: string;
}

export interface InstalledHook {
  name: string;
  path: string;
  dataFile?: string;
  scope: 'user' | 'project';
  agent: AgentId;
}

export interface DriveManifestEntry {
  description?: string;
  project?: string;
}

export interface Manifest {
  agents?: Partial<Record<AgentId, string>>;
  dependencies?: Record<string, string>;
  mcp?: Record<string, McpServerConfig>;
  drives?: Record<string, DriveManifestEntry>;
  defaults?: {
    method?: 'symlink' | 'copy';
    scope?: 'global' | 'project';
    agents?: AgentId[];
  };
}

export interface CommandInstallation {
  path: string;
  method: 'symlink' | 'copy';
}

export interface SkillMetadata {
  name: string;
  description: string;
  author?: string;
  version?: string;
  license?: string;
  keywords?: string[];
}

export interface SkillInstallation {
  path: string;
  method: 'symlink' | 'copy';
}

export interface SkillState {
  source: string;
  ruleCount: number;
  installations: Partial<Record<AgentId, SkillInstallation>>;
}

export interface InstalledSkill {
  name: string;
  path: string;
  metadata: SkillMetadata;
  ruleCount: number;
  scope: 'user' | 'project';
  agent: AgentId;
}

export interface RepoInfo {
  source: string;
  branch: string;
  commit: string;
  lastSync: string;
}

export const DEFAULT_SYSTEM_REPO = 'gh:muqsitnawaz/.agents';

// Registry types
export type RegistryType = 'mcp' | 'skill';

export interface RegistryConfig {
  url: string;
  enabled: boolean;
  apiKey?: string;
}

export const DEFAULT_REGISTRIES: Record<RegistryType, Record<string, RegistryConfig>> = {
  mcp: {
    official: {
      url: 'https://registry.modelcontextprotocol.io/v0',
      enabled: true,
    },
  },
  skill: {
    // No public API available yet - skills.sh has no programmatic access
    // When available: official: { url: 'https://api.skills.sh/v1', enabled: true }
  },
};

// MCP Registry API response types
export interface McpPackage {
  registry_name: string;
  name: string;
  description?: string;
  runtime?: 'node' | 'python' | 'docker' | 'binary';
  transport?: 'stdio' | 'sse' | 'streamable-http';
  packageArguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpServerEntry {
  name: string;
  description?: string;
  repository?: {
    url: string;
    source?: string;
    directory?: string;
  };
  version_detail?: {
    version: string;
  };
  packages?: McpPackage[];
  _meta?: Record<string, unknown>;
}

export interface McpRegistryResponse {
  servers: Array<{ server: McpServerEntry }>;
  metadata?: {
    count: number;
    next_cursor?: string;
  };
}

// Skill Registry API response types (for future use)
export interface SkillEntry {
  name: string;
  description?: string;
  source: string;
  path?: string;
  author?: string;
  installs?: number;
  tags?: string[];
}

export interface SkillRegistryResponse {
  skills: SkillEntry[];
  metadata?: {
    count: number;
    next_cursor?: string;
  };
}

// Unified search result
export interface RegistrySearchResult {
  name: string;
  description?: string;
  type: 'mcp' | 'skill';
  source: string;
  registry: string;
  version?: string;
  installs?: number;
}

// Resolved package for installation
export interface ResolvedPackage {
  type: 'mcp' | 'skill' | 'git';
  source: string;
  mcpEntry?: McpServerEntry;
  skillEntry?: SkillEntry;
}

// Resource tracking per agent version
export type ResourceType = 'commands' | 'skills' | 'hooks' | 'memory' | 'mcp' | 'permissions' | 'subagents' | 'plugins';

export interface VersionResources {
  commands?: string[];
  skills?: string[];
  hooks?: string[];
  memory?: string[];
  mcp?: string[];
  permissions?: string[];
  subagents?: string[];
  plugins?: string[];
}

// Plugin types
export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  agents?: AgentId[];
}

export interface DiscoveredPlugin {
  name: string;
  root: string;
  manifest: PluginManifest;
  skills: string[];
  hooks: string[];
  scripts: string[];
}

// Subagent types
export interface SubagentFrontmatter {
  name: string;
  description: string;
  model?: string;
  color?: string;
}

export interface DiscoveredSubagent {
  name: string;
  path: string;
  files: string[];
  agentMd: string;
  frontmatter: SubagentFrontmatter;
}

export interface InstalledSubagent {
  name: string;
  path: string;
  files: string[];
  frontmatter: SubagentFrontmatter;
}

export interface Meta {
  agents?: Partial<Record<AgentId, string>>;
  registries?: Record<RegistryType, Record<string, RegistryConfig>>;
  // Per-version resource tracking
  versions?: Partial<Record<AgentId, Record<string, VersionResources>>>;
  // Git remote source URL (when ~/.agents/ is a git repo)
  source?: string;
}

export interface SyncOptions {
  agents?: AgentId[];
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  skipClis?: boolean;
  skipMcp?: boolean;
}

// Permission types - canonical format uses Claude's syntax
export interface PermissionSet {
  name: string;
  description?: string;
  allow: string[];
  deny?: string[];
  additionalDirectories?: string[];
}

export interface InstalledPermission {
  name: string;
  path: string;
  set: PermissionSet;
}

// Agent-specific permission formats
export interface ClaudePermissions {
  permissions: {
    allow: string[];
    deny: string[];
    additionalDirectories?: string[];
  };
}

export interface OpenCodePermissions {
  permission: {
    bash: Record<string, 'allow' | 'deny' | 'ask'>;
  };
}

export interface CodexPermissions {
  approval_policy?: 'on-request' | 'on-failure' | 'never';
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  sandbox_workspace_write?: {
    network_access?: boolean;
    writable_roots?: string[];
  };
}
