import type { Command } from 'commander';
import chalk from 'chalk';
import {
  buildExecCommand,
  parseExecEnv,
  execAgent,
  runWithFallback,
  AGENT_COMMANDS,
  type ExecOptions,
  type ExecMode,
  type ExecEffort,
  type FallbackEntry,
} from '../lib/exec.js';
import type { AgentId } from '../lib/types.js';
import { profileExists, resolveProfileForRun } from '../lib/profiles.js';

const VALID_AGENTS = Object.keys(AGENT_COMMANDS);

interface ExecCommandActionOptions {
  mode: ExecMode;
  effort: ExecEffort;
  model?: string;
  cwd?: string;
  addDir: string[];
  env: string[];
  json?: boolean;
  headless?: boolean;
  sessionId?: string;
  verbose?: boolean;
  timeout?: string;
  fallback?: string;
}

function isValidAgent(agent: string): agent is AgentId {
  return VALID_AGENTS.includes(agent);
}

export function registerRunCommand(program: Command): void {
  program
    .command('run <agent> <prompt>')
    .description('Execute an agent non-interactively from scripts, scheduled jobs, or automation pipelines. Returns when the agent finishes.')
    .option('-m, --mode <mode>', 'How much the agent can do: plan (read-only), edit (can write files), full (writes + all permissions)', 'plan')
    .option('-e, --effort <effort>', 'Reasoning effort: low | medium | high | xhigh | max | auto (claude and codex only)', 'auto')
    .option('--model <model>', 'Override the model directly (e.g., claude-opus-4-6)')
    .option(
      '--env <key=value>',
      'Pass environment variable to the agent (repeatable, e.g., --env DEBUG=1 --env API_KEY=xyz)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--cwd <dir>', 'Working directory for the agent (defaults to current directory)')
    .option(
      '--add-dir <dir>',
      'Grant access to an additional directory outside the project (Claude only, repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--json', 'Stream events as JSON lines (for parsing by other tools)')
    .option('--headless', 'Non-interactive mode (default for run)', true)
    .option('--session-id <id>', 'Resume a previous conversation (Claude only)')
    .option('--verbose', 'Show detailed execution logs')
    .option('--timeout <duration>', 'Kill the agent after this duration (e.g., 30m, 1h, 2h30m)')
    .option(
      '--fallback <agents>',
      'Comma-separated agents to try on rate-limit failure. Each entry accepts an optional @version pin (e.g., codex@0.116.0,gemini). The primary runs first; if it exits with a rate-limit error, the next agent picks up via /continue handoff.',
    )
    .addHelpText('after', `
Examples:
  # Quick read-only analysis (plan mode, low reasoning effort)
  agents run claude "summarize recent git commits" --mode plan --effort low

  # Edit files with the agent's default effort
  agents run codex@0.116.0 "fix linting errors in src/" --mode edit

  # Full autonomy with maximum reasoning for a complex task
  agents run claude "refactor auth to use JWT" --mode full --effort max

  # Resume a previous conversation to continue work
  agents run claude "now add rate limiting" --session-id a1b2c3d4 --mode edit

  # Automated cron job: generate daily report with 10-minute timeout
  agents run claude "generate sales report for yesterday" --mode plan --timeout 10m --json > report.jsonl

  # Auto-fallback to codex then gemini if claude hits a rate limit
  agents run claude "refactor auth module" --mode edit --fallback codex,gemini

  # Pin fallback versions: primary claude@2.0.65, fallback codex@0.116.0 then gemini
  agents run claude@2.0.65 "deep refactor" --fallback codex@0.116.0,gemini

Note: 'agents run' executes non-interactively (no TTY). To work interactively with
the agent, launch it directly (e.g., 'claude', 'codex') instead of using 'run'.
`)
    .action(async (agentSpec: string, prompt: string, options: ExecCommandActionOptions) => {
      // Parse agent@version
      const [rawAgent, rawVersion] = agentSpec.split('@');
      let agent: AgentId;
      let version: string | undefined = rawVersion || undefined;
      let profileEnv: Record<string, string> | undefined;

      if (isValidAgent(rawAgent)) {
        agent = rawAgent;
      } else if (profileExists(rawAgent)) {
        // Not a known agent id, but a profile by this name exists. Profiles
        // bind (host agent, version, env overrides, keychain-backed auth)
        // so Chinese models (Kimi, DeepSeek, Qwen, GLM) can run inside
        // Claude Code without a local proxy.
        try {
          const resolved = resolveProfileForRun(rawAgent);
          agent = resolved.agent;
          if (!version) version = resolved.version;
          profileEnv = resolved.env;
          process.stderr.write(chalk.gray(`Resolved profile '${resolved.profileName}' -> ${agent}${version ? `@${version}` : ''}\n`));
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      } else {
        console.error(chalk.red(`Unknown agent: ${rawAgent}`));
        console.error(chalk.gray(`Available agents: ${VALID_AGENTS.join(', ')}`));
        console.error(chalk.gray(`Or add a profile: agents profiles add <name>`));
        process.exit(1);
      }

      const mode = options.mode as ExecMode;
      if (!['plan', 'edit', 'full'].includes(mode)) {
        console.error(chalk.red(`Invalid mode: ${mode}. Use 'plan', 'edit', or 'full'`));
        process.exit(1);
      }

      const effort = options.effort as ExecEffort;
      if (!['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(effort)) {
        console.error(chalk.red(`Invalid effort: ${effort}. Use 'low', 'medium', 'high', 'xhigh', 'max', or 'auto'`));
        process.exit(1);
      }

      let userEnv: Record<string, string> | undefined;
      try {
        userEnv = parseExecEnv(options.env);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }

      // Merge order: profile env is the base (resolved at exec time from
      // keychain), then user --env flags override. This lets users tweak a
      // single variable (e.g. --env ANTHROPIC_MODEL=...) without losing the
      // profile's endpoint + auth.
      const env: Record<string, string> | undefined =
        profileEnv || userEnv
          ? { ...(profileEnv ?? {}), ...(userEnv ?? {}) }
          : undefined;

      const execOptions: ExecOptions = {
        agent,
        version,
        prompt,
        mode,
        effort,
        cwd: options.cwd,
        model: options.model,
        addDirs: options.addDir,
        json: options.json,
        headless: options.headless ?? true,
        sessionId: options.sessionId,
        verbose: options.verbose,
        timeout: options.timeout,
        env,
      };

      const fallback: FallbackEntry[] = [];
      if (options.fallback) {
        const entries = options.fallback.split(',').map(s => s.trim()).filter(Boolean);
        for (const entry of entries) {
          const [fbAgent, fbVersion] = entry.split('@');
          if (!isValidAgent(fbAgent)) {
            console.error(chalk.red(`Unknown fallback agent: ${fbAgent}`));
            console.error(chalk.gray(`Available: ${VALID_AGENTS.join(', ')}`));
            process.exit(1);
          }
          if (fbAgent === agent) {
            console.error(chalk.red(`Fallback cannot include the primary agent (${agent}). Rate-limit fallback only helps when switching providers.`));
            process.exit(1);
          }
          fallback.push({ agent: fbAgent, version: fbVersion || undefined });
        }
      }

      // Show what we're running (stderr so stdout stays clean for piping)
      const cmd = buildExecCommand(execOptions);
      process.stderr.write(chalk.gray(`Running: ${cmd.join(' ')}\n\n`));

      try {
        const exitCode = fallback.length > 0
          ? await runWithFallback({ ...execOptions, fallback })
          : await execAgent(execOptions);
        process.exit(exitCode);
      } catch (err) {
        console.error(chalk.red(`Failed to execute ${agent}: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
