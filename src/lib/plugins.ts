import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, DiscoveredPlugin, PluginManifest } from './types.js';
import { getPluginsDir } from './state.js';
import { AGENTS, PLUGINS_CAPABLE_AGENTS } from './agents.js';

const PLUGIN_MANIFEST_DIR = '.claude-plugin';
const PLUGIN_MANIFEST_FILE = 'plugin.json';

/**
 * Discover all plugins in ~/.agents/plugins/.
 * A valid plugin has a .claude-plugin/plugin.json manifest.
 */
export function discoverPlugins(): DiscoveredPlugin[] {
  const pluginsDir = getPluginsDir();
  if (!fs.existsSync(pluginsDir)) {
    return [];
  }

  const plugins: DiscoveredPlugin[] = [];
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const pluginRoot = path.join(pluginsDir, entry.name);
    const manifest = loadPluginManifest(pluginRoot);
    if (!manifest) continue;

    plugins.push({
      name: manifest.name,
      root: pluginRoot,
      manifest,
      skills: discoverPluginSkills(pluginRoot),
      hooks: discoverPluginHooks(pluginRoot),
      scripts: discoverPluginScripts(pluginRoot),
    });
  }

  return plugins;
}

/**
 * Load a plugin manifest from a plugin directory.
 */
export function loadPluginManifest(pluginRoot: string): PluginManifest | null {
  const manifestPath = path.join(pluginRoot, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content) as PluginManifest;
    if (!parsed.name || !parsed.version) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Get a specific plugin by name.
 */
export function getPlugin(name: string): DiscoveredPlugin | null {
  const plugins = discoverPlugins();
  return plugins.find(p => p.name === name) || null;
}

/**
 * Check if an agent supports a specific plugin.
 * If the plugin specifies agents, only those are supported.
 * Otherwise defaults to all plugin-capable agents.
 */
export function pluginSupportsAgent(plugin: DiscoveredPlugin, agent: AgentId): boolean {
  if (!PLUGINS_CAPABLE_AGENTS.includes(agent)) return false;
  if (plugin.manifest.agents && plugin.manifest.agents.length > 0) {
    return plugin.manifest.agents.includes(agent);
  }
  return true;
}

/**
 * Discover skill directories inside a plugin.
 */
function discoverPluginSkills(pluginRoot: string): string[] {
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);
}

/**
 * Discover hook definitions inside a plugin.
 */
function discoverPluginHooks(pluginRoot: string): string[] {
  const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksFile)) return [];

  try {
    const content = JSON.parse(fs.readFileSync(hooksFile, 'utf-8')) as Record<string, unknown>;
    return Object.keys(content);
  } catch {
    return [];
  }
}

/**
 * Discover scripts inside a plugin.
 */
function discoverPluginScripts(pluginRoot: string): string[] {
  const scriptsDir = path.join(pluginRoot, 'scripts');
  if (!fs.existsSync(scriptsDir)) return [];

  return fs.readdirSync(scriptsDir).filter(f => !f.startsWith('.'));
}

/**
 * Expand plugin variables in a string.
 *
 * Variables:
 *   ${CLAUDE_PLUGIN_ROOT}  -> absolute path to plugin directory
 *   ${CLAUDE_PLUGIN_DATA}  -> per-version data directory for this plugin
 */
export function expandPluginVars(
  str: string,
  pluginRoot: string,
  pluginName: string,
  agentId: AgentId,
  versionHome: string
): string {
  const dataDir = path.join(versionHome, `.${agentId}`, 'plugin-data', pluginName);
  return str
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, dataDir);
}

/**
 * Sync a plugin to a specific agent version's home directory.
 *
 * For Claude:
 *   1. Copy plugin skills into version's skills dir (prefixed: pluginName:skillName)
 *   2. Read hooks/hooks.json, expand vars, merge into settings.json hooks
 *   3. Read settings.json, expand vars, merge permissions into settings.json
 *
 * For OpenClaw:
 *   1. Copy plugin skills into version's skills dir
 */
