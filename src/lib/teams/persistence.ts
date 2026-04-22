/**
 * Teams configuration persistence.
 *
 * Manages reading, writing, and migrating the teams config file
 * (~/.agents/teams/config.json) that stores per-agent-type settings
 * (command templates, enabled state, pinned models) and provider configs.
 * Also resolves the base data directory for teammate process storage.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir, tmpdir } from 'os';
import { constants as fsConstants } from 'fs';
import { AgentType } from './parsers.js';

// All supported teammate agent types
const ALL_AGENTS: AgentType[] = ['claude', 'codex', 'gemini', 'cursor', 'opencode'];

// Teams data lives under ~/.agents/teams/
const TEAMS_DIR = path.join(homedir(), '.agents', 'teams');

// Legacy paths (for migration)
const LEGACY_CONFIG_DIR = path.join(homedir(), '.agents');
const LEGACY_BASE_DIR = path.join(homedir(), '.swarmify');
const TMP_FALLBACK_DIR = path.join(tmpdir(), 'agents');

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureWritableDir(p: string): Promise<boolean> {
  try {
    await fs.mkdir(p, { recursive: true });
    await fs.access(p, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the base data directory for teams, preferring ~/.agents/teams/ with a temp fallback. */
export async function resolveBaseDir(): Promise<string> {
  if (await ensureWritableDir(TEAMS_DIR)) {
    return TEAMS_DIR;
  }

  if (await ensureWritableDir(TMP_FALLBACK_DIR)) {
    console.warn(`[agents teams] Falling back to temp data dir at ${TMP_FALLBACK_DIR}`);
    return TMP_FALLBACK_DIR;
  }

  throw new Error('Unable to determine a writable data directory for teams');
}

async function resolveAgentsPath(): Promise<string> {
  const base = await resolveBaseDir();
  return path.join(base, 'agents');
}

async function resolveConfigPath(): Promise<string> {
  await fs.mkdir(TEAMS_DIR, { recursive: true });
  return path.join(TEAMS_DIR, 'config.json');
}

async function resolveLegacyConfigPath(): Promise<string> {
  return path.join(LEGACY_CONFIG_DIR, 'config.json');
}

async function resolveLegacySwarmifyConfigPath(): Promise<string> {
  return path.join(LEGACY_BASE_DIR, 'agents', 'config.json');
}

/** Reasoning-intensity levels supported by the teams system. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/**
 * Legacy type retained for config-file back-compat. Older configs pinned a
 * model per effort tier; we no longer act on these entries but accept them
 * without error when loading from disk.
 */
export type ModelOverrides = Partial<Record<AgentType, Partial<Record<EffortLevel, string>>>>;

/** API endpoint configuration for a model provider. */
export interface ProviderConfig {
  apiEndpoint: string | null;
}

/** Per-agent-type configuration: CLI command template, enabled state, optional pinned model, and provider. */
export interface AgentConfig {
  command: string;
  enabled: boolean;
  // Pinned model for this agent. When null, the teammate launch omits --model
  // and lets the agent's CLI use its own default. Effort is a separate knob
  // that controls reasoning intensity via buildReasoningFlags, not model.
  model: string | null;
  provider: string;
}

/** Top-level teams configuration structure persisted to config.json. */
export interface SwarmConfig {
  agents: Record<AgentType, AgentConfig>;
  providers: Record<string, ProviderConfig>;
}

/** Result of reading the teams config, including resolved agent and provider configurations. */
export interface ReadConfigResult {
  hasConfig: boolean;
  enabledAgents: AgentType[];
  agentConfigs: Record<AgentType, AgentConfig>;
  providerConfigs: Record<string, ProviderConfig>;
}

let AGENTS_DIR: string | null = null;
let CONFIG_PATH: string | null = null;

/** Resolve and ensure the agents subdirectory exists under the teams base dir. */
export async function resolveAgentsDir(): Promise<string> {
  if (!AGENTS_DIR) {
    AGENTS_DIR = await resolveAgentsPath();
  }
  await fs.mkdir(AGENTS_DIR, { recursive: true });
  return AGENTS_DIR;
}

