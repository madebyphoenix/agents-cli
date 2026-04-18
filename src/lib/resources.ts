/**
 * Unified resource discovery for agents.
 * Scans filesystem (source of truth) to find all installed resources for an agent.
 */

import type { AgentId } from './types.js';
import { AGENTS, listInstalledMcpsWithScope } from './agents.js';
import { listInstalledCommandsWithScope } from './commands.js';
import { listInstalledSkillsWithScope, type SkillParseError } from './skills.js';
import { listInstalledHooksWithScope } from './hooks.js';
import { listInstalledInstructionsWithScope } from './memory.js';
import { getEffectiveHome } from './versions.js';
import { listMcpServerConfigs } from './mcp.js';

export interface ResourceEntry {
  name: string;
  path: string;
  scope: 'user' | 'project';
}

export interface SkillResourceEntry extends ResourceEntry {
  ruleCount?: number;
}

export interface McpResourceEntry {
  name: string;
  scope: 'user' | 'project';
  version?: string;
}

export interface AgentResources {
  agentId: AgentId;
  commands: ResourceEntry[];
  skills: SkillResourceEntry[];
  skillErrors: SkillParseError[];
  mcp: McpResourceEntry[];
  memory: ResourceEntry[];
  hooks: ResourceEntry[];
}

export interface GetAgentResourcesOptions {
  cwd?: string;
  scope?: 'user' | 'project' | 'all';
  /** For MCP scanning - whether the CLI is installed */
  cliInstalled?: boolean;
  /** Version home to scan for user-scoped resources */
  home?: string;
}

/**
 * Get all resources installed for a specific agent by scanning the filesystem.
 * This is the source of truth - not the tracking data in agents.yaml.
 */
export function getAgentResources(
  agentId: AgentId,
  options: GetAgentResourcesOptions = {}
): AgentResources {
  const { cwd = process.cwd(), scope = 'all', cliInstalled = true, home } = options;
  const agent = AGENTS[agentId];

  const shouldInclude = (resourceScope: 'user' | 'project'): boolean => {
    if (scope === 'all') return true;
    return resourceScope === scope;
  };

  // Commands
  const commands: ResourceEntry[] = [];
  for (const cmd of listInstalledCommandsWithScope(agentId, cwd, { home })) {
    if (shouldInclude(cmd.scope)) {
      commands.push({ name: cmd.name, path: cmd.path, scope: cmd.scope });
    }
  }

  // Skills
  const skills: SkillResourceEntry[] = [];
  const skillErrors: SkillParseError[] = [];
  for (const skill of listInstalledSkillsWithScope(agentId, cwd, { home, errors: skillErrors })) {
    if (shouldInclude(skill.scope)) {
      skills.push({
        name: skill.name,
        path: skill.path,
        scope: skill.scope,
        ruleCount: skill.ruleCount,
      });
    }
  }

  // MCP
  const mcp: McpResourceEntry[] = [];
  const mcpByName = new Map<string, McpResourceEntry>();

  // Project/user-scoped MCP definitions from .agents/mcp
  for (const server of listMcpServerConfigs(cwd)) {
    const scope = server.scope || 'user';
    if (shouldInclude(scope) && !mcpByName.has(server.name)) {
      mcpByName.set(server.name, { name: server.name, scope });
    }
  }

  if (cliInstalled) {
    const effectiveHome = home || getEffectiveHome(agentId);
    for (const m of listInstalledMcpsWithScope(agentId, cwd, { home: effectiveHome })) {
      if (!shouldInclude(m.scope)) continue;
      if (!mcpByName.has(m.name)) {
        mcpByName.set(m.name, { name: m.name, scope: m.scope, version: m.version });
      }
    }
  }

  mcp.push(...mcpByName.values());

  // Memory/Instructions
  const memory: ResourceEntry[] = [];
  for (const instr of listInstalledInstructionsWithScope(agentId, cwd, { home })) {
    if (instr.exists && shouldInclude(instr.scope)) {
      memory.push({
        name: agent.instructionsFile,
        path: instr.path,
        scope: instr.scope,
      });
    }
  }

  // Hooks
  const hooks: ResourceEntry[] = [];
  for (const hook of listInstalledHooksWithScope(agentId, cwd, { home })) {
    if (shouldInclude(hook.scope)) {
      hooks.push({ name: hook.name, path: hook.path, scope: hook.scope });
    }
  }

  return {
    agentId,
    commands,
    skills,
    skillErrors,
    mcp,
    memory,
    hooks,
  };
}

/**
 * Get resources for all agents.
 */
export function getAllAgentResources(
  agentIds: AgentId[],
  options: GetAgentResourcesOptions & { cliStates?: Record<AgentId, { installed: boolean }> } = {}
): AgentResources[] {
  const { cliStates, ...restOptions } = options;

  return agentIds.map((agentId) => {
    const cliInstalled = cliStates?.[agentId]?.installed ?? true;
    return getAgentResources(agentId, { ...restOptions, cliInstalled });
  });
}