export function syncPluginToVersion(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): { success: boolean; skills: string[]; hooks: string[]; permissions: boolean } {
  const result = { success: false, skills: [] as string[], hooks: [] as string[], permissions: false };

  if (!pluginSupportsAgent(plugin, agent)) {
    return result;
  }

  // 1. Sync skills
  const skillsResult = syncPluginSkills(plugin, agent, versionHome);
  result.skills = skillsResult;

  // 2. Sync hooks (Claude only - uses settings.json hook registration)
  if (agent === 'claude') {
    const hooksResult = syncPluginHooks(plugin, agent, versionHome);
    result.hooks = hooksResult;
  }

  // 3. Sync permissions (Claude only - uses settings.json permissions)
  if (agent === 'claude') {
    result.permissions = syncPluginPermissions(plugin, agent, versionHome);
  }

  result.success = result.skills.length > 0 || result.hooks.length > 0 || result.permissions;
  return result;
}

/**
 * Copy plugin skills into the version's skills directory.
 * Skills are prefixed with the plugin name: pluginName:skillName
 */
function syncPluginSkills(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): string[] {
  const synced: string[] = [];
  const pluginSkillsDir = path.join(plugin.root, 'skills');
  if (!fs.existsSync(pluginSkillsDir)) return synced;

  const agentConfig = AGENTS[agent];
  const targetSkillsDir = path.join(versionHome, `.${agent}`, 'skills');
  fs.mkdirSync(targetSkillsDir, { recursive: true });

  for (const skillName of plugin.skills) {
    const srcDir = path.join(pluginSkillsDir, skillName);
    // Prefix with plugin name for namespacing
    const prefixedName = `${plugin.name}:${skillName}`;
    // Use colon-to-dash for filesystem (colons not allowed on some systems)
    const fsSafeName = prefixedName.replace(/:/g, '--');
    const destDir = path.join(targetSkillsDir, fsSafeName);

    try {
      // Remove existing and copy fresh
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      copyDirWithVarExpansion(srcDir, destDir, plugin.root, plugin.name, agent, versionHome);
      synced.push(prefixedName);
    } catch {
      // Skip on error
    }
  }

  return synced;
}

/**
 * Merge plugin hooks into Claude's settings.json.
 * Reads the plugin's hooks/hooks.json and merges each event's hooks
 * into the version's settings.json, expanding variables.
 */
function syncPluginHooks(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): string[] {
  const synced: string[] = [];
  const hooksFile = path.join(plugin.root, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksFile)) return synced;

  let pluginHooks: Record<string, Array<{
    matcher?: string;
    hooks?: Array<{ type: string; command: string; timeout?: number }>;
  }>>;

  try {
    pluginHooks = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  } catch {
    return synced;
  }

  // Read existing settings.json
  const configDir = path.join(versionHome, `.${agent}`);
  const settingsPath = path.join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // Start fresh if parse fails
    }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooksConfig = settings.hooks as Record<string, unknown[]>;

  // Merge each event from the plugin
  for (const [event, matcherGroups] of Object.entries(pluginHooks)) {
    if (!hooksConfig[event]) {
      hooksConfig[event] = [];
    }
    const eventEntries = hooksConfig[event] as Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; timeout?: number }>;
    }>;

    for (const group of matcherGroups) {
      const matcher = group.matcher || '';
      const expandedHooks = (group.hooks || []).map(h => ({
        ...h,
        command: expandPluginVars(h.command, plugin.root, plugin.name, agent, versionHome),
      }));

      // Find or create matcher group
      let matcherGroup = eventEntries.find(e => (e.matcher || '') === matcher);
      if (!matcherGroup) {
        matcherGroup = { matcher, hooks: [] };
        eventEntries.push(matcherGroup);
      }
      if (!matcherGroup.hooks) {
        matcherGroup.hooks = [];
      }

      // Add hooks that aren't already registered (by command path)
      for (const hook of expandedHooks) {
        const exists = matcherGroup.hooks.some(h => h.command === hook.command);
        if (!exists) {
          matcherGroup.hooks.push(hook);
        }
      }
    }

    synced.push(event);
  }

  // Write back
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch {
    // Ignore write errors
  }

  return synced;
}

/**
 * Merge plugin permissions into Claude's settings.json.
 * Reads the plugin's settings.json and merges permissions.allow entries.
 */
