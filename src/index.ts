#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { select } from '@inquirer/prompts';

// Force exit on Ctrl+C when no interactive prompt is handling it.
process.on('SIGINT', () => process.exit(130));

// Ignore SIGPIPE — prevents exit code 13 crashes in piped environments
// (e.g. `agents sessions list | head`, or when stdout is captured by another process).
process.on('SIGPIPE', () => {});

// Get version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;

// Import command registrations
import { registerPullCommand } from './commands/pull.js';
import { registerPushCommand } from './commands/push.js';
import { registerForkCommand } from './commands/fork.js';
import { registerStatusCommand } from './commands/status.js';
import { registerViewCommand } from './commands/view.js';
import { registerCommandsCommands } from './commands/commands.js';
import { registerHooksCommands } from './commands/hooks.js';
import { registerSkillsCommands } from './commands/skills.js';
import { registerRulesCommands } from './commands/rules.js';
import { registerPermissionsCommands } from './commands/permissions.js';
import { registerMcpCommands } from './commands/mcp.js';
import { registerVersionsCommands } from './commands/versions.js';
import { registerPackagesCommands } from './commands/packages.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerRoutinesCommands } from './commands/routines.js';
import { registerExecCommand } from './commands/exec.js';
import { registerSubagentsCommands } from './commands/subagents.js';
import { registerPluginsCommands } from './commands/plugins.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerSessionsCommands } from './commands/sessions.js';
import { applyGlobalHelpConventions } from './lib/help.js';
import { isPromptCancelled } from './commands/utils.js';

const program = new Command();

program
  .name('agents')
  .description('Environment manager for AI agents')
  .version(VERSION)
  .helpOption('-h, --help', 'Show help')
  .addHelpCommand(false);

// Custom help for the main program only
const originalHelpInformation = program.helpInformation.bind(program);
program.helpInformation = function () {
  if (this.name() === 'agents' && !this.parent) {
    return `Usage: agents [command] [options]

Install, configure, and sync AI coding agents from one place.
Works with Claude, Codex, Gemini, Cursor, OpenCode, and OpenClaw.

Quick start:
  agents add claude@latest        Install an agent CLI
  agents use claude@2.1.79        Switch to a specific version
  agents view                     See what's installed
  agents pull gh:you/.agents      Set up all agents from a shared config repo

Agent versions:
  add <agent>[@version]           Install an agent CLI (e.g. agents add codex)
  remove <agent>[@version]        Uninstall a version
  use <agent>@<version>           Set the default version
  view [agent[@version]]          List versions, or inspect one in detail

Agent configuration (synced across versions):
  rules                           Instructions given to agents (CLAUDE.md, etc.)
  commands                        Slash commands (/commit, /test, etc.)
  skills                          Knowledge packs (SKILL.md + supporting files)
  mcp                             MCP servers (stdio or HTTP)
  permissions                     Allow/deny rules for tool calls
  hooks                           Shell scripts that run on agent events
  subagents                       Named sub-agent definitions
  plugins                         Bundles of skills, hooks, and scripts

Packages:
  search <query>                  Find MCP servers and skills in registries
  install <pkg>                   Install from registry (mcp:name, skill:user/repo)

Sessions:
  sessions                        List and view past sessions across all agents

Automation:
  routines                        Schedule agents to run on a timer
  daemon                          Start/stop the routines scheduler
  exec <agent> <prompt>           Run an agent non-interactively

Config sync (portable setup via git):
  pull [gh:user/repo]             Clone or pull a shared .agents config repo
  push                            Commit and push your local config
  fork                            Fork the default config repo to your GitHub

Options:
  -V, --version                   Show version number
  -h, --help                      Show help

Config lives in ~/.agents/. Run 'agents <command> --help' for details.
`;
  }
  return originalHelpInformation();
};

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

async function showWhatsNew(fromVersion: string, toVersion: string): Promise<void> {
  try {
    const response = await fetch(`https://unpkg.com/@swarmify/agents-cli@${toVersion}/CHANGELOG.md`);
    if (!response.ok) return;

    const changelog = await response.text();
    const lines = changelog.split('\n');

    const relevantChanges: string[] = [];
    let inRelevantSection = false;
    let currentVersion = '';

    for (const line of lines) {
      const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/);
      if (versionMatch) {
        currentVersion = versionMatch[1];
        const isNewer = currentVersion !== fromVersion &&
          compareVersions(currentVersion, fromVersion) > 0;
        inRelevantSection = isNewer;
        if (inRelevantSection) {
          relevantChanges.push('');
          relevantChanges.push(chalk.bold(`v${currentVersion}`));
        }
        continue;
      }

      if (inRelevantSection && line.trim()) {
        if (line.startsWith('**') && line.endsWith('**')) {
          relevantChanges.push(chalk.cyan(line.replace(/\*\*/g, '')));
        } else if (line.startsWith('- ')) {
          relevantChanges.push(chalk.gray(`  ${line}`));
        }
      }
    }

    if (relevantChanges.length > 0) {
      console.log(chalk.bold("\nWhat's new:\n"));
      for (const line of relevantChanges) {
        console.log(line);
      }
      console.log();
    }
  } catch {
    // Silently ignore changelog fetch errors
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const UPDATE_CHECK_FILE = path.join(os.homedir(), '.agents', '.update-check');

function shouldCheckForUpdates(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf-8'));
    return Date.now() - data.lastCheck > UPDATE_CHECK_INTERVAL_MS;
  } catch {
    return true; // No cache file or unreadable — check now
  }
}

function saveUpdateCheck(latestVersion: string): void {
  try {
    const dir = path.dirname(UPDATE_CHECK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ lastCheck: Date.now(), latestVersion }));
  } catch {
    // Best-effort
  }
}

