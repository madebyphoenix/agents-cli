import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import * as TOML from 'smol-toml';
import { checkbox, select, confirm } from '@inquirer/prompts';
import type { AgentId, VersionResources } from './types.js';
import { getVersionsDir, getShimsDir, ensureAgentsDir, readMeta, writeMeta, getCommandsDir, getSkillsDir, getHooksDir, getMemoryDir, getPermissionsDir, getSubagentsDir, clearVersionResources, getVersionResources, recordVersionResources, getMcpDir, getProjectAgentsDir } from './state.js';
import { AGENTS, getAccountEmail, MCP_CAPABLE_AGENTS, COMMANDS_CAPABLE_AGENTS, getMcpConfigPathForHome, parseMcpConfig, resolveAgentName, formatAgentError } from './agents.js';
import { getDefaultPermissionSet, applyPermissionsToVersion as applyPermsToVersion, PERMISSIONS_CAPABLE_AGENTS, discoverPermissionGroups, getTotalPermissionRuleCount, buildPermissionsFromGroups, CODEX_RULES_FILENAME } from './permissions.js';
import { installMcpServers } from './mcp.js';
import { markdownToToml } from './convert.js';
import { createVersionedAlias, removeVersionedAlias, switchConfigSymlink, getConfigSymlinkVersion } from './shims.js';
import { listInstalledSubagents, transformSubagentForClaude, syncSubagentToOpenclaw, SUBAGENT_CAPABLE_AGENTS } from './subagents.js';
import { parseHookManifest, registerHooksToSettings } from './hooks.js';
import { discoverPlugins, syncPluginToVersion, isPluginSynced, pluginSupportsAgent, cleanOrphanedPluginSkills } from './plugins.js';
import { PLUGINS_CAPABLE_AGENTS } from './agents.js';

const execAsync = promisify(exec);

/**
 * Resource selection for syncing to a version.
 * Each field can be:
 * - 'all' - sync all available resources of this type
 * - string[] - sync only these specific resources
 * - undefined - skip this resource type
 */
export interface ResourceSelection {
  commands?: string[] | 'all';
  skills?: string[] | 'all';
  hooks?: string[] | 'all';
  memory?: string[] | 'all';
  mcp?: string[] | 'all';
  permissions?: string[] | 'all';
  subagents?: string[] | 'all';
  plugins?: string[] | 'all';
}

/**
 * Available resources in ~/.agents/ for syncing.
 */
export interface AvailableResources {
  commands: string[];
  skills: string[];
  hooks: string[];
  memory: string[];
  mcp: string[];
  permissions: string[];
  subagents: string[];
  plugins: string[];
}

/**
 * Get all available resources from ~/.agents/.
 */
export function getAvailableResources(cwd: string = process.cwd()): AvailableResources {
  const result: AvailableResources = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
  };

  const projectAgentsDir = getProjectAgentsDir(cwd);
  const userBase = path.dirname(getCommandsDir());
  const resourceBases: Array<{ scope: 'project' | 'user'; base: string }> = [];
  if (projectAgentsDir) {
    resourceBases.push({ scope: 'project', base: projectAgentsDir });
  }
  resourceBases.push({ scope: 'user', base: userBase });

  // Commands (*.md files)
  const commandNames = new Set<string>();
  for (const { base } of resourceBases) {
    const commandsDir = path.join(base, 'commands');
    if (!fs.existsSync(commandsDir)) continue;
    const names = fs.readdirSync(commandsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
    for (const name of names) {
      commandNames.add(name);
    }
  }
  result.commands = Array.from(commandNames);

  // Skills (directories, excluding hidden)
  const skillNames = new Set<string>();
  for (const { base } of resourceBases) {
    const skillsDir = path.join(base, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    const names = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
    for (const name of names) {
      skillNames.add(name);
    }
  }
  result.skills = Array.from(skillNames);

  // Hooks (files)
  const hookNames = new Set<string>();
  for (const { base } of resourceBases) {
    const hooksDir = path.join(base, 'hooks');
    if (!fs.existsSync(hooksDir)) continue;
    const names = fs.readdirSync(hooksDir).filter(f => !f.startsWith('.'));
    for (const name of names) {
      hookNames.add(name);
    }
  }
  result.hooks = Array.from(hookNames);

  // Memory (*.md files, excluding symlinks)
  const memoryNames = new Set<string>();
  for (const { base } of resourceBases) {
    const memoryDir = path.join(base, 'memory');
    if (!fs.existsSync(memoryDir)) continue;
    const names = fs.readdirSync(memoryDir)
      .filter(f => {
        if (!f.endsWith('.md')) return false;
        const stat = fs.lstatSync(path.join(memoryDir, f));
        return !stat.isSymbolicLink();
      })
      .map(f => f.replace(/\.md$/, ''));
    for (const name of names) {
      memoryNames.add(name);
    }
  }
  result.memory = Array.from(memoryNames);

  // MCP servers (*.yaml files)
  const mcpNames = new Set<string>();
  for (const { base } of resourceBases) {
    const mcpDir = path.join(base, 'mcp');
    if (!fs.existsSync(mcpDir)) continue;
    const names = fs.readdirSync(mcpDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => f.replace(/\.(yaml|yml)$/, ''));
    for (const name of names) {
      mcpNames.add(name);
    }
  }
  result.mcp = Array.from(mcpNames);

  // Permission groups (from permissions/groups/*.yaml)
  const permissionNames = new Set<string>();
  for (const { base } of resourceBases) {
    const permsGroupsDir = path.join(base, 'permissions', 'groups');
    if (!fs.existsSync(permsGroupsDir)) continue;
    const names = fs.readdirSync(permsGroupsDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => f.replace(/\.(yaml|yml)$/, ''));
    for (const name of names) {
      permissionNames.add(name);
    }
  }
  result.permissions = Array.from(permissionNames);

  // Subagents (directories with AGENT.md)
  const subagentNames = new Set<string>();
  for (const { base } of resourceBases) {
    const subagentsDir = path.join(base, 'subagents');
    if (!fs.existsSync(subagentsDir)) continue;
    const names = fs.readdirSync(subagentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(subagentsDir, d.name, 'AGENT.md')))
      .map(d => d.name);
    for (const name of names) {
      subagentNames.add(name);
    }
  }
  result.subagents = Array.from(subagentNames);

  // Plugins (directories with .claude-plugin/plugin.json)
  const allPlugins = discoverPlugins();
  result.plugins = allPlugins.map(p => p.name);

  return result;
}

/**
 * Recursively compare two directories: every file in src must exist in dest with identical content.
 */
function skillDirsMatch(src: string, dest: string): boolean {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) return false;
      if (!skillDirsMatch(srcPath, destPath)) return false;
    } else {
      if (!fs.existsSync(destPath)) return false;
      const srcContent = fs.readFileSync(srcPath, 'utf-8');
      const destContent = fs.readFileSync(destPath, 'utf-8');
      if (srcContent !== destContent) return false;
    }
  }
  return true;
}

/**
 * Get what's ACTUALLY synced to a version by inspecting the version home.
 * This is the source of truth - not the tracking in agents.yaml.
 */
