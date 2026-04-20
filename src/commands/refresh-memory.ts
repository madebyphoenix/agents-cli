import { Command } from 'commander';
import chalk from 'chalk';
import { AGENTS } from '../lib/agents.js';
import { isVersionInstalled } from '../lib/versions.js';
import { ensureMemoryFresh, supportsMemoryImports } from '../lib/memory-compile.js';

/**
 * Hidden command invoked by shims for agents that don't natively resolve
 * @-imports in their memory file. Fast-path check first (sha256 of tracked
 * source files); only recompiles if a source has changed since the last
 * sync. Typical cost: 10-20ms when memory is fresh.
 */
export function registerRefreshMemoryCommand(program: Command): void {
  program
    .command('refresh-memory', { hidden: true })
    .description('Internal: recompile memory for an agent if sources have changed. Called by shims.')
    .requiredOption('--agent <agent>', 'Agent identifier (codex, opencode, cursor, etc.)')
    .requiredOption('--agent-version <version>', 'Installed version whose memory file should be refreshed')
    .option('--quiet', 'Suppress all output (exit code indicates success)', false)
    .action((opts) => {
      const agentId = opts.agent as keyof typeof AGENTS;
      const version = opts.agentVersion as string;
      const quiet = !!opts.quiet;

      if (!AGENTS[agentId]) {
        if (!quiet) console.error(chalk.red(`Unknown agent '${agentId}'`));
        process.exitCode = 1;
        return;
      }

      if (supportsMemoryImports(agentId)) {
        // Nothing to do — agent resolves @-imports natively.
        return;
      }

      if (!isVersionInstalled(agentId, version)) {
        if (!quiet) {
          console.error(chalk.red(`${AGENTS[agentId].name}@${version} is not installed`));
        }
        process.exitCode = 1;
        return;
      }

      const recompiled = ensureMemoryFresh(agentId, version);
      if (!quiet && recompiled) {
        console.log(chalk.gray(`Refreshed memory for ${agentId}@${version}`));
      }
    });
}
