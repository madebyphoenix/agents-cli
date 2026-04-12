import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import type { AgentId, SkillMetadata, InstalledSkill } from './types.js';
import { AGENTS, SKILLS_CAPABLE_AGENTS, ensureSkillsDir } from './agents.js';
import { getAgentsDir, getProjectAgentsDir } from './state.js';
import { getEffectiveHome } from './versions.js';

const HOME = os.homedir();

export function getSkillsDir(): string {
  return path.join(getAgentsDir(), 'skills');
}

export function ensureCentralSkillsDir(): void {
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getAgentSkillsDir(agentId: AgentId): string {
  const home = getEffectiveHome(agentId);
  return path.join(home, `.${agentId}`, 'skills');
}

export function getProjectSkillsDir(agentId: AgentId, cwd: string = process.cwd()): string {
  const dirs: string[] = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    dirs.push(path.join(projectAgentsDir, 'skills'));
  }
  dirs.push(path.join(cwd, `.${agentId}`, 'skills'));
  // Return the first existing dir, otherwise default to the first candidate
  for (const dir of dirs) {
    if (fs.existsSync(dir)) return dir;
  }
  return dirs[0];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSkillMetadata(metadata: SkillMetadata | null, skillName: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!metadata) {
    errors.push('SKILL.md not found or has no valid frontmatter');
    return { valid: false, errors, warnings };
  }

  // name is required
  if (!metadata.name || metadata.name.trim() === '') {
    errors.push('Missing required field: name');
  } else {
    if (metadata.name.length > 64) {
      errors.push(`name exceeds 64 characters (${metadata.name.length})`);
    }
    if (!/^[a-z0-9-]+$/.test(metadata.name)) {
      warnings.push('name should be lowercase with hyphens (e.g., my-skill-name)');
    }
  }

  // description is required
  if (!metadata.description || metadata.description.trim() === '') {
    errors.push('Missing required field: description');
  } else if (metadata.description.length > 1024) {
    warnings.push(`description exceeds 1024 characters (${metadata.description.length})`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

export interface SkillParseError {
  name: string;
  path: string;
  error: string;
  scope: 'user' | 'project';
}

export interface SkillParseResult {
  metadata: SkillMetadata | null;
  error?: string;
}

/**
 * Parse skill metadata from SKILL.md, returning both result and any error.
 */
export function tryParseSkillMetadata(skillDir: string): SkillParseResult {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    return { metadata: null, error: 'SKILL.md not found' };
  }

  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const lines = content.split('\n');

    // Check for YAML frontmatter (required)
    if (lines[0] === '---') {
      const endIndex = lines.slice(1).findIndex((l) => l === '---');
      if (endIndex > 0) {
        const frontmatter = lines.slice(1, endIndex + 1).join('\n');
        const parsed = yaml.parse(frontmatter);
        return {
          metadata: {
            name: parsed.name || '',
            description: parsed.description || '',
            author: parsed.author,
            version: parsed.version,
            license: parsed.license,
            keywords: parsed.keywords,
          },
        };
      }
    }

    // No valid frontmatter
    return { metadata: null, error: 'No valid YAML frontmatter found' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown parse error';
    return { metadata: null, error: `Invalid YAML: ${msg}` };
  }
}

/**
 * Parse skill metadata from SKILL.md (backward-compatible, returns null on error).
 */
export function parseSkillMetadata(skillDir: string): SkillMetadata | null {
  return tryParseSkillMetadata(skillDir).metadata;
}

export function countSkillRules(skillDir: string): number {
  const rulesDir = path.join(skillDir, 'rules');
  if (!fs.existsSync(rulesDir)) {
    return 0;
  }

  try {
    const files = fs.readdirSync(rulesDir);
    return files.filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

export interface DiscoveredSkill {
  name: string;
  path: string;
  metadata: SkillMetadata;
  ruleCount: number;
  validation: ValidationResult;
  parseError?: string;
}

export function discoverSkillsFromRepo(repoPath: string): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];

  // Look for skills in common locations
  const searchPaths = [
    path.join(repoPath, 'skills'),
    path.join(repoPath, 'agent-skills'),
    repoPath, // Root level skill directories
  ];

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) continue;

    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Skip hidden directories (e.g., .system)
        if (entry.name.startsWith('.')) continue;

        const skillDir = path.join(searchPath, entry.name);
        const skillMdPath = path.join(skillDir, 'SKILL.md');

        if (fs.existsSync(skillMdPath)) {
          const parseResult = tryParseSkillMetadata(skillDir);
          const validation = validateSkillMetadata(parseResult.metadata, entry.name);
          // Include even if invalid (for discovery/listing with warnings)
          skills.push({
            name: entry.name,
            path: skillDir,
            metadata: parseResult.metadata || { name: entry.name, description: '' },
            ruleCount: countSkillRules(skillDir),
            validation,
            parseError: parseResult.error,
          });
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  return skills;
}

export function installSkill(
  sourcePath: string,
  skillName: string,
  agents: AgentId[],
  method: 'symlink' | 'copy' = 'symlink'
): { success: boolean; error?: string; warnings?: string[] } {
  // Validate skill metadata before installation
  const metadata = parseSkillMetadata(sourcePath);
  const validation = validateSkillMetadata(metadata, skillName);

  if (!validation.valid) {
    return {
      success: false,
      error: `Invalid skill: ${validation.errors.join(', ')}`,
      warnings: validation.warnings,
    };
  }

  ensureCentralSkillsDir();

  const centralPath = path.join(getSkillsDir(), skillName);

  // Copy to central location if not already there
  if (!fs.existsSync(centralPath)) {
    try {
      fs.cpSync(sourcePath, centralPath, { recursive: true });
    } catch (err) {
      return { success: false, error: `Failed to copy skill: ${(err as Error).message}` };
    }
  }

  // Symlink to each agent
  for (const agentId of agents) {
    if (!SKILLS_CAPABLE_AGENTS.includes(agentId)) {
      continue;
    }

    ensureSkillsDir(agentId);
    const agentSkillPath = path.join(getAgentSkillsDir(agentId), skillName);

    // Remove existing if present
    if (fs.existsSync(agentSkillPath)) {
      try {
        fs.rmSync(agentSkillPath, { recursive: true, force: true });
      } catch {
        // Ignore removal errors
      }
    }

    try {
      if (method === 'symlink') {
        fs.symlinkSync(centralPath, agentSkillPath, 'dir');
      } else {
        fs.cpSync(centralPath, agentSkillPath, { recursive: true });
      }
    } catch (err) {
      return {
        success: false,
        error: `Failed to ${method} skill to ${agentId}: ${(err as Error).message}`,
      };
    }
  }

  return { success: true };
}

/**
 * Check if a skill exists for an agent.
 */
export function skillExists(agentId: AgentId, skillName: string): boolean {
  const agentSkillPath = path.join(getAgentSkillsDir(agentId), skillName);
  return fs.existsSync(agentSkillPath);
}

/**
 * Normalize content for comparison (trim, normalize line endings).
 */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/**
 * Compare two directories recursively for content equality.
 */
function directoriesMatch(dir1: string, dir2: string): boolean {
  if (!fs.existsSync(dir1) || !fs.existsSync(dir2)) {
    return fs.existsSync(dir1) === fs.existsSync(dir2);
  }

  try {
    const files1 = fs.readdirSync(dir1).filter(f => f.endsWith('.md')).sort();
    const files2 = fs.readdirSync(dir2).filter(f => f.endsWith('.md')).sort();

    if (files1.length !== files2.length) return false;
    if (files1.join(',') !== files2.join(',')) return false;

    for (const file of files1) {
      const content1 = fs.readFileSync(path.join(dir1, file), 'utf-8');
      const content2 = fs.readFileSync(path.join(dir2, file), 'utf-8');
      if (normalizeContent(content1) !== normalizeContent(content2)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Check if installed skill content matches source content.
 * Compares SKILL.md and all rules/*.md files.
 */
export function skillContentMatches(
  agentId: AgentId,
  skillName: string,
  sourcePath: string
): boolean {
  const installedPath = path.join(getAgentSkillsDir(agentId), skillName);

  if (!fs.existsSync(installedPath) || !fs.existsSync(sourcePath)) {
    return false;
  }

  try {
    const installedSkillMd = path.join(installedPath, 'SKILL.md');
    const sourceSkillMd = path.join(sourcePath, 'SKILL.md');

    if (!fs.existsSync(installedSkillMd) || !fs.existsSync(sourceSkillMd)) {
      return false;
    }

    const installedContent = fs.readFileSync(installedSkillMd, 'utf-8');
    const sourceContent = fs.readFileSync(sourceSkillMd, 'utf-8');

    if (normalizeContent(installedContent) !== normalizeContent(sourceContent)) {
      return false;
    }

    const installedRulesDir = path.join(installedPath, 'rules');
    const sourceRulesDir = path.join(sourcePath, 'rules');

    return directoriesMatch(installedRulesDir, sourceRulesDir);
  } catch {
    return false;
  }
}

export function uninstallSkill(skillName: string): { success: boolean; error?: string } {
  // Remove from central location
  const centralPath = path.join(getSkillsDir(), skillName);
  if (!fs.existsSync(centralPath)) {
    return { success: false, error: `Skill '${skillName}' not found` };
  }

  // Remove from all agents
  for (const agentId of SKILLS_CAPABLE_AGENTS) {
    const agentSkillPath = path.join(getAgentSkillsDir(agentId), skillName);
    if (fs.existsSync(agentSkillPath)) {
      try {
        fs.rmSync(agentSkillPath, { recursive: true, force: true });
      } catch {
        // Ignore removal errors
      }
    }
  }

  try {
    fs.rmSync(centralPath, { recursive: true, force: true });
  } catch {
    // Ignore removal errors
  }

  return { success: true };
}

export function listInstalledSkills(): Map<string, DiscoveredSkill> {
  const skills = new Map<string, DiscoveredSkill>();
  const centralDir = getSkillsDir();

  if (!fs.existsSync(centralDir)) {
    return skills;
  }

  try {
    const entries = fs.readdirSync(centralDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip hidden directories (e.g., .system)
      if (entry.name.startsWith('.')) continue;

      const skillDir = path.join(centralDir, entry.name);
      const metadata = parseSkillMetadata(skillDir);

      const validation = validateSkillMetadata(metadata, entry.name);
      if (metadata) {
        skills.set(entry.name, {
          name: entry.name,
          path: skillDir,
          metadata,
          ruleCount: countSkillRules(skillDir),
          validation,
        });
      }
    }
  } catch {
    // Ignore errors
  }

  return skills;
}

export function listInstalledSkillsWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string; errors?: SkillParseError[] }
): InstalledSkill[] {
  const results: InstalledSkill[] = [];
  const seen = new Set<string>();

  // Project-scoped skills
  const projectCandidates: string[] = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    projectCandidates.push(path.join(projectAgentsDir, 'skills'));
  }
  projectCandidates.push(path.join(cwd, `.${agentId}`, 'skills'));

  for (const projectSkillsDir of projectCandidates) {
    if (!fs.existsSync(projectSkillsDir)) continue;
    try {
      const entries = fs.readdirSync(projectSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const skillDir = path.join(projectSkillsDir, entry.name);

        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            const stat = fs.statSync(skillDir);
            isDir = stat.isDirectory();
          } catch {
            continue;
          }
        }
        if (!isDir) continue;

        const result = tryParseSkillMetadata(skillDir);

        if (result.metadata && !seen.has(entry.name)) {
          results.push({
            name: entry.name,
            path: skillDir,
            metadata: result.metadata,
            ruleCount: countSkillRules(skillDir),
            scope: 'project',
            agent: agentId,
          });
          seen.add(entry.name);
        } else if (result.error && options?.errors && !seen.has(entry.name)) {
          options.errors.push({
            name: entry.name,
            path: skillDir,
            error: result.error,
            scope: 'project',
          });
          seen.add(entry.name);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // User-scoped skills (version-aware when home is provided)
  const userSkillsDir = options?.home
    ? path.join(options.home, `.${agentId}`, 'skills')
    : getAgentSkillsDir(agentId);
  if (fs.existsSync(userSkillsDir)) {
    try {
      const entries = fs.readdirSync(userSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;

        const skillDir = path.join(userSkillsDir, entry.name);

        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            const stat = fs.statSync(skillDir);
            isDir = stat.isDirectory();
          } catch {
            continue;
          }
        }
        if (!isDir) continue;

        const result = tryParseSkillMetadata(skillDir);

        if (result.metadata && !seen.has(entry.name)) {
          results.push({
            name: entry.name,
            path: skillDir,
            metadata: result.metadata,
            ruleCount: countSkillRules(skillDir),
            scope: 'user',
            agent: agentId,
          });
          seen.add(entry.name);
        } else if (result.error && options?.errors && !seen.has(entry.name)) {
          options.errors.push({
            name: entry.name,
            path: skillDir,
            error: result.error,
            scope: 'user',
          });
          seen.add(entry.name);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return results;
}

export function getSkillInfo(skillName: string): DiscoveredSkill | null {
  const centralPath = path.join(getSkillsDir(), skillName);
  if (!fs.existsSync(centralPath)) {
    return null;
  }

  const metadata = parseSkillMetadata(centralPath);
  const validation = validateSkillMetadata(metadata, skillName);
  if (!metadata) {
    return null;
  }

  return {
    name: skillName,
    path: centralPath,
    metadata,
    ruleCount: countSkillRules(centralPath),
    validation,
  };
}

export function getSkillRules(skillName: string): string[] {
  const centralPath = path.join(getSkillsDir(), skillName);
  const rulesDir = path.join(centralPath, 'rules');

  if (!fs.existsSync(rulesDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(rulesDir);
    return files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

/**
 * Install a skill to central ~/.agents/skills/ directory only.
 * Does not create per-agent symlinks (shims handle that for synced agents).
 */
export function installSkillCentrally(
  sourcePath: string,
  skillName: string
): { success: boolean; error?: string; warnings?: string[] } {
  // Validate skill metadata (warnings only, don't block installation)
  const metadata = parseSkillMetadata(sourcePath);
  const validation = validateSkillMetadata(metadata, skillName);
  const allWarnings = [...validation.warnings];

  // Convert validation errors to warnings instead of blocking
  if (!validation.valid) {
    allWarnings.push(...validation.errors.map(e => `Validation: ${e}`));
  }

  ensureCentralSkillsDir();
  const centralPath = path.join(getSkillsDir(), skillName);

  // Resolve to absolute paths for comparison
  const resolvedSource = path.resolve(sourcePath);
  const resolvedCentral = path.resolve(centralPath);

  // If source is already the central path, nothing to copy
  if (resolvedSource === resolvedCentral) {
    return { success: true, warnings: allWarnings.length > 0 ? allWarnings : undefined };
  }

  // Remove existing if present
  if (fs.existsSync(centralPath)) {
    try {
      fs.rmSync(centralPath, { recursive: true, force: true });
    } catch {
      // Ignore removal errors
    }
  }

  try {
    fs.cpSync(sourcePath, centralPath, { recursive: true });
    return { success: true, warnings: allWarnings.length > 0 ? allWarnings : undefined };
  } catch (err) {
    return { success: false, error: `Failed to copy skill: ${(err as Error).message}` };
  }
}
