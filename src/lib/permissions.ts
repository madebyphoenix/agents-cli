import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import type {
  AgentId,
  PermissionSet,
  InstalledPermission,
  ClaudePermissions,
  OpenCodePermissions,
  CodexPermissions,
} from './types.js';
import { getPermissionsDir, ensureAgentsDir } from './state.js';
import { AGENTS } from './agents.js';

const HOME = os.homedir();

// Agents that support permissions
export const PERMISSIONS_CAPABLE_AGENTS: AgentId[] = ['claude', 'codex', 'opencode'];

/**
 * Ensure central permissions directory exists.
 */
export function ensurePermissionsDir(): void {
  const dir = getPermissionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Parse a permission set from a YAML file.
 */
export function parsePermissionSet(filePath: string): PermissionSet | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    return {
      name: parsed.name || path.basename(filePath, path.extname(filePath)),
      description: parsed.description,
      allow: Array.isArray(parsed.allow) ? parsed.allow : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny : [],
    };
  } catch {
    return null;
  }
}

/**
 * Discover permission sets from a repository.
 */
export function discoverPermissionsFromRepo(repoPath: string): Array<{ name: string; path: string; set: PermissionSet }> {
  const results: Array<{ name: string; path: string; set: PermissionSet }> = [];

  // Look for permissions in common locations
  const searchPaths = [
    path.join(repoPath, 'permissions'),
    path.join(repoPath, 'agent-permissions'),
    repoPath,
  ];

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) continue;

    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

        const filePath = path.join(searchPath, entry.name);
        const set = parsePermissionSet(filePath);
        if (set) {
          results.push({
            name: set.name,
            path: filePath,
            set,
          });
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  return results;
}

/**
 * List installed permission sets from central storage.
 */
export function listInstalledPermissions(): InstalledPermission[] {
  ensureAgentsDir();
  const dir = getPermissionsDir();

  if (!fs.existsSync(dir)) {
    return [];
  }

  const results: InstalledPermission[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

      const filePath = path.join(dir, entry.name);
      const set = parsePermissionSet(filePath);
      if (set) {
        results.push({
          name: set.name,
          path: filePath,
          set,
        });
      }
    }
  } catch {
    // Ignore errors
  }

  return results;
}

/**
 * Get a specific permission set by name.
 */
export function getPermissionSet(name: string): InstalledPermission | null {
  const dir = getPermissionsDir();

  for (const ext of ['.yml', '.yaml']) {
    const filePath = path.join(dir, name + ext);
    if (fs.existsSync(filePath)) {
      const set = parsePermissionSet(filePath);
      if (set) {
        return { name: set.name, path: filePath, set };
      }
    }
  }

  return null;
}

/**
 * Install a permission set to central storage.
 */
