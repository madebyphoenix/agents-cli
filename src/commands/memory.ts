import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { select, checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  ALL_AGENT_IDS,
  resolveAgentName,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverInstructionsFromRepo,
  discoverMemoryFilesFromRepo,
  installInstructionsCentrally,
  uninstallInstructions,
  listInstalledInstructionsWithScope,
  promoteInstructionsToUser,
  instructionsExists,
  getInstructionsContent,
  listCentralMemory,
} from '../lib/memory.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import { isPromptCancelled, formatPath } from './utils.js';

export function registerMemoryCommands(program: Command): void {
  const memoryCmd = program
    .command('memory')
    .description('Manage agent memory files');

  memoryCmd
    .command('list [agent]')
    .description('List installed memory files')
    .option('-a, --agent <agent>', 'Filter by agent')
    .action(async (agentArg, options) => {
      const cwd = process.cwd();

      // Resolve agent filter - positional arg takes precedence over -a flag
      const agentInput = agentArg || options.agent;
      let agents: AgentId[];
      if (agentInput) {
        const resolved = resolveAgentName(agentInput);
        if (!resolved) {
          console.log(chalk.red(`Unknown agent '${agentInput}'. Use ${ALL_AGENT_IDS.join(', ')}`));
          process.exit(1);
        }
        agents = [resolved];
      } else {
        agents = ALL_AGENT_IDS;
      }

      console.log(chalk.bold('Installed Memory\n'));

      for (const agentId of agents) {
        const agent = AGENTS[agentId];
        const defaultVer = getGlobalDefault(agentId);
        const versionStr = defaultVer ? chalk.gray(` (${defaultVer})`) : '';

        const installed = listInstalledInstructionsWithScope(agentId, cwd);
        const userInstr = installed.find((i) => i.scope === 'user');
        const projectInstr = installed.find((i) => i.scope === 'project');

        const hasUser = userInstr?.exists;
        const hasProject = projectInstr?.exists;

        if (!hasUser && !hasProject) {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}:`);
          console.log(`    ${chalk.gray('User:')} ${chalk.gray('none')}`);
          console.log(`    ${chalk.gray('Project:')} ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}:`);

          if (hasUser) {
            console.log(`    ${chalk.gray('User:')}`);
            console.log(`      ${chalk.cyan(agent.instructionsFile.padEnd(20))} ${chalk.gray(formatPath(userInstr.path, cwd))}`);
          } else {
            console.log(`    ${chalk.gray('User:')} ${chalk.gray('none')}`);
          }

          if (hasProject) {
            console.log(`    ${chalk.gray('Project:')}`);
            console.log(`      ${chalk.yellow(agent.instructionsFile.padEnd(20))} ${chalk.gray(formatPath(projectInstr.path, cwd))}`);
          } else {
            console.log(`    ${chalk.gray('Project:')} ${chalk.gray('none')}`);
          }
        }
        console.log();
      }
    });

  memoryCmd
    .command('add [source]')
    .description('Install memory files from a repo or local path')
    .option('-a, --agents <list>', 'Comma-separated agents to install to')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(async (source: string | undefined, options) => {
      try {
        let memoryNames: string[];

        if (!source) {
          // Interactive mode: pick from central storage
          const centralMemory = listCentralMemory();
          if (centralMemory.length === 0) {
            console.log(chalk.yellow('No memory files in ~/.agents/memory/'));
            console.log(chalk.gray('\nTo add memory files from a repo:'));
            console.log(chalk.cyan('  agents memory add gh:user/repo'));
            return;
          }

          const choices = centralMemory.map((name) => ({
            value: name,
            name,
          }));

          const selected = await checkbox({
            message: 'Select memory files to install',
            choices: [
              { value: '__all__', name: chalk.bold('Select All') },
              ...choices,
            ],
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No memory files selected.'));
            return;
          }

          memoryNames = selected.includes('__all__')
            ? centralMemory
            : selected.filter((s) => s !== '__all__');
        } else {
          // Source provided: fetch from repo or local path
          const spinner = ora('Fetching memory files...').start();

          const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                            source.startsWith('ssh:') || source.startsWith('https://') ||
                            source.startsWith('http://');

          let localPath: string;
          if (isGitRepo) {
            const result = await cloneRepo(source);
            localPath = result.localPath;
            spinner.succeed('Repository cloned');
          } else {
            localPath = source.startsWith('~')
              ? path.join(os.homedir(), source.slice(1))
              : path.resolve(source);

            if (!fs.existsSync(localPath)) {
              spinner.fail(`Path not found: ${localPath}`);
              return;
            }
            spinner.succeed('Using local path');
          }

          const agentInstructions = discoverInstructionsFromRepo(localPath);
          const memoryFiles = discoverMemoryFilesFromRepo(localPath);

          const totalFiles = agentInstructions.length + memoryFiles.length;
          console.log(chalk.bold(`\nFound ${totalFiles} memory file(s):`));

          if (totalFiles === 0) {
            console.log(chalk.yellow('No memory files found'));
            return;
          }

          for (const instr of agentInstructions) {
            console.log(`  ${chalk.cyan(AGENTS[instr.agentId].instructionsFile)} (${AGENTS[instr.agentId].name})`);
          }
          for (const file of memoryFiles) {
            console.log(`  ${chalk.cyan(file)} (shared)`);
          }

          // Install to central storage first
          const installSpinner = ora('Installing memory files to central storage...').start();
          const centralResult = installInstructionsCentrally(localPath);

          if (centralResult.errors.length > 0) {
            installSpinner.stop();
            for (const error of centralResult.errors) {
              console.log(chalk.yellow(`\n  Warning: ${error}`));
            }
            installSpinner.start();
          }

          installSpinner.succeed(`Installed ${centralResult.installed.length} memory files to ~/.agents/memory/`);
          memoryNames = centralResult.installed.map((p) => path.basename(p));
        }

        // Get agent and version selection
        let selectedAgents: AgentId[];
        let versionSelections: Map<AgentId, string[]>;

        if (options.agents) {
          selectedAgents = options.agents.split(',') as AgentId[];
          versionSelections = new Map();
          for (const agentId of selectedAgents) {
            const versions = listInstalledVersions(agentId);
            if (versions.length > 0) {
              const defaultVer = getGlobalDefault(agentId);
              versionSelections.set(agentId, defaultVer ? [defaultVer] : [versions[versions.length - 1]]);
            }
          }
        } else {
          const result = await promptAgentVersionSelection(ALL_AGENT_IDS, { skipPrompts: options.yes });
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        }

        if (selectedAgents.length === 0) {
          console.log(chalk.yellow('\nNo agents selected.'));
          return;
        }

        // Sync to selected versions
        const syncSpinner = ora('Syncing to agent versions...').start();
        let synced = 0;

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'memory', memoryNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nMemory files installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add memory files'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  memoryCmd
    .command('view [agent]')
    .alias('show')
    .description('Show memory content for an agent')
    .option('-s, --scope <scope>', 'Scope: user or project', 'user')
    .action(async (agentArg?: string, options?: { scope?: string }) => {
      const cwd = process.cwd();
      let agentId: AgentId | undefined;

      if (agentArg) {
        agentId = resolveAgentName(agentArg) || undefined;
        if (!agentId) {
          console.log(chalk.red(`Unknown agent: ${agentArg}`));
          process.exit(1);
        }
      } else {
        const choices = ALL_AGENT_IDS.filter((id) => instructionsExists(id, 'user', cwd) || instructionsExists(id, 'project', cwd));
        if (choices.length === 0) {
          console.log(chalk.yellow('No memory files found.'));
          return;
        }
        agentId = await select({
          message: 'Select agent:',
          choices: choices.map((id) => ({ name: AGENTS[id].name, value: id })),
        });
      }

      const scope = (options?.scope || 'user') as 'user' | 'project';
      const content = getInstructionsContent(agentId, scope, cwd);

      if (!content) {
        console.log(chalk.yellow(`No ${scope} memory found for ${AGENTS[agentId].name}`));
        return;
      }

      console.log(chalk.bold(`\n${AGENTS[agentId].name} Memory (${scope}):\n`));
      console.log(content);
    });

  memoryCmd
    .command('push <agent>')
    .description('Promote project memory to user scope')
    .action((agentArg: string) => {
      const cwd = process.cwd();
      const agentId = resolveAgentName(agentArg);

      if (!agentId) {
        console.log(chalk.red(`Unknown agent: ${agentArg}`));
        process.exit(1);
      }

      const result = promoteInstructionsToUser(agentId, cwd);
      if (result.success) {
        console.log(chalk.green(`Pushed ${AGENTS[agentId].instructionsFile} to user scope`));
      } else {
        console.log(chalk.red(result.error || 'Failed to push memory'));
      }
    });

  memoryCmd
    .command('remove <agent>')
    .description('Remove user memory for an agent')
    .action((agentArg: string) => {
      const agentId = resolveAgentName(agentArg);

      if (!agentId) {
        console.log(chalk.red(`Unknown agent: ${agentArg}`));
        process.exit(1);
      }

      const result = uninstallInstructions(agentId);
      if (result) {
        console.log(chalk.green(`Removed ${AGENTS[agentId].instructionsFile}`));
      } else {
        console.log(chalk.yellow(`No memory file found for ${AGENTS[agentId].name}`));
      }
    });
}
