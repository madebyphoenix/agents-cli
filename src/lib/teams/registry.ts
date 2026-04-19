import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveBaseDir } from './persistence.js';

export interface TeamMeta {
  created_at: string;
  description?: string;
}

export type TeamRegistry = Record<string, TeamMeta>;

async function registryPath(): Promise<string> {
  const base = await resolveBaseDir();
  return path.join(base, 'registry.json');
}

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

export async function ensureTeam(name: string): Promise<TeamMeta> {
  const reg = await loadTeams();
  if (reg[name]) return reg[name];
  const meta: TeamMeta = { created_at: new Date().toISOString() };
  reg[name] = meta;
  await saveTeams(reg);
  return meta;
}

export async function removeTeam(name: string): Promise<boolean> {
  const reg = await loadTeams();
  if (!reg[name]) return false;
  delete reg[name];
  await saveTeams(reg);
  return true;
}

export async function teamExists(name: string): Promise<boolean> {
  const reg = await loadTeams();
  return Boolean(reg[name]);
}