export function installPermissionSet(
  sourcePath: string,
  name: string
): { success: boolean; error?: string } {
  ensurePermissionsDir();

  const set = parsePermissionSet(sourcePath);
  if (!set) {
    return { success: false, error: 'Invalid permission file' };
  }

  const targetPath = path.join(getPermissionsDir(), name + '.yml');

  try {
    fs.copyFileSync(sourcePath, targetPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Remove a permission set from central storage.
 */
export function removePermissionSet(name: string): { success: boolean; error?: string } {
  const dir = getPermissionsDir();

  for (const ext of ['.yml', '.yaml']) {
    const filePath = path.join(dir, name + ext);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    }
  }

  return { success: false, error: `Permission set '${name}' not found` };
}

// ============================================================================
// Agent-specific converters
// ============================================================================

/**
 * Convert canonical permission set to Claude format.
 * Claude uses: { permissions: { allow: ["Bash(*)", "Read(**)"], deny: [] } }
 */
export function convertToClaudeFormat(set: PermissionSet): ClaudePermissions {
  return {
    permissions: {
      allow: [...set.allow],
      deny: set.deny ? [...set.deny] : [],
    },
  };
}

/**
 * Parse canonical permission pattern to extract tool and pattern.
 * "Bash(git *)" -> { tool: "bash", pattern: "git *" }
 * "Read(**)" -> { tool: "read", pattern: "**" }
 */
function parseCanonicalPattern(permission: string): { tool: string; pattern: string } | null {
  const match = permission.match(/^(\w+)\((.+)\)$/);
  if (!match) return null;
  return { tool: match[1].toLowerCase(), pattern: match[2] };
}

/**
 * Convert canonical permission set to OpenCode format.
 * OpenCode uses: { permission: { bash: { "git *": "allow", "rm *": "deny" } } }
 */
export function convertToOpenCodeFormat(set: PermissionSet): OpenCodePermissions {
  const bashPermissions: Record<string, 'allow' | 'deny' | 'ask'> = {};

  // Process allow list
  for (const perm of set.allow) {
    const parsed = parseCanonicalPattern(perm);
    if (parsed && parsed.tool === 'bash') {
      bashPermissions[parsed.pattern] = 'allow';
    }
  }

  // Process deny list
  if (set.deny) {
    for (const perm of set.deny) {
      const parsed = parseCanonicalPattern(perm);
      if (parsed && parsed.tool === 'bash') {
        bashPermissions[parsed.pattern] = 'deny';
      }
    }
  }

  return {
    permission: {
      bash: bashPermissions,
    },
  };
}

/**
 * Convert canonical permission set to Codex format.
 * Codex uses coarse-grained modes, so we infer the best fit.
 */
export function convertToCodexFormat(set: PermissionSet, cwd?: string): CodexPermissions {
  const result: CodexPermissions = {};

  // Check for broad bash permissions -> suggest full-auto
  const hasBroadBash = set.allow.some((p) => {
    const parsed = parseCanonicalPattern(p);
    return parsed && parsed.tool === 'bash' && (parsed.pattern === '*' || parsed.pattern === '**');
  });

  if (hasBroadBash) {
    result.approval_policy = 'never';
    result.sandbox_mode = 'workspace-write';
  } else if (set.allow.length > 0) {
    result.approval_policy = 'on-failure';
    result.sandbox_mode = 'workspace-write';
  }

  // Check for network/web permissions
  const hasNetwork = set.allow.some((p) => {
    const parsed = parseCanonicalPattern(p);
    return parsed && (parsed.tool === 'websearch' || parsed.tool === 'webfetch');
  });

  if (hasNetwork) {
    result.sandbox_workspace_write = {
      network_access: true,
    };
  }

  return result;
}

// ============================================================================
// Read agent permissions from native configs
// ============================================================================

/**
 * Strip JSON comments for JSONC parsing.
 */
function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let escape = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (escape) {
      result += char;
      escape = false;
      i++;
      continue;
    }

    if (char === '\\' && inString) {
      result += char;
      escape = true;
      i++;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      if (char === '/' && next === '/') {
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
        continue;
      }
      if (char === '/' && next === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Read Claude's current permissions from settings.json.
 */
export function readClaudePermissions(scope: 'user' | 'project' = 'user', cwd?: string): ClaudePermissions | null {
  const configPath = scope === 'user'
    ? path.join(HOME, '.claude', 'settings.json')
    : path.join(cwd || process.cwd(), '.claude', 'settings.json');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    if (config.permissions) {
      return {
        permissions: {
          allow: config.permissions.allow || [],
          deny: config.permissions.deny || [],
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read OpenCode's current permissions from opencode.jsonc.
 */
export function readOpenCodePermissions(scope: 'user' | 'project' = 'user', cwd?: string): OpenCodePermissions | null {
  const configPath = scope === 'user'
    ? path.join(HOME, '.opencode', 'opencode.jsonc')
    : path.join(cwd || process.cwd(), '.opencode', 'opencode.jsonc');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
    const config = JSON.parse(content);
    if (config.permission) {
      return {
        permission: {
          bash: config.permission.bash || {},
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read Codex's current permissions from config.toml.
 */
export function readCodexPermissions(scope: 'user' | 'project' = 'user', cwd?: string): CodexPermissions | null {
  const configPath = scope === 'user'
    ? path.join(HOME, '.codex', 'config.toml')
    : path.join(cwd || process.cwd(), '.codex', 'config.toml');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = TOML.parse(content) as Record<string, unknown>;

    const result: CodexPermissions = {};

    if (config.approval_policy) {
      result.approval_policy = config.approval_policy as CodexPermissions['approval_policy'];
    }
    if (config.sandbox_mode) {
      result.sandbox_mode = config.sandbox_mode as CodexPermissions['sandbox_mode'];
    }
    if (config.sandbox_workspace_write) {
      const sw = config.sandbox_workspace_write as Record<string, unknown>;
      result.sandbox_workspace_write = {
        network_access: sw.network_access as boolean | undefined,
        writable_roots: sw.writable_roots as string[] | undefined,
      };
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Read agent permissions based on agent ID.
 */
export function readAgentPermissions(
  agentId: AgentId,
  scope: 'user' | 'project' = 'user',
  cwd?: string
): ClaudePermissions | OpenCodePermissions | CodexPermissions | null {
  switch (agentId) {
    case 'claude':
      return readClaudePermissions(scope, cwd);
    case 'opencode':
      return readOpenCodePermissions(scope, cwd);
    case 'codex':
      return readCodexPermissions(scope, cwd);
    default:
      return null;
  }
}

// ============================================================================
// Apply permissions to agents
// ============================================================================

/**
 * Apply a permission set to Claude's settings.json.
 */
export function applyClaudePermissions(
  set: PermissionSet,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  merge: boolean = true
): { success: boolean; error?: string } {
  const configDir = scope === 'user'
    ? path.join(HOME, '.claude')
    : path.join(cwd || process.cwd(), '.claude');
  const configPath = path.join(configDir, 'settings.json');

  try {
    // Ensure directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Read existing config
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }

    const newPermissions = convertToClaudeFormat(set);

    if (merge && config.permissions) {
      const existing = config.permissions as { allow?: string[]; deny?: string[] };
      const mergedAllow = new Set([...(existing.allow || []), ...newPermissions.permissions.allow]);
      const mergedDeny = new Set([...(existing.deny || []), ...newPermissions.permissions.deny]);
      config.permissions = {
        allow: [...mergedAllow],
        deny: [...mergedDeny],
      };
    } else {
      config.permissions = newPermissions.permissions;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Apply a permission set to OpenCode's opencode.jsonc.
 */
export function applyOpenCodePermissions(
  set: PermissionSet,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  merge: boolean = true
): { success: boolean; error?: string } {
  const configDir = scope === 'user'
    ? path.join(HOME, '.opencode')
    : path.join(cwd || process.cwd(), '.opencode');
  const configPath = path.join(configDir, 'opencode.jsonc');

  try {
    // Ensure directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Read existing config
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
      config = JSON.parse(content);
    }

    const newPermissions = convertToOpenCodeFormat(set);

    if (merge && config.permission) {
      const existing = config.permission as { bash?: Record<string, string> };
      config.permission = {
        ...existing,
        bash: {
          ...(existing.bash || {}),
          ...newPermissions.permission.bash,
        },
      };
    } else {
      config.permission = newPermissions.permission;
    }

    // Write without comments (they'll be lost)
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Apply a permission set to Codex's config.toml.
 */
export function applyCodexPermissions(
  set: PermissionSet,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  merge: boolean = true
): { success: boolean; error?: string } {
  const configDir = scope === 'user'
    ? path.join(HOME, '.codex')
    : path.join(cwd || process.cwd(), '.codex');
  const configPath = path.join(configDir, 'config.toml');

  try {
    // Ensure directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Read existing config
    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = TOML.parse(content) as Record<string, unknown>;
    }

    const newPermissions = convertToCodexFormat(set, cwd);

    // Merge or replace
    if (newPermissions.approval_policy) {
      config.approval_policy = newPermissions.approval_policy;
    }
    if (newPermissions.sandbox_mode) {
      config.sandbox_mode = newPermissions.sandbox_mode;
    }
    if (newPermissions.sandbox_workspace_write) {
      const existing = config.sandbox_workspace_write as Record<string, unknown> | undefined;
      config.sandbox_workspace_write = merge
        ? { ...existing, ...newPermissions.sandbox_workspace_write }
        : newPermissions.sandbox_workspace_write;
    }

    fs.writeFileSync(configPath, TOML.stringify(config as any), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Apply a permission set to an agent (global config).
 */
export function applyPermissionsToAgent(
  agentId: AgentId,
  set: PermissionSet,
  scope: 'user' | 'project' = 'user',
  cwd?: string,
  merge: boolean = true
): { success: boolean; error?: string } {
  switch (agentId) {
    case 'claude':
      return applyClaudePermissions(set, scope, cwd, merge);
    case 'opencode':
      return applyOpenCodePermissions(set, scope, cwd, merge);
    case 'codex':
      return applyCodexPermissions(set, scope, cwd, merge);
    default:
      return { success: false, error: `Agent '${agentId}' does not support permissions` };
  }
}

/**
 * Apply a permission set to a specific version's home directory.
 * This writes to {versionHome}/.{agent}/settings.json (or equivalent).
 */
export function applyPermissionsToVersion(
  agentId: AgentId,
  set: PermissionSet,
  versionHome: string,
  merge: boolean = true
): { success: boolean; error?: string } {
  const configDir = path.join(versionHome, `.${agentId}`);

  try {
    fs.mkdirSync(configDir, { recursive: true });

    if (agentId === 'claude') {
      const configPath = path.join(configDir, 'settings.json');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      const newPermissions = convertToClaudeFormat(set);

      if (merge && config.permissions) {
        const existing = config.permissions as { allow?: string[]; deny?: string[] };
        const mergedAllow = new Set([...(existing.allow || []), ...newPermissions.permissions.allow]);
        const mergedDeny = new Set([...(existing.deny || []), ...newPermissions.permissions.deny]);
        config.permissions = {
          allow: [...mergedAllow],
          deny: [...mergedDeny],
        };
      } else {
        config.permissions = newPermissions.permissions;
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true };
    }

    if (agentId === 'opencode') {
      const configPath = path.join(configDir, 'opencode.jsonc');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
        config = JSON.parse(content);
      }

      const newPermissions = convertToOpenCodeFormat(set);

      if (merge && config.permission) {
        const existing = config.permission as { bash?: Record<string, string> };
        config.permission = {
          ...existing,
          bash: {
            ...(existing.bash || {}),
            ...newPermissions.permission.bash,
          },
        };
      } else {
        config.permission = newPermissions.permission;
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true };
    }

    if (agentId === 'codex') {
      const configPath = path.join(configDir, 'config.toml');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        config = TOML.parse(content) as Record<string, unknown>;
      }

      const newPermissions = convertToCodexFormat(set);

      if (newPermissions.approval_policy) {
        config.approval_policy = newPermissions.approval_policy;
      }
      if (newPermissions.sandbox_mode) {
        config.sandbox_mode = newPermissions.sandbox_mode;
      }
      if (newPermissions.sandbox_workspace_write) {
        const existing = config.sandbox_workspace_write as Record<string, unknown> | undefined;
        config.sandbox_workspace_write = merge
          ? { ...existing, ...newPermissions.sandbox_workspace_write }
          : newPermissions.sandbox_workspace_write;
      }

      fs.writeFileSync(configPath, TOML.stringify(config as any), 'utf-8');
      return { success: true };
    }

    return { success: false, error: `Agent '${agentId}' does not support permissions` };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ============================================================================
// Export canonical format from agent
// ============================================================================

/**
 * Convert Claude permissions back to canonical format.
 */
export function claudeToCanonical(perms: ClaudePermissions): PermissionSet {
  return {
    name: 'exported',
    allow: perms.permissions.allow,
    deny: perms.permissions.deny.length > 0 ? perms.permissions.deny : undefined,
  };
}

/**
 * Convert OpenCode permissions back to canonical format.
 */
export function openCodeToCanonical(perms: OpenCodePermissions): PermissionSet {
  const allow: string[] = [];
  const deny: string[] = [];

  for (const [pattern, action] of Object.entries(perms.permission.bash)) {
    if (action === 'allow') {
      allow.push(`Bash(${pattern})`);
    } else if (action === 'deny') {
      deny.push(`Bash(${pattern})`);
    }
  }

  return {
    name: 'exported',
    allow,
    deny: deny.length > 0 ? deny : undefined,
  };
}

/**
 * Convert Codex permissions back to canonical format (approximation).
 */
export function codexToCanonical(perms: CodexPermissions): PermissionSet {
  const allow: string[] = [];

  if (perms.approval_policy === 'never' || perms.sandbox_mode === 'danger-full-access') {
    allow.push('Bash(*)');
    allow.push('Read(**)');
    allow.push('Write(**)');
    allow.push('Edit(**)');
  } else if (perms.sandbox_mode === 'workspace-write') {
    allow.push('Bash(*)');
    allow.push('Read(**)');
  }

  if (perms.sandbox_workspace_write?.network_access) {
    allow.push('WebSearch(*)');
    allow.push('WebFetch(*)');
  }

  return {
    name: 'exported',
    allow,
  };
}

/**
 * Export agent's current permissions to canonical format.
 */
export function exportAgentPermissions(
  agentId: AgentId,
  scope: 'user' | 'project' = 'user',
  cwd?: string
): PermissionSet | null {
  const perms = readAgentPermissions(agentId, scope, cwd);
  if (!perms) return null;

  switch (agentId) {
    case 'claude':
      return claudeToCanonical(perms as ClaudePermissions);
    case 'opencode':
      return openCodeToCanonical(perms as OpenCodePermissions);
    case 'codex':
      return codexToCanonical(perms as CodexPermissions);
    default:
      return null;
  }
}

/**
 * Export permissions from a specific config file path to canonical format.
 * Auto-detects agent type from file path/name.
 */
export function exportPermissionsFromPath(filePath: string): PermissionSet | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);
  const parentDir = path.basename(path.dirname(filePath));

  // Detect agent type from path
  let agentId: AgentId | null = null;

  if (fileName === 'settings.json' && parentDir === '.claude') {
    agentId = 'claude';
  } else if (fileName === 'opencode.jsonc' || parentDir === '.opencode') {
    agentId = 'opencode';
  } else if (fileName === 'config.toml' && parentDir === '.codex') {
    agentId = 'codex';
  } else if (filePath.includes('.claude')) {
    agentId = 'claude';
  } else if (filePath.includes('.opencode')) {
    agentId = 'opencode';
  } else if (filePath.includes('.codex')) {
    agentId = 'codex';
  }

  if (!agentId) {
    return null;
  }

  try {
    switch (agentId) {
      case 'claude': {
        const config = JSON.parse(content);
        if (config.permissions) {
          return claudeToCanonical({
            permissions: {
              allow: config.permissions.allow || [],
              deny: config.permissions.deny || [],
            },
          });
        }
        return null;
      }
      case 'opencode': {
        // Strip JSONC comments
        const jsonContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const config = JSON.parse(jsonContent);
        if (config.permission) {
          return openCodeToCanonical({
            permission: {
              bash: config.permission.bash || {},
            },
          });
        }
        return null;
      }
      case 'codex': {
        const config = TOML.parse(content) as Record<string, unknown>;
        const perms: CodexPermissions = {};
        if (config.approval_policy) {
          perms.approval_policy = config.approval_policy as CodexPermissions['approval_policy'];
        }
        if (config.sandbox_mode) {
          perms.sandbox_mode = config.sandbox_mode as CodexPermissions['sandbox_mode'];
        }
        if (config.sandbox_workspace_write) {
          const sw = config.sandbox_workspace_write as Record<string, unknown>;
          perms.sandbox_workspace_write = {
            network_access: sw.network_access as boolean | undefined,
            writable_roots: sw.writable_roots as string[] | undefined,
          };
        }
        return codexToCanonical(perms);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Save a permission set to central storage.
 */
export function savePermissionSet(set: PermissionSet): { success: boolean; error?: string } {
  ensurePermissionsDir();
  const filePath = path.join(getPermissionsDir(), set.name + '.yml');

  try {
    const content = yaml.stringify({
      name: set.name,
      description: set.description,
      allow: set.allow,
      deny: set.deny,
    });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

const DEFAULT_PERMISSION_SET_NAME = 'default';

/**
 * Get the default permission set from central storage.
 */
export function getDefaultPermissionSet(): PermissionSet {
  const existing = getPermissionSet(DEFAULT_PERMISSION_SET_NAME);
  if (existing) {
    return existing.set;
  }
  return {
    name: DEFAULT_PERMISSION_SET_NAME,
    description: 'Default permission set',
    allow: [],
    deny: [],
  };
}

/**
 * Compute diff between existing and new permissions.
 * Returns { added, existing, removed } for both allow and deny rules.
 */
export function computePermissionsDiff(
  existing: PermissionSet,
  incoming: PermissionSet
): {
  allow: { added: string[]; existing: string[] };
  deny: { added: string[]; existing: string[] };
} {
  const existingAllowSet = new Set(existing.allow);
  const existingDenySet = new Set(existing.deny || []);

  const allowAdded = incoming.allow.filter((r) => !existingAllowSet.has(r));
  const allowExisting = incoming.allow.filter((r) => existingAllowSet.has(r));

  const incomingDeny = incoming.deny || [];
  const denyAdded = incomingDeny.filter((r) => !existingDenySet.has(r));
  const denyExisting = incomingDeny.filter((r) => existingDenySet.has(r));

  return {
    allow: { added: allowAdded, existing: allowExisting },
    deny: { added: denyAdded, existing: denyExisting },
  };
}

/**
 * Merge incoming permissions into existing, deduplicating.
 */
export function mergePermissionSets(existing: PermissionSet, incoming: PermissionSet): PermissionSet {
  const allowSet = new Set([...existing.allow, ...incoming.allow]);
  const denySet = new Set([...(existing.deny || []), ...(incoming.deny || [])]);

  return {
    name: existing.name,
    description: existing.description,
    allow: Array.from(allowSet).sort(),
    deny: Array.from(denySet).sort(),
  };
}

/**
 * Save the default permission set.
 */
export function saveDefaultPermissionSet(set: PermissionSet): { success: boolean; error?: string } {
  set.name = DEFAULT_PERMISSION_SET_NAME;
  return savePermissionSet(set);
}
