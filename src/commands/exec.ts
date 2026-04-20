import type { Command } from 'commander';
import chalk from 'chalk';
import {
  buildExecCommand,
  parseExecEnv,
  execAgent,
  AGENT_COMMANDS,
  type ExecOptions,
  type ExecMode,
  type ExecEffort,
} from '../lib/exec.js';
import type { AgentId } from '../lib/types.js';

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
}

function isValidAgent(agent: string): agent is AgentId {
  return VALID_AGENTS.includes(agent);
}

export function registerRunCommand(program: Command): void {
  program
    .command('run <agent> <prompt>')
    .description('Execute an agent non-interactively from scripts, scheduled jobs, or automation pipelines. Returns when the agent finishes.')
    .option('-m, --mode <mode>', 'How much the agent can do: plan (read-only), edit (can write files), full (writes + all permissions)', 'plan')
    .option('-e, --effort <effort>', 'Model tier to use: fast (haiku), default (sonnet), detailed (opus)', 'default')
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
    .addHelpText('after', `
Examples:
  # Quick read-only analysis (plan mode, fast model)
  agents run claude "summarize recent git commits" --mode plan --effort fast

  # Edit files with default model (sonnet)
  agents run codex@0.116.0 "fix linting errors in src/" --mode edit

  # Full autonomy with opus model for complex task
  agents run claude "refactor auth to use JWT" --mode full --effort detailed

  # Resume a previous conversation to continue work
  agents run claude "now add rate limiting" --session-id a1b2c3d4 --mode edit

  # Automated cron job: generate daily report with 10-minute timeout
  agents run claude "generate sales report for yesterday" --mode plan --timeout 10m --json > report.jsonl

Note: 'agents run' executes non-interactively (no TTY). To work interactively with
the agent, launch it directly (e.g., 'claude', 'codex') instead of using 'run'.
`)
    .action(async (agentSpec: string, prompt: string, options: ExecCommandActionOptions) => {
      // Parse agent@version
      const [agent, version] = agentSpec.split('@');

      if (!isValidAgent(agent)) {
        console.error(chalk.red(`Unknown agent: ${agent}`));
        console.error(chalk.gray(`Available: ${VALID_AGENTS.join(', ')}`));
        process.exit(1);
      }

      const mode = options.mode as ExecMode;
      if (!['plan', 'edit', 'full'].includes(mode)) {
        console.error(chalk.red(`Invalid mode: ${mode}. Use 'plan', 'edit', or 'full'`));
        process.exit(1);
      }

      const effort = options.effort as ExecEffort;
      if (!['fast', 'default', 'detailed'].includes(effort)) {
        console.error(chalk.red(`Invalid effort: ${effort}. Use 'fast', 'default', or 'detailed'`));
        process.exit(1);
      }

      let env: Record<string, string> | undefined;
      try {
        env = parseExecEnv(options.env);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }

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

      // Show what we're running (stderr so stdout stays clean for piping)
      const cmd = buildExecCommand(execOptions);
      process.stderr.write(chalk.gray(`Running: ${cmd.join(' ')}\n\n`));

      try {
        const exitCode = await execAgent(execOptions);
        process.exit(exitCode);
      } catch (err) {
        console.error(chalk.red(`Failed to execute ${agent}: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
