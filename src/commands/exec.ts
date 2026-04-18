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

export function registerExecCommand(program: Command): void {
  program
    .command('exec <agent> <prompt>')
    .description('Execute an agent CLI with unified interface')
    .option('-m, --mode <mode>', 'Execution mode: plan (read-only), edit (write), or full (full autonomy)', 'plan')
    .option('-e, --effort <effort>', 'Effort level: fast, default, detailed', 'default')
    .option('--model <model>', 'Override model selection')
    .option(
      '--env <key=value>',
      'Pass an environment variable to the spawned agent process (can repeat)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--cwd <dir>', 'Working directory')
    .option(
      '--add-dir <dir>',
      'Add directory access (Claude only, can repeat)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--json', 'Output JSON events')
    .option('--headless', 'Non-interactive mode (default for exec)', true)
    .option('--session-id <id>', 'Session ID for conversation continuity (Claude only)')
    .option('--verbose', 'Enable verbose output')
    .option('--timeout <duration>', 'Timeout duration (e.g., 30m, 1h)')
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
