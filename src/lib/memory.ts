import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AGENTS, ALL_AGENT_IDS } from './agents.js';
import { getMemoryDir, getProjectAgentsDir } from './state.js';
import { getEffectiveHome } from './versions.js';
import type { AgentId } from './types.js';

export type InstructionsScope = 'user' | 'project';

export interface InstalledInstructions {
  agentId: AgentId;
  scope: InstructionsScope;
  path: string;
  exists: boolean;
}

export interface DiscoveredInstructions {
  agentId: AgentId;
  sourcePath: string;
  filename: string;
}

/**
 * Central memory filename constant.
 * All agents map to this file in ~/.agents/memory/, renamed per-agent when synced.
 */
export const CENTRAL_MEMORY_FILENAME = 'AGENTS.md';

/**
 * Get the canonical central memory filename for an agent's instructionsFile.
 * Central storage uses AGENTS.md, which gets renamed per-agent when syncing:
 *   - Claude: AGENTS.md → CLAUDE.md
 *   - Gemini: AGENTS.md → GEMINI.md
 *   - Cursor: AGENTS.md → .cursorrules
 *   - Codex/OpenCode: AGENTS.md → AGENTS.md (no rename)
 */
export function getCentralMemoryFileName(agentId: AgentId): string {
  const agent = AGENTS[agentId];
  const instrFile = agent.instructionsFile;

  // If it contains a path separator, extract just the filename
  const filename = instrFile.includes('/') ? path.basename(instrFile) : instrFile;

  // If the agent's instructionsFile isn't AGENTS.md, it was renamed FROM AGENTS.md
  if (filename !== CENTRAL_MEMORY_FILENAME) {
    return CENTRAL_MEMORY_FILENAME;
  }
  return filename;
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/**
 * Get the user-scope config dir for an agent (version-aware).
 */
function getUserConfigDir(agentId: AgentId): string {
  const home = getEffectiveHome(agentId);
  return path.join(home, `.${agentId}`);
}

export function getInstructionsPath(agentId: AgentId, scope: InstructionsScope, cwd: string = process.cwd()): string {
  const agent = AGENTS[agentId];
  if (scope === 'user') {
    return path.join(getUserConfigDir(agentId), agent.instructionsFile);
  }
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    const projectMemoryDir = path.join(projectAgentsDir, 'memory');
    const centralName = getCentralMemoryFileName(agentId);
    const candidates = [
      path.join(projectMemoryDir, centralName),
      path.join(projectMemoryDir, agent.instructionsFile),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  const rootPath = path.join(cwd, agent.instructionsFile);
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }
  return path.join(cwd, `.${agentId}`, agent.instructionsFile);
}

export function instructionsExists(agentId: AgentId, scope: InstructionsScope = 'user', cwd: string = process.cwd()): boolean {
  const instructionsPath = getInstructionsPath(agentId, scope, cwd);
  return fs.existsSync(instructionsPath);
}

export function discoverInstructionsFromRepo(repoPath: string): DiscoveredInstructions[] {
  const instructions: DiscoveredInstructions[] = [];

  const memoryDir = path.join(repoPath, 'memory');
  if (!fs.existsSync(memoryDir)) {
    return instructions;
  }

  for (const agentId of ALL_AGENT_IDS) {
    const agent = AGENTS[agentId];
    // AGENTS.md is the canonical central memory file - don't claim it per-agent.
    // It gets installed centrally to ~/.agents/memory/ and shims symlink it per-agent.
    const possibleNames = [
      `${agentId}.md`,
      agent.instructionsFile,
    ].filter(name => name !== 'AGENTS.md');

    for (const filename of possibleNames) {
      const sourcePath = path.join(memoryDir, filename);
      if (fs.existsSync(sourcePath)) {
        instructions.push({
          agentId,
          sourcePath,
          filename,
        });
        break;
      }
    }
  }

  return instructions;
}

export function resolveInstructionsSource(repoPath: string, agentId: AgentId): string | null {
  const agent = AGENTS[agentId];
  const memoryDir = path.join(repoPath, 'memory');

  if (!fs.existsSync(memoryDir)) {
    return null;
  }

  const possibleNames = [
    `${agentId}.md`,
    agent.instructionsFile,
  ].filter(name => name !== 'AGENTS.md');

  for (const filename of possibleNames) {
    const sourcePath = path.join(memoryDir, filename);
    if (fs.existsSync(sourcePath)) {
      return sourcePath;
    }
  }

  return null;
}

export function discoverMemoryFilesFromRepo(repoPath: string): string[] {
  const memoryDir = path.join(repoPath, 'memory');
  if (!fs.existsSync(memoryDir)) {
    return [];
  }

  try {
    return fs
      .readdirSync(memoryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function installInstructions(
  sourcePath: string,
  agentId: AgentId,
  method: 'symlink' | 'copy' = 'copy'
): { path: string; method: 'symlink' | 'copy'; error?: string } {
  const agent = AGENTS[agentId];
  const configDir = getUserConfigDir(agentId);
  const targetPath = path.join(configDir, agent.instructionsFile);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (fs.existsSync(targetPath)) {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(targetPath);
    } else {
      fs.unlinkSync(targetPath);
    }
  }

  try {
    if (method === 'symlink') {
      fs.symlinkSync(sourcePath, targetPath);
      return { path: targetPath, method: 'symlink' };
    }

    fs.copyFileSync(sourcePath, targetPath);
    return { path: targetPath, method: 'copy' };
  } catch (err) {
    return { path: '', method: 'copy', error: (err as Error).message };
  }
}

export function uninstallInstructions(agentId: AgentId): boolean {
  const agent = AGENTS[agentId];
  const configDir = getUserConfigDir(agentId);
  const targetPath = path.join(configDir, agent.instructionsFile);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
    return true;
  }
  return false;
}

export function instructionsContentMatches(
  agentId: AgentId,
  sourcePath: string,
  scope: InstructionsScope = 'user',
  cwd: string = process.cwd()
): boolean {
  const installedPath = getInstructionsPath(agentId, scope, cwd);

  if (!fs.existsSync(installedPath) || !fs.existsSync(sourcePath)) {
    return false;
  }

  try {
    const installedContent = fs.readFileSync(installedPath, 'utf-8');
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    return normalizeContent(installedContent) === normalizeContent(sourceContent);
  } catch {
    return false;
  }
}

export function listInstalledInstructionsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledInstructions[] {
  const results: InstalledInstructions[] = [];
  const agent = AGENTS[agentId];

  // User-scoped instructions (version-aware when home is provided)
  const home = options?.home || getEffectiveHome(agentId);
  const userConfigDir = path.join(home, `.${agentId}`);
  const userPath = path.join(userConfigDir, agent.instructionsFile);
  results.push({
    agentId,
    scope: 'user',
    path: userPath,
    exists: fs.existsSync(userPath),
  });

  const projectPath = getInstructionsPath(agentId, 'project', cwd);
  results.push({
    agentId,
    scope: 'project',
    path: projectPath,
    exists: fs.existsSync(projectPath),
  });

  return results;
}

export function getInstructionsContent(agentId: AgentId, scope: InstructionsScope = 'user', cwd: string = process.cwd()): string | null {
  const instructionsPath = getInstructionsPath(agentId, scope, cwd);
  if (!fs.existsSync(instructionsPath)) {
    return null;
  }
  try {
    return fs.readFileSync(instructionsPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Install memory files from repo memory/ to central ~/.agents/memory/ directory.
 * Shims will symlink these to per-agent directories for synced agents.
 */
export function installInstructionsCentrally(
  repoPath: string,
  filesToInstall?: string[]
): { installed: string[]; errors: string[] } {
  const installed: string[] = [];
  const errors: string[] = [];

  const centralDir = getMemoryDir();
  if (!fs.existsSync(centralDir)) {
    fs.mkdirSync(centralDir, { recursive: true });
  }

  const memoryDir = path.join(repoPath, 'memory');
  if (!fs.existsSync(memoryDir)) {
    return { installed, errors };
  }

  try {
    const files = filesToInstall ?? fs.readdirSync(memoryDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const sourcePath = path.join(memoryDir, file);
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) continue;

      const targetPath = path.join(centralDir, file);

      try {
        fs.copyFileSync(sourcePath, targetPath);
        installed.push(file);
      } catch (err) {
        errors.push(`${file}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`Failed to read memory directory: ${(err as Error).message}`);
  }

  return { installed, errors };
}

/**
 * List memory files from central ~/.agents/memory/ directory.
 */
export function listCentralMemory(): string[] {
  const centralDir = getMemoryDir();
  if (!fs.existsSync(centralDir)) {
    return [];
  }

  return fs
    .readdirSync(centralDir)
    .filter((f) => f.endsWith('.md'));
}
