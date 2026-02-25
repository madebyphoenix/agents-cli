import type { Command } from 'commander';
import chalk from 'chalk';
import {
  buildExecCommand,
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
  json?: boolean;
  headless?: boolean;
}

function isValidAgent(agent: string): agent is AgentId {
  return VALID_AGENTS.includes(agent);
}

export function registerExecCommand(program: Command): void {
  program
    .command('exec <agent> <prompt>')
    .description('Execute an agent CLI with unified interface')
    .option('-m, --mode <mode>', 'Execution mode: plan (read-only) or edit (write)', 'plan')
    .option('-e, --effort <effort>', 'Effort level: fast, default, detailed', 'default')
    .option('--model <model>', 'Override model selection')
    .option('--cwd <dir>', 'Working directory')
    .option(
      '--add-dir <dir>',
      'Add directory access (Claude only, can repeat)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--json', 'Output JSON events')
    .option('--headless', 'Non-interactive mode (default for exec)', true)
    .action(async (agentSpec: string, prompt: string, options: ExecCommandActionOptions) => {
      // Parse agent@version
      const [agent, version] = agentSpec.split('@');

      if (!isValidAgent(agent)) {
        console.log(chalk.red(`Unknown agent: ${agent}`));
        console.log(chalk.gray(`Available: ${VALID_AGENTS.join(', ')}`));
        process.exit(1);
      }

      const mode = options.mode as ExecMode;
      if (!['plan', 'edit'].includes(mode)) {
        console.log(chalk.red(`Invalid mode: ${mode}. Use 'plan' or 'edit'`));
        process.exit(1);
      }

      const effort = options.effort as ExecEffort;
      if (!['fast', 'default', 'detailed'].includes(effort)) {
        console.log(chalk.red(`Invalid effort: ${effort}. Use 'fast', 'default', or 'detailed'`));
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
      };

      // Show what we're running
      const cmd = buildExecCommand(execOptions);
      console.log(chalk.gray(`Running: ${cmd.join(' ')}\n`));

      try {
        const exitCode = await execAgent(execOptions);
        process.exit(exitCode);
      } catch (err) {
        console.error(chalk.red(`Failed to execute ${agent}: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