async function ensureConfigPath(): Promise<string> {
  if (!CONFIG_PATH) {
    CONFIG_PATH = await resolveConfigPath();
  }
  const dir = path.dirname(CONFIG_PATH);
  await fs.mkdir(dir, { recursive: true });
  return CONFIG_PATH;
}

// Get default agent configuration. `model` is null by default — the teammate
// launcher omits --model and the agent's CLI picks its own default, which is
// what "drop hardcoded model mapping" means in practice.
function getDefaultAgentConfig(agentType: AgentType): AgentConfig {
  const defaults: Record<AgentType, AgentConfig> = {
    claude: {
      command: 'claude -p \'{prompt}\' --output-format stream-json --json',
      enabled: true,
      model: null,
      provider: 'anthropic'
    },
    codex: {
      command: 'codex exec --sandbox workspace-write \'{prompt}\' --json',
      enabled: true,
      model: null,
      provider: 'openai'
    },
    gemini: {
      command: 'gemini \'{prompt}\' --output-format stream-json',
      enabled: true,
      model: null,
      provider: 'google'
    },
    cursor: {
      command: 'cursor-agent -p --output-format stream-json \'{prompt}\'',
      enabled: true,
      model: null,
      provider: 'custom'
    },
    opencode: {
      command: 'opencode run --format json \'{prompt}\'',
      enabled: true,
      model: null,
      provider: 'custom'
    }
  };

  return defaults[agentType];
}

// Get default provider configuration
function getDefaultProviderConfig(): Record<string, ProviderConfig> {
  return {
    anthropic: {
      apiEndpoint: 'https://api.anthropic.com'
    },
    openai: {
      apiEndpoint: 'https://api.openai.com/v1'
    },
    google: {
      apiEndpoint: 'https://generativelanguage.googleapis.com/v1'
    },
    custom: {
      apiEndpoint: null
    }
  };
}

// Get default full configuration
function getDefaultSwarmConfig(): SwarmConfig {
  const agents: Record<string, AgentConfig> = {};
  for (const agentType of ALL_AGENTS) {
    agents[agentType] = getDefaultAgentConfig(agentType);
  }

  return {
    agents,
    providers: getDefaultProviderConfig()
  };
}

// Try to read a config file as either SwarmConfig or legacy format
async function tryReadLegacyConfig(configPath: string): Promise<SwarmConfig | null> {
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(data);

    // New format: has agents object with nested configs. We detect it by any
    // recognizable per-agent field (model, models, command, enabled) — the old
    // 'models' field is still accepted so pre-existing configs load cleanly.
    if (parsed.agents && typeof parsed.agents === 'object') {
      const firstValue = Object.values(parsed.agents)[0];
      if (firstValue && typeof firstValue === 'object') {
        const obj = firstValue as Record<string, unknown>;
        if ('model' in obj || 'models' in obj || 'command' in obj || 'enabled' in obj) {
          return parsed as SwarmConfig;
        }
      }
    }

    // Old format: { enabledAgents: string[] }
    if (parsed.enabledAgents && Array.isArray(parsed.enabledAgents)) {
      const defaultConfig = getDefaultSwarmConfig();
      for (const agentType of parsed.enabledAgents) {
        if (ALL_AGENTS.includes(agentType as AgentType)) {
          defaultConfig.agents[agentType as AgentType].enabled = true;
        }
      }
      return defaultConfig;
    }

    return null;
  } catch {
    return null;
  }
}

// Migrate from legacy config locations
async function migrateLegacyConfig(): Promise<SwarmConfig | null> {
  // Try ~/.agents/config.json first (most recent legacy location)
  const legacyConfigPath = await resolveLegacyConfigPath();
  let config = await tryReadLegacyConfig(legacyConfigPath);

  // Try ~/.swarmify/agents/config.json
  if (!config) {
    const swarmifyConfigPath = await resolveLegacySwarmifyConfigPath();
    config = await tryReadLegacyConfig(swarmifyConfigPath);
  }

  if (!config) return null;

  // Write migrated config to new location
  const newConfigPath = await ensureConfigPath();
  await fs.writeFile(newConfigPath, JSON.stringify(config, null, 2));
  console.warn(`[agents-mcp] Migrated config to ${newConfigPath}`);

  return config;
}

