import type { AgentId } from './types.js';

export interface Preset {
  name: string;
  description: string;
  provider: string;
  host: AgentId;
  env: Record<string, string>;
  authEnvVar: string;
  signupUrl?: string;
}

// Presets ship pre-verified endpoints and model IDs. Profiles created via a
// preset snapshot these values; re-running `profiles add` does not silently
// upgrade an existing profile. Users can `agents profiles view <name>` to see
// what got stored.
//
// Model IDs intentionally omit a dated suffix when the provider offers a
// moving 'latest' alias, so Kimi/DeepSeek pick up upstream upgrades.

const OPENROUTER_BASE = 'https://openrouter.ai/api';

export const PRESETS: Preset[] = [
  // ----- Via OpenRouter (shared key: agents-cli.openrouter.token) -----
  {
    name: 'kimi',
    description: 'Kimi K2 via OpenRouter',
    provider: 'openrouter',
    host: 'claude',
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2',
      ANTHROPIC_SMALL_FAST_MODEL: 'moonshotai/kimi-k2',
    },
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    signupUrl: 'https://openrouter.ai/keys',
  },
  {
    name: 'deepseek',
    description: 'DeepSeek V3 via OpenRouter',
    provider: 'openrouter',
    host: 'claude',
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'deepseek/deepseek-chat',
      ANTHROPIC_SMALL_FAST_MODEL: 'deepseek/deepseek-chat',
    },
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    signupUrl: 'https://openrouter.ai/keys',
  },
  {
    name: 'qwen',
    description: 'Qwen3 Coder via OpenRouter',
    provider: 'openrouter',
    host: 'claude',
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'qwen/qwen3-coder',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen/qwen3-coder',
    },
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    signupUrl: 'https://openrouter.ai/keys',
  },
  {
    name: 'glm',
    description: 'GLM 4.6 via OpenRouter',
    provider: 'openrouter',
    host: 'claude',
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'z-ai/glm-4.6',
      ANTHROPIC_SMALL_FAST_MODEL: 'z-ai/glm-4.6',
    },
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    signupUrl: 'https://openrouter.ai/keys',
  },
];

export function getPreset(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}

export function listPresets(): Preset[] {
  return [...PRESETS];
}

export function listProviders(): string[] {
  return [...new Set(PRESETS.map((p) => p.provider))];
}
