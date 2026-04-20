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
  // Model IDs verified against openrouter.ai/{provider} on 2026-04-20.
  // Each preset picks the newest coding-focused variant of its provider.
  // Re-verify periodically; running presets won't upgrade in place, so
  // existing profiles stay pinned until the user re-adds with --force.
  {
    name: 'kimi',
    description: 'Kimi K2 (0905) via OpenRouter (262K ctx, $0.40/$2.00 per 1M, non-reasoning)',
    provider: 'openrouter',
    host: 'claude',
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'moonshotai/kimi-k2-0905',
      ANTHROPIC_SMALL_FAST_MODEL: 'moonshotai/kimi-k2-0905',
    },
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    signupUrl: 'https://openrouter.ai/keys',
  },
  {
    name: 'deepseek',
    description: 'DeepSeek Chat V3 (0324) via OpenRouter. Chosen because it ignores Anthropic `thinking:enabled` and returns text-only, which lets Claude Code `--print` render the response. V3.2 / V3.1-Terminus / V3.2-Speciale are reasoning variants — they work interactively but not with `--print`.',
    provider: 'openrouter',
    host: 'claude',
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'deepseek/deepseek-chat-v3-0324',
      ANTHROPIC_SMALL_FAST_MODEL: 'deepseek/deepseek-chat-v3-0324',
    },
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    signupUrl: 'https://openrouter.ai/keys',
  },
  {
    name: 'qwen',
    description: 'Qwen3 Coder Next via OpenRouter (256K ctx, $0.15/$0.80 per 1M, sparse MoE 80B/3B active)',
    provider: 'openrouter',
    host: 'claude',
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'qwen/qwen3-coder-next',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen/qwen3-coder-next',
    },
    authEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    signupUrl: 'https://openrouter.ai/keys',
  },
  {
    name: 'glm',
    description: 'GLM 5 via OpenRouter (80K ctx, $0.72/$2.30 per 1M). Zhipu\'s top-ranked model on BenchLM.ai (Apr 2026). KNOWN LIMITATION: decides whether to reason based on input complexity; short prompts stay text-only but Claude Code\'s 38K-token system prompt triggers thinking blocks, which breaks `agents run --print`. Works fine in interactive `claude` mode with the same env. Same applies to GLM 4.6/4.7/5.1.',
    provider: 'openrouter',
    host: 'claude',
    env: {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE,
      ANTHROPIC_MODEL: 'z-ai/glm-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'z-ai/glm-5',
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