function syncPluginPermissions(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): boolean {
  const pluginSettingsPath = path.join(plugin.root, 'settings.json');
  if (!fs.existsSync(pluginSettingsPath)) return false;

  let pluginSettings: { permissions?: { allow?: string[]; deny?: string[] } };
  try {
    pluginSettings = JSON.parse(fs.readFileSync(pluginSettingsPath, 'utf-8'));
  } catch {
    return false;
  }

  const pluginAllow = pluginSettings.permissions?.allow || [];
  const pluginDeny = pluginSettings.permissions?.deny || [];
  if (pluginAllow.length === 0 && pluginDeny.length === 0) return false;

  // Expand variables in permission rules
  const expandedAllow = pluginAllow.map(rule =>
    expandPluginVars(rule, plugin.root, plugin.name, agent, versionHome)
  );
  const expandedDeny = pluginDeny.map(rule =>
    expandPluginVars(rule, plugin.root, plugin.name, agent, versionHome)
  );

  // Read existing settings.json
  const configDir = path.join(versionHome, `.${agent}`);
  const settingsPath = path.join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // Start fresh
    }
  }

  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = { allow: [], deny: [] };
  }
  const perms = settings.permissions as { allow: string[]; deny: string[] };
  if (!perms.allow) perms.allow = [];
  if (!perms.deny) perms.deny = [];

  // Merge allow rules (deduplicate)
  for (const rule of expandedAllow) {
    if (!perms.allow.includes(rule)) {
      perms.allow.push(rule);
    }
  }

  // Merge deny rules (deduplicate)
  for (const rule of expandedDeny) {
    if (!perms.deny.includes(rule)) {
      perms.deny.push(rule);
    }
  }

  // Write back
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a directory recursively, expanding plugin variables in file contents.
 * Only expands variables in text files (.md, .json, .sh, .py, .js, .ts, .yaml, .yml, .toml).
 */
function copyDirWithVarExpansion(
  src: string,
  dest: string,
  pluginRoot: string,
  pluginName: string,
  agent: AgentId,
  versionHome: string
): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  const textExtensions = new Set(['.md', '.json', '.sh', '.py', '.js', '.ts', '.yaml', '.yml', '.toml', '.txt']);

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirWithVarExpansion(srcPath, destPath, pluginRoot, pluginName, agent, versionHome);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (textExtensions.has(ext)) {
        // Expand variables in text files
        let content = fs.readFileSync(srcPath, 'utf-8');
        content = expandPluginVars(content, pluginRoot, pluginName, agent, versionHome);
        fs.writeFileSync(destPath, content, 'utf-8');
      } else {
        // Binary copy
        fs.copyFileSync(srcPath, destPath);
      }

      // Preserve executable permission
      const stat = fs.statSync(srcPath);
      if (stat.mode & 0o111) {
        fs.chmodSync(destPath, stat.mode);
      }
    }
  }
}

/**
 * Check if a plugin is synced to a version by inspecting the version home.
 * Checks multiple signals: skills directories, hook commands in settings.json,
 * and plugin permissions in settings.json.
 */
export function isPluginSynced(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): boolean {
  // Check 1: plugin skill directories exist
  if (plugin.skills.length > 0) {
    const skillsDir = path.join(versionHome, `.${agent}`, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const skillName of plugin.skills) {
        const fsSafeName = `${plugin.name}--${skillName}`;
        if (fs.existsSync(path.join(skillsDir, fsSafeName))) {
          return true;
        }
      }
    }
  }

  // Check 2: plugin hooks registered in settings.json (commands referencing plugin root)
  if (plugin.hooks.length > 0 && agent === 'claude') {
    const settingsPath = path.join(versionHome, `.${agent}`, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        // Check if any hook command references this plugin's root path
        if (content.includes(plugin.root)) {
          return true;
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  // Check 3: plugin permissions in settings.json (rules referencing plugin root)
  if (agent === 'claude') {
    const settingsPath = path.join(versionHome, `.${agent}`, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const allow = settings.permissions?.allow || [];
        if (allow.some((rule: string) => rule.includes(plugin.root))) {
          return true;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return false;
}

/**
 * Remove orphaned plugin skill directories from a version home.
 * An orphan is a skill dir with the plugin prefix pattern (name--skill)
 * where the plugin no longer exists in ~/.agents/plugins/.
 */
export function cleanOrphanedPluginSkills(
  agent: AgentId,
  versionHome: string,
  activePluginNames: Set<string>
): string[] {
  const removed: string[] = [];
  const skillsDir = path.join(versionHome, `.${agent}`, 'skills');
  if (!fs.existsSync(skillsDir)) return removed;

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Plugin skill dirs use the pattern: pluginName--skillName
    const dashIdx = entry.name.indexOf('--');
    if (dashIdx === -1) continue;

    const pluginName = entry.name.slice(0, dashIdx);
    if (!activePluginNames.has(pluginName)) {
      try {
        fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        // Skip on error
      }
    }
  }
  return removed;
}