async function checkForUpdates(): Promise<void> {
  if (!shouldCheckForUpdates()) return;

  try {
    const response = await fetch('https://registry.npmjs.org/@swarmify/agents-cli/latest', {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return;

    const data = (await response.json()) as { version: string };
    const latestVersion = data.version;
    saveUpdateCheck(latestVersion);

    if (latestVersion !== VERSION && compareVersions(latestVersion, VERSION) > 0) {
      // Non-interactive environment — just print the notice
      if (!process.stdout.isTTY) {
        console.error(chalk.yellow(`Update available: ${VERSION} -> ${latestVersion}. Run: npm install -g @swarmify/agents-cli@latest`));
        return;
      }

      const answer = await select({
        message: `Update available: ${VERSION} -> ${latestVersion}`,
        choices: [
          { value: 'now', name: 'Upgrade now' },
          { value: 'later', name: 'Later' },
        ],
      });

      if (answer === 'now') {
        const { exec, spawnSync } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        const spinner = ora('Upgrading...').start();
        try {
          await execAsync('npm install -g @swarmify/agents-cli@latest');
          spinner.succeed(`Upgraded to ${latestVersion}`);
          await showWhatsNew(VERSION, latestVersion);
          console.log();
          // Re-exec with new version and exit
          const result = spawnSync('agents', process.argv.slice(2), {
            stdio: 'inherit',
            shell: true,
          });
          process.exit(result.status ?? 0);
        } catch {
          spinner.fail('Upgrade failed');
          console.log(chalk.gray('Run manually: npm install -g @swarmify/agents-cli@latest'));
        }
        console.log();
      }
    }
  } catch (err) {
    if (isPromptCancelled(err)) {
      return;
    }
    // Silently ignore network errors
  }
}


// Register all commands
registerViewCommand(program);
registerStatusCommand(program);
registerCommandsCommands(program);
registerHooksCommands(program);
registerSkillsCommands(program);
registerRulesCommands(program);

// Deprecated 'memory' command - hard error, force users to use 'rules'
program
  .command('memory', { hidden: true })
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => {
    console.error(chalk.red('"agents memory" has been renamed to "agents rules".'));
    console.error(chalk.gray('Run "agents rules --help" for usage.\n'));
    process.exit(1);
  });
registerPermissionsCommands(program);

// Deprecated 'perms' alias for 'permissions'
program
  .command('perms', { hidden: true })
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (opts, cmd) => {
    console.log(chalk.yellow('Deprecated: Use "agents permissions" instead of "agents perms"\n'));
    // Re-parse with 'permissions' command
    const args = process.argv.slice(2);
    args[0] = 'permissions';
    await program.parseAsync(['node', 'agents', ...args]);
  });

registerMcpCommands(program);
registerSubagentsCommands(program);
registerPluginsCommands(program);
registerVersionsCommands(program);
registerPackagesCommands(program);
registerDaemonCommands(program);
registerRoutinesCommands(program);
registerExecCommand(program);
registerSessionsCommands(program);
registerSyncCommand(program);

// Deprecated 'jobs' and 'cron' aliases for 'routines'
for (const alias of ['jobs', 'cron']) {
  program
    .command(alias, { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      console.log(chalk.yellow(`Deprecated: Use "agents routines" instead of "agents ${alias}"\n`));
      const args = process.argv.slice(2);
      args[0] = 'routines';
      await program.parseAsync(['node', 'agents', ...args]);
    });
}

program
    .command('upgrade')
    .description('Upgrade agents-cli to the latest version')
    .action(async () => {
      const spinner = ora('Checking for updates...').start();
      try {
        const response = await fetch('https://registry.npmjs.org/@swarmify/agents-cli/latest', {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          spinner.fail('Could not reach npm registry');
          process.exit(1);
        }

        const data = (await response.json()) as { version: string };
        const latestVersion = data.version;

        if (latestVersion === VERSION) {
          spinner.succeed(`Already on latest version (${VERSION})`);
          return;
        }

        if (compareVersions(latestVersion, VERSION) <= 0) {
          spinner.succeed(`Already ahead of latest (${VERSION} >= ${latestVersion})`);
          return;
        }

        spinner.text = `Upgrading ${VERSION} -> ${latestVersion}...`;
        const { exec: execCb } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(execCb);
        await execAsync('npm install -g @swarmify/agents-cli@latest');
        spinner.succeed(`Upgraded to ${latestVersion}`);
        await showWhatsNew(VERSION, latestVersion);
      } catch (err) {
        spinner.fail('Upgrade failed');
        console.log(chalk.gray('Run manually: npm install -g @swarmify/agents-cli@latest'));
      }
    });

registerPullCommand(program);
registerPushCommand(program);
registerForkCommand(program);

applyGlobalHelpConventions(program);

/**
 * Calculate Levenshtein edit distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Auto-correct typos with edit distance 1
program.on('command:*', (operands) => {
  const unknown = operands[0];
  const allCommands = program.commands.map((c) => c.name());

  let closest: string | null = null;
  let minDist = Infinity;
  for (const cmd of allCommands) {
    const dist = levenshtein(unknown, cmd);
    if (dist < minDist) {
      minDist = dist;
      closest = cmd;
    }
  }

  if (minDist === 1 && closest) {
    const args = process.argv.slice(2);
    args[0] = closest;
    program.parse(['node', 'agents', ...args]);
    return;
  }

  console.error(`error: unknown command '${unknown}'`);
  if (closest && minDist <= 3) {
    console.error(`(Did you mean ${closest}?)`);
  }
  process.exit(1);
});

// Run update check on EVERY invocation before parsing
await checkForUpdates();

await program.parseAsync();
