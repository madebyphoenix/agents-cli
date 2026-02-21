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
  formatAgentError,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverInstructionsFromRepo,
  discoverMemoryFilesFromRepo,
  installInstructionsCentrally,
  uninstallInstructions,
  listInstalledInstructionsWithScope,
  instructionsExists,
  getInstructionsContent,
  listCentralMemory,
} from '../lib/memory.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  getVersionHomePath,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import { isPromptCancelled, formatPath } from './utils.js';

export function registerMemoryCommands(program: Command): void {
  const memoryCmd = program
    .command('memory')
    .description('Manage agent memory files');

  memoryCmd
    .command('list [agent]')
    .description('List installed memory files. Use agent@version for specific version, agent@default for default only.')
    .option('-a, --agent <agent>', 'Filter by agent')
    .action(async (agentArg, options) => {
      const cwd = process.cwd();

      // Parse agent input - handle agent@version syntax
      const agentInput = agentArg || options.agent;
      let agentId: AgentId | null = null;
      let requestedVersion: string | null = null;

      if (agentInput) {
        const parts = agentInput.split('@');
        const agentName = parts[0];
        requestedVersion = parts[1] || null;

        agentId = resolveAgentName(agentName);
        if (!agentId) {
          console.log(chalk.red(formatAgentError(agentName)));
          process.exit(1);
        }
      }

      // Helper to render memory for a specific version
      const renderVersionMemory = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string
      ) => {
        const agent = AGENTS[agentId];
        const installed = listInstalledInstructionsWithScope(agentId, cwd, { home });
        const userInstr = installed.find((i) => i.scope === 'user');
        const projectInstr = installed.find((i) => i.scope === 'project');

        const hasUser = userInstr?.exists;
        const hasProject = projectInstr?.exists;

        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

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
        console.log();
      };

      // Single agent specified - show versions based on requestedVersion
      if (agentId) {
        const agent = AGENTS[agentId];
        console.log(chalk.bold(`Installed Memory for ${agent.name}\n`));
        const installedVersions = listInstalledVersions(agentId);
        const defaultVer = getGlobalDefault(agentId);

        if (installedVersions.length === 0) {
          // Not version-managed
          const installed = listInstalledInstructionsWithScope(agentId, cwd);
          const userInstr = installed.find((i) => i.scope === 'user');
          const projectInstr = installed.find((i) => i.scope === 'project');
          const hasUser = userInstr?.exists;
          const hasProject = projectInstr?.exists;

          console.log(`  ${chalk.bold(agent.name)}:`);
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
          return;
        }

        let versionsToShow: string[];
        if (requestedVersion === 'default') {
          if (!defaultVer) {
            console.log(chalk.yellow(`  No default version set for ${agent.name}. Run: agents use ${agentId}@<version>`));
            return;
          }
          versionsToShow = [defaultVer];
        } else if (requestedVersion) {
          if (!installedVersions.includes(requestedVersion)) {
            console.log(chalk.red(`  Version ${requestedVersion} not installed for ${agent.name}.`));
            console.log(chalk.gray(`  Installed versions: ${installedVersions.join(', ')}`));
            return;
          }
          versionsToShow = [requestedVersion];
        } else {
          versionsToShow = [...installedVersions].sort((a, b) => {
            if (a === defaultVer) return -1;
            if (b === defaultVer) return 1;
            return 0;
          });
        }

        for (const version of versionsToShow) {
          const home = getVersionHomePath(agentId, version);
          renderVersionMemory(agentId, version, version === defaultVer, home);
        }
        return;
      }

      // No agent specified - show default version for each agent
      console.log(chalk.bold('Installed Memory\n'));
      for (const aid of ALL_AGENT_IDS) {
        const agent = AGENTS[aid];
        const installedVersions = listInstalledVersions(aid);
        const defaultVer = getGlobalDefault(aid);

        if (installedVersions.length > 0 && defaultVer) {
          const home = getVersionHomePath(aid, defaultVer);
          renderVersionMemory(aid, defaultVer, true, home);
        } else {
          // Not version-managed or no default
          const installed = listInstalledInstructionsWithScope(aid, cwd);
          const userInstr = installed.find((i) => i.scope === 'user');
          const projectInstr = installed.find((i) => i.scope === 'project');
          const hasUser = userInstr?.exists;
          const hasProject = projectInstr?.exists;

          console.log(`  ${chalk.bold(agent.name)}:`);
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
          console.log();
        }
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
    .description('Show memory content for an agent. Use agent@version for specific version.')
    .option('-s, --scope <scope>', 'Scope: user or project', 'user')
    .action(async (agentArg?: string, options?: { scope?: string }) => {
      const cwd = process.cwd();
      let agentId: AgentId | undefined;
      let requestedVersion: string | null = null;

      if (agentArg) {
        const parts = agentArg.split('@');
        const agentName = parts[0];
        requestedVersion = parts[1] || null;

        agentId = resolveAgentName(agentName) || undefined;
        if (!agentId) {
          console.log(chalk.red(formatAgentError(agentName)));
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

      // Helper to format and display content
      const displayContent = async (content: string, title: string, memPath: string) => {
        const { renderMarkdown } = await import('../lib/markdown.js');

        console.log(chalk.bold(`\n${title}`));
        console.log(chalk.gray(`Path: ${memPath}\n`));

        const rendered = renderMarkdown(content);
        const contentLines = content.split('\n');

        // Pipe through less for scrolling if content is large
        if (contentLines.length > 40) {
          const { spawnSync } = await import('child_process');
          const less = spawnSync('less', ['-R'], {
            input: rendered,
            stdio: ['pipe', 'inherit', 'inherit'],
          });

          // Fallback to direct output if less fails
          if (less.status !== 0) {
            console.log(rendered);
          }
        } else {
          console.log(rendered);
        }
      };

      // Handle version-specific view
      if (requestedVersion && scope === 'user') {
        const installedVersions = listInstalledVersions(agentId);
        if (!installedVersions.includes(requestedVersion)) {
          console.log(chalk.red(`Version ${requestedVersion} not installed for ${AGENTS[agentId].name}`));
          console.log(chalk.gray(`Installed versions: ${installedVersions.join(', ') || 'none'}`));
          return;
        }
        const home = getVersionHomePath(agentId, requestedVersion);
        const memPath = path.join(home, `.${agentId}`, AGENTS[agentId].instructionsFile);
        if (!fs.existsSync(memPath)) {
          console.log(chalk.yellow(`No user memory found for ${AGENTS[agentId].name}@${requestedVersion}`));
          return;
        }
        const content = fs.readFileSync(memPath, 'utf-8');
        await displayContent(content, `${AGENTS[agentId].name}@${requestedVersion} Memory (${scope})`, memPath);
        return;
      }

      const content = getInstructionsContent(agentId, scope, cwd);

      if (!content) {
        console.log(chalk.yellow(`No ${scope} memory found for ${AGENTS[agentId].name}`));
        return;
      }

      // Get the path for display
      const installed = listInstalledInstructionsWithScope(agentId, cwd);
      const instr = installed.find((i) => i.scope === scope);
      const memPath = instr?.path || '';

      await displayContent(content, `${AGENTS[agentId].name} Memory (${scope})`, memPath);
    });

  memoryCmd
    .command('remove <agent>')
    .description('Remove user memory for an agent. Use agent@version for specific version.')
    .action((agentArg: string) => {
      const parts = agentArg.split('@');
      const agentName = parts[0];
      const requestedVersion = parts[1] || null;

      const agentId = resolveAgentName(agentName);
      if (!agentId) {
        console.log(chalk.red(formatAgentError(agentName)));
        process.exit(1);
      }

      // Handle version-specific remove
      if (requestedVersion) {
        const installedVersions = listInstalledVersions(agentId);
        if (!installedVersions.includes(requestedVersion)) {
          console.log(chalk.red(`Version ${requestedVersion} not installed for ${AGENTS[agentId].name}`));
          console.log(chalk.gray(`Installed versions: ${installedVersions.join(', ') || 'none'}`));
          process.exit(1);
        }
        const home = getVersionHomePath(agentId, requestedVersion);
        const agent = AGENTS[agentId];
        const memPath = path.join(home, `.${agentId}`, agent.instructionsFile);

        if (fs.existsSync(memPath)) {
          fs.unlinkSync(memPath);
          console.log(chalk.green(`Removed ${agent.instructionsFile} from ${agent.name}@${requestedVersion}`));
        } else {
          console.log(chalk.yellow(`No memory file found for ${agent.name}@${requestedVersion}`));
        }
        return;
      }

      const result = uninstallInstructions(agentId);
      if (result) {
        console.log(chalk.green(`Removed ${AGENTS[agentId].instructionsFile}`));
      } else {
        console.log(chalk.yellow(`No memory file found for ${AGENTS[agentId].name}`));
      }
    });

  // Deprecated alias for 'view'
  memoryCmd
    .command('show [agent]', { hidden: true })
    .action(async (agentArg?: string) => {
      console.log(chalk.yellow('Deprecated: Use "agents memory view" instead of "agents memory show"\n'));
      // Re-execute view command logic
      await memoryCmd.commands.find((c) => c.name() === 'view')?.parseAsync(['view', ...(agentArg ? [agentArg] : [])], { from: 'user' });
    });
}
