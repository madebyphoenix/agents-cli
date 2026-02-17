#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { select } from '@inquirer/prompts';

// Force exit on Ctrl+C when no interactive prompt is handling it.
process.on('SIGINT', () => process.exit(130));

// Get version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;

// Import command registrations
import { registerPullCommand } from './commands/pull.js';
import { registerPushCommand } from './commands/push.js';
import { registerRepoCommands } from './commands/repo.js';
import { registerStatusCommand } from './commands/status.js';
import { registerCommandsCommands } from './commands/commands.js';
import { registerHooksCommands } from './commands/hooks.js';
import { registerSkillsCommands } from './commands/skills.js';
import { registerMemoryCommands } from './commands/memory.js';
import { registerPermissionsCommands } from './commands/permissions.js';
import { registerMcpCommands } from './commands/mcp.js';
import { registerVersionsCommands } from './commands/versions.js';
import { registerPackagesCommands } from './commands/packages.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerJobsCommands } from './commands/jobs.js';
import { applyGlobalHelpConventions } from './lib/help.js';
import { isPromptCancelled } from './commands/utils.js';

const program = new Command();

program
  .name('agents')
  .description('Manage AI coding agents - configs, CLIs, and automation')
  .version(VERSION)
  .helpOption('-h, --help', 'Show help')
  .addHelpCommand(false);

// Custom help for the main program only
const originalHelpInformation = program.helpInformation.bind(program);
program.helpInformation = function () {
  if (this.name() === 'agents' && !this.parent) {
    return `Usage: agents [options] [command]

Manage AI coding agents - configs, CLIs, and automation

Agents
  add <agent>[@version]           Install agent CLI
  remove <agent>[@version]        Remove agent CLI
  use <agent>@<version>           Set default version
  list                            List installed versions

Resources
  memory                          Manage AGENTS.md, SOUL.md, etc.
  commands                        Manage slash commands
  mcp                             Manage MCP servers
  skills                          Manage skills (SKILL.md + rules/)
  hooks                           Manage agent hooks
  permissions                     Manage agent permissions

Packages
  search <query>                  Search MCP servers
  install <pkg>                   Install mcp:name or skill:user/repo

Automation
  jobs                            Manage scheduled jobs
  daemon                          Manage the scheduler daemon

Env
  status                          Show installed agents and sync status
  pull                            Sync from .agents repo
  push                            Push config to your .agents repo

Options:
  -V, --version                   Show version number
  -h, --help                      Show help

Run 'agents <command> --help' for details.
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

async function checkForUpdates(): Promise<void> {
  try {
    const response = await fetch('https://registry.npmjs.org/@swarmify/agents-cli/latest', {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return;

    const data = (await response.json()) as { version: string };
    const latestVersion = data.version;

    if (latestVersion !== VERSION && compareVersions(latestVersion, VERSION) > 0) {
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

// Run update check before command runs
program.hook('preAction', async () => {
  const args = process.argv.slice(2);
  const skipCommands = ['--version', '-V', '--help', '-h'];
  if (args.length === 0 || skipCommands.includes(args[0])) {
    return;
  }
  await checkForUpdates();
});

// Register all commands
registerStatusCommand(program);
registerCommandsCommands(program);
registerHooksCommands(program);
registerSkillsCommands(program);
registerMemoryCommands(program);
registerPermissionsCommands(program);
registerMcpCommands(program);
registerVersionsCommands(program);
registerPackagesCommands(program);
registerDaemonCommands(program);
registerJobsCommands(program);
registerPullCommand(program);
registerPushCommand(program);
registerRepoCommands(program);

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

program.parse();
