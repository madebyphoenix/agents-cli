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
} from '../lib/skills.js';
import {
  listInstalledVersions,
  getGlobalDefault,
  syncResourcesToVersion,
  promptAgentVersionSelection,
} from '../lib/versions.js';
import { recordVersionResources } from '../lib/state.js';
import { isPromptCancelled } from './utils.js';

export function registerSkillsCommands(program: Command): void {
  const skillsCmd = program
    .command('skills')
    .description('Manage skills (SKILL.md + rules/)');

  skillsCmd
    .command('list [agent]')
    .description('List installed skills')
    .option('-a, --agent <agent>', 'Filter by agent')
    .option('-s, --scope <scope>', 'Filter by scope: user, project, or all', 'all')
    .action(async (agentArg, options) => {
      const spinner = ora({ text: 'Loading...', isSilent: !process.stdout.isTTY }).start();
      const cwd = process.cwd();

      // Resolve agent filter - positional arg takes precedence over -a flag
      const agentInput = agentArg || options.agent;
      let agents: AgentId[];
      if (agentInput) {
        const resolved = resolveAgentName(agentInput);
        if (!resolved) {
          spinner.stop();
          console.log(chalk.red(`Unknown agent '${agentInput}'. Use ${SKILLS_CAPABLE_AGENTS.join(', ')}`));
          process.exit(1);
        }
        agents = [resolved];
      } else {
        agents = SKILLS_CAPABLE_AGENTS;
      }
      const showPaths = !!agentInput;

      // Get CLI states to determine managed vs unmanaged
      const cliStates = await getAllCliStates();

      // Separate version-managed from globally-installed agents
      const versionManaged: AgentId[] = [];
      const globallyInstalled: AgentId[] = [];

      for (const agentId of agents) {
        const versions = listInstalledVersions(agentId);
        const cliState = cliStates[agentId];

        if (versions.length > 0) {
          versionManaged.push(agentId);
        } else if (cliState?.installed) {
          globallyInstalled.push(agentId);
        }
      }

      // Helper to render skills for an agent
      const renderAgentSkills = (agentId: AgentId, showVersion: boolean = false) => {
        const agent = AGENTS[agentId];
        if (!agent.capabilities.skills) {
          console.log(`  ${chalk.bold(agent.name)}: ${chalk.gray('skills not supported')}`);
          console.log();
          return;
        }

        const skills = listInstalledSkillsWithScope(agentId, cwd).filter(
          (s) => options.scope === 'all' || s.scope === options.scope
        );

        // Get version info for managed agents
        const defaultVer = showVersion ? getGlobalDefault(agentId) : null;
        const versionStr = defaultVer ? chalk.gray(` (${defaultVer})`) : '';

        if (skills.length === 0) {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}: ${chalk.gray('none')}`);
        } else {
          console.log(`  ${chalk.bold(agent.name)}${versionStr}:`);

          const userSkills = skills.filter((s) => s.scope === 'user');
          const projectSkills = skills.filter((s) => s.scope === 'project');

          if (userSkills.length > 0 && (options.scope === 'all' || options.scope === 'user')) {
            console.log(`    ${chalk.gray('User:')}`);
            for (const skill of userSkills) {
              const desc = skill.metadata.description ? ` - ${chalk.gray(skill.metadata.description)}` : '';
              const ruleInfo = skill.ruleCount > 0 ? chalk.gray(` (${skill.ruleCount} rules)`) : '';
              console.log(`      ${chalk.cyan(skill.name)}${desc}${ruleInfo}`);
              if (showPaths) console.log(chalk.gray(`        ${skill.path}`));
            }
          }

          if (projectSkills.length > 0 && (options.scope === 'all' || options.scope === 'project')) {
            console.log(`    ${chalk.gray('Project:')}`);
            for (const skill of projectSkills) {
              const desc = skill.metadata.description ? ` - ${chalk.gray(skill.metadata.description)}` : '';
              const ruleInfo = skill.ruleCount > 0 ? chalk.gray(` (${skill.ruleCount} rules)`) : '';
              console.log(`      ${chalk.yellow(skill.name)}${desc}${ruleInfo}`);
              if (showPaths) console.log(chalk.gray(`        ${skill.path}`));
            }
          }
        }
        console.log();
      };

      spinner.stop();

      // Show version-managed agents first
      if (versionManaged.length > 0) {
        console.log(chalk.bold('Installed Agent Skills\n'));
        for (const agentId of versionManaged) {
          renderAgentSkills(agentId, true);
        }
      }

      // Show globally installed (not managed) agents
      if (globallyInstalled.length > 0) {
        console.log(chalk.bold('Not Managed by Agents CLI\n'));
        for (const agentId of globallyInstalled) {
          renderAgentSkills(agentId, false);
        }
      }

      // No agents with skills
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
              const { parseSkillMetadata, validateSkillMetadata, countSkillRules } = await import('../lib/skills.js');
              const metadata = parseSkillMetadata(localPath);
              const validation = validateSkillMetadata(metadata, skillName);
              discoveredSkills = [{
                name: skillName,
                path: localPath,
                metadata: metadata || { name: skillName, description: '' },
                ruleCount: countSkillRules(localPath),
                validation,
              }];
              spinner.succeed('Using skill directory');
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
            console.log(`\n  ${chalk.cyan(skill.name)}: ${skill.metadata.description || 'no description'}`);
            if (skill.ruleCount > 0) {
              console.log(`    ${chalk.gray(`${skill.ruleCount} rules`)}`);
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
