import * as os from 'os';

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
