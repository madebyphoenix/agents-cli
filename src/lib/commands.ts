import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { AGENTS, ensureCommandsDir } from './agents.js';
import { markdownToToml } from './convert.js';
import { getCommandsDir } from './state.js';
import { getEffectiveHome } from './versions.js';
import type { AgentId, CommandInstallation } from './types.js';

export type CommandScope = 'user' | 'project';

export interface CommandMetadata {
  name: string;
  description: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface DiscoveredCommand {
  name: string;
  description: string;
  sourcePath: string;
  isShared: boolean;
  validation: ValidationResult;
}

export interface InstalledCommand {
  name: string;
  scope: CommandScope;
  path: string;
  description?: string;
}

export function parseCommandMetadata(filePath: string): CommandMetadata | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check for YAML frontmatter
    if (lines[0] === '---') {
      const endIndex = lines.slice(1).findIndex((l) => l === '---');
      if (endIndex > 0) {
        const frontmatter = lines.slice(1, endIndex + 1).join('\n');
        const parsed = yaml.parse(frontmatter);
        return {
          name: parsed.name || '',
          description: parsed.description || '',
        };
      }
    }

    // Check for TOML format
    const tomlNameMatch = content.match(/name\s*=\s*"([^"]+)"/);
    const tomlDescMatch = content.match(/description\s*=\s*"([^"]+)"/);
    if (tomlNameMatch || tomlDescMatch) {
      return {
        name: tomlNameMatch?.[1] || '',
        description: tomlDescMatch?.[1] || '',
      };
    }

    // No valid frontmatter found
    return null;
  } catch {
    return null;
  }
}

export function validateCommandMetadata(
  metadata: CommandMetadata | null,
  commandName: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!metadata) {
    errors.push('Missing YAML frontmatter with name and description');
    return { valid: false, errors, warnings };
  }

  // name is optional - if not provided, will use filename (commandName)
  // Only validate length if name is explicitly provided
  if (metadata.name && metadata.name.length > 64) {
    warnings.push(`name exceeds 64 characters (${metadata.name.length})`);
  }

  // description is required
  if (!metadata.description || metadata.description.trim() === '') {
    errors.push('Missing required field: description');
  } else if (metadata.description.length > 1024) {
    warnings.push(`description exceeds 1024 characters (${metadata.description.length})`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function discoverCommands(repoPath: string): DiscoveredCommand[] {
  const commands: DiscoveredCommand[] = [];

  const commandsDir = path.join(repoPath, 'commands');
  if (fs.existsSync(commandsDir)) {
    for (const file of fs.readdirSync(commandsDir)) {
      if (file.endsWith('.md')) {
        const name = file.replace('.md', '');
        const sourcePath = path.join(commandsDir, file);
        const metadata = parseCommandMetadata(sourcePath);
        const validation = validateCommandMetadata(metadata, name);
        commands.push({
          name,
          description: metadata?.description || extractDescription(fs.readFileSync(sourcePath, 'utf-8')),
          sourcePath,
          isShared: true,
          validation,
        });
      }
    }
  }

  return commands;
}

function extractDescription(content: string): string {
  const match = content.match(/description:\s*(.+)/i);
  if (match) return match[1].trim();

  const tomlMatch = content.match(/description\s*=\s*"([^"]+)"/);
  if (tomlMatch) return tomlMatch[1];

  const firstLine = content.split('\n').find((l) => l.trim() && !l.startsWith('---'));
  return firstLine?.slice(0, 80) || '';
}

export function resolveCommandSource(
  repoPath: string,
  commandName: string
): string | null {
  const commandPath = path.join(repoPath, 'commands', `${commandName}.md`);
  if (fs.existsSync(commandPath)) {
    return commandPath;
  }

  return null;
}

export function installCommand(
  sourcePath: string,
  agentId: AgentId,
  commandName: string,
  method: 'symlink' | 'copy' = 'symlink'
): CommandInstallation & { error?: string; warnings?: string[] } {
  // Validate command metadata before installation
  const metadata = parseCommandMetadata(sourcePath);
  const validation = validateCommandMetadata(metadata, commandName);

  if (!validation.valid) {
    return {
      path: '',
      method: 'copy',
      error: `Invalid command: ${validation.errors.join(', ')}`,
      warnings: validation.warnings,
    };
  }

  const agent = AGENTS[agentId];
  ensureCommandsDir(agentId);

  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, `.${agentId}`, agent.commandsSubdir);
  fs.mkdirSync(commandsDir, { recursive: true });

  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const targetPath = path.join(commandsDir, `${commandName}${ext}`);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
  const sourceIsMarkdown = sourcePath.endsWith('.md');
  const needsConversion = agent.format === 'toml' && sourceIsMarkdown;

  if (needsConversion) {
    const tomlContent = markdownToToml(commandName, sourceContent);
    fs.writeFileSync(targetPath, tomlContent, 'utf-8');
    return { path: targetPath, method: 'copy', warnings: validation.warnings };
  }

  if (method === 'symlink') {
    fs.symlinkSync(sourcePath, targetPath);
    return { path: targetPath, method: 'symlink', warnings: validation.warnings };
  }

  fs.copyFileSync(sourcePath, targetPath);
  return { path: targetPath, method: 'copy', warnings: validation.warnings };
}

export function uninstallCommand(agentId: AgentId, commandName: string): boolean {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, `.${agentId}`, agent.commandsSubdir);
  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const targetPath = path.join(commandsDir, `${commandName}${ext}`);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
    return true;
  }
  return false;
}

