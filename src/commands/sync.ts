import { Command } from 'commander';
import chalk from 'chalk';
import { AGENTS } from '../lib/agents.js';
import { isVersionInstalled, syncResourcesToVersion } from '../lib/versions.js';

export function registerSyncCommand(program: Command): void {
  program
    .command('sync', { hidden: true })
    .description('Internal: sync resources to a version home. Called by shims, not directly by users.')
    .requiredOption('--agent <agent>', 'Agent identifier (claude, codex, gemini, cursor, opencode, openclaw)')
    .requiredOption('--version <version>', 'Installed version to sync resources into')
    .option('--project-dir <path>', 'Path to project-level .agents/ directory containing project-scoped resources')
    .option('--cwd <path>', 'Working directory for discovering project manifest and resources')
    .option('--quiet', 'Suppress all output (exit code indicates success)', false)
    .action((opts) => {
      const agentId = opts.agent as keyof typeof AGENTS;
      const version = opts.version as string;
      const projectDir = opts.projectDir as string | undefined;
      const cwd = opts.cwd as string | undefined;
      const quiet = !!opts.quiet;

      if (!AGENTS[agentId]) {
        if (!quiet) {
          console.error(chalk.red(`Unknown agent '${agentId}'`));
        }
        process.exitCode = 1;
        return;
      }

      if (!isVersionInstalled(agentId, version)) {
        if (!quiet) {
          console.error(chalk.red(`${AGENTS[agentId].name}@${version} is not installed`));
        }
        process.exitCode = 1;
        return;
      }

      const result = syncResourcesToVersion(agentId, version, undefined, { projectDir, cwd });

      if (quiet) {
        return;
      }

      const synced: string[] = [];
      if (result.commands) synced.push('commands');
      if (result.skills) synced.push('skills');
      if (result.hooks) synced.push('hooks');
      if (result.memory.length > 0) synced.push('memory');
      if (result.permissions) synced.push('permissions');
      if (result.mcp.length > 0) synced.push('mcp');
      if (result.subagents.length > 0) synced.push('subagents');
      if (result.plugins.length > 0) synced.push('plugins');

      if (synced.length > 0) {
        console.log(chalk.green(`Synced ${synced.join(', ')} to ${agentId}@${version}`));
      } else {
        console.log(chalk.gray('No resources to sync'));
      }
    });
}
