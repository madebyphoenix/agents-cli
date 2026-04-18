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
  agentLabel,
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
import {
  isPromptCancelled,
  formatPath,
  isInteractiveTerminal,
  parseCommaSeparatedList,
  printWithPager,
  requireInteractiveSelection,
} from './utils.js';

export function registerRulesCommands(program: Command): void {
  const rulesCmd = program
    .command('rules')
    .description('Manage agent rules/instructions (AGENTS.md, CLAUDE.md, .cursorrules, etc.)');

  rulesCmd
    .command('list [agent]')
    .description('List installed rule files. Use agent@version for specific version, agent@default for default only.')
    .option('-a, --agent <agent>', 'Filter by agent')
    .action(async (agentArg, options) => {
      const cwd = process.cwd();

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

      const renderVersionRules = (
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

        console.log(`  ${chalk.bold(agentLabel(agent.id))}${versionStr}:`);

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

      if (agentId) {
        const agent = AGENTS[agentId];
        console.log(chalk.bold(`Installed Rules for ${agentLabel(agent.id)}\n`));
        const installedVersions = listInstalledVersions(agentId);
        const defaultVer = getGlobalDefault(agentId);

        if (installedVersions.length === 0) {
          const installed = listInstalledInstructionsWithScope(agentId, cwd);
          const userInstr = installed.find((i) => i.scope === 'user');
          const projectInstr = installed.find((i) => i.scope === 'project');
          const hasUser = userInstr?.exists;
          const hasProject = projectInstr?.exists;

          console.log(`  ${chalk.bold(agentLabel(agent.id))}:`);
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
            console.log(chalk.yellow(`  No default version set for ${agentLabel(agent.id)}. Run: agents use ${agentId}@<version>`));
            return;
          }
          versionsToShow = [defaultVer];
        } else if (requestedVersion) {
          if (!installedVersions.includes(requestedVersion)) {
            console.log(chalk.red(`  Version ${requestedVersion} not installed for ${agentLabel(agent.id)}.`));
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
          renderVersionRules(agentId, version, version === defaultVer, home);
        }
        return;
      }

      console.log(chalk.bold('Installed Rules\n'));
      for (const aid of ALL_AGENT_IDS) {
        const agent = AGENTS[aid];
        const installedVersions = listInstalledVersions(aid);
        const defaultVer = getGlobalDefault(aid);

        if (installedVersions.length > 0 && defaultVer) {
          const home = getVersionHomePath(aid, defaultVer);
          renderVersionRules(aid, defaultVer, true, home);
        } else {
          const installed = listInstalledInstructionsWithScope(aid, cwd);
          const userInstr = installed.find((i) => i.scope === 'user');
          const projectInstr = installed.find((i) => i.scope === 'project');
          const hasUser = userInstr?.exists;
          const hasProject = projectInstr?.exists;

          console.log(`  ${chalk.bold(agentLabel(aid))}:`);
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

  rulesCmd
    .command('add [source]')
    .description('Install rule files from a repo or local path')
    .option('-a, --agents <list>', 'Comma-separated agents to install to')
    .option('--names <list>', 'Comma-separated rule file names from ~/.agents/memory/')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(async (source: string | undefined, options) => {
      try {
        let ruleNames: string[];

        if (!source) {
          const centralRules = listCentralMemory();
          if (centralRules.length === 0) {
            console.log(chalk.yellow('No rule files in ~/.agents/memory/'));
            console.log(chalk.gray('\nTo add rule files from a repo:'));
            console.log(chalk.cyan('  agents rules add gh:user/repo'));
            return;
          }

          const requestedNames = parseCommaSeparatedList(options.names);
          if (requestedNames.length > 0) {
            const missing = requestedNames.filter((name) => !centralRules.includes(name));
            if (missing.length > 0) {
              console.log(chalk.red(`Unknown rule file(s): ${missing.join(', ')}`));
              console.log(chalk.gray(`Available: ${centralRules.join(', ')}`));
              process.exit(1);
            }
            ruleNames = requestedNames;
          } else {
            if (!isInteractiveTerminal()) {
              requireInteractiveSelection('Selecting rule files from ~/.agents/memory/', [
                'agents rules add --names AGENTS.md --agents codex',
                'agents rules add gh:team/rules --agents codex',
              ]);
            }

            const choices = centralRules.map((name) => ({
              value: name,
              name,
            }));

            const selected = await checkbox({
              message: 'Select rule files to install',
              choices: [
                { value: '__all__', name: chalk.bold('Select All') },
                ...choices,
              ],
            });

            if (selected.length === 0) {
              console.log(chalk.gray('No rule files selected.'));
              return;
            }

            ruleNames = selected.includes('__all__')
              ? centralRules
              : selected.filter((s) => s !== '__all__');
          }
        } else {
          const spinner = ora('Fetching rule files...').start();

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
          const ruleFiles = discoverMemoryFilesFromRepo(localPath);

          const totalFiles = agentInstructions.length + ruleFiles.length;
          console.log(chalk.bold(`\nFound ${totalFiles} rule file(s):`));

          if (totalFiles === 0) {
            console.log(chalk.yellow('No rule files found'));
            return;
          }

          for (const instr of agentInstructions) {
            console.log(`  ${chalk.cyan(AGENTS[instr.agentId].instructionsFile)} (${agentLabel(instr.agentId)})`);
          }
          for (const file of ruleFiles) {
            console.log(`  ${chalk.cyan(file)} (shared)`);
          }

          const installSpinner = ora('Installing rule files to central storage...').start();
          const centralResult = installInstructionsCentrally(localPath);

          if (centralResult.errors.length > 0) {
            installSpinner.stop();
            for (const error of centralResult.errors) {
              console.log(chalk.yellow(`\n  Warning: ${error}`));
            }
            installSpinner.start();
          }

          installSpinner.succeed(`Installed ${centralResult.installed.length} rule files to ~/.agents/memory/`);
          ruleNames = centralResult.installed.map((p) => path.basename(p));
        }

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
          const result = await promptAgentVersionSelection(ALL_AGENT_IDS, {
            skipPrompts: options.yes || !isInteractiveTerminal(),
          });
          selectedAgents = result.selectedAgents;
          versionSelections = result.versionSelections;
        }

        if (selectedAgents.length === 0) {
          console.log(chalk.yellow('\nNo agents selected.'));
          return;
        }

        const syncSpinner = ora('Syncing to agent versions...').start();
        let synced = 0;

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'memory', ruleNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nRule files installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add rule files'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  rulesCmd
    .command('view [agent]')
    .description('Show rule file content for an agent. Use agent@version for specific version.')
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
          console.log(chalk.yellow('No rule files found.'));
          return;
        }
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Selecting an agent rule file to view', [
            'agents rules view claude',
            'agents rules view codex@0.113.0 --scope user',
          ]);
        }
        agentId = await select({
          message: 'Select agent:',
          choices: choices.map((id) => ({ name: agentLabel(id), value: id })),
        });
      }

      const scope = (options?.scope || 'user') as 'user' | 'project';

      const displayContent = async (content: string, title: string, filePath: string) => {
        const { renderMarkdown } = await import('../lib/markdown.js');

        console.log(chalk.bold(`\n${title}`));
        console.log(chalk.gray(`Path: ${filePath}\n`));

        const rendered = renderMarkdown(content);
        const contentLines = content.split('\n');
        printWithPager(rendered, contentLines.length);
      };

      if (requestedVersion && scope === 'user') {
        const installedVersions = listInstalledVersions(agentId);
        if (!installedVersions.includes(requestedVersion)) {
          console.log(chalk.red(`Version ${requestedVersion} not installed for ${agentLabel(agentId)}`));
          console.log(chalk.gray(`Installed versions: ${installedVersions.join(', ') || 'none'}`));
          return;
        }
        const home = getVersionHomePath(agentId, requestedVersion);
        const filePath = path.join(home, `.${agentId}`, AGENTS[agentId].instructionsFile);
        if (!fs.existsSync(filePath)) {
          console.log(chalk.yellow(`No user rules found for ${agentLabel(agentId)}@${requestedVersion}`));
          return;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        await displayContent(content, `${agentLabel(agentId)}@${requestedVersion} Rules (${scope})`, filePath);
        return;
      }

      const content = getInstructionsContent(agentId, scope, cwd);

      if (!content) {
        console.log(chalk.yellow(`No ${scope} rules found for ${agentLabel(agentId)}`));
        return;
      }

      const installed = listInstalledInstructionsWithScope(agentId, cwd);
      const instr = installed.find((i) => i.scope === scope);
      const filePath = instr?.path || '';

      await displayContent(content, `${agentLabel(agentId)} Rules (${scope})`, filePath);
    });

  rulesCmd
    .command('remove <agent>')
    .description('Remove user rules for an agent. Use agent@version for specific version.')
    .action((agentArg: string) => {
      const parts = agentArg.split('@');
      const agentName = parts[0];
      const requestedVersion = parts[1] || null;

      const agentId = resolveAgentName(agentName);
      if (!agentId) {
        console.log(chalk.red(formatAgentError(agentName)));
        process.exit(1);
      }

      if (requestedVersion) {
        const installedVersions = listInstalledVersions(agentId);
        if (!installedVersions.includes(requestedVersion)) {
          console.log(chalk.red(`Version ${requestedVersion} not installed for ${agentLabel(agentId)}`));
          console.log(chalk.gray(`Installed versions: ${installedVersions.join(', ') || 'none'}`));
          process.exit(1);
        }
        const home = getVersionHomePath(agentId, requestedVersion);
        const agent = AGENTS[agentId];
        const filePath = path.join(home, `.${agentId}`, agent.instructionsFile);

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(chalk.green(`Removed ${agent.instructionsFile} from ${agentLabel(agent.id)}@${requestedVersion}`));
        } else {
          console.log(chalk.yellow(`No rule file found for ${agentLabel(agent.id)}@${requestedVersion}`));
        }
        return;
      }

      const result = uninstallInstructions(agentId);
      if (result) {
        console.log(chalk.green(`Removed ${AGENTS[agentId].instructionsFile}`));
      } else {
        console.log(chalk.yellow(`No rule file found for ${agentLabel(agentId)}`));
      }
    });

  rulesCmd
    .command('show [agent]', { hidden: true })
    .action(async (agentArg?: string) => {
      console.log(chalk.yellow('Deprecated: Use "agents rules view" instead of "agents rules show"\n'));
      await rulesCmd.commands.find((c) => c.name() === 'view')?.parseAsync(['view', ...(agentArg ? [agentArg] : [])], { from: 'user' });
    });
}
