/**
 * Extra DotAgent repo management.
 *
 * Registers `agents repo add|list|remove|enable|disable` which clone
 * additional DotAgent repos alongside the primary ~/.agents/ repo so
 * private, work, or team skills can ship separately from public ones.
 *
 * Extras live at ~/.agents/.repos/<alias>/ and are registered in
 * meta.extraRepos. Sync functions merge their resources into agent
 * version homes after the primary's (primary-wins on name collisions).
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';

import {
  ensureAgentsDir,
  getAgentsDir,
  getExtraRepoDir,
  readMeta,
  updateMeta,
} from '../lib/state.js';
import { parseSource, pullRepo } from '../lib/git.js';
import type { ExtraRepoConfig } from '../lib/types.js';

const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Derive a default alias from a source URL (e.g. gh:foo/.agents-work -> agents-work). */
function deriveAlias(source: string): string {
  const parsed = parseSource(source);
  let base: string;
  if (parsed.type === 'local') {
    base = path.basename(parsed.url);
  } else {
    const match = parsed.url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    base = match ? match[2] : parsed.url;
  }
  // Strip leading dots (e.g. ".agents-work" -> "agents-work") so the alias
  // is usable as a visible directory name under ~/.agents/.repos/.
  return base.replace(/^\.+/, '') || 'repo';
}

/** Ensure the .repos/ path and its parent .gitignore entry are set up. */
function ensureExtraReposDir(agentsDir: string): void {
  ensureAgentsDir();
  const gitignorePath = path.join(agentsDir, '.gitignore');
  let current = '';
  try {
    current = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    /* file doesn't exist yet — we'll create it */
  }
  const line = '/.repos/';
  const lines = current.split('\n');
  if (!lines.includes(line) && !lines.includes('.repos/') && !lines.includes('/.repos')) {
    const next = (current.endsWith('\n') || current === '' ? current : current + '\n') + line + '\n';
    fs.writeFileSync(gitignorePath, next, 'utf-8');
  }
}

/** Get the last commit short hash for a repo, or null if unavailable. */
async function getShortCommit(repoDir: string): Promise<string | null> {
  try {
    const git = simpleGit(repoDir);
    const log = await git.log({ maxCount: 1 });
    return log.latest?.hash.slice(0, 8) || null;
  } catch {
    return null;
  }
}

