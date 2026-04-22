/**
 * Secrets bundle management commands.
 *
 * Registers the `agents secrets` command tree for creating, viewing,
 * and managing named bundles of environment variables backed by macOS
 * Keychain. Bundles are injected at run time via `agents run --secrets`.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import {
  bundleExists,
  deleteBundle,
  describeBundle,
  keychainItemsForBundle,
  keychainRef,
  listBundles,
  parseDotenv,
  readBundle,
  validateBundleName,
  validateEnvKey,
  writeBundle,
  type SecretsBundle,
} from '../lib/secrets-bundles.js';
import {
  deleteKeychainToken,
  getKeychainToken,
  hasKeychainToken,
  secretsKeychainItem,
  setKeychainToken,
} from '../lib/secrets.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

/** Prompt the user for a secret value with masked input. Requires an interactive TTY. */
async function promptForSecret(message: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A secret is required but the shell is not interactive. Pass --value, --value-stdin, or run from a TTY.');
  }
  const { password } = await import('@inquirer/prompts');
  return await password({ message, mask: true });
}

/** Read all available data from stdin synchronously, trimmed. */
function readStdinSync(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
    } catch {
      break;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

/** Format a single bundle as a table row for the `secrets list` output. */
function renderBundleRow(b: SecretsBundle): string {
  const entries = describeBundle(b);
  const keys = entries.length;
  const sensitive = entries.filter((e) => e.kind === 'keychain').length;
  return `${chalk.cyan(b.name.padEnd(20))} ${String(keys).padEnd(6)} ${chalk.yellow(String(sensitive).padEnd(10))} ${chalk.gray(b.description || '')}`;
}

/** Colorize a variable source kind (literal, keychain, env, file, exec). */
function kindLabel(kind: string): string {
  switch (kind) {
    case 'literal': return chalk.gray('literal');
    case 'keychain': return chalk.green('keychain');
    case 'env': return chalk.blue('env');
    case 'file': return chalk.magenta('file');
    case 'exec': return chalk.red('exec');
    default: return kind;
  }
}

/** Mask a value with asterisks unless reveal is true. */
function redact(value: string, reveal: boolean): string {
  if (reveal) return value;
  if (!value) return '';
  return '*'.repeat(Math.min(value.length, 8));
}

/** Register the `agents secrets` command tree. */
export function registerSecretsCommands(program: Command): void {
  const cmd = program
    .command('secrets')
    .description('Named bundles of env variables backed by macOS Keychain. Inject into agents via `agents run --secrets <name>`.');

  cmd
    .command('list')
    .alias('ls')
    .description('List configured secrets bundles')
    .action(() => {
      const bundles = listBundles();
      if (bundles.length === 0) {
        console.log(chalk.gray('No secrets bundles configured.'));
        console.log(chalk.gray('Try: agents secrets add <name>'));
        return;
      }
      console.log(chalk.bold(`${'NAME'.padEnd(20)} ${'KEYS'.padEnd(6)} ${'SENSITIVE'.padEnd(10)} DESCRIPTION`));
      for (const b of bundles) {
        console.log(renderBundleRow(b));
      }
    });

  cmd
    .command('view <name>')
    .alias('show')
    .description('Show a bundle. Keychain values are masked by default — pass --reveal to see them.')
    .option('--reveal', 'Print keychain-backed values in the clear (TTY only unless --plaintext)')
    .option('--plaintext', 'Allow --reveal in non-interactive shells (use with care)')
    .action((name: string, opts: { reveal?: boolean; plaintext?: boolean }) => {
      try {
        const bundle = readBundle(name);
        const entries = describeBundle(bundle);
        console.log(chalk.bold(bundle.name));
        if (bundle.description) console.log(chalk.gray(bundle.description));
        if (bundle.allow_exec) console.log(chalk.yellow('allow_exec: true'));
        console.log();
        if (entries.length === 0) {
          console.log(chalk.gray('(no keys)'));
          return;
        }
        const reveal = Boolean(opts.reveal);
        if (reveal && !isInteractiveTerminal() && !opts.plaintext) {
          console.error(chalk.red('--reveal in a non-TTY requires --plaintext.'));
          process.exit(1);
        }
        for (const e of entries) {
          if (e.kind === 'keychain') {
            const item = secretsKeychainItem(bundle.name, e.detail);
            const stored = hasKeychainToken(item);
            const marker = stored ? chalk.green('stored') : chalk.red('missing');
            let valueCol = `[keychain:${e.detail}] ${marker}`;
            if (reveal && stored) {
              try {
                valueCol = redact(getKeychainToken(item), true);
              } catch {
                // fall through to masked
              }
            }
            console.log(`  ${chalk.cyan(e.key.padEnd(28))} ${kindLabel(e.kind).padEnd(18)} ${valueCol}`);
          } else if (e.kind === 'literal') {
            const raw = bundle.vars[e.key];
            const literalValue =
              typeof raw === 'string'
                ? raw
                : (raw && typeof raw === 'object' && 'value' in raw ? (raw as any).value : '');
            console.log(`  ${chalk.cyan(e.key.padEnd(28))} ${kindLabel(e.kind).padEnd(18)} ${literalValue}`);
          } else {
            console.log(`  ${chalk.cyan(e.key.padEnd(28))} ${kindLabel(e.kind).padEnd(18)} ${e.detail}`);
          }
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('add <name>')
    .description('Create an empty bundle')
    .option('--description <text>', 'Free-form description')
    .option('--allow-exec', 'Allow exec: refs in this bundle (off by default)')
    .option('--force', 'Overwrite an existing bundle')
    .action((name: string, opts: { description?: string; allowExec?: boolean; force?: boolean }) => {
      try {
        validateBundleName(name);
        if (bundleExists(name) && !opts.force) {
          console.error(chalk.red(`Bundle '${name}' already exists. Use --force to overwrite.`));
          process.exit(1);
        }
        const bundle: SecretsBundle = {
          name,
          description: opts.description,
          allow_exec: opts.allowExec,
          vars: {},
        };
        writeBundle(bundle);
        console.log(chalk.green(`Bundle '${name}' created.`));
        console.log(chalk.gray(`Try: agents secrets set ${name} MY_KEY`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('set <bundle> <key>')
    .description('Set a variable. Defaults to keychain-backed; pass --value for literal, --env/--file/--exec for refs.')
    .option('--value <v>', 'Store as a plaintext literal in the YAML (non-sensitive values only)')
    .option('--value-stdin', 'Read the value from stdin (stored in keychain unless combined with --value)')
    .option('--env <VAR>', 'Store as an env: ref that reads from the parent process.env at run time')
    .option('--file <path>', 'Store as a file: ref that reads from a file at run time')
    .option('--exec <cmd>', 'Store as an exec: ref that runs a command at run time (requires allow_exec)')
    .action(async (bundleName: string, key: string, opts: {
      value?: string;
      valueStdin?: boolean;
      env?: string;
      file?: string;
      exec?: string;
    }) => {
      try {
        validateEnvKey(key);
        const bundle = readBundle(bundleName);
        const sources = [opts.value !== undefined, Boolean(opts.env), Boolean(opts.file), Boolean(opts.exec)].filter(Boolean).length;
        if (sources > 1) {
          throw new Error('Pick one of: --value, --env, --file, --exec.');
        }
        if (opts.env) {
          bundle.vars[key] = `env:${opts.env}`;
          writeBundle(bundle);
          console.log(chalk.green(`${bundleName}.${key} -> env:${opts.env}`));
          return;
        }
        if (opts.file) {
          bundle.vars[key] = `file:${opts.file}`;
          writeBundle(bundle);
          console.log(chalk.green(`${bundleName}.${key} -> file:${opts.file}`));
          return;
        }
        if (opts.exec) {
          if (!bundle.allow_exec) {
            throw new Error(`Bundle '${bundleName}' does not allow exec refs. Re-create with --allow-exec.`);
          }
          bundle.vars[key] = `exec:${opts.exec}`;
          writeBundle(bundle);
          console.log(chalk.green(`${bundleName}.${key} -> exec:${opts.exec}`));
          return;
        }
        if (opts.value !== undefined) {
          bundle.vars[key] = { value: opts.value };
          writeBundle(bundle);
          console.log(chalk.green(`${bundleName}.${key} = <literal>`));
          return;
        }
        // Default path: keychain-backed.
        let secretValue: string;
        if (opts.valueStdin) {
          secretValue = readStdinSync();
          if (!secretValue) throw new Error('No value received on stdin.');
        } else {
          secretValue = await promptForSecret(`Enter value for ${bundleName}.${key}`);
        }
        const item = secretsKeychainItem(bundleName, key);
        setKeychainToken(item, secretValue);
        bundle.vars[key] = keychainRef(key);
        writeBundle(bundle);
        console.log(chalk.green(`${bundleName}.${key} stored in keychain (${item}).`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('unset <bundle> <key>')
    .description('Remove a key from the bundle. Purges the keychain item if the ref was keychain:. Use --keep-secret to retain it.')
    .option('--keep-secret', 'Leave the keychain item in place after removing the YAML ref')
    .action((bundleName: string, key: string, opts: { keepSecret?: boolean }) => {
      try {
        const bundle = readBundle(bundleName);
        if (!(key in bundle.vars)) {
          console.error(chalk.red(`Key '${key}' not found in bundle '${bundleName}'.`));
          process.exit(1);
        }
        const raw = bundle.vars[key];
        delete bundle.vars[key];
        writeBundle(bundle);
        if (!opts.keepSecret && typeof raw === 'string' && raw.startsWith('keychain:')) {
          const item = secretsKeychainItem(bundleName, raw.slice('keychain:'.length));
          const removed = deleteKeychainToken(item);
          if (removed) {
            console.log(chalk.green(`Removed ${bundleName}.${key} and purged keychain item.`));
            return;
          }
        }
        console.log(chalk.green(`Removed ${bundleName}.${key}.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('rm <name>')
    .alias('remove')
    .description('Delete a bundle and purge all its keychain items (use --keep-secrets to retain them).')
    .option('--keep-secrets', 'Leave keychain items in place after deleting the bundle file')
    .action((name: string, opts: { keepSecrets?: boolean }) => {
      try {
        const bundle = readBundle(name);
        if (!opts.keepSecrets) {
          for (const { item } of keychainItemsForBundle(bundle)) {
            deleteKeychainToken(item);
          }
        }
        const existed = deleteBundle(name);
        if (!existed) {
          console.error(chalk.red(`Bundle '${name}' not found.`));
          process.exit(1);
        }
        console.log(chalk.green(`Bundle '${name}' removed.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('import <bundle>')
    .description('Import keys from a .env file into a bundle. By default every key is stored in keychain.')
    .requiredOption('--from <path>', 'Path to a .env file')
    .option('--all-plaintext', 'Store every imported value as a YAML literal (skip keychain prompts)')
    .option('--force', 'Overwrite an existing key in the bundle')
    .action((bundleName: string, opts: { from: string; allPlaintext?: boolean; force?: boolean }) => {
      try {
        const bundle = readBundle(bundleName);
        const raw = fs.readFileSync(opts.from, 'utf-8');
        const pairs = parseDotenv(raw);
        let added = 0;
        let skipped = 0;
        for (const [key, value] of Object.entries(pairs)) {
          if (!opts.force && key in bundle.vars) {
            skipped++;
            continue;
          }
          if (opts.allPlaintext) {
            bundle.vars[key] = { value };
          } else {
            const item = secretsKeychainItem(bundleName, key);
            setKeychainToken(item, value);
            bundle.vars[key] = keychainRef(key);
          }
          added++;
        }
        writeBundle(bundle);
        console.log(chalk.green(`Imported ${added} key(s)${skipped ? `, skipped ${skipped} (already set, pass --force)` : ''}.`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('export <bundle>')
    .description('Resolve a bundle and print KEY=VALUE lines (for `eval "$(agents secrets export prod)"`). Refuses on a TTY unless --plaintext.')
    .option('--plaintext', 'Acknowledge that the resolved values will be printed in the clear')
    .action(async (bundleName: string, opts: { plaintext?: boolean }) => {
      try {
        const { resolveBundleEnv } = await import('../lib/secrets-bundles.js');
        const bundle = readBundle(bundleName);
        if (isInteractiveTerminal() && !opts.plaintext) {
          console.error(chalk.red('export to a TTY requires --plaintext (prevents shoulder-surfing).'));
          process.exit(1);
        }
        const env = resolveBundleEnv(bundle);
        for (const [k, v] of Object.entries(env)) {
          const escaped = v.replace(/'/g, `'\\''`);
          process.stdout.write(`export ${k}='${escaped}'\n`);
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