export function listInstalledCommands(agentId: AgentId): string[] {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, `.${agentId}`, agent.commandsSubdir);
  if (!fs.existsSync(commandsDir)) {
    return [];
  }

  const ext = agent.format === 'toml' ? '.toml' : '.md';
  return fs
    .readdirSync(commandsDir)
    .filter((f) => f.endsWith(ext))
    .map((f) => f.replace(ext, ''));
}

/**
 * Check if a command exists for an agent.
 */
export function commandExists(agentId: AgentId, commandName: string): boolean {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, `.${agentId}`, agent.commandsSubdir);
  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const targetPath = path.join(commandsDir, `${commandName}${ext}`);
  return fs.existsSync(targetPath);
}

/**
 * Normalize content for comparison (trim, normalize line endings).
 */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/**
 * Check if installed command content matches source content.
 * Handles format conversion (markdown to TOML for Gemini).
 */
export function commandContentMatches(
  agentId: AgentId,
  commandName: string,
  sourcePath: string
): boolean {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, `.${agentId}`, agent.commandsSubdir);
  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const installedPath = path.join(commandsDir, `${commandName}${ext}`);

  if (!fs.existsSync(installedPath) || !fs.existsSync(sourcePath)) {
    return false;
  }

  try {
    const installedContent = fs.readFileSync(installedPath, 'utf-8');
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');

    const sourceIsMarkdown = sourcePath.endsWith('.md');
    const needsConversion = agent.format === 'toml' && sourceIsMarkdown;

    if (needsConversion) {
      const convertedSource = markdownToToml(commandName, sourceContent);
      return normalizeContent(installedContent) === normalizeContent(convertedSource);
    }

    return normalizeContent(installedContent) === normalizeContent(sourceContent);
  } catch {
    return false;
  }
}

/**
 * Get the project-scoped commands directory for an agent.
 * Claude: .claude/commands/
 * Codex: .codex/prompts/
 * Gemini: .gemini/commands/
 */
function getProjectCommandsDir(agentId: AgentId, cwd: string = process.cwd()): string {
  const agent = AGENTS[agentId];
  return path.join(cwd, `.${agentId}`, agent.commandsSubdir);
}

/**
 * List commands from a specific directory.
 */
function listCommandsFromDir(dir: string, format: 'markdown' | 'toml'): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const ext = format === 'toml' ? '.toml' : '.md';
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => f.replace(ext, ''));
}

/**
 * List installed commands with scope information.
 */
export function listInstalledCommandsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd()
): InstalledCommand[] {
  const agent = AGENTS[agentId];
  const ext = agent.format === 'toml' ? '.toml' : '.md';
  const results: InstalledCommand[] = [];

  // User-scoped commands (version-aware)
  const home = getEffectiveHome(agentId);
  const userCommandsDir = path.join(home, `.${agentId}`, agent.commandsSubdir);
  const userCommands = listCommandsFromDir(userCommandsDir, agent.format);
  for (const name of userCommands) {
    const commandPath = path.join(userCommandsDir, `${name}${ext}`);
    results.push({
      name,
      scope: 'user',
      path: commandPath,
      description: getCommandDescription(commandPath),
    });
  }

  // Project-scoped commands
  const projectDir = getProjectCommandsDir(agentId, cwd);
  const projectCommands = listCommandsFromDir(projectDir, agent.format);
  for (const name of projectCommands) {
    const commandPath = path.join(projectDir, `${name}${ext}`);
    results.push({
      name,
      scope: 'project',
      path: commandPath,
      description: getCommandDescription(commandPath),
    });
  }

  return results;
}

/**
 * Get command description from file.
 */
function getCommandDescription(filePath: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return extractDescription(content) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copy a project-scoped command to user scope.
 */
export function promoteCommandToUser(
  agentId: AgentId,
  commandName: string,
  cwd: string = process.cwd()
): { success: boolean; error?: string } {
  const agent = AGENTS[agentId];
  const ext = agent.format === 'toml' ? '.toml' : '.md';

  const projectDir = getProjectCommandsDir(agentId, cwd);
  const sourcePath = path.join(projectDir, `${commandName}${ext}`);

  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `Project command '${commandName}' not found` };
  }

  const home = getEffectiveHome(agentId);
  const commandsDir = path.join(home, `.${agentId}`, agent.commandsSubdir);
  fs.mkdirSync(commandsDir, { recursive: true });
  const targetPath = path.join(commandsDir, `${commandName}${ext}`);

  try {
    fs.copyFileSync(sourcePath, targetPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Install a command to central ~/.agents/commands/ directory.
 * Shims will symlink this to per-agent directories for synced agents.
 */
export function installCommandCentrally(
  sourcePath: string,
  commandName: string
): { success: boolean; path: string; error?: string; warnings?: string[] } {
  // Validate command metadata before installation
  const metadata = parseCommandMetadata(sourcePath);
  const validation = validateCommandMetadata(metadata, commandName);

  if (!validation.valid) {
    return {
      success: false,
      path: '',
      error: `Invalid command: ${validation.errors.join(', ')}`,
      warnings: validation.warnings,
    };
  }

  const centralDir = getCommandsDir();
  if (!fs.existsSync(centralDir)) {
    fs.mkdirSync(centralDir, { recursive: true });
  }

  // Always use markdown for central storage
  const targetPath = path.join(centralDir, `${commandName}.md`);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  try {
    fs.copyFileSync(sourcePath, targetPath);
    return { success: true, path: targetPath, warnings: validation.warnings };
  } catch (err) {
    return { success: false, path: '', error: (err as Error).message };
  }
}

/**
 * List commands from central ~/.agents/commands/ directory.
 */
export function listCentralCommands(): string[] {
  const centralDir = getCommandsDir();
  if (!fs.existsSync(centralDir)) {
    return [];
  }

  return fs
    .readdirSync(centralDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace('.md', ''));
}
