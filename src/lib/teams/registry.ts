/**
 * Team registry.
 *
 * Manages the persistent registry of named teams stored in registry.json
 * under the teams data directory. Provides CRUD operations for team metadata
 * (creation timestamp and optional description).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveBaseDir } from './persistence.js';

/** Metadata for a registered team. */
export interface TeamMeta {
  created_at: string;
  description?: string;
}

/** Map of team name to team metadata. */
export type TeamRegistry = Record<string, TeamMeta>;

async function registryPath(): Promise<string> {
  const base = await resolveBaseDir();
  return path.join(base, 'registry.json');
}

/** Load all teams from the registry file. Returns an empty object if the file does not exist. */
export async function loadTeams(): Promise<TeamRegistry> {
  try {
    const raw = await fs.readFile(await registryPath(), 'utf-8');
    return JSON.parse(raw) as TeamRegistry;
  } catch {
    return {};
  }
}

async function saveTeams(reg: TeamRegistry): Promise<void> {
  const p = await registryPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(reg, null, 2));
}

/** Create a new team. Throws if a team with the same name already exists. */
export async function createTeam(name: string, description?: string): Promise<TeamMeta> {
  const reg = await loadTeams();
  if (reg[name]) {
    throw new Error(`Team '${name}' already exists`);
  }
  const meta: TeamMeta = {
    created_at: new Date().toISOString(),
    ...(description ? { description } : {}),
  };
  reg[name] = meta;
  await saveTeams(reg);
  return meta;
}

/** Return existing team metadata or create a new team if it does not exist. */
export async function ensureTeam(name: string): Promise<TeamMeta> {
  const reg = await loadTeams();
  if (reg[name]) return reg[name];
  const meta: TeamMeta = { created_at: new Date().toISOString() };
  reg[name] = meta;
  await saveTeams(reg);
  return meta;
}

/** Remove a team from the registry. Returns false if the team did not exist. */
export async function removeTeam(name: string): Promise<boolean> {
  const reg = await loadTeams();
  if (!reg[name]) return false;
  delete reg[name];
  await saveTeams(reg);
  return true;
}

/** Check whether a team with the given name exists in the registry. */
export async function teamExists(name: string): Promise<boolean> {
  const reg = await loadTeams();
  return Boolean(reg[name]);
}
