/**
 * Deprecated status command.
 *
 * Registers the `agents status` command as a backward-compatible alias
 * for `agents view`. Prints a deprecation notice and delegates to viewAction.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { viewAction } from './view.js';

/** Register the deprecated `agents status` command (alias for `agents view`). */
export function registerStatusCommand(program: Command): void {
  // Deprecated: use `agents view` instead
  program
    .command('status [agent]')
    .description('Show installed agents and resources')
    .action(async (agentFilter?: string) => {
      console.log(chalk.red('Deprecated: "agents status" is now "agents view"\n'));
      // If agent specified without version, default to @default for backwards compatibility
      if (agentFilter && !agentFilter.includes('@')) {
        await viewAction(`${agentFilter}@default`);
      } else {
        await viewAction(agentFilter);
      }
    });
}
