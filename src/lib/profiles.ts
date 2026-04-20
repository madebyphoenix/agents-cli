import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId } from './types.js';
import { getAgentsDir } from './state.js';
import { getKeychainToken, keychainItemName } from './profiles-keychain.js';
import { getPreset, type Preset } from './profiles-presets.js';

export interface Profile {
  name: string;
  host: {
    agent: AgentId;
    version?: string;
  };
  env: Record<string, string>;
  auth?: {
    envVar: string;
    keychainItem: string;
  };
  description?: string;
  preset?: string;
  provider?: string;
}

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,48}$/i;

export function getProfilesDir(): string {
  return path.join(getAgentsDir(), 'profiles');
}

function profilePath(name: string): string {
  return path.join(getProfilesDir(), `${name}.yml`);
}

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid profile name '${name}'. Use letters, digits, dash, underscore (max 48 chars).`);
  }
}

export function profileExists(name: string): boolean {
  return fs.existsSync(profilePath(name));
}

export function readProfile(name: string): Profile {
  validateProfileName(name);
  const file = profilePath(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Profile '${name}' not found.`);
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = yaml.parse(raw) as Profile;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Profile '${name}' is malformed.`);
  }
  if (!parsed.name) parsed.name = name;
  if (!parsed.host?.agent) {
    throw new Error(`Profile '${name}' is missing host.agent.`);
  }
  if (!parsed.env || typeof parsed.env !== 'object') {
    parsed.env = {};
  }
  return parsed;
}

export function writeProfile(profile: Profile): void {
  validateProfileName(profile.name);
  const dir = getProfilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const body = yaml.stringify(profile);
  const file = profilePath(profile.name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);
}

export function deleteProfile(name: string): boolean {
  validateProfileName(name);
  const file = profilePath(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

export function listProfiles(): Profile[] {
  const dir = getProfilesDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const profiles: Profile[] = [];
  for (const entry of entries) {
    const name = entry.replace(/\.(yml|yaml)$/, '');
    try {
      profiles.push(readProfile(name));
    } catch {
      // Skip malformed profile files; surfacing via `agents profiles view <name>`.
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

// Build a profile from a preset. The keychain item is shared across all
// profiles that point at the same provider, so adding kimi + deepseek prompts
// for the OpenRouter key exactly once.
export function profileFromPreset(profileName: string, preset: Preset, version?: string): Profile {
  return {
    name: profileName,
    host: { agent: preset.host, version },
    env: { ...preset.env },
    auth: {
      envVar: preset.authEnvVar,
      keychainItem: keychainItemName(preset.provider),
    },
    description: preset.description,
    preset: preset.name,
    provider: preset.provider,
  };
}

// Resolve a profile into the env block that should be injected into the
// spawned agent process. Reads the token from keychain at exec time so the
// profile YAML never holds secrets.
export function resolveProfileEnv(profile: Profile): Record<string, string> {
  const env: Record<string, string> = { ...profile.env };
  if (profile.auth) {
    const token = getKeychainToken(profile.auth.keychainItem);
    env[profile.auth.envVar] = token;
  }
  return env;
}

export interface ResolvedProfileRun {
  agent: AgentId;
  version?: string;
  env: Record<string, string>;
  profileName: string;
}

// Resolve a name into (agent, version, env). Throws if the name is not a
// profile. Callers are expected to try agent-id resolution first and fall
// back to this when that fails, so we don't need a "isProfile" probe.
export function resolveProfileForRun(name: string): ResolvedProfileRun {
  const profile = readProfile(name);
  return {
    agent: profile.host.agent,
    version: profile.host.version,
    env: resolveProfileEnv(profile),
    profileName: profile.name,
  };
}

// Look up the preset a profile was created from, if any. Used by
// `profiles view` to show upstream metadata like signup URLs.
export function getPresetForProfile(profile: Profile): Preset | undefined {
  return profile.preset ? getPreset(profile.preset) : undefined;
}
