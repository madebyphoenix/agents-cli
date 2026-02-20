import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { select, checkbox } from '@inquirer/prompts';

import {
  AGENTS,
  SKILLS_CAPABLE_AGENTS,
  resolveAgentName,
  getAllCliStates,
  formatAgentError,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverSkillsFromRepo,
  installSkillCentrally,
  uninstallSkill,
  listInstalledSkills,
  listInstalledSkillsWithScope,
  promoteSkillToUser,
  getSkillInfo,
  getSkillRules,
  tryParseSkillMetadata,
  type SkillParseError,
} from '../lib/skills.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
  getVersionHomePath,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import { isPromptCancelled } from './utils.js';

export function registerSkillsCommands(program: Command): void {
  const skillsCmd = program
    .command('skills')
    .description('Manage skills (SKILL.md + rules/)');

  skillsCmd
    .command('list [agent]')
    .description('List installed skills. Use agent@version for specific version, agent@default for default only.')
    .option('-a, --agent <agent>', 'Filter by agent')
    .option('-s, --scope <scope>', 'Filter by scope: user, project, or all', 'all')
    .action(async (agentArg, options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
      const cwd = process.cwd();

      // Parse agent input - handle agent@version syntax
      const agentInput = agentArg || options.agent;
      let agentId: AgentId | null = null;
      let requestedVersion: string | null = null; // null = all versions, 'default' = default only, 'x.y.z' = specific

      if (agentInput) {
        const parts = agentInput.split('@');
        const agentName = parts[0];
        requestedVersion = parts[1] || null; // null means show all versions

        agentId = resolveAgentName(agentName);
        if (!agentId) {
          spinner.stop();
          console.log(chalk.red(formatAgentError(agentName, SKILLS_CAPABLE_AGENTS)));
          process.exit(1);
        }
      }

      const showPaths = !!agentInput;

      // Get CLI states to determine managed vs unmanaged
      const cliStates = await getAllCliStates();

      // Helper to render skills for a specific version
      const renderVersionSkills = (
        agentId: AgentId,
        version: string,
        isDefault: boolean,
        home: string
      ) => {
        const agent = AGENTS[agentId];
        const errors: SkillParseError[] = [];
        const skills = listInstalledSkillsWithScope(agentId, cwd, { home, errors }).filter(
          (s) => options.scope === 'all' || s.scope === options.scope
        );

        const defaultLabel = isDefault ? ' default' : '';
        const versionStr = chalk.gray(` (${version}${defaultLabel})`);

        if (skills.length === 0) {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}:`);

          const userSkills = skills.filter((s) => s.scope === 'user');
          const projectSkills = skills.filter((s) => s.scope === 'project');

          if (userSkills.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
            console.log(`    ${chalk.gray('User:')}`);
            for (const skill of userSkills) {
              const desc = skill.metadata.description ? ` ${chalk.gray(skill.metadata.description)}` : '';
              const ruleInfo = skill.ruleCount > 0 ? chalk.gray(` (${skill.ruleCount} rules)`) : '';
              console.log(`      ${chalk.cyan(skill.name.padEnd(20))}${desc}${ruleInfo}`);
              if (showPaths) console.log(chalk.gray(`        ${skill.path}`));
            }
          }

          if (projectSkills.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
            console.log(`    ${chalk.gray('Project:')}`);
            for (const skill of projectSkills) {
              const desc = skill.metadata.description ? ` ${chalk.gray(skill.metadata.description)}` : '';
              const ruleInfo = skill.ruleCount > 0 ? chalk.gray(` (${skill.ruleCount} rules)`) : '';
              console.log(`      ${chalk.yellow(skill.name.padEnd(20))}${desc}${ruleInfo}`);
              if (showPaths) console.log(chalk.gray(`        ${skill.path}`));
            }
          }
        }

        // Show skills with parse errors
        if (errors.length > 0) {
          console.log(`    ${chalk.red('Errors:')}`);
          for (const err of errors) {
            console.log(`      ${chalk.red(err.name.padEnd(20))} ${chalk.gray(err.error)}`);
            if (showPaths) console.log(chalk.gray(`        ${err.path}`));
          }
        }
        console.log();
      };

      // Helper to render skills for an agent (default version only, for multi-agent view)
      const renderAgentSkillsDefault = (agentId: AgentId) => {
        const agent = AGENTS[agentId];
        if (!agent.capabilities.skills) {
          console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('skills not supported')}`);
          console.log();
          return;
        }

        const defaultVer = getGlobalDefault(agentId);
        if (defaultVer) {
          const home = getVersionHomePath(agentId, defaultVer);
          renderVersionSkills(agentId, defaultVer, true, home);
        } else {
          // No default set, show from effective home
          const errors: SkillParseError[] = [];
          const skills = listInstalledSkillsWithScope(agentId, cwd, { errors }).filter(
            (s) => options.scope === 'all' || s.scope === options.scope
          );
          if (skills.length === 0 && errors.length === 0) {
            console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
          } else {
            console.log(`  ${chalk.bold(agent.name)}:`);
            const userSkills = skills.filter((s) => s.scope === 'user');
            if (userSkills.length > 0) {
              console.log(`    ${chalk.gray('User:')}`);
              for (const skill of userSkills) {
                const desc = skill.metadata.description ? ` ${chalk.gray(skill.metadata.description)}` : '';
                const ruleInfo = skill.ruleCount > 0 ? chalk.gray(` (${skill.ruleCount} rules)`) : '';
                console.log(`      ${chalk.cyan(skill.name.padEnd(20))}${desc}${ruleInfo}`);
              }
            }
            if (errors.length > 0) {
              console.log(`    ${chalk.red('Errors:')}`);
              for (const err of errors) {
                console.log(`      ${chalk.red(err.name.padEnd(20))} ${chalk.gray(err.error)}`);
              }
            }
          }
          console.log();
        }
      };

      spinner.stop();

      // Single agent specified - show versions based on requestedVersion
      if (agentId) {
        const agent = AGENTS[agentId];
        if (!agent.capabilities.skills) {
          console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('skills not supported')}`);
          return;
        }

        const installedVersions = listInstalledVersions(agentId);
        const defaultVer = getGlobalDefault(agentId);

        if (installedVersions.length === 0) {
          // Not version-managed, check if globally installed
          const cliState = cliStates[agentId];
          if (cliState?.installed) {
            console.log(chalk.bold('Not Managed by Agents CLI\n'));
            const skills = listInstalledSkillsWithScope(agentId, cwd).filter(
              (s) => options.scope === 'all' || s.scope === options.scope
            );
            if (skills.length === 0) {
              console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
            } else {
              console.log(`  ${chalk.bold(agent.name)}:`);
              const userSkills = skills.filter((s) => s.scope === 'user');
              if (userSkills.length > 0) {
                console.log(`    ${chalk.gray('User:')}`);
                for (const skill of userSkills) {
                  const desc = skill.metadata.description ? ` - ${chalk.gray(skill.metadata.description)}` : '';
                  const ruleInfo = skill.ruleCount > 0 ? chalk.gray(` (${skill.ruleCount} rules)`) : '';
                  console.log(`      ${chalk.cyan(skill.name)}${desc}${ruleInfo}`);
                  if (showPaths) console.log(chalk.gray(`        ${skill.path}`));
                }
              }
            }
          } else {
            console.log(chalk.gray(`  ${agent.name} is not installed.`));
          }
          return;
        }

        console.log(chalk.bold(`Installed Agent Skills for ${agent.name}\n`));

        // Determine which versions to show
        let versionsToShow: string[];
        if (requestedVersion === 'default') {
          // Show only default version
          if (!defaultVer) {
            console.log(chalk.yellow(`  No default version set for ${agent.name}. Run: agents use ${agentId}@<version>`));
            return;
          }
          versionsToShow = [defaultVer];
        } else if (requestedVersion) {
          // Show specific version
          if (!installedVersions.includes(requestedVersion)) {
            console.log(chalk.red(`  Version ${requestedVersion} not installed for ${agent.name}.`));
            console.log(chalk.gray(`  Installed versions: ${installedVersions.join(', ')}`));
            return;
          }
          versionsToShow = [requestedVersion];
        } else {
          // Show all versions, default first
          versionsToShow = [...installedVersions].sort((a, b) => {
            if (a === defaultVer) return -1;
            if (b === defaultVer) return 1;
            return 0;
          });
        }

        for (const version of versionsToShow) {
          const home = getVersionHomePath(agentId, version);
          renderVersionSkills(agentId, version, version === defaultVer, home);
        }
        return;
      }

      // No agent specified - show default version for each agent
      const versionManaged: AgentId[] = [];
      const globallyInstalled: AgentId[] = [];

      for (const aid of SKILLS_CAPABLE_AGENTS) {
        const versions = listInstalledVersions(aid);
        const cliState = cliStates[aid];

        if (versions.length > 0) {
          versionManaged.push(aid);
        } else if (cliState?.installed) {
          globallyInstalled.push(aid);
        }
      }

      if (versionManaged.length > 0) {
        console.log(chalk.bold('Installed Agent Skills\n'));
        for (const aid of versionManaged) {
          renderAgentSkillsDefault(aid);
        }
      }

      if (globallyInstalled.length > 0) {
        console.log(chalk.bold('Not Managed by Agents CLI\n'));
        for (const aid of globallyInstalled) {
          const agent = AGENTS[aid];
          const skills = listInstalledSkillsWithScope(aid, cwd).filter(
            (s) => options.scope === 'all' || s.scope === options.scope
          );
          if (skills.length === 0) {
            console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('none')}`);
          } else {
            console.log(`  ${chalk.bold(agent.name)}:`);
            const userSkills = skills.filter((s) => s.scope === 'user');
            if (userSkills.length > 0) {
              console.log(`    ${chalk.gray('User:')}`);
              for (const skill of userSkills) {
                const desc = skill.metadata.description ? ` ${chalk.gray(skill.metadata.description)}` : '';
                const ruleInfo = skill.ruleCount > 0 ? chalk.gray(` (${skill.ruleCount} rules)`) : '';
                console.log(`      ${chalk.cyan(skill.name.padEnd(20))}${desc}${ruleInfo}`);
              }
            }
          }
          console.log();
        }
      }

      if (versionManaged.length === 0 && globallyInstalled.length === 0) {
        console.log(chalk.gray('  No agents with skills installed.'));
        console.log();
      }
    });

  skillsCmd
    .command('add [source]')
    .description('Install skills from a repo or local path')
    .option('-a, --agents <list>', 'Comma-separated agents to install to')
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(async (source: string | undefined, options) => {
      try {
        let skills: { name: string; path?: string; metadata: { description?: string }; ruleCount?: number }[];

        if (!source) {
          // Interactive mode: pick from central storage
          const installedSkills = listInstalledSkills();
          if (installedSkills.size === 0) {
            console.log(chalk.yellow('No skills in ~/.agents/skills/'));
            console.log(chalk.gray('\nTo add skills from a repo:'));
            console.log(chalk.cyan('  agents skills add gh:user/repo'));
            return;
          }

          const choices = Array.from(installedSkills.entries()).map(([name, skill]) => ({
            value: name,
            name: skill.metadata.description
              ? `${name}  ${chalk.gray(skill.metadata.description.slice(0, 50))}`
              : name,
          }));

          const selected = await checkbox({
            message: 'Select skills to install',
            choices: [
              { value: '__all__', name: chalk.bold('Select All') },
              ...choices,
            ],
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No skills selected.'));
            return;
          }

          const selectedNames = selected.includes('__all__')
            ? Array.from(installedSkills.keys())
            : selected.filter((s) => s !== '__all__');

          skills = selectedNames.map((name) => {
            const skill = installedSkills.get(name);
            return { name, metadata: skill?.metadata || {} };
          });
        } else {
          // Source provided: fetch from repo or local path
          const spinner = ora('Fetching skills...').start();

          const isGitRepo = source.startsWith('gh:') || source.startsWith('git:') ||
                            source.startsWith('ssh:') || source.startsWith('https://') ||
                            source.startsWith('http://');

          let localPath: string;
          let discoveredSkills: ReturnType<typeof discoverSkillsFromRepo>;

          if (isGitRepo) {
            const result = await cloneRepo(source);
            localPath = result.localPath;
            discoveredSkills = discoverSkillsFromRepo(localPath);
            spinner.succeed('Repository cloned');
          } else {
            localPath = source.startsWith('~')
              ? path.join(os.homedir(), source.slice(1))
              : path.resolve(source);

            if (!fs.existsSync(localPath)) {
              spinner.fail(`Path not found: ${localPath}`);
              return;
            }

            const skillMdPath = path.join(localPath, 'SKILL.md');
            if (fs.existsSync(skillMdPath)) {
              const skillName = path.basename(localPath);
              const { validateSkillMetadata, countSkillRules } = await import('../lib/skills.js');
              const parseResult = tryParseSkillMetadata(localPath);
              const validation = validateSkillMetadata(parseResult.metadata, skillName);

              // Warn if YAML is invalid
              if (parseResult.error) {
                spinner.warn(`Skill '${skillName}' has invalid SKILL.md`);
                console.log(chalk.yellow(`  ${parseResult.error}`));
                console.log(chalk.gray('  The skill will be installed but may not appear in listings.\n'));
              } else {
                spinner.succeed('Using skill directory');
              }

              discoveredSkills = [{
                name: skillName,
                path: localPath,
                metadata: parseResult.metadata || { name: skillName, description: '' },
                ruleCount: countSkillRules(localPath),
                validation,
              }];
            } else {
              discoveredSkills = discoverSkillsFromRepo(localPath);
              spinner.succeed('Using local path');
            }
          }

          console.log(chalk.bold(`\nFound ${discoveredSkills.length} skill(s):`));

          if (discoveredSkills.length === 0) {
            console.log(chalk.yellow('No skills found (looking for SKILL.md files)'));
            return;
          }

          for (const skill of discoveredSkills) {
            const nameColor = skill.parseError ? chalk.yellow : chalk.cyan;
            console.log(`\n  ${nameColor(skill.name)}: ${skill.metadata.description || 'no description'}`);
            if (skill.ruleCount > 0) {
              console.log(`    ${chalk.gray(`${skill.ruleCount} rules`)}`);
            }
            if (skill.parseError) {
              console.log(`    ${chalk.yellow('Warning:')} ${chalk.gray(skill.parseError)}`);
            }
          }

          // Install to central storage first
          const installSpinner = ora('Installing skills to central storage...').start();
          let installed = 0;

          for (const skill of discoveredSkills) {
            const result = installSkillCentrally(skill.path, skill.name);
            if (result.success) {
              installed++;
            } else {
              installSpinner.stop();
              console.log(chalk.red(`\n  Failed to install ${skill.name}: ${result.error}`));
              installSpinner.start();
            }
          }

          installSpinner.succeed(`Installed ${installed} skills to ~/.agents/skills/`);
          skills = discoveredSkills;
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
          const result = await promptAgentVersionSelection(SKILLS_CAPABLE_AGENTS, { skipPrompts: options.yes });
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
        const skillNames = skills.map((s) => s.name);

        for (const [agentId, versions] of versionSelections) {
          for (const version of versions) {
            syncResourcesToVersion(agentId, version);
            recordVersionResources(agentId, version, 'skills', skillNames);
            synced++;
          }
        }

        if (synced > 0) {
          syncSpinner.succeed(`Synced to ${synced} agent version(s)`);
        } else {
          syncSpinner.info('No version-managed agents to sync');
        }

        console.log(chalk.green('\nSkills installed.'));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.gray('\nCancelled'));
          return;
        }
        console.error(chalk.red('Failed to add skills'));
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  skillsCmd
    .command('remove [name]')
    .description('Remove a skill')
    .action(async (name?: string) => {
      let skillsToRemove: string[];

      if (name) {
        skillsToRemove = [name];
      } else {
        // Interactive picker
        const installedSkills = listInstalledSkills();
        if (installedSkills.size === 0) {
          console.log(chalk.yellow('No skills installed.'));
          return;
        }

        try {
          const choices = Array.from(installedSkills.entries()).map(([skillName, skill]) => ({
            value: skillName,
            name: skill.metadata.description
              ? `${skillName} - ${skill.metadata.description}`
              : skillName,
          }));

          const selected = await checkbox({
            message: 'Select skills to remove',
            choices,
          });

          if (selected.length === 0) {
            console.log(chalk.gray('No skills selected.'));
            return;
          }

          skillsToRemove = selected;
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      for (const skillName of skillsToRemove) {
        const result = uninstallSkill(skillName);
        if (result.success) {
          console.log(chalk.green(`Removed skill '${skillName}'`));
        } else {
          console.log(chalk.red(result.error || `Failed to remove skill '${skillName}'`));
        }
      }
    });

  skillsCmd
    .command('push <name>')
    .description('Promote a project skill to user scope')
    .option('-a, --agents <list>', 'Comma-separated agents to push for')
    .action((name: string, options) => {
      const cwd = process.cwd();
      const agents = options.agents
        ? (options.agents.split(',') as AgentId[])
        : SKILLS_CAPABLE_AGENTS;

      let pushed = 0;
      for (const agentId of agents) {
        if (!AGENTS[agentId].capabilities.skills) continue;

        const result = promoteSkillToUser(agentId, name, cwd);
        if (result.success) {
          console.log(`  ${chalk.green('+')} ${AGENTS[agentId].name}`);
          pushed++;
        } else if (result.error && !result.error.includes('not found')) {
          console.log(`  ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
        }
      }

      if (pushed === 0) {
        console.log(chalk.yellow(`Project skill '${name}' not found for any agent`));
      } else {
        console.log(chalk.green(`\nPushed to user scope for ${pushed} agents.`));
      }
    });

  skillsCmd
    .command('view [name]')
    .alias('info')
    .description('Show installed skill details')
    .action(async (name?: string) => {
      // If no name provided, show interactive select
      if (!name) {
        const cwd = process.cwd();
        const allSkills: Array<{ name: string; description: string }> = [];
        const seenNames = new Set<string>();

        for (const agentId of SKILLS_CAPABLE_AGENTS) {
          const skills = listInstalledSkillsWithScope(agentId, cwd);
          for (const skill of skills) {
            if (!seenNames.has(skill.name)) {
              seenNames.add(skill.name);
              allSkills.push({
                name: skill.name,
                description: skill.metadata.description || '',
              });
            }
          }
        }

        if (allSkills.length === 0) {
          console.log(chalk.yellow('No skills installed'));
          return;
        }

        try {
          name = await select({
            message: 'Select a skill to view',
            choices: allSkills.map((s) => {
              const maxDescLen = Math.max(0, 70 - s.name.length);
              const desc = s.description.length > maxDescLen
                ? s.description.slice(0, maxDescLen - 3) + '...'
                : s.description;
              return {
                value: s.name,
                name: desc ? `${s.name} - ${desc}` : s.name,
              };
            }),
          });
        } catch (err) {
          if (isPromptCancelled(err)) {
            console.log(chalk.gray('Cancelled'));
            return;
          }
          throw err;
        }
      }

      const skill = getSkillInfo(name);
      if (!skill) {
        console.log(chalk.yellow(`Skill '${name}' not found`));
        return;
      }

      // Build output
      const lines: string[] = [];
      lines.push(chalk.bold(`\n${skill.metadata.name}\n`));
      if (skill.metadata.description) {
        lines.push(`  ${skill.metadata.description}`);
      }
      lines.push('');
      if (skill.metadata.author) {
        lines.push(`  Author: ${skill.metadata.author}`);
      }
      if (skill.metadata.version) {
        lines.push(`  Version: ${skill.metadata.version}`);
      }
      if (skill.metadata.license) {
        lines.push(`  License: ${skill.metadata.license}`);
      }
      lines.push(`  Path: ${skill.path}`);

      const rules = getSkillRules(name);
      if (rules.length > 0) {
        lines.push(chalk.bold(`\n  Rules (${rules.length}):\n`));
        for (const rule of rules) {
          lines.push(`    ${chalk.cyan(rule)}`);
        }
      }
      lines.push('');

      const output = lines.join('\n');

      // Pipe through less for scrolling (q to quit)
      const { spawnSync } = await import('child_process');
      const less = spawnSync('less', ['-R'], {
        input: output,
        stdio: ['pipe', 'inherit', 'inherit'],
      });

      // Fallback to direct output if less fails
      if (less.status !== 0) {
        console.log(output);
      }
    });
}
