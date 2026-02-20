/**
 * MCP server management - reading from ~/.agents/mcp/ and applying to agent configs.
 *
 * MCP servers are stored as YAML files in ~/.agents/mcp/:
 *   ~/.agents/mcp/swarm.yaml
 *   ~/.agents/mcp/figma.yaml
 *
 * Each file defines a server that gets applied (merged) into agent configs during sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import type { AgentId } from './types.js';
import { getMcpDir } from './state.js';
import { MCP_CAPABLE_AGENTS } from './agents.js';

/**
 * MCP server config as stored in ~/.agents/mcp/*.yaml
 */
export interface McpYamlConfig {
  name: string;
  transport: 'stdio' | 'http';
  // For stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // For http transport
  url?: string;
  // Optional: limit to specific agents (default: all MCP-capable)
  agents?: AgentId[];
}

export interface InstalledMcpServer {
  name: string;
  path: string;
  config: McpYamlConfig;
}

/**
 * Parse an MCP server config from a YAML file.
 */
export function parseMcpServerConfig(filePath: string): McpYamlConfig | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    // Validate required fields
    if (!parsed.name || !parsed.transport) {
      return null;
    }

    // Validate transport-specific fields
    if (parsed.transport === 'stdio' && !parsed.command) {
      return null;
    }
    if (parsed.transport === 'http' && !parsed.url) {
      return null;
    }

    return parsed as McpYamlConfig;
  } catch {
    return null;
  }
}

/**
 * List all MCP server configs from ~/.agents/mcp/.
 */
export function listMcpServerConfigs(): InstalledMcpServer[] {
  const mcpDir = getMcpDir();
  if (!fs.existsSync(mcpDir)) {
    return [];
  }

  const results: InstalledMcpServer[] = [];
  const entries = fs.readdirSync(mcpDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

    const filePath = path.join(mcpDir, entry.name);
    const config = parseMcpServerConfig(filePath);
    if (config) {
      results.push({
        name: config.name,
        path: filePath,
        config,
      });
    }
  }

  return results;
}

/**
 * Get MCP servers that should be applied to a specific agent.
 */
export function getMcpServersForAgent(agentId: AgentId): InstalledMcpServer[] {
  if (!MCP_CAPABLE_AGENTS.includes(agentId)) {
    return [];
  }

  const allServers = listMcpServerConfigs();
  return allServers.filter((server) => {
    // If agents is specified, check if this agent is in the list
    if (server.config.agents && server.config.agents.length > 0) {
      return server.config.agents.includes(agentId);
    }
    // Otherwise, apply to all MCP-capable agents
    return true;
  });
}

/**
 * Apply MCP servers to a version's config file.
 * Merges new servers with existing ones (doesn't overwrite).
 */
export function applyMcpToVersion(
  agentId: AgentId,
  versionHome: string,
  merge: boolean = true
): { success: boolean; applied: string[]; error?: string } {
  const servers = getMcpServersForAgent(agentId);
  if (servers.length === 0) {
    return { success: true, applied: [] };
  }

  const configDir = path.join(versionHome, `.${agentId}`);
  fs.mkdirSync(configDir, { recursive: true });

  const applied: string[] = [];

  try {
    if (agentId === 'claude') {
      // Claude stores MCPs in ~/.claude.json (in version home as .claude.json)
      const configPath = path.join(versionHome, '.claude.json');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        config.mcpServers = {};
      }

      const mcpServers = config.mcpServers as Record<string, unknown>;
      for (const server of servers) {
        if (merge && mcpServers[server.name]) {
          continue; // Don't overwrite existing
        }

        if (server.config.transport === 'stdio') {
          mcpServers[server.name] = {
            command: server.config.command,
            args: server.config.args || [],
            env: server.config.env || {},
          };
        } else {
          mcpServers[server.name] = {
            url: server.config.url,
          };
        }
        applied.push(server.name);
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true, applied };
    }

    if (agentId === 'codex') {
      // Codex stores MCPs in config.toml under [mcp_servers.Name]
      const configPath = path.join(configDir, 'config.toml');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      }

      if (!config.mcp_servers || typeof config.mcp_servers !== 'object') {
        config.mcp_servers = {};
      }

      const mcpServers = config.mcp_servers as Record<string, unknown>;
      for (const server of servers) {
        if (merge && mcpServers[server.name]) {
          continue; // Don't overwrite existing
        }

        if (server.config.transport === 'stdio') {
          mcpServers[server.name] = {
            command: server.config.command,
            args: server.config.args || [],
            ...(server.config.env && { env: server.config.env }),
          };
        } else {
          mcpServers[server.name] = {
            url: server.config.url,
          };
        }
        applied.push(server.name);
      }

      fs.writeFileSync(configPath, TOML.stringify(config as any), 'utf-8');
      return { success: true, applied };
    }

    if (agentId === 'gemini') {
      // Gemini stores MCPs in settings.json under mcpServers
      const configPath = path.join(configDir, 'settings.json');
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        config.mcpServers = {};
      }

      const mcpServers = config.mcpServers as Record<string, unknown>;
      for (const server of servers) {
        if (merge && mcpServers[server.name]) {
          continue;
        }

        if (server.config.transport === 'stdio') {
          mcpServers[server.name] = {
            command: server.config.command,
            args: server.config.args || [],
            env: server.config.env || {},
          };
        } else {
          mcpServers[server.name] = {
            url: server.config.url,
          };
        }
        applied.push(server.name);
      }

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true, applied };
    }

    // For other agents, skip MCP application
    return { success: true, applied: [] };
  } catch (err) {
    return { success: false, applied, error: (err as Error).message };
  }
}

/**
 * Write an MCP server config to ~/.agents/mcp/.
 */
export function writeMcpServerConfig(config: McpYamlConfig): string {
  const mcpDir = getMcpDir();
  fs.mkdirSync(mcpDir, { recursive: true });

  const fileName = `${config.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}.yaml`;
  const filePath = path.join(mcpDir, fileName);

  const content = yaml.stringify(config);
  fs.writeFileSync(filePath, content, 'utf-8');

  return filePath;
}

/**
 * Remove an MCP server config from ~/.agents/mcp/.
 */
export function removeMcpServerConfig(name: string): boolean {
  const servers = listMcpServerConfigs();
  const server = servers.find((s) => s.name === name);
  if (!server) {
    return false;
  }

  fs.unlinkSync(server.path);
  return true;
}