/** Register the `agents repo` command tree. */
export function registerRepoCommands(program: Command): void {
  const repoCmd = program
    .command('repo')
    .description('Manage extra DotAgent repos alongside the primary ~/.agents/ (for private or team skills)')
    .addHelpText('after', `
Extras live at ~/.agents/.repos/<alias>/ and can be public or private. Their skills,
commands, and hooks merge into agent version homes after the primary repo's — so
the primary (~/.agents/) wins on name collisions.

Examples:
  # Add a private repo for work-only skills
  agents repo add gh:yourname/.agents-work

  # Add with a custom alias
  agents repo add git@github.com:acme/team-skills.git --as acme

  # Show all registered repos
  agents repo list

  # Temporarily disable without deleting
  agents repo disable acme

  # Permanently remove
  agents repo remove acme
`);

  repoCmd
    .command('add <source>')
    .description('Clone a DotAgent repo into ~/.agents/.repos/<alias>/ and register it for sync')
    .option('--as <alias>', 'Override the auto-derived alias (letters, digits, _ or -)')
    .action(async (source: string, options: { as?: string }) => {
      const meta = readMeta();
      const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };

      const alias = options.as ? options.as.trim() : deriveAlias(source);
      if (!ALIAS_PATTERN.test(alias)) {
        console.log(chalk.red(`Invalid alias "${alias}".`));
        console.log(chalk.gray('Alias must start with a letter/digit and contain only letters, digits, "_" or "-".'));
        process.exitCode = 1;
        return;
      }
      if (extras[alias]) {
        console.log(chalk.red(`Alias "${alias}" is already registered.`));
        console.log(chalk.gray(`Existing: ${extras[alias].url}`));
        console.log(chalk.gray(`Use --as <other-alias>, or: agents repo remove ${alias}`));
        process.exitCode = 1;
        return;
      }

      let parsed;
      try {
        parsed = parseSource(source);
      } catch (err) {
        console.log(chalk.red((err as Error).message));
        process.exitCode = 1;
        return;
      }

      ensureExtraReposDir(getAgentsDir());
      const targetDir = getExtraRepoDir(alias);
      if (fs.existsSync(targetDir)) {
        console.log(chalk.red(`Directory already exists: ${targetDir}`));
        console.log(chalk.gray('Remove it manually or pick a different alias with --as.'));
        process.exitCode = 1;
        return;
      }

      const spinner = ora(`Cloning ${source}...`).start();
      try {
        // Use git clone directly so both remote and local sources land as a
        // real working tree under ~/.agents/.repos/<alias>/. (lib/git's
        // cloneOrPull short-circuits for local sources, which we don't want
        // here — we always want a clone so pulls work later.)
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        await simpleGit().clone(parsed.url, targetDir);
        if (parsed.ref) {
          await simpleGit(targetDir).checkout(parsed.ref);
        }
        const log = await simpleGit(targetDir).log({ maxCount: 1 });
        const commit = log.latest?.hash.slice(0, 8) || 'unknown';
        spinner.succeed(`Cloned ${source} -> .repos/${alias} (${commit})`);
      } catch (err) {
        spinner.fail(`Clone failed: ${(err as Error).message}`);
        try {
          fs.rmSync(targetDir, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
        process.exitCode = 1;
        return;
      }

      extras[alias] = { url: parsed.url, enabled: true };
      updateMeta({ extraRepos: extras });

      console.log(chalk.gray(`\nRegistered as "${alias}". Skills and commands from this repo will be`));
      console.log(chalk.gray(`picked up on the next \`agents pull\` or \`agents skills sync\`.`));
    });

  repoCmd
    .command('list')
    .alias('ls')
    .description('Show the primary ~/.agents/ repo and every registered extra')
    .action(async () => {
      const meta = readMeta();
      const primaryUrl = meta.source || '(no remote configured)';
      console.log(chalk.bold('\nPrimary:'));
      console.log(`  ${chalk.cyan('(primary)')}  ${primaryUrl}`);

      const extras = meta.extraRepos || {};
      const aliases = Object.keys(extras);
      console.log(chalk.bold('\nExtras:'));
      if (aliases.length === 0) {
        console.log(chalk.gray('  (none — add one with `agents repo add <source>`)\n'));
        return;
      }

      for (const alias of aliases) {
        const config = extras[alias];
        const dir = getExtraRepoDir(alias);
        const onDisk = fs.existsSync(dir);
        const commit = onDisk ? await getShortCommit(dir) : null;

        const status = !config.enabled
          ? chalk.yellow('disabled')
          : !onDisk
            ? chalk.red('missing')
            : chalk.green('enabled');
        const commitLabel = commit ? chalk.gray(`(${commit})`) : '';
        console.log(`  ${chalk.cyan(alias.padEnd(12))}  ${config.url}  ${status}  ${commitLabel}`);
      }
      console.log('');
    });

  repoCmd
    .command('remove <alias>')
    .alias('rm')
    .description('Unregister an extra repo and delete its local clone')
    .action(async (alias: string) => {
      const meta = readMeta();
      const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };
      if (!extras[alias]) {
        console.log(chalk.red(`No extra repo registered as "${alias}".`));
        process.exitCode = 1;
        return;
      }

      const dir = getExtraRepoDir(alias);
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (err) {
        console.log(chalk.yellow(`Warning: could not delete ${dir}: ${(err as Error).message}`));
      }

      delete extras[alias];
      updateMeta({ extraRepos: extras });
      console.log(chalk.green(`Removed "${alias}"`));
    });

  repoCmd
    .command('enable <alias>')
    .description('Re-enable a previously disabled extra repo')
    .action(async (alias: string) => {
      await toggle(alias, true);
    });

  repoCmd
    .command('disable <alias>')
    .description('Stop merging this repo during sync without deleting the clone')
    .action(async (alias: string) => {
      await toggle(alias, false);
    });

  repoCmd
    .command('pull [alias]')
    .description('Pull updates for a single extra repo, or all enabled extras when no alias is given')
    .action(async (alias: string | undefined) => {
      const meta = readMeta();
      const extras = meta.extraRepos || {};
      const targets = alias
        ? (extras[alias] ? [alias] : [])
        : Object.keys(extras).filter((a) => extras[a].enabled);

      if (alias && targets.length === 0) {
        console.log(chalk.red(`No extra repo registered as "${alias}".`));
        process.exitCode = 1;
        return;
      }
      if (targets.length === 0) {
        console.log(chalk.gray('No enabled extras to pull.'));
        return;
      }

      for (const a of targets) {
        const dir = getExtraRepoDir(a);
        if (!fs.existsSync(dir)) {
          console.log(chalk.yellow(`  ${a}: clone missing, skipping`));
          continue;
        }
        const spinner = ora(`Pulling ${a}...`).start();
        const result = await pullRepo(dir);
        if (result.success) {
          spinner.succeed(`${a} -> ${result.commit}`);
        } else {
          spinner.fail(`${a}: ${result.error}`);
        }
      }
    });
}

async function toggle(alias: string, enabled: boolean): Promise<void> {
  const meta = readMeta();
  const extras: Record<string, ExtraRepoConfig> = { ...(meta.extraRepos || {}) };
  if (!extras[alias]) {
    console.log(chalk.red(`No extra repo registered as "${alias}".`));
    process.exitCode = 1;
    return;
  }
  if (extras[alias].enabled === enabled) {
    console.log(chalk.gray(`"${alias}" is already ${enabled ? 'enabled' : 'disabled'}.`));
    return;
  }
  extras[alias] = { ...extras[alias], enabled };
  updateMeta({ extraRepos: extras });
  console.log(chalk.green(`${enabled ? 'Enabled' : 'Disabled'} "${alias}"`));
}
