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
import { execSync } from 'child_process';
import * as os from 'os';
import type { AgentId } from './types.js';
import { getMcpDir, getProjectAgentsDir } from './state.js';
import { MCP_CAPABLE_AGENTS, AGENTS } from './agents.js';

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
}

export interface InstalledMcpServer {
  name: string;
  path: string;
  config: McpYamlConfig;
  scope?: 'user' | 'project';
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
export function listMcpServerConfigs(cwd: string = process.cwd()): InstalledMcpServer[] {
  const dirs: Array<{ scope: 'project' | 'user'; dir: string }> = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    dirs.push({ scope: 'project', dir: path.join(projectAgentsDir, 'mcp') });
  }
  dirs.push({ scope: 'user', dir: getMcpDir() });

  const results = new Map<string, InstalledMcpServer>();

  for (const { scope, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

      const filePath = path.join(dir, entry.name);
      const config = parseMcpServerConfig(filePath);
      if (config && !results.has(config.name)) {
        results.set(config.name, {
          name: config.name,
          path: filePath,
          config,
          scope,
        });
      }
    }
  }

  return Array.from(results.values());
}

/**
 * Get MCP servers by name.
 * If names is provided, returns only those servers.
 * Otherwise returns all servers.
 */
export function getMcpServersByName(names?: string[], options: { cwd?: string } = {}): InstalledMcpServer[] {
  const allServers = listMcpServerConfigs(options.cwd);
  if (!names || names.length === 0) {
    return allServers;
  }
  return allServers.filter((server) => names.includes(server.name));
}

/**
 * Install MCP server using Claude CLI.
 * Uses: claude mcp add --scope user --transport <type> <name> [--env K=V]... -- <cmd> [args...]
 */
function installMcpViaClaude(binaryPath: string, server: InstalledMcpServer, versionHome: string): void {
  const execEnv = { ...process.env, HOME: versionHome };

  if (server.config.transport === 'stdio') {
    // Build env args
    const envArgs: string[] = [];
    if (server.config.env) {
      for (const [key, value] of Object.entries(server.config.env)) {
        envArgs.push('--env', `${key}=${value}`);
      }
    }

    // claude mcp add --scope user --transport stdio <name> [--env K=V]... -- <cmd> [args...]
    const args = [
      'mcp', 'add', '--scope', 'user', '--transport', 'stdio',
      server.name,
      ...envArgs,
      '--',
      server.config.command!,
      ...(server.config.args || [])
    ];

    execSync(`"${binaryPath}" ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`, {
      stdio: 'pipe',
      timeout: 30000,
      env: execEnv,
    });
  } else {
    // claude mcp add --scope user --transport http <name> <url>
    execSync(`"${binaryPath}" mcp add --scope user --transport http "${server.name}" "${server.config.url}"`, {
      stdio: 'pipe',
      timeout: 30000,
      env: execEnv,
    });
  }
}

/**
 * Install MCP server using Codex CLI.
 * Uses: codex mcp add <name> -- <cmd> [args...]
 */
function installMcpViaCodex(binaryPath: string, server: InstalledMcpServer, versionHome: string): void {
  if (server.config.transport === 'stdio') {
    // codex mcp add <name> -- <cmd> [args...]
    const args = [
      'mcp', 'add', server.name,
      '--',
      server.config.command!,
      ...(server.config.args || [])
    ];

    execSync(`"${binaryPath}" ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`, {
      stdio: 'pipe',
      timeout: 30000,
      env: { ...process.env, HOME: versionHome },
    });
  }
  // Note: Codex may not support HTTP MCPs
}

/**
 * Install MCP server to Gemini config file.
 */
function installMcpToGeminiConfig(server: InstalledMcpServer, versionHome: string): void {
  const configPath = path.join(versionHome, '.gemini', 'settings.json');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const mcpServers = config.mcpServers as Record<string, unknown>;

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

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Install MCP server to Cursor config file.
 */
function installMcpToCursorConfig(server: InstalledMcpServer, versionHome: string): void {
  const configPath = path.join(versionHome, '.cursor', 'mcp.json');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const mcpServers = config.mcpServers as Record<string, unknown>;

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

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Install MCP server to OpenCode config file.
 */
function installMcpToOpenCodeConfig(server: InstalledMcpServer, versionHome: string): void {
  const configPath = path.join(versionHome, '.opencode', 'opencode.jsonc');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    // Strip JSONC comments
    const jsonContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    try {
      config = JSON.parse(jsonContent);
    } catch {
      config = {};
    }
  }

  if (!config.mcp || typeof config.mcp !== 'object') {
    config.mcp = {};
  }

  const mcpServers = config.mcp as Record<string, unknown>;

  if (server.config.transport === 'stdio') {
    // OpenCode uses command as array
    const commandArray = [server.config.command, ...(server.config.args || [])];
    mcpServers[server.name] = {
      type: 'local',
      command: commandArray,
      ...(server.config.env && { env: server.config.env }),
    };
  } else {
    mcpServers[server.name] = {
      type: 'remote',
      url: server.config.url,
    };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Install MCP servers to an agent.
 * For Claude/Codex: uses CLI commands (claude mcp add, codex mcp add)
 * For others: edits config files directly
 */
export function installMcpServers(
  agentId: AgentId,
  version: string,
  versionHome: string,
  mcpNames?: string[],
  options: { cwd?: string } = {}
): { success: boolean; applied: string[]; errors: string[] } {
  if (!MCP_CAPABLE_AGENTS.includes(agentId)) {
    return { success: true, applied: [], errors: [] };
  }

  const servers = getMcpServersByName(mcpNames, { cwd: options.cwd });
  if (servers.length === 0) {
    return { success: true, applied: [], errors: [] };
  }

  const applied: string[] = [];
  const errors: string[] = [];

  // Get binary path for CLI-based agents
  const homeDir = os.homedir();
  const agentsDir = path.join(homeDir, '.agents');
  const cliCommand = AGENTS[agentId].cliCommand;
  const binaryPath = path.join(agentsDir, 'versions', agentId, version, 'node_modules', '.bin', cliCommand);

  for (const server of servers) {
    try {
      if (agentId === 'claude') {
        installMcpViaClaude(binaryPath, server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'codex') {
        installMcpViaCodex(binaryPath, server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'gemini') {
        installMcpToGeminiConfig(server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'cursor') {
        installMcpToCursorConfig(server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'opencode') {
        installMcpToOpenCodeConfig(server, versionHome);
        applied.push(server.name);
      }
    } catch (err) {
      const message = (err as Error).message;
      // Check if it's an "already exists" error - that's not a real error
      if (message.includes('already exists') || message.includes('already configured')) {
        applied.push(server.name); // Count as applied since it's already there
      } else {
        errors.push(`${server.name}: ${message}`);
      }
    }
  }

  return { success: errors.length === 0, applied, errors };
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
