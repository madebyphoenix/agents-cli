import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import {
  listProfiles,
  readProfile,
  writeProfile,
  deleteProfile,
  profileExists,
  profileFromPreset,
  getPresetForProfile,
} from '../lib/profiles.js';
import { getPreset, listPresets } from '../lib/profiles-presets.js';
import {
  hasKeychainToken,
  keychainItemName,
  setKeychainToken,
  deleteKeychainToken,
} from '../lib/profiles-keychain.js';
import { isInteractiveTerminal } from './utils.js';

async function promptForSecret(message: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A secret is required but the shell is not interactive. Pipe the key via stdin (--key-stdin).');
  }
  const { password } = await import('@inquirer/prompts');
  return await password({ message, mask: true });
}

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

async function ensureProviderToken(provider: string, signupUrl?: string, fromStdin?: boolean): Promise<void> {
  const item = keychainItemName(provider);
  if (hasKeychainToken(item)) {
    return;
  }
  let token: string;
  if (fromStdin) {
    token = readStdinSync();
    if (!token) {
      throw new Error('No key received on stdin.');
    }
  } else {
    const hint = signupUrl ? ` (get one at ${signupUrl})` : '';
    token = await promptForSecret(`Enter API key for ${provider}${hint}`);
  }
  setKeychainToken(item, token);
  console.log(chalk.green(`Stored in keychain: ${item}`));
}

function renderProfileRow(p: ReturnType<typeof listProfiles>[number]): string {
  const host = p.host.version ? `${p.host.agent}@${p.host.version}` : p.host.agent;
  const model = p.env.ANTHROPIC_MODEL || p.env.OPENAI_MODEL || p.env.GEMINI_MODEL || '-';
  const provider = p.provider || (p.auth?.keychainItem?.split('.')[1]) || '-';
  return `${chalk.cyan(p.name.padEnd(16))} ${host.padEnd(14)} ${provider.padEnd(12)} ${chalk.gray(model)}`;
}

export function registerProfilesCommands(program: Command): void {
  const cmd = program
    .command('profiles')
    .description('Named bundles of (host CLI, endpoint, model, auth) — run Kimi/DeepSeek/Qwen/etc through Claude Code without a proxy.');

  cmd
    .command('list')
    .alias('ls')
    .description('List configured profiles')
    .action(() => {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        console.log(chalk.gray('No profiles configured.'));
        console.log(chalk.gray('Try: agents profiles add kimi'));
        console.log(chalk.gray('     agents profiles presets'));
        return;
      }
      console.log(chalk.bold(`${'NAME'.padEnd(16)} ${'HOST'.padEnd(14)} ${'PROVIDER'.padEnd(12)} MODEL`));
      for (const p of profiles) {
        console.log(renderProfileRow(p));
      }
    });

  cmd
    .command('presets')
    .description('List built-in presets (OpenRouter + direct providers)')
    .action(() => {
      const presets = listPresets();
      console.log(chalk.bold(`${'NAME'.padEnd(14)} ${'PROVIDER'.padEnd(12)} DESCRIPTION`));
      for (const p of presets) {
        console.log(`${chalk.cyan(p.name.padEnd(14))} ${p.provider.padEnd(12)} ${chalk.gray(p.description)}`);
      }
    });

  cmd
    .command('view <name>')
    .alias('show')
    .description('Show a profile (env, host, auth source, preset link)')
    .action((name: string) => {
      try {
        const p = readProfile(name);
        console.log(chalk.bold(p.name));
        if (p.description) console.log(chalk.gray(p.description));
        console.log();
        console.log(chalk.bold('Host:'), p.host.agent + (p.host.version ? `@${p.host.version}` : ''));
        if (p.provider) console.log(chalk.bold('Provider:'), p.provider);
        if (p.preset) console.log(chalk.bold('Preset:'), p.preset);
        console.log();
        console.log(chalk.bold('Env:'));
        for (const [k, v] of Object.entries(p.env)) {
          console.log(`  ${k}=${v}`);
        }
        if (p.auth) {
          console.log();
          console.log(chalk.bold('Auth:'));
          const tokenStatus = hasKeychainToken(p.auth.keychainItem) ? chalk.green('stored') : chalk.red('missing');
          console.log(`  ${p.auth.envVar} <- keychain:${p.auth.keychainItem} (${tokenStatus})`);
        }
        const preset = getPresetForProfile(p);
        if (preset?.signupUrl) {
          console.log();
          console.log(chalk.gray(`Sign up: ${preset.signupUrl}`));
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('add <name>')
    .description('Add a profile. If <name> matches a built-in preset, the preset is applied. Prompts for API key (once per provider).')
    .option('--preset <preset>', 'Use a named preset (defaults to <name> if a preset by that name exists)')
    .option('--version <version>', 'Pin the host CLI version (e.g., 2.1.113)')
    .option('--key-stdin', 'Read API key from stdin instead of prompting (for scripts/CI)')
    .option('--force', 'Overwrite an existing profile with the same name')
    .action(async (name: string, opts: { preset?: string; version?: string; keyStdin?: boolean; force?: boolean }) => {
      try {
        if (profileExists(name) && !opts.force) {
          console.error(chalk.red(`Profile '${name}' already exists. Use --force to overwrite.`));
          process.exit(1);
        }

        const presetName = opts.preset || name;
        const preset = getPreset(presetName);
        if (!preset) {
          console.error(chalk.red(`No preset '${presetName}'.`));
          console.error(chalk.gray('Available presets: ' + listPresets().map((p) => p.name).join(', ')));
          console.error(chalk.gray('Or pass --preset <name> to pick explicitly.'));
          process.exit(1);
        }

        await ensureProviderToken(preset.provider, preset.signupUrl, opts.keyStdin);

        const profile = profileFromPreset(name, preset, opts.version);
        writeProfile(profile);
        console.log(chalk.green(`Profile '${name}' added.`));
        console.log(chalk.gray(`Try: agents run ${name} "hello"`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('remove <name>')
    .alias('rm')
    .description('Delete a profile (keychain token is kept — use `profiles logout <provider>` to remove)')
    .action((name: string) => {
      const existed = deleteProfile(name);
      if (!existed) {
        console.error(chalk.red(`Profile '${name}' not found.`));
        process.exit(1);
      }
      console.log(chalk.green(`Profile '${name}' removed.`));
    });

  cmd
    .command('login <provider>')
    .description('Store or rotate the API key for a provider (e.g., openrouter). Shared across profiles using that provider.')
    .option('--key-stdin', 'Read API key from stdin')
    .action(async (provider: string, opts: { keyStdin?: boolean }) => {
      try {
        const item = keychainItemName(provider);
        let token: string;
        if (opts.keyStdin) {
          token = readStdinSync();
          if (!token) throw new Error('No key received on stdin.');
        } else {
          token = await promptForSecret(`Enter API key for ${provider}`);
        }
        setKeychainToken(item, token);
        console.log(chalk.green(`Stored in keychain: ${item}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  cmd
    .command('logout <provider>')
    .description('Remove a stored provider key from keychain')
    .action((provider: string) => {
      const item = keychainItemName(provider);
      const existed = deleteKeychainToken(item);
      if (!existed) {
        console.error(chalk.yellow(`No keychain item '${item}' to remove.`));
        process.exit(1);
      }
      console.log(chalk.green(`Removed keychain item: ${item}`));
    });
}
