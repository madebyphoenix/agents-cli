import simpleGit, { SimpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import { getPackageLocalPath } from './state.js';

export interface GitSource {
  type: 'github' | 'url' | 'local';
  url: string;
  ref?: string;
}

/**
 * Parse a source string into a GitSource object.
 *
 * Supported formats:
 *   gh:owner/repo                    -> https://github.com/owner/repo.git
 *   gh:owner/repo@branch             -> https://github.com/owner/repo.git (ref: branch)
 *   owner/repo                       -> https://github.com/owner/repo.git
 *   owner/repo@branch                -> https://github.com/owner/repo.git (ref: branch)
 *   github.com/owner/repo            -> https://github.com/owner/repo.git
 *   github.com:owner/repo            -> https://github.com/owner/repo.git
 *   github.com:owner/repo.git        -> https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git    -> https://github.com/owner/repo.git
 *   https://github.com/owner/repo    -> https://github.com/owner/repo.git
 *   https://github.com/owner/repo.git -> https://github.com/owner/repo.git
 *   /path/to/local                   -> local path
 *   ./relative/path                  -> local path
 */
export function parseSource(source: string): GitSource {
  // Split off @ref suffix (but not from URLs with @ in them like git@)
  let ref: string | undefined;
  let cleanSource = source;

  // Handle @ref suffix (only if it's at the end and not part of git@)
  const atIndex = source.lastIndexOf('@');
  if (atIndex > 0 && !source.startsWith('git@') && !source.slice(0, atIndex).includes('://')) {
    // Check if what's after @ looks like a ref (no slashes, no dots except in branch names)
    const possibleRef = source.slice(atIndex + 1);
    if (possibleRef && !possibleRef.includes('/') && !possibleRef.includes(':')) {
      ref = possibleRef;
      cleanSource = source.slice(0, atIndex);
    }
  }

  // gh:owner/repo shorthand
  if (cleanSource.startsWith('gh:')) {
    const repo = cleanSource.slice(3).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // git@github.com:owner/repo.git (SSH URL)
  if (cleanSource.startsWith('git@github.com:')) {
    const repo = cleanSource.slice(15).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // github.com:owner/repo.git (SSH-style without git@)
  if (cleanSource.startsWith('github.com:')) {
    const repo = cleanSource.slice(11).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // github.com/owner/repo (domain without protocol)
  if (cleanSource.startsWith('github.com/')) {
    const repo = cleanSource.slice(11).replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // https:// or http:// URLs
  if (cleanSource.startsWith('http://') || cleanSource.startsWith('https://')) {
    // Check if it's a GitHub URL
    const githubMatch = cleanSource.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (githubMatch) {
      return {
        type: 'github',
        url: `https://github.com/${githubMatch[1]}.git`,
        ref: ref || 'main',
      };
    }

    // Generic URL
    return {
      type: 'url',
      url: cleanSource.endsWith('.git') ? cleanSource : `${cleanSource}.git`,
      ref,
    };
  }

  // Local path (absolute or relative)
  if (cleanSource.startsWith('/') || cleanSource.startsWith('./') || cleanSource.startsWith('../')) {
    if (fs.existsSync(cleanSource)) {
      return {
        type: 'local',
        url: path.resolve(cleanSource),
      };
    }
  }

  // Check if it exists as a local path (could be a directory name without ./)
  if (fs.existsSync(cleanSource)) {
    return {
      type: 'local',
      url: path.resolve(cleanSource),
    };
  }

  // Bare owner/repo format (assumes GitHub)
  if (cleanSource.includes('/') && !cleanSource.includes(':') && !cleanSource.includes('.')) {
    const repo = cleanSource.replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  // Last attempt: treat as GitHub if it looks like owner/repo (with possible .git)
  if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(cleanSource)) {
    const repo = cleanSource.replace(/\.git$/, '');
    return {
      type: 'github',
      url: `https://github.com/${repo}.git`,
      ref: ref || 'main',
    };
  }

  throw new Error(`Invalid source: ${source}. Supported formats: gh:owner/repo, owner/repo, github.com/owner/repo, https://github.com/owner/repo, or local path`);
}

export async function cloneOrPull(
  source: GitSource,
  targetDir: string
): Promise<{ isNew: boolean; commit: string }> {
  const git: SimpleGit = simpleGit();

  if (source.type === 'local') {
    return { isNew: false, commit: 'local' };
  }

  const exists = fs.existsSync(path.join(targetDir, '.git'));

  if (exists) {
    const repoGit = simpleGit(targetDir);
    await repoGit.fetch();
    if (source.ref) {
      await repoGit.checkout(source.ref);
    }
    await repoGit.pull();
    const log = await repoGit.log({ maxCount: 1 });
    return { isNew: false, commit: log.latest?.hash.slice(0, 8) || 'unknown' };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  await git.clone(source.url, targetDir);

  const repoGit = simpleGit(targetDir);
  if (source.ref) {
    await repoGit.checkout(source.ref);
  }
  const log = await repoGit.log({ maxCount: 1 });
  return { isNew: true, commit: log.latest?.hash.slice(0, 8) || 'unknown' };
}

export async function cloneRepo(source: string): Promise<{
  localPath: string;
  commit: string;
  isNew: boolean;
}> {
  const parsed = parseSource(source);

  if (parsed.type === 'local') {
    return {
      localPath: parsed.url,
      commit: 'local',
      isNew: false,
    };
  }

  const localPath = getPackageLocalPath(source);
  const result = await cloneOrPull(parsed, localPath);

  return {
    localPath,
    commit: result.commit,
    isNew: result.isNew,
  };
}

export async function clonePackage(source: string): Promise<{
  localPath: string;
  commit: string;
  isNew: boolean;
}> {
  const parsed = parseSource(source);

  if (parsed.type === 'local') {
    return {
      localPath: parsed.url,
      commit: 'local',
      isNew: false,
    };
  }

  const localPath = getPackageLocalPath(source);
  const result = await cloneOrPull(parsed, localPath);

  return {
    localPath,
    commit: result.commit,
    isNew: result.isNew,
  };
}

export async function getRepoCommit(repoPath: string): Promise<string> {
  try {
    const git = simpleGit(repoPath);
    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash.slice(0, 8) || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Get the current GitHub username using gh CLI.
 * Returns null if gh is not installed or user is not authenticated.
 */
export async function getGitHubUsername(): Promise<string | null> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    const { stdout } = await execAsync('gh api user --jq ".login"');
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the remote URL for origin in a git repo.
 */
export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const git = simpleGit(repoPath);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    return origin?.refs?.fetch || origin?.refs?.push || null;
  } catch {
    return null;
  }
}

/**
 * Set the remote URL for origin in a git repo.
 */
export async function setRemoteUrl(repoPath: string, url: string): Promise<void> {
  const git = simpleGit(repoPath);
  const remotes = await git.getRemotes(true);
  const hasOrigin = remotes.some(r => r.name === 'origin');

  if (hasOrigin) {
    await git.remote(['set-url', 'origin', url]);
  } else {
    await git.remote(['add', 'origin', url]);
  }
}

/**
 * Check if a GitHub repo exists.
 */
export async function checkGitHubRepoExists(owner: string, repo: string): Promise<boolean> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    await execAsync(`gh repo view ${owner}/${repo} --json name`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit and push changes in a repo.
 */
export async function commitAndPush(repoPath: string, message: string): Promise<{ success: boolean; error?: string }> {
  try {
    const git = simpleGit(repoPath);

    // Check for changes
    const status = await git.status();
    if (status.files.length === 0) {
      return { success: true }; // Nothing to commit
    }

    // Stage all changes
    await git.add('-A');

    // Commit
    await git.commit(message);

    // Push
    await git.push('origin', 'main');

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Check if repo has uncommitted changes.
 */
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  try {
    const git = simpleGit(repoPath);
    const status = await git.status();
    return status.files.length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Initialize a git repo in an existing directory.
 */
export async function initRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init();
}

/**
 * Clone a repo into an existing directory (for initializing ~/.agents/).
 * This clones into a temp dir, moves .git, then checks out tracked files.
 */
export async function cloneIntoExisting(
  source: string,
  targetDir: string
): Promise<{ success: boolean; commit: string; error?: string }> {
  const parsed = parseSource(source);
  if (parsed.type === 'local') {
    return { success: false, commit: '', error: 'Cannot clone local source' };
  }

  const git = simpleGit();
  const tempDir = path.join(targetDir, '.git-clone-temp');

  try {
    // Clone to temp directory
    fs.mkdirSync(tempDir, { recursive: true });
    await git.clone(parsed.url, tempDir);

    const repoGit = simpleGit(tempDir);
    if (parsed.ref) {
      await repoGit.checkout(parsed.ref);
    }

    // Move .git directory to target
    const gitDir = path.join(tempDir, '.git');
    const targetGitDir = path.join(targetDir, '.git');
    if (fs.existsSync(targetGitDir)) {
      fs.rmSync(targetGitDir, { recursive: true });
    }
    fs.renameSync(gitDir, targetGitDir);

    // Clean up temp
    fs.rmSync(tempDir, { recursive: true });

    // Checkout tracked files from git (restores repo files, respects .gitignore)
    const targetGit = simpleGit(targetDir);
    await targetGit.checkout('.');

    const log = await targetGit.log({ maxCount: 1 });

    return {
      success: true,
      commit: log.latest?.hash.slice(0, 8) || 'unknown',
    };
  } catch (err) {
    // Clean up temp on error
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
    return { success: false, commit: '', error: (err as Error).message };
  }
}

/**
 * Check if the repo's origin points to the system repo.
 */
export async function isSystemRepoOrigin(dir: string): Promise<boolean> {
  try {
    const git = simpleGit(dir);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (!origin?.refs?.fetch) return false;

    // Check if it's muqsitnawaz/.agents
    const url = origin.refs.fetch.toLowerCase();
    return url.includes('muqsitnawaz/.agents') || url.includes('muqsitnawaz/agents');
  } catch {
    return false;
  }
}

/**
 * Check if repo has uncommitted changes (including untracked files).
 */
export async function hasLocalChanges(dir: string): Promise<boolean> {
  try {
    const git = simpleGit(dir);
    const status = await git.status();
    return !status.isClean();
  } catch {
    return false;
  }
}

/**
 * Pull changes in an existing repo.
 * Handles untracked files by stashing (for system repo) or committing (for user's repo).
 */
export async function pullRepo(dir: string): Promise<{ success: boolean; commit: string; error?: string; stashed?: boolean }> {
  try {
    const git = simpleGit(dir);
    const status = await git.status();
    const hasChanges = !status.isClean();
    const isSystemRepo = await isSystemRepoOrigin(dir);
    let stashed = false;

    if (hasChanges) {
      if (isSystemRepo) {
        // System repo: stash changes (including untracked) before pull
        await git.stash(['push', '-u', '-m', 'agents-cli: auto-stash before pull']);
        stashed = true;
      } else {
        // User's repo: commit changes before pull so we can merge
        await git.add('-A');
        await git.commit('Local changes before pull', { '--allow-empty': null });
      }
    }

    await git.fetch();
    await git.pull();

    // Restore stashed changes
    if (stashed) {
      try {
        await git.stash(['pop']);
      } catch (stashErr) {
        // Stash pop failed - likely conflicts
        return {
          success: true,
          commit: (await git.log({ maxCount: 1 })).latest?.hash.slice(0, 8) || 'unknown',
          error: `Pulled successfully but stash pop had conflicts. Run 'cd ~/.agents && git stash pop' to resolve.`,
        };
      }
    }

    const log = await git.log({ maxCount: 1 });
    return {
      success: true,
      commit: log.latest?.hash.slice(0, 8) || 'unknown',
      stashed,
    };
  } catch (err) {
    return { success: false, commit: '', error: (err as Error).message };
  }
}

/**
 * Get git status for sync display.
 * Returns files categorized by their status relative to HEAD.
 */
export interface GitSyncStatus {
  synced: string[];      // Tracked and unchanged
  modified: string[];    // Modified but not staged
  new: string[];         // Untracked files
  staged: string[];      // Staged for commit
  deleted: string[];     // Deleted files
}

export async function getGitSyncStatus(dir: string, subdir?: string): Promise<GitSyncStatus | null> {
  if (!isGitRepo(dir)) {
    return null;
  }

  try {
    const git = simpleGit(dir);
    const status = await git.status();

    const result: GitSyncStatus = {
      synced: [],
      modified: [],
      new: [],
      staged: [],
      deleted: [],
    };

    // Filter to subdir if specified
    const filterPath = (file: string) => {
      if (!subdir) return true;
      return file.startsWith(subdir + '/') || file === subdir;
    };

    // Working tree changes (not staged)
    for (const file of status.modified.filter(filterPath)) {
      result.modified.push(file);
    }
    for (const file of status.not_added.filter(filterPath)) {
      result.new.push(file);
    }
    for (const file of status.deleted.filter(filterPath)) {
      result.deleted.push(file);
    }

    // Staged changes (in index, ready to commit)
    for (const file of status.created.filter(filterPath)) {
      result.staged.push(file);
    }
    for (const file of status.staged.filter(filterPath)) {
      if (!result.staged.includes(file)) {
        result.staged.push(file);
      }
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Get list of files tracked by git in a directory.
 */
export async function getTrackedFiles(dir: string, subdir?: string): Promise<string[]> {
  if (!isGitRepo(dir)) {
    return [];
  }

  try {
    const git = simpleGit(dir);
    const result = await git.raw(['ls-files', subdir || '.']);
    return result.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