/** Read teams config from disk, migrating legacy formats if needed. Returns defaults when no config exists. */
export async function readConfig(): Promise<ReadConfigResult> {
  const configPath = await ensureConfigPath();

  // Try to read new config first
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(data) as SwarmConfig;

    const enabledAgents: AgentType[] = [];
    const agentConfigs: Record<AgentType, AgentConfig> = {} as Record<AgentType, AgentConfig>;
    const providerConfigs: Record<string, ProviderConfig> = {};

    // Parse agent configs
    if (config.agents && typeof config.agents === 'object') {
      for (const [agentKey, agentValue] of Object.entries(config.agents)) {
        if (!ALL_AGENTS.includes(agentKey as AgentType)) continue;
        const agentType = agentKey as AgentType;

        // Merge with defaults for missing fields
        const defaultAgentConfig = getDefaultAgentConfig(agentType);
        const mergedAgentConfig = {
          ...defaultAgentConfig,
          ...(agentValue as Partial<AgentConfig>)
        };

        if (mergedAgentConfig.enabled) {
          enabledAgents.push(agentType);
        }
        agentConfigs[agentType] = mergedAgentConfig;
      }
    }

    // Fill in missing agents with defaults
    for (const agentType of ALL_AGENTS) {
      if (!agentConfigs[agentType]) {
        agentConfigs[agentType] = getDefaultAgentConfig(agentType);
      }
    }

    // Parse provider configs
    if (config.providers && typeof config.providers === 'object') {
      for (const [providerKey, providerValue] of Object.entries(config.providers)) {
        const providerConfig = providerValue as ProviderConfig;
        providerConfigs[providerKey] = providerConfig;
      }
    }

    // Fill in missing providers with defaults
    const defaultProviders = getDefaultProviderConfig();
    for (const [providerKey, providerValue] of Object.entries(defaultProviders)) {
      if (!providerConfigs[providerKey]) {
        providerConfigs[providerKey] = providerValue;
      }
    }

    return { enabledAgents, agentConfigs, providerConfigs, hasConfig: true };
  } catch {
    // Config doesn't exist or is invalid, try migration
    const migratedConfig = await migrateLegacyConfig();
    if (migratedConfig) {
      const enabledAgents: AgentType[] = [];
      const agentConfigs: Record<AgentType, AgentConfig> = {} as Record<AgentType, AgentConfig>;
      const providerConfigs = migratedConfig.providers;

      for (const [agentKey, agentValue] of Object.entries(migratedConfig.agents)) {
        const agentType = agentKey as AgentType;
        agentConfigs[agentType] = agentValue;
        if (agentValue.enabled) {
          enabledAgents.push(agentType);
        }
      }

      return { enabledAgents, agentConfigs, providerConfigs, hasConfig: true };
    }

    // No config and no legacy config, return defaults
    const defaultConfig = getDefaultSwarmConfig();
    const enabledAgents: AgentType[] = [];
    const agentConfigs: Record<AgentType, AgentConfig> = defaultConfig.agents as Record<AgentType, AgentConfig>;
    const providerConfigs = defaultConfig.providers;

    for (const [agentKey, agentValue] of Object.entries(defaultConfig.agents)) {
      if (agentValue.enabled) {
        enabledAgents.push(agentKey as AgentType);
      }
    }

    // Write default config to file
    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));

    return { enabledAgents, agentConfigs, providerConfigs, hasConfig: false };
  }
}

/** Write teams config to disk. */
export async function writeConfig(config: SwarmConfig): Promise<void> {
  const configPath = await ensureConfigPath();
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

/** Update the enabled/disabled status of a specific agent type in the config file. */
export async function setAgentEnabled(agentType: AgentType, enabled: boolean): Promise<void> {
  const { agentConfigs } = await readConfig();
  agentConfigs[agentType].enabled = enabled;

  const configPath = await ensureConfigPath();
  const config = await fs.readFile(configPath, 'utf-8');
  const parsed = JSON.parse(config) as SwarmConfig;

  if (!parsed.agents[agentType]) {
    parsed.agents[agentType] = getDefaultAgentConfig(agentType);
  }
  parsed.agents[agentType].enabled = enabled;

  await fs.writeFile(configPath, JSON.stringify(parsed, null, 2));
}
