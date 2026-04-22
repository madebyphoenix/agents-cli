/**
 * Shared utilities for command implementations.
 *
 * Small helpers used across multiple commands: prompt cancellation detection,
 * table formatting, spinner management, and platform-specific workarounds.
 */

import * as os from 'os';
import { spawnSync } from 'child_process';
import chalk from 'chalk';

/**
 * Check if an error is from user cancelling a prompt (Ctrl+C)
 */
export function isPromptCancelled(err: unknown): boolean {
  return err instanceof Error && (
    err.name === 'ExitPromptError' ||
    err.message.includes('force closed') ||
    err.message.includes('User force closed')
  );
}

/**
 * True when stdin/stdout are attached to a real terminal.
 */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Exit with a clean message when a picker would be required in a non-interactive shell.
 */
export function requireInteractiveSelection(action: string, alternatives: string[]): never {
  console.error(chalk.red(`${action} requires an interactive terminal.`));
  if (alternatives.length > 0) {
    console.error(chalk.gray('Run one of these non-interactive forms instead:'));
    for (const alternative of alternatives) {
      console.error(chalk.cyan(`  ${alternative}`));
    }
  }
  process.exit(1);
}

/**
 * Print a properly-cased "missing argument" error for destructive commands and
 * exit. Destructive commands (remove, disband, disable) deliberately do NOT
 * fall back to an interactive picker — typing the name is the safety check.
 *
 * Lists available items so the user can copy-paste, but never auto-selects.
 */
export function requireDestructiveArg(opts: {
  argName: string;       // e.g. 'team', 'name', 'agent'
  command: string;       // e.g. 'agents teams disband'
  itemNoun: string;      // e.g. 'team', 'plugin' — used for grammar
  available: string[];   // names to list
  emptyHint?: string;    // shown when no items exist
}): never {
  const { argName, command, itemNoun, available, emptyHint } = opts;
  console.error(chalk.red(`Missing required argument: ${argName.toUpperCase()}`));
  console.error('');
  if (available.length === 0) {
    console.error(chalk.gray(emptyHint || `No ${itemNoun}s to choose from.`));
  } else {
    const label = available.length === 1 ? itemNoun : `${itemNoun}s`;
    console.error(chalk.gray(`Available ${label}:`));
    for (const name of available) {
      console.error(`  ${chalk.cyan(name)}`);
    }
    console.error('');
    console.error(chalk.gray(`Re-run with the ${itemNoun} you want:`));
    console.error(chalk.cyan(`  ${command} ${available[0]}`));
  }
  console.error('');
  console.error(
    chalk.gray(`Tip: this is a destructive command, so you have to type the ${itemNoun} name explicitly.`)
  );
  process.exit(2);
}

/**
 * Print long content directly in non-interactive shells, use a pager only for real terminals.
 */
export function printWithPager(output: string, lineCount: number): void {
  if (!isInteractiveTerminal() || lineCount <= 40) {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return;
  }

  const less = spawnSync('less', ['-R'], {
    input: output,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  if (less.status !== 0) {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  }
}

/**
 * Parse a comma-separated CLI list, trimming whitespace and dropping empties.
 */
export function parseCommaSeparatedList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Format a path for display, using ~ for home directory
 */
export function formatPath(fullPath: string, cwd?: string): string {
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  const currentDir = cwd || process.cwd();
  if (fullPath.startsWith(currentDir + '/')) {
    return fullPath.slice(currentDir.length + 1);
  }
  return fullPath;
}