export function getActuallySyncedResources(agent: AgentId, version: string, options: { cwd?: string } = {}): AvailableResources {
  const agentConfig = AGENTS[agent];
  const versionHome = path.join(getVersionsDir(), agent, version, 'home');
  const configDir = path.join(versionHome, `.${agent}`);
  const projectAgentsDir = getProjectAgentsDir(options.cwd || process.cwd());

  const result: AvailableResources = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
  };

  // Commands - check what files exist in version home
  const commandsDir = path.join(configDir, agentConfig.commandsSubdir);
  if (fs.existsSync(commandsDir)) {
    const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
    result.commands = fs.readdirSync(commandsDir)
      .filter(f => f.endsWith(ext))
      .map(f => f.replace(new RegExp(`\\${ext}$`), ''));
  }

  // Skills - check what directories exist AND content matches central source
  const skillsDir = path.join(configDir, 'skills');
  const centralSkillsDir = getSkillsDir();
  const projectSkillsDir = projectAgentsDir ? path.join(projectAgentsDir, 'skills') : null;
  if (fs.existsSync(skillsDir)) {
    const installedSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
    for (const skill of installedSkills) {
      const versionSkillDir = path.join(skillsDir, skill);
      const projectSourceDir = projectSkillsDir ? path.join(projectSkillsDir, skill) : null;
      const centralSkillDir = path.join(centralSkillsDir, skill);
      const hasProjectSource = projectSourceDir ? fs.existsSync(projectSourceDir) : false;
      const hasUserSource = fs.existsSync(centralSkillDir);
      if (!hasProjectSource && !hasUserSource) {
        result.skills.push(skill);
        continue;
      }
      const sourceDir = hasProjectSource ? projectSourceDir! : centralSkillDir;
      const allMatch = skillDirsMatch(sourceDir, versionSkillDir);
      if (allMatch) {
        result.skills.push(skill);
      }
    }
  }

  // Hooks - check what files exist AND content matches central source
  const hooksDir = path.join(configDir, 'hooks');
  const centralHooksDir = getHooksDir();
  const projectHooksDir = projectAgentsDir ? path.join(projectAgentsDir, 'hooks') : null;
  if (fs.existsSync(hooksDir)) {
    const installedHooks = fs.readdirSync(hooksDir).filter(f => !f.startsWith('.'));
    for (const hook of installedHooks) {
      const projectFile = projectHooksDir ? path.join(projectHooksDir, hook) : null;
      const centralFile = path.join(centralHooksDir, hook);
      const versionFile = path.join(hooksDir, hook);
      const hasProject = projectFile ? fs.existsSync(projectFile) : false;
      const hasCentral = fs.existsSync(centralFile);
      const sourceFile = hasProject ? projectFile! : centralFile;
      if (!hasProject && !hasCentral) {
        result.hooks.push(hook);
        continue;
      }
      try {
        const centralContent = fs.readFileSync(sourceFile, 'utf-8');
        const versionContent = fs.readFileSync(versionFile, 'utf-8');
        if (centralContent === versionContent) {
          result.hooks.push(hook);
        }
      } catch {
        // If read fails, consider not synced
      }
    }
  }

  // Memory - check which memory files are actually in sync (content matches)
  const memoryDir = getMemoryDir();
  const projectMemoryDir = projectAgentsDir ? path.join(projectAgentsDir, 'memory') : null;
  const memoryFiles = new Set<string>();
  if (fs.existsSync(memoryDir)) {
    fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).forEach(f => memoryFiles.add(f));
  }
  if (projectMemoryDir && fs.existsSync(projectMemoryDir)) {
    fs.readdirSync(projectMemoryDir).filter(f => f.endsWith('.md')).forEach(f => memoryFiles.add(f));
  }
  for (const file of memoryFiles) {
    const memName = file.replace(/\.md$/, '');
    const targetName = file === 'AGENTS.md' ? agentConfig.instructionsFile : file;
    const versionFile = path.join(configDir, targetName);
    if (!fs.existsSync(versionFile)) continue;

    const projectFile = projectMemoryDir ? path.join(projectMemoryDir, file) : null;
    const centralFile = path.join(memoryDir, file);
    const hasProject = projectFile ? fs.existsSync(projectFile) : false;
    const hasCentral = fs.existsSync(centralFile);
    const sourceFile = hasProject ? projectFile! : centralFile;
    if (!hasProject && !hasCentral) {
      result.memory.push(memName);
      continue;
    }
    try {
      const centralContent = fs.readFileSync(sourceFile, 'utf-8');
      const versionContent = fs.readFileSync(versionFile, 'utf-8');
      if (centralContent === versionContent) {
        result.memory.push(memName);
      }
    } catch {
      // Ignore
    }
  }

  // MCP - use canonical config path + parser per agent
  if (MCP_CAPABLE_AGENTS.includes(agent)) {
    const mcpConfigPath = getMcpConfigPathForHome(agent, versionHome);
    if (fs.existsSync(mcpConfigPath)) {
      try {
        const servers = parseMcpConfig(agent, mcpConfigPath);
        result.mcp = Object.keys(servers);
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Permissions - check agent-specific config files
  const settingsPath = path.join(configDir, 'settings.json');
  if (PERMISSIONS_CAPABLE_AGENTS.includes(agent)) {
    if (agent === 'claude' && fs.existsSync(settingsPath)) {
      // Claude: check settings.json permissions.allow and deny
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const allowRules = settings.permissions?.allow || [];
        const denyRules = settings.permissions?.deny || [];

        if (allowRules.length > 0 || denyRules.length > 0) {
          const permGroups = discoverPermissionGroups();
          const appliedGroups: string[] = [];

          for (const group of permGroups) {
            const groupSet = buildPermissionsFromGroups([group.name]);

            // Empty groups (like header files) are considered synced if ANY permissions are applied
            if (groupSet.allow.length === 0 && (!groupSet.deny || groupSet.deny.length === 0)) {
              appliedGroups.push(group.name);
              continue;
            }

            const hasAllowRule = groupSet.allow.some(rule => allowRules.includes(rule));
            const hasDenyRule = groupSet.deny?.some(rule => denyRules.includes(rule)) || false;

            if (hasAllowRule || hasDenyRule) {
              appliedGroups.push(group.name);
            }
          }
          result.permissions = appliedGroups;
        }
      } catch {
        // Ignore parse errors
      }
    } else if (agent === 'codex') {
      // Codex: config.toml for approval_policy/sandbox_mode, .rules for deny
      const codexConfigPath = path.join(configDir, 'config.toml');
      const codexRulesPath = path.join(configDir, 'rules', CODEX_RULES_FILENAME);
      const hasConfig = fs.existsSync(codexConfigPath);
      const hasRules = fs.existsSync(codexRulesPath);
      if (hasConfig || hasRules) {
        try {
          // Codex format is lossy — all groups merge into a few keys.
          // If any permission artifacts exist, all groups were applied together.
          let hasPermKeys = false;
          if (hasConfig) {
            const content = fs.readFileSync(codexConfigPath, 'utf-8');
            const config = TOML.parse(content) as Record<string, unknown>;
            hasPermKeys = !!(config.approval_policy || config.sandbox_mode || config.sandbox_workspace_write);
          }
          if (hasPermKeys || hasRules) {
            result.permissions = discoverPermissionGroups().map(g => g.name);
          }
        } catch {
          // Ignore parse errors
        }
      }
    } else if (agent === 'opencode') {
      // OpenCode: opencode.jsonc for permission.bash
      const opencodeConfigPath = path.join(configDir, 'opencode.jsonc');
      if (fs.existsSync(opencodeConfigPath)) {
        try {
          const content = fs.readFileSync(opencodeConfigPath, 'utf-8');
          const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
          const config = JSON.parse(stripped);
          if (config.permission && Object.keys(config.permission.bash || {}).length > 0) {
            result.permissions = discoverPermissionGroups().map(g => g.name);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  // Subagents - check agent-specific locations
  if (SUBAGENT_CAPABLE_AGENTS.includes(agent)) {
    if (agent === 'claude') {
      const agentsDir = path.join(configDir, 'agents');
      if (fs.existsSync(agentsDir)) {
        result.subagents = fs.readdirSync(agentsDir)
          .filter(f => f.endsWith('.md'))
          .map(f => f.replace('.md', ''));
      }
    } else if (agent === 'openclaw') {
      // OpenClaw: directories with AGENTS.md
      const openclawDir = path.join(versionHome, '.openclaw');
      if (fs.existsSync(openclawDir)) {
        result.subagents = fs.readdirSync(openclawDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && fs.existsSync(path.join(openclawDir, d.name, 'AGENTS.md')))
          .map(d => d.name);
      }
    }
  }

  // Plugins - check which discovered plugins have their skills in the version
  if (PLUGINS_CAPABLE_AGENTS.includes(agent)) {
    const allPlugins = discoverPlugins();
    for (const plugin of allPlugins) {
      if (isPluginSynced(plugin, agent, versionHome)) {
        result.plugins.push(plugin.name);
      }
    }
  }

  return result;
}

/**
 * Compare available resources with what's ACTUALLY synced to version home.
 * Returns only NEW resources that haven't been synced yet.
 * Source of truth: the actual files/config, NOT agents.yaml tracking.
 */
export function getNewResources(
  available: AvailableResources,
  actuallySynced: AvailableResources
): AvailableResources {
  return {
    commands: available.commands.filter(c => !actuallySynced.commands.includes(c)),
    skills: available.skills.filter(s => !actuallySynced.skills.includes(s)),
    hooks: available.hooks.filter(h => !actuallySynced.hooks.includes(h)),
    memory: available.memory.filter(m => !actuallySynced.memory.includes(m)),
    mcp: available.mcp.filter(m => !actuallySynced.mcp.includes(m)),
    permissions: available.permissions.filter(p => !actuallySynced.permissions.includes(p)),
    subagents: available.subagents.filter(s => !actuallySynced.subagents.includes(s)),
    plugins: available.plugins.filter(p => !actuallySynced.plugins.includes(p)),
  };
}

/**
 * Check if there are any new resources to sync.
 */
export function hasNewResources(diff: AvailableResources, agent?: AgentId): boolean {
  const commandsApply = agent ? COMMANDS_CAPABLE_AGENTS.includes(agent) : true;
  const hooksApply = agent ? AGENTS[agent].supportsHooks : true;
  const mcpApply = agent ? MCP_CAPABLE_AGENTS.includes(agent) : true;
  const permsApply = agent ? PERMISSIONS_CAPABLE_AGENTS.includes(agent) : true;
  const subagentsApply = agent ? SUBAGENT_CAPABLE_AGENTS.includes(agent) : true;
  const pluginsApply = agent ? PLUGINS_CAPABLE_AGENTS.includes(agent) : true;
  return (
    (diff.commands.length > 0 && commandsApply) ||
    diff.skills.length > 0 ||
    (diff.hooks.length > 0 && hooksApply) ||
    (diff.memory.length > 0 && commandsApply) ||
    (diff.mcp.length > 0 && mcpApply) ||
    (diff.permissions.length > 0 && permsApply) ||
    (diff.subagents.length > 0 && subagentsApply) ||
    (diff.plugins.length > 0 && pluginsApply)
  );
}

/**
 * Build a summary string of new resources.
 * E.g., "2 commands, 5 permission groups"
 */
function buildNewResourcesSummary(newResources: AvailableResources, agent: AgentId): string {
  const agentConfig = AGENTS[agent];
  const parts: string[] = [];

  if (newResources.commands.length > 0 && COMMANDS_CAPABLE_AGENTS.includes(agent)) {
    parts.push(`${newResources.commands.length} command${newResources.commands.length === 1 ? '' : 's'}`);
  }
  if (newResources.skills.length > 0) {
    parts.push(`${newResources.skills.length} skill${newResources.skills.length === 1 ? '' : 's'}`);
  }
  if (newResources.hooks.length > 0 && agentConfig.supportsHooks) {
    parts.push(`${newResources.hooks.length} hook${newResources.hooks.length === 1 ? '' : 's'}`);
  }
  if (newResources.memory.length > 0 && COMMANDS_CAPABLE_AGENTS.includes(agent)) {
    parts.push(`${newResources.memory.length} rule file${newResources.memory.length === 1 ? '' : 's'}`);
  }
  if (newResources.mcp.length > 0 && MCP_CAPABLE_AGENTS.includes(agent)) {
    parts.push(`${newResources.mcp.length} MCP${newResources.mcp.length === 1 ? '' : 's'}`);
  }
  if (newResources.permissions.length > 0 && PERMISSIONS_CAPABLE_AGENTS.includes(agent)) {
    parts.push(`${newResources.permissions.length} permission group${newResources.permissions.length === 1 ? '' : 's'}`);
  }
  if (newResources.subagents.length > 0 && SUBAGENT_CAPABLE_AGENTS.includes(agent)) {
    parts.push(`${newResources.subagents.length} subagent${newResources.subagents.length === 1 ? '' : 's'}`);
  }
  if (newResources.plugins.length > 0 && PLUGINS_CAPABLE_AGENTS.includes(agent)) {
    parts.push(`${newResources.plugins.length} plugin${newResources.plugins.length === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}

/**
 * Prompt user to select which NEW resources to sync.
 * Only shows resources that haven't been synced yet.
 */
export async function promptNewResourceSelection(
  agent: AgentId,
  newResources: AvailableResources
): Promise<ResourceSelection | null> {
  const agentConfig = AGENTS[agent];
  const selection: ResourceSelection = {};

  // Get permission group info for display
  const permissionGroups = discoverPermissionGroups();
  const newPermissionGroups = permissionGroups.filter(g => newResources.permissions.includes(g.name));
  const totalNewPermissionRules = newPermissionGroups.reduce((sum, g) => sum + g.ruleCount, 0);

  // Build the summary
  const summary = buildNewResourcesSummary(newResources, agent);
  console.log(chalk.cyan(`\nNew resources available:`));
  console.log(chalk.gray(`  ${summary}`));

  // Ask how to handle new resources
  const action = await select<'all' | 'specific' | 'skip'>({
    message: 'Sync new resources?',
    choices: [
      { value: 'all', name: 'Yes, sync all new' },
      { value: 'specific', name: 'Select specific items' },
      { value: 'skip', name: 'Skip' },
    ],
    default: 'all',
  });

  if (action === 'skip') {
    return null;
  }

  if (action === 'all') {
    // Sync all new resources
    if (newResources.commands.length > 0 && COMMANDS_CAPABLE_AGENTS.includes(agent)) selection.commands = newResources.commands;
    if (newResources.skills.length > 0) selection.skills = newResources.skills;
    if (newResources.hooks.length > 0 && agentConfig.supportsHooks) selection.hooks = newResources.hooks;
    if (newResources.memory.length > 0 && COMMANDS_CAPABLE_AGENTS.includes(agent)) selection.memory = newResources.memory;
    if (newResources.mcp.length > 0 && MCP_CAPABLE_AGENTS.includes(agent)) selection.mcp = newResources.mcp;
    if (newResources.permissions.length > 0 && PERMISSIONS_CAPABLE_AGENTS.includes(agent)) selection.permissions = newResources.permissions;
    if (newResources.subagents.length > 0 && SUBAGENT_CAPABLE_AGENTS.includes(agent)) selection.subagents = newResources.subagents;
    if (newResources.plugins.length > 0 && PLUGINS_CAPABLE_AGENTS.includes(agent)) selection.plugins = newResources.plugins;
    return selection;
  }

  // Select specific items for each category
  if (newResources.commands.length > 0 && COMMANDS_CAPABLE_AGENTS.includes(agent)) {
    const selected = await checkbox({
      message: 'Select new commands to sync:',
      choices: newResources.commands.map(c => ({ name: c, value: c, checked: true })),
    });
    if (selected.length > 0) selection.commands = selected;
  }

  if (newResources.skills.length > 0) {
    const selected = await checkbox({
      message: 'Select new skills to sync:',
      choices: newResources.skills.map(s => ({ name: s, value: s, checked: true })),
    });
    if (selected.length > 0) selection.skills = selected;
  }

  if (newResources.hooks.length > 0 && agentConfig.supportsHooks) {
    const selected = await checkbox({
      message: 'Select new hooks to sync:',
      choices: newResources.hooks.map(h => ({ name: h, value: h, checked: true })),
    });
    if (selected.length > 0) selection.hooks = selected;
  }

  if (newResources.memory.length > 0 && COMMANDS_CAPABLE_AGENTS.includes(agent)) {
    const selected = await checkbox({
      message: 'Select new rule files to sync:',
      choices: newResources.memory.map(m => ({ name: m, value: m, checked: true })),
    });
    if (selected.length > 0) selection.memory = selected;
  }

  if (newResources.mcp.length > 0 && MCP_CAPABLE_AGENTS.includes(agent)) {
    const selected = await checkbox({
      message: 'Select new MCPs to sync:',
      choices: newResources.mcp.map(m => ({ name: m, value: m, checked: true })),
    });
    if (selected.length > 0) selection.mcp = selected;
  }

  if (newResources.permissions.length > 0 && PERMISSIONS_CAPABLE_AGENTS.includes(agent)) {
    const selected = await checkbox({
      message: 'Select new permission groups to sync:',
      choices: newPermissionGroups.map(g => ({
        name: `${g.name} (${g.ruleCount} rules)`,
        value: g.name,
        checked: true,
      })),
    });
    if (selected.length > 0) selection.permissions = selected;
  }

  if (newResources.subagents.length > 0 && SUBAGENT_CAPABLE_AGENTS.includes(agent)) {
    const selected = await checkbox({
      message: 'Select new subagents to sync:',
      choices: newResources.subagents.map(s => ({ name: s, value: s, checked: true })),
    });
    if (selected.length > 0) selection.subagents = selected;
  }

  if (newResources.plugins.length > 0 && PLUGINS_CAPABLE_AGENTS.includes(agent)) {
    const allPlugins = discoverPlugins();
    const pluginMap = new Map(allPlugins.map(p => [p.name, p]));
    const selected = await checkbox({
      message: 'Select new plugins to sync:',
      choices: newResources.plugins.map(name => {
        const plugin = pluginMap.get(name);
        const desc = plugin?.manifest.description;
        return { name: desc ? `${name} - ${desc}` : name, value: name, checked: true };
      }),
    });
    if (selected.length > 0) selection.plugins = selected;
  }

  return selection;
}

/**
 * Prompt user to select which resources to sync from ~/.agents/.
 * Returns the selection, or null if user cancels.
 */
export async function promptResourceSelection(agent: AgentId): Promise<ResourceSelection | null> {
  const available = getAvailableResources();
  const agentConfig = AGENTS[agent];
  const selection: ResourceSelection = {};

  // Get permission group info for display
  const permissionGroups = discoverPermissionGroups();
  const totalPermissionRules = permissionGroups.reduce((sum, g) => sum + g.ruleCount, 0);

  // Build category choices based on what's available
  type CategoryKey = keyof AvailableResources;
  const categories: { key: CategoryKey; label: string; available: boolean; displayCount: string }[] = [
    { key: 'commands', label: 'Commands', available: COMMANDS_CAPABLE_AGENTS.includes(agent) && available.commands.length > 0, displayCount: `${available.commands.length} available` },
    { key: 'skills', label: 'Skills', available: available.skills.length > 0, displayCount: `${available.skills.length} available` },
    { key: 'hooks', label: 'Hooks', available: agentConfig.supportsHooks && available.hooks.length > 0, displayCount: `${available.hooks.length} available` },
    { key: 'memory', label: 'Rules', available: COMMANDS_CAPABLE_AGENTS.includes(agent) && available.memory.length > 0, displayCount: `${available.memory.length} available` },
    { key: 'mcp', label: 'MCPs', available: MCP_CAPABLE_AGENTS.includes(agent) && available.mcp.length > 0, displayCount: `${available.mcp.length} available` },
    { key: 'permissions', label: 'Permissions', available: PERMISSIONS_CAPABLE_AGENTS.includes(agent) && permissionGroups.length > 0, displayCount: `${permissionGroups.length} groups, ${totalPermissionRules} rules` },
    { key: 'subagents', label: 'Subagents', available: SUBAGENT_CAPABLE_AGENTS.includes(agent) && available.subagents.length > 0, displayCount: `${available.subagents.length} available` },
    { key: 'plugins', label: 'Plugins', available: PLUGINS_CAPABLE_AGENTS.includes(agent) && available.plugins.length > 0, displayCount: `${available.plugins.length} available` },
  ];

  const availableCategories = categories.filter(c => c.available);

  if (availableCategories.length === 0) {
    console.log(chalk.gray('No resources available in ~/.agents/'));
    return {};
  }

  // Step 1: Select categories (with "Select All" shortcut at the top)
  console.log();
  const SELECT_ALL_KEY = '__select_all__' as CategoryKey;
  const selectedCategories = await checkbox<CategoryKey>({
    message: 'Which resources from ~/.agents/ would you like to sync?',
    choices: [
      { name: chalk.bold('Select All (sync everything)'), value: SELECT_ALL_KEY, checked: false },
      ...availableCategories.map(c => ({
        name: `${c.label} (${c.displayCount})`,
        value: c.key,
        checked: true, // Default all checked
      })),
    ],
  });

  if (selectedCategories.length === 0) {
    return {};
  }

  // If "Select All" was picked, sync everything without per-category prompts
  if (selectedCategories.includes(SELECT_ALL_KEY)) {
    for (const c of availableCategories) {
      selection[c.key] = 'all';
    }
    return selection;
  }

  // Step 2: For each selected category, ask all/specific/skip
  for (const category of selectedCategories) {
    const categoryLabel = categories.find(c => c.key === category)!.label;

    // Special handling for permissions - show groups
    if (category === 'permissions') {
      const choice = await select<'all' | 'specific' | 'skip'>({
        message: `${categoryLabel}:`,
        choices: [
          { name: `Select all (${permissionGroups.length} groups)`, value: 'all' },
          { name: 'Select specific groups', value: 'specific' },
          { name: 'Skip', value: 'skip' },
        ],
        default: 'all',
      });

      if (choice === 'all') {
        selection.permissions = 'all';
      } else if (choice === 'specific') {
        const selected = await checkbox<string>({
          message: 'Select permission groups to sync:',
          choices: permissionGroups.map(g => ({
            name: `${g.name} (${g.ruleCount} rules)`,
            value: g.name,
            checked: true,
          })),
        });
        if (selected.length > 0) {
          selection.permissions = selected;
        }
      }
    } else {
      // Standard handling for other categories
      const items = available[category];

      const choice = await select<'all' | 'specific' | 'skip'>({
        message: `${categoryLabel}:`,
        choices: [
          { name: `Select all (${items.length})`, value: 'all' },
          { name: 'Select specific', value: 'specific' },
          { name: 'Skip', value: 'skip' },
        ],
        default: 'all',
      });

      if (choice === 'all') {
        selection[category] = 'all';
      } else if (choice === 'specific') {
        const selected = await checkbox<string>({
          message: `Select ${categoryLabel.toLowerCase()} to sync:`,
          choices: items.map(item => ({
            name: item,
            value: item,
            checked: true,
          })),
        });
        if (selected.length > 0) {
          selection[category] = selected;
        }
      }
    }
    // 'skip' means we don't set anything for this category
  }

  return selection;
}

export interface AgentSpec {
  agent: AgentId;
  version: string;
}

/**
 * Parse agent@version syntax.
 * Examples:
 *   "claude@1.5.0" -> { agent: "claude", version: "1.5.0" }
 *   "claude" -> { agent: "claude", version: "latest" }
 *   "codex@latest" -> { agent: "codex", version: "latest" }
 */
export function parseAgentSpec(spec: string): AgentSpec | null {
  const parts = spec.split('@');
  const agentName = parts[0].toLowerCase();
  const version = parts[1] || 'latest';

  if (!AGENTS[agentName as AgentId]) {
    return null;
  }

  return {
    agent: agentName as AgentId,
    version,
  };
}

/**
 * Get the directory where a specific version is installed.
 */
export function getVersionDir(agent: AgentId, version: string): string {
  return path.join(getVersionsDir(), agent, version);
}

/**
 * Get the binary path for a specific agent version.
 */
export function getBinaryPath(agent: AgentId, version: string): string {
  const versionDir = getVersionDir(agent, version);
  const agentConfig = AGENTS[agent];
  return path.join(versionDir, 'node_modules', '.bin', agentConfig.cliCommand);
}

/**
 * Get the isolated HOME directory for a specific agent version.
 * Each version has its own config isolation (like jobs sandbox).
 */
export function getVersionHomePath(agent: AgentId, version: string): string {
  return path.join(getVersionDir(agent, version), 'home');
}

/**
 * Check if a specific version is installed.
 */
export function isVersionInstalled(agent: AgentId, version: string): boolean {
  const binaryPath = getBinaryPath(agent, version);
  return fs.existsSync(binaryPath);
}

/**
 * Get the latest available version from npm for an agent.
 */
export async function getLatestNpmVersion(agent: AgentId): Promise<string | null> {
  const agentConfig = AGENTS[agent];
  if (!agentConfig.npmPackage) return null;

  try {
    const { stdout } = await execAsync(`npm view ${agentConfig.npmPackage} version`);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Check if 'latest' version is already installed (by resolving to actual version).
 */
export async function isLatestInstalled(agent: AgentId): Promise<{ installed: boolean; version: string | null }> {
  const latestVersion = await getLatestNpmVersion(agent);
  if (!latestVersion) {
    return { installed: false, version: null };
  }
  return { installed: isVersionInstalled(agent, latestVersion), version: latestVersion };
}

/**
 * List all installed versions for an agent.
 */
export function listInstalledVersions(agent: AgentId): string[] {
  const agentVersionsDir = path.join(getVersionsDir(), agent);
  if (!fs.existsSync(agentVersionsDir)) {
    return [];
  }

  const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  const versions: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const binaryPath = getBinaryPath(agent, entry.name);
      if (fs.existsSync(binaryPath)) {
        versions.push(entry.name);
      }
    }
  }

  return versions.sort(compareVersions);
}

/**
 * Get the global default version for an agent.
 */
export function getGlobalDefault(agent: AgentId): string | null {
  const meta = readMeta();
  return meta.agents?.[agent] || null;
}

/**
 * Set the global default version for an agent.
 */
export function setGlobalDefault(agent: AgentId, version: string | undefined): void {
  const meta = readMeta();
  if (!meta.agents) {
    meta.agents = {};
  }
  if (version === undefined) {
    delete meta.agents[agent];
  } else {
    meta.agents[agent] = version;
  }
  writeMeta(meta);
}

/**
 * Install a specific version of an agent.
 */
export async function installVersion(
  agent: AgentId,
  version: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; installedVersion: string; error?: string }> {
  const agentConfig = AGENTS[agent];

  if (!agentConfig.npmPackage) {
    return { success: false, installedVersion: version, error: 'Agent has no npm package' };
  }

  ensureAgentsDir();
  const versionDir = getVersionDir(agent, version);

  // Create version directory and isolated home
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });

  // Initialize package.json
  const packageJson = {
    name: `agents-${agent}-${version}`,
    version: '1.0.0',
    private: true,
  };
  fs.writeFileSync(path.join(versionDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  // Install the package
  const packageSpec = version === 'latest'
    ? agentConfig.npmPackage
    : `${agentConfig.npmPackage}@${version}`;

  try {
    onProgress?.(`Installing ${packageSpec}...`);
    const { stdout } = await execAsync(`npm install ${packageSpec}`, { cwd: versionDir });

    // Determine the actual installed version
    let installedVersion = version;
    if (version === 'latest') {
      const pkgJsonPath = path.join(versionDir, 'node_modules', agentConfig.npmPackage.replace(/^@/, '').split('/')[0], 'package.json');
      // Try to read the actual version from installed package
      try {
        const installedPkgPath = path.join(versionDir, 'node_modules', agentConfig.npmPackage, 'package.json');
        if (fs.existsSync(installedPkgPath)) {
          const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf-8'));
          installedVersion = installedPkg.version;

          // Rename the directory to the actual version
          if (installedVersion !== 'latest') {
            const actualVersionDir = getVersionDir(agent, installedVersion);
            if (!fs.existsSync(actualVersionDir)) {
              fs.renameSync(versionDir, actualVersionDir);
            } else {
              // Already exists, remove the 'latest' dir
              fs.rmSync(versionDir, { recursive: true, force: true });
            }
          }
        }
      } catch (e) {
        // Failed to determine version - this shouldn't happen
        throw new Error(`Failed to determine installed version: ${(e as Error).message}`);
      }
    }

    // Create versioned alias (e.g., claude@2.0.65)
    createVersionedAlias(agent, installedVersion);

    return { success: true, installedVersion };
  } catch (err) {
    // Clean up on failure
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    return { success: false, installedVersion: version, error: (err as Error).message };
  }
}

/**
 * Remove a specific version of an agent.
 */
export function removeVersion(agent: AgentId, version: string): boolean {
  const versionDir = getVersionDir(agent, version);

  if (!fs.existsSync(versionDir)) {
    return false;
  }

  fs.rmSync(versionDir, { recursive: true, force: true });

  // Remove versioned alias (e.g., claude@2.0.65)
  removeVersionedAlias(agent, version);

  // Clear resource tracking for this version
  clearVersionResources(agent, version);

  // Clear default if it was the removed version - user must explicitly pick a new one
  if (getGlobalDefault(agent) === version) {
    const meta = readMeta();
    if (meta.agents?.[agent]) {
      delete meta.agents[agent];
      writeMeta(meta);
    }
    const remaining = listInstalledVersions(agent);
    if (remaining.length > 0) {
      console.log(chalk.yellow(`Default version removed. Run: agents use ${agent}@<version> to set a new default`));
    }
  }

  // Clean up dangling config symlink if it pointed to the removed version
  const symlinkVersion = getConfigSymlinkVersion(agent);
  if (symlinkVersion === version) {
    const configPath = path.join(os.homedir(), `.${agent}`);
    try {
      fs.unlinkSync(configPath);
    } catch {
      // Ignore if already gone
    }
  }

  return true;
}

/**
 * Remove all versions of an agent.
 */
export function removeAllVersions(agent: AgentId): number {
  const versions = listInstalledVersions(agent);
  let removed = 0;

  for (const version of versions) {
    if (removeVersion(agent, version)) {
      removed++;
    }
  }

  // Clean up the agent directory
  const agentDir = path.join(getVersionsDir(), agent);
  if (fs.existsSync(agentDir)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }

  return removed;
}

/**
 * Get the resolved version for an agent in the current context.
 * Checks project manifest first, then global default.
 */
export function resolveVersion(agent: AgentId, projectPath?: string): string | null {
  // Check project manifest
  if (projectPath) {
    const version = getProjectVersion(agent, projectPath);
    if (version) {
      return version;
    }
  }

  // Fall back to global default
  return getGlobalDefault(agent);
}

/**
 * Get version specified in project manifest.
 */
export function getProjectVersion(agent: AgentId, startPath: string): string | null {
  let dir = path.resolve(startPath);

  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, '.agents', 'agents.yaml');
    if (fs.existsSync(manifestPath)) {
      try {
        const content = fs.readFileSync(manifestPath, 'utf-8');
        // Simple YAML parsing for agents section (flat format: claude: "1.5.0")
        const agentMatch = content.match(new RegExp(`^\\s+${agent}:\\s*['"]?([^'"\n]+)['"]?`, 'm'));
        if (agentMatch) {
          return agentMatch[1].trim();
        }
      } catch {
        // Ignore parsing errors
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Compare semver versions for sorting.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map((n) => parseInt(n, 10) || 0);
  const bParts = b.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal !== bVal) {
      return aVal - bVal;
    }
  }

  return 0;
}

/**
 * Get actual version from an installed 'latest' directory.
 */
export async function getInstalledVersion(agent: AgentId, version: string): Promise<string | null> {
  const binaryPath = getBinaryPath(agent, version);
  if (!fs.existsSync(binaryPath)) {
    return null;
  }

  try {
    const { stdout } = await execAsync(`${binaryPath} --version`);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : version;
  } catch {
    return version;
  }
}

export interface SyncResult {
  commands: boolean;
  skills: boolean;
  hooks: boolean;
  memory: string[];
  permissions: boolean;
  mcp: string[];
  subagents: string[];
  plugins: string[];
}

export interface ResourceDiff {
  commands: { added: string[]; dangling: string[] };
  skills: { added: string[]; dangling: string[] };
  hooks: { added: string[]; dangling: string[] };
  memory: { added: string[]; dangling: string[] };
  totalAdded: number;
  totalDangling: number;
}

/**
 * Get the diff between central resources (~/.agents/) and what's synced to a version.
 * Uses filesystem state - no tracking needed.
 */
export function getResourceDiff(agent: AgentId, version: string): ResourceDiff {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, `.${agent}`);

  const diff: ResourceDiff = {
    commands: { added: [], dangling: [] },
    skills: { added: [], dangling: [] },
    hooks: { added: [], dangling: [] },
    memory: { added: [], dangling: [] },
    totalAdded: 0,
    totalDangling: 0,
  };

  // Helper to check symlink status
  const getSymlinkStatus = (linkPath: string): 'valid' | 'dangling' | 'none' => {
    try {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) return 'none';
      // Check if target exists
      try {
        fs.statSync(linkPath);
        return 'valid';
      } catch {
        return 'dangling';
      }
    } catch {
      return 'none';
    }
  };

  // Commands: check directory symlink (or individual files for Gemini)
  const centralCommands = getCommandsDir();
  const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);

  if (agentConfig.format === 'toml') {
    // Gemini: compare .md files in central vs .toml files in version
    if (fs.existsSync(centralCommands)) {
      const centralFiles = fs.readdirSync(centralCommands).filter(f => f.endsWith('.md'));
      const versionFiles = fs.existsSync(commandsTarget)
        ? fs.readdirSync(commandsTarget).filter(f => f.endsWith('.toml'))
        : [];
      const versionNames = new Set(versionFiles.map(f => f.replace('.toml', '')));

      for (const file of centralFiles) {
        const name = file.replace('.md', '');
        if (!versionNames.has(name)) {
          diff.commands.added.push(file);
        }
      }
      // Check for dangling (toml exists but no md source)
      const centralNames = new Set(centralFiles.map(f => f.replace('.md', '')));
      for (const file of versionFiles) {
        const name = file.replace('.toml', '');
        if (!centralNames.has(name)) {
          diff.commands.dangling.push(file);
        }
      }
    }
  } else {
    // Other agents: check directory symlink
    const status = getSymlinkStatus(commandsTarget);
    if (status === 'none' && fs.existsSync(centralCommands)) {
      const files = fs.readdirSync(centralCommands).filter(f => f.endsWith('.md'));
      diff.commands.added = files;
    } else if (status === 'dangling') {
      diff.commands.dangling = ['commands/'];
    }
  }

  // Skills: check directory symlink (skip if agent natively reads ~/.agents/skills/)
  if (!agentConfig.nativeAgentsSkillsDir) {
    const centralSkills = getSkillsDir();
    const skillsTarget = path.join(agentDir, 'skills');
    const skillsStatus = getSymlinkStatus(skillsTarget);
    if (skillsStatus === 'none' && fs.existsSync(centralSkills)) {
      const dirs = fs.readdirSync(centralSkills).filter(f => {
        const stat = fs.statSync(path.join(centralSkills, f));
        return stat.isDirectory() && !f.startsWith('.');
      });
      diff.skills.added = dirs;
    } else if (skillsStatus === 'dangling') {
      diff.skills.dangling = ['skills/'];
    }
  }

  // Hooks: check directory symlink (if agent supports hooks)
  if (agentConfig.supportsHooks) {
    const centralHooks = getHooksDir();
    const hooksTarget = path.join(agentDir, 'hooks');
    const hooksStatus = getSymlinkStatus(hooksTarget);
    if (hooksStatus === 'none' && fs.existsSync(centralHooks)) {
      const files = fs.readdirSync(centralHooks).filter(f => !f.startsWith('.'));
      diff.hooks.added = files;
    } else if (hooksStatus === 'dangling') {
      diff.hooks.dangling = ['hooks/'];
    }
  }

  // Memory: check individual file symlinks
  const centralMemory = getMemoryDir();
  if (fs.existsSync(centralMemory)) {
    const memoryFiles = fs.readdirSync(centralMemory).filter(f => f.endsWith('.md'));
    for (const file of memoryFiles) {
      const targetName = file === 'AGENTS.md' ? agentConfig.instructionsFile : file;
      const targetPath = path.join(agentDir, targetName);
      const status = getSymlinkStatus(targetPath);
      if (status === 'none') {
        diff.memory.added.push(file);
      } else if (status === 'dangling') {
        diff.memory.dangling.push(targetName);
      }
    }
  }

  // Calculate totals
  diff.totalAdded = diff.commands.added.length + diff.skills.added.length +
    diff.hooks.added.length + diff.memory.added.length;
  diff.totalDangling = diff.commands.dangling.length + diff.skills.dangling.length +
    diff.hooks.dangling.length + diff.memory.dangling.length;

  return diff;
}

/**
 * Sync central resources (~/.agents/) into a specific version's config directory.
 * Copies selected resources from central storage into {versionHome}/.{agent}/.
 *
 * @param agent - The agent ID
 * @param version - The version string
 * @param selection - Optional resource selection. If not provided, syncs all resources.
 *
 * For Gemini: commands are converted from markdown to TOML.
 */
export function syncResourcesToVersion(agent: AgentId, version: string, selection?: ResourceSelection, options: { projectDir?: string; cwd?: string } = {}): SyncResult {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, `.${agent}`);
  fs.mkdirSync(agentDir, { recursive: true });

  const result: SyncResult = { commands: false, skills: false, hooks: false, memory: [], permissions: false, mcp: [], subagents: [], plugins: [] };
  const cwd = options.cwd || process.cwd();
  const projectAgentsDir = options.projectDir || getProjectAgentsDir(cwd);
  const available = getAvailableResources(cwd);

  // Helper: remove a path (symlink or real) if it exists
  const removePath = (p: string) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(p);
      } else if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch { /* file already removed or inaccessible */ }
  };

  // Helper: copy a directory recursively
  const copyDir = (src: string, dest: string) => {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };

  // Helper: resolve selection to list of items
  const resolveSelection = (sel: string[] | 'all' | undefined, available: string[]): string[] => {
    if (sel === 'all') return available;
    if (Array.isArray(sel)) return sel;
    return [];
  };

  // Sync commands
  const commandsToSync = selection
    ? resolveSelection(selection.commands, available.commands)
    : available.commands; // No selection = sync all

  if (commandsToSync.length > 0 && COMMANDS_CAPABLE_AGENTS.includes(agent)) {
    const centralCommands = getCommandsDir();
    const projectCommandsDir = projectAgentsDir ? path.join(projectAgentsDir, 'commands') : null;
    const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);
    fs.mkdirSync(commandsTarget, { recursive: true });

    const syncedCommands: string[] = [];
    for (const cmd of commandsToSync) {
      const projectSource = projectCommandsDir ? path.join(projectCommandsDir, `${cmd}.md`) : null;
      const userSource = path.join(centralCommands, `${cmd}.md`);
      const srcFile = projectSource && fs.existsSync(projectSource) ? projectSource : userSource;
      if (!fs.existsSync(srcFile)) continue;

      if (agentConfig.format === 'toml') {
        const content = fs.readFileSync(srcFile, 'utf-8');
        const tomlContent = markdownToToml(cmd, content);
        fs.writeFileSync(path.join(commandsTarget, `${cmd}.toml`), tomlContent);
      } else {
        fs.copyFileSync(srcFile, path.join(commandsTarget, `${cmd}.md`));
      }
      syncedCommands.push(cmd);
    }
    result.commands = syncedCommands.length > 0;
    if (syncedCommands.length > 0) {
      recordVersionResources(agent, version, 'commands', syncedCommands);
    }
  }

  // Sync skills (skip if agent natively reads ~/.agents/skills/)
  if (agentConfig.nativeAgentsSkillsDir) {
    // Clean up stale skills symlink/dir — agent reads from ~/.agents/skills/ directly
    const skillsTarget = path.join(agentDir, 'skills');
    removePath(skillsTarget);
  } else {
    const skillsToSync = selection
      ? resolveSelection(selection.skills, available.skills)
      : available.skills;

    if (skillsToSync.length > 0) {
      const centralSkills = getSkillsDir();
      const projectSkills = projectAgentsDir ? path.join(projectAgentsDir, 'skills') : null;
      const skillsTarget = path.join(agentDir, 'skills');
      fs.mkdirSync(skillsTarget, { recursive: true });

      const syncedSkills: string[] = [];
      for (const skill of skillsToSync) {
        const projectSource = projectSkills ? path.join(projectSkills, skill) : null;
        const srcDir = projectSource && fs.existsSync(projectSource) ? projectSource : path.join(centralSkills, skill);
        if (!fs.existsSync(srcDir)) continue;

        const destDir = path.join(skillsTarget, skill);
        removePath(destDir);
        copyDir(srcDir, destDir);
        syncedSkills.push(skill);
      }
      result.skills = syncedSkills.length > 0;
      if (syncedSkills.length > 0) {
        recordVersionResources(agent, version, 'skills', syncedSkills);
      }
    }
  }

  // Sync hooks (if agent supports them)
  if (agentConfig.supportsHooks) {
    const hooksToSync = selection
      ? resolveSelection(selection.hooks, available.hooks)
      : available.hooks;

    if (hooksToSync.length > 0) {
      const centralHooks = getHooksDir();
      const projectHooksDir = projectAgentsDir ? path.join(projectAgentsDir, 'hooks') : null;
      const hooksTarget = path.join(agentDir, 'hooks');
      fs.mkdirSync(hooksTarget, { recursive: true });

      const syncedHooks: string[] = [];
      for (const hook of hooksToSync) {
        const projectSource = projectHooksDir ? path.join(projectHooksDir, hook) : null;
        const srcFile = projectSource && fs.existsSync(projectSource) ? projectSource : path.join(centralHooks, hook);
        if (!fs.existsSync(srcFile)) continue;

        const destFile = path.join(hooksTarget, hook);
        fs.copyFileSync(srcFile, destFile);
        fs.chmodSync(destFile, 0o755);
        syncedHooks.push(hook);
      }
      result.hooks = syncedHooks.length > 0;
      if (syncedHooks.length > 0) {
        recordVersionResources(agent, version, 'hooks', syncedHooks);
      }

      if (agent === 'claude') {
        registerHooksToSettings(agent, versionHome);
      }
    }
  }

  // Sync memory files
  const memoryToSync = selection
    ? resolveSelection(selection.memory, available.memory)
    : available.memory;

  if (memoryToSync.length > 0 && COMMANDS_CAPABLE_AGENTS.includes(agent)) {
    const centralMemory = getMemoryDir();
    const projectMemoryDir = projectAgentsDir ? path.join(projectAgentsDir, 'memory') : null;
    const syncedMemory: string[] = [];

    for (const mem of memoryToSync) {
      const projectSource = projectMemoryDir ? path.join(projectMemoryDir, `${mem}.md`) : null;
      const srcFile = projectSource && fs.existsSync(projectSource)
        ? projectSource
        : path.join(centralMemory, `${mem}.md`);
      if (!fs.existsSync(srcFile)) continue;

      const targetName = mem === 'AGENTS' ? agentConfig.instructionsFile : `${mem}.md`;
      const destFile = path.join(agentDir, targetName);

      removePath(destFile);
      fs.copyFileSync(srcFile, destFile);
      result.memory.push(targetName);
      syncedMemory.push(mem);
    }
    if (syncedMemory.length > 0) {
      recordVersionResources(agent, version, 'memory', syncedMemory);
    }
  }

  // Apply permissions (if agent supports them)
  // Permissions are now stored as groups in ~/.agents/permissions/groups/
  const permissionGroups = discoverPermissionGroups();
  const allGroupNames = permissionGroups.map(g => g.name);
  const permsToSync = selection
    ? resolveSelection(selection.permissions, allGroupNames)
    : (PERMISSIONS_CAPABLE_AGENTS.includes(agent) ? allGroupNames : []);

  if (permsToSync.length > 0 && PERMISSIONS_CAPABLE_AGENTS.includes(agent)) {
    // Build permissions from selected groups
    const builtPerms = buildPermissionsFromGroups(permsToSync);
    if (builtPerms.allow.length > 0 || (builtPerms.deny && builtPerms.deny.length > 0)) {
      const permResult = applyPermsToVersion(agent, builtPerms, versionHome, true);
      result.permissions = permResult.success;
      if (permResult.success) {
        recordVersionResources(agent, version, 'permissions', permsToSync);
      }
    }
  }

  // Install MCP servers (if agent supports them)
  // For Claude/Codex: uses CLI commands (claude mcp add, codex mcp add)
  // For others: edits config files directly
  const mcpToSync = selection
    ? resolveSelection(selection.mcp, available.mcp)
    : (MCP_CAPABLE_AGENTS.includes(agent) ? available.mcp : []);

  if (mcpToSync.length > 0 && MCP_CAPABLE_AGENTS.includes(agent)) {
    const mcpResult = installMcpServers(agent, version, versionHome, mcpToSync, { cwd });
    result.mcp = mcpResult.applied;
    if (mcpResult.applied.length > 0) {
      recordVersionResources(agent, version, 'mcp', mcpResult.applied);
    }
  }

  // Sync subagents (claude and openclaw only)
  const subagentsToSync = selection
    ? resolveSelection(selection.subagents, available.subagents)
    : (SUBAGENT_CAPABLE_AGENTS.includes(agent) ? available.subagents : []);

  if (subagentsToSync.length > 0 && SUBAGENT_CAPABLE_AGENTS.includes(agent)) {
    const allSubagents = listInstalledSubagents();
    const subagentsMap = new Map(allSubagents.map(s => [s.name, s]));

    for (const name of subagentsToSync) {
      const subagent = subagentsMap.get(name);
      if (!subagent) continue;

      try {
        if (agent === 'claude') {
          // Claude: flatten to single .md file
          const agentsDir = path.join(agentDir, 'agents');
          fs.mkdirSync(agentsDir, { recursive: true });
          const transformed = transformSubagentForClaude(subagent.path);
          fs.writeFileSync(path.join(agentsDir, `${subagent.name}.md`), transformed);
          result.subagents.push(subagent.name);
        } else if (agent === 'openclaw') {
          // OpenClaw: copy full directory, rename AGENT.md -> AGENTS.md
          const targetDir = path.join(versionHome, '.openclaw', subagent.name);
          const syncResult = syncSubagentToOpenclaw(subagent.path, targetDir);
          if (syncResult.success) {
            result.subagents.push(subagent.name);
          }
        }
      } catch { /* resource sync failed for this item */ }
    }

    if (result.subagents.length > 0) {
      recordVersionResources(agent, version, 'subagents', result.subagents);
    }
  }

  // Sync plugins (claude and openclaw)
  const pluginsToSync = selection
    ? resolveSelection(selection.plugins, available.plugins)
    : (PLUGINS_CAPABLE_AGENTS.includes(agent) ? available.plugins : []);

  if (pluginsToSync.length > 0 && PLUGINS_CAPABLE_AGENTS.includes(agent)) {
    const allPlugins = discoverPlugins();
    const pluginMap = new Map(allPlugins.map(p => [p.name, p]));

    // Clean orphaned plugin skills from plugins that no longer exist
    const activePluginNames = new Set(allPlugins.map(p => p.name));
    cleanOrphanedPluginSkills(agent, versionHome, activePluginNames);

    for (const name of pluginsToSync) {
      const plugin = pluginMap.get(name);
      if (!plugin || !pluginSupportsAgent(plugin, agent)) continue;

      const pluginResult = syncPluginToVersion(plugin, agent, versionHome);
      if (pluginResult.success) {
        result.plugins.push(name);
      }
    }

    if (result.plugins.length > 0) {
      recordVersionResources(agent, version, 'plugins', result.plugins);
    }
  }

  return result;
}

/**
 * Get the effective HOME directory for an agent.
 * If version-managed with a resolved version, returns the version's home directory.
 * Otherwise returns the real HOME.
 */
export function getEffectiveHome(agentId: AgentId): string {
  const resolved = resolveVersion(agentId, process.cwd());
  if (resolved && isVersionInstalled(agentId, resolved)) {
    return getVersionHomePath(agentId, resolved);
  }
  return os.homedir();
}

export interface VersionSelectionResult {
  selectedAgents: AgentId[];
  versionSelections: Map<AgentId, string[]>;
}

export interface InstalledAgentTargetResult {
  selectedAgents: AgentId[];
  directAgents: AgentId[];
  versionSelections: Map<AgentId, string[]>;
}

/**
 * Resolve a comma-separated --agents list into concrete version selections.
 * Bare agents target the default version, or the newest installed version when no default exists.
 * Explicit agent@version targets only that installed version.
 */
export function resolveAgentVersionTargets(
  value: string,
  availableAgents: readonly AgentId[],
  options: { allVersions?: boolean } = {}
): VersionSelectionResult {
  const selectedAgents: AgentId[] = [];
  const versionSelections = new Map<AgentId, string[]>();
  const explicitSelections = new Set<AgentId>();
  const targets = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  for (const target of targets) {
    const atIndex = target.indexOf('@');
    const agentToken = (atIndex === -1 ? target : target.slice(0, atIndex)).trim();
    const versionToken = atIndex === -1 ? null : target.slice(atIndex + 1).trim();

    if (!agentToken) {
      continue;
    }

    if (atIndex !== -1 && !versionToken) {
      throw new Error(`Missing version in --agents entry '${target}'. Use agent@x.y.z or agent@default.`);
    }

    const agentId = resolveAgentName(agentToken);
    if (!agentId || !availableAgents.includes(agentId)) {
      throw new Error(formatAgentError(agentToken, [...availableAgents]));
    }

    if (!selectedAgents.includes(agentId)) {
      selectedAgents.push(agentId);
    }

    if (explicitSelections.has(agentId) && !versionToken) {
      continue;
    }

    const installedVersions = listInstalledVersions(agentId);
    const defaultVersion = getGlobalDefault(agentId);

    if (!versionToken) {
      if (installedVersions.length === 0) {
        continue;
      }

      versionSelections.set(
        agentId,
        options.allVersions
          ? [...installedVersions]
          : [defaultVersion || installedVersions[installedVersions.length - 1]]
      );
      continue;
    }

    if (installedVersions.length === 0) {
      throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
    }

    if (versionToken === 'default') {
      if (!defaultVersion) {
        throw new Error(`No default version set for ${AGENTS[agentId].name}. Run: agents use ${agentId}@<version>`);
      }

      const explicitVersions = explicitSelections.has(agentId)
        ? (versionSelections.get(agentId) || [])
        : [];

      if (!explicitVersions.includes(defaultVersion)) {
        explicitVersions.push(defaultVersion);
      }
      versionSelections.set(agentId, explicitVersions);
      explicitSelections.add(agentId);
      continue;
    }

    if (!installedVersions.includes(versionToken)) {
      throw new Error(
        `Version ${versionToken} is not installed for ${AGENTS[agentId].name}. Installed versions: ${installedVersions.join(', ')}`
      );
    }

    const explicitVersions = explicitSelections.has(agentId)
      ? (versionSelections.get(agentId) || [])
      : [];

    if (!explicitVersions.includes(versionToken)) {
      explicitVersions.push(versionToken);
    }
    versionSelections.set(agentId, explicitVersions);
    explicitSelections.add(agentId);
  }

  return { selectedAgents, versionSelections };
}

/**
 * Resolve a comma-separated --agents list into install/apply targets.
 * Bare agents target the default version (or newest installed version) when managed,
 * and fall back to the agent's effective HOME when unmanaged.
 * Explicit agent@version targets only that installed version.
 */
export function resolveInstalledAgentTargets(
  value: string,
  availableAgents: readonly AgentId[],
  options: { allVersions?: boolean } = {}
): InstalledAgentTargetResult {
  const selectedAgents: AgentId[] = [];
  const directAgents: AgentId[] = [];
  const versionSelections = new Map<AgentId, string[]>();
  const targets = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const addVersionTarget = (agentId: AgentId, version: string) => {
    const versions = versionSelections.get(agentId) || [];
    if (!versions.includes(version)) {
      versions.push(version);
      versionSelections.set(agentId, versions);
    }

    const directIndex = directAgents.indexOf(agentId);
    if (directIndex !== -1) {
      directAgents.splice(directIndex, 1);
    }
  };

  for (const target of targets) {
    const atIndex = target.indexOf('@');
    const agentToken = (atIndex === -1 ? target : target.slice(0, atIndex)).trim();
    const versionToken = atIndex === -1 ? null : target.slice(atIndex + 1).trim();

    if (!agentToken) {
      continue;
    }

    if (atIndex !== -1 && !versionToken) {
      throw new Error(`Missing version in --agents entry '${target}'. Use agent@x.y.z or agent@default.`);
    }

    const agentId = resolveAgentName(agentToken);
    if (!agentId || !availableAgents.includes(agentId)) {
      throw new Error(formatAgentError(agentToken, [...availableAgents]));
    }

    if (!selectedAgents.includes(agentId)) {
      selectedAgents.push(agentId);
    }

    const installedVersions = listInstalledVersions(agentId);
    const defaultVersion = getGlobalDefault(agentId);

    if (!versionToken) {
      if (installedVersions.length === 0) {
        if (!directAgents.includes(agentId)) {
          directAgents.push(agentId);
        }
        continue;
      }

      const targetVersions = options.allVersions
        ? [...installedVersions]
        : [defaultVersion || installedVersions[installedVersions.length - 1]];

      for (const version of targetVersions) {
        addVersionTarget(agentId, version);
      }
      continue;
    }

    if (versionToken === 'default') {
      if (!defaultVersion) {
        throw new Error(`No default version set for ${AGENTS[agentId].name}. Run: agents use ${agentId}@<version>`);
      }
      addVersionTarget(agentId, defaultVersion);
      continue;
    }

    if (installedVersions.length === 0) {
      throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
    }

    if (!installedVersions.includes(versionToken)) {
      throw new Error(
        `Version ${versionToken} is not installed for ${AGENTS[agentId].name}. Installed versions: ${installedVersions.join(', ')}`
      );
    }

    addVersionTarget(agentId, versionToken);
  }

  return { selectedAgents, directAgents, versionSelections };
}

/**
 * Resolve configured manifest targets into direct homes and managed versions.
 */
export function resolveConfiguredAgentTargets(
  agents: readonly AgentId[] | undefined,
  agentVersions: Partial<Record<AgentId, string[]>> | undefined,
  availableAgents: readonly AgentId[],
  options: { allVersions?: boolean } = {}
): InstalledAgentTargetResult {
  const targetSpecs: string[] = [];
  const broadTargets = agents ? [...agents] : [...availableAgents];

  for (const agentId of broadTargets) {
    if (availableAgents.includes(agentId)) {
      targetSpecs.push(agentId);
    }
  }

  if (agentVersions) {
    for (const [agentId, versions] of Object.entries(agentVersions) as Array<[AgentId, string[] | undefined]>) {
      if (!availableAgents.includes(agentId) || !versions) continue;
      for (const version of versions) {
        targetSpecs.push(`${agentId}@${version}`);
      }
    }
  }

  if (targetSpecs.length === 0) {
    return {
      selectedAgents: [],
      directAgents: [],
      versionSelections: new Map(),
    };
  }

  return resolveInstalledAgentTargets(targetSpecs.join(','), availableAgents, options);
}

/**
 * Prompt user to select agents and versions for resource installation.
 * Returns selected agents and their version selections.
 */
export async function promptAgentVersionSelection(
  availableAgents: AgentId[],
  options: { skipPrompts?: boolean } = {}
): Promise<VersionSelectionResult> {
  const versionSelections = new Map<AgentId, string[]>();

  // Filter to installed agents (only those with versions managed by agents CLI)
  const installedAgents = availableAgents.filter((id) => {
    const versions = listInstalledVersions(id);
    return versions.length > 0;
  });

  if (installedAgents.length === 0) {
    return { selectedAgents: [], versionSelections };
  }

  const formatAgentLabel = (agentId: AgentId): string => {
    const versions = listInstalledVersions(agentId);
    const defaultVer = getGlobalDefault(agentId);
    if (versions.length === 0) return `${AGENTS[agentId].name}  ${chalk.gray('(not installed)')}`;
    if (defaultVer) return `${AGENTS[agentId].name}  ${chalk.gray(`(active: ${defaultVer})`)}`;
    return `${AGENTS[agentId].name}  ${chalk.gray(`(${versions[0]})`)}`;
  };

  let selectedAgents: AgentId[];

  if (options.skipPrompts) {
    // Auto-select all installed agents with default versions
    selectedAgents = [...installedAgents];
    for (const agentId of selectedAgents) {
      const versions = listInstalledVersions(agentId);
      if (versions.length > 0) {
        const defaultVer = getGlobalDefault(agentId);
        versionSelections.set(agentId, defaultVer ? [defaultVer] : [versions[versions.length - 1]]);
      }
    }
  } else {
    // Prompt for agent selection
    const checkboxResult = await checkbox<string>({
      message: 'Which agents should receive these resources?',
      choices: [
        { name: chalk.bold('All'), value: 'all', checked: true },
        ...installedAgents.map((id) => ({
          name: `  ${formatAgentLabel(id)}`,
          value: id,
          checked: false,
        })),
      ],
    });

    if (checkboxResult.includes('all')) {
      selectedAgents = [...installedAgents];
    } else {
      selectedAgents = checkboxResult as AgentId[];
    }

    // Version selection per agent
    for (const agentId of selectedAgents) {
      const versions = listInstalledVersions(agentId);
      if (versions.length === 0) continue;
      if (versions.length === 1) {
        versionSelections.set(agentId, [versions[0]]);
        continue;
      }

      const defaultVer = getGlobalDefault(agentId);
      const versionEmails = await Promise.all(
        versions.map((v) =>
          getAccountEmail(agentId, getVersionHomePath(agentId, v)).then((email) => ({ v, email }))
        )
      );
      const versionEmailMap = new Map(versionEmails.map((e) => [e.v, e.email]));

      const maxLabelLen = Math.max(...versions.map((v) => (v === defaultVer ? `${v} (default)` : v).length));
      const versionResult = await checkbox<string>({
        message: `Which versions of ${AGENTS[agentId].name} should receive these resources?`,
        choices: [
          { name: chalk.bold('All versions'), value: 'all', checked: false },
          ...versions.map((v) => {
            const base = v === defaultVer ? `${v} (default)` : v;
            let label = base.padEnd(maxLabelLen);
            const email = versionEmailMap.get(v);
            if (email) label += chalk.cyan(`  ${email}`);
            return { name: label, value: v, checked: v === defaultVer };
          }),
        ],
      });

      if (versionResult.includes('all')) {
        versionSelections.set(agentId, [...versions]);
      } else {
        versionSelections.set(agentId, versionResult);
      }
    }
  }

  return { selectedAgents, versionSelections };
}
