import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { checkbox, confirm, select } from '@inquirer/prompts';

import {
  AGENTS,
  ALL_AGENT_IDS,
  MCP_CAPABLE_AGENTS,
  SKILLS_CAPABLE_AGENTS,
  HOOKS_CAPABLE_AGENTS,
  getAllCliStates,
  isMcpRegistered,
  registerMcp,
  unregisterMcp,
  listInstalledMcpsWithScope,
  getMcpConfigPathForHome,
  parseMcpConfig,
  getAccountEmail,
  isAgentName,
  resolveAgentName,
} from '../lib/agents.js';
import {
  readManifest,
  MANIFEST_FILENAME,
} from '../lib/manifest.js';
import {
  readMeta,
  getRepoLocalPath,
  getMemoryDir,
  getRepo,
  setRepo,
  getReposByPriority,
  getRepoPriority,
} from '../lib/state.js';
import { REPO_PRIORITIES, DEFAULT_SYSTEM_REPO } from '../lib/types.js';
import type { AgentId, RepoName } from '../lib/types.js';
import { cloneRepo, parseSource } from '../lib/git.js';
import {
  discoverCommands,
  resolveCommandSource,
  installCommandCentrally,
  commandExists,
  commandContentMatches,
} from '../lib/commands.js';
import {
  discoverHooksFromRepo,
  installHooksCentrally,
  hookExists,
  hookContentMatches,
  getSourceHookEntry,
} from '../lib/hooks.js';
import {
  discoverSkillsFromRepo,
  installSkillCentrally,
  skillExists,
  skillContentMatches,
} from '../lib/skills.js';
import {
  discoverInstructionsFromRepo,
  discoverMemoryFilesFromRepo,
  installInstructionsCentrally,
  instructionsExists,
  instructionsContentMatches,
} from '../lib/memory.js';
import {
  installVersion,
  listInstalledVersions,
  getGlobalDefault,
  getBinaryPath,
  getVersionHomePath,
  syncResourcesToVersion,
  getEffectiveHome,
} from '../lib/versions.js';
import { createShim } from '../lib/shims.js';
import {
  discoverJobsFromRepo,
  jobExists,
  jobContentMatches,
  installJobFromSource,
} from '../lib/jobs.js';
import {
  discoverDrivesFromRepo,
  driveExists,
  driveContentMatches,
  installDriveFromSource,
} from '../lib/drives.js';
import {
  isDaemonRunning,
  signalDaemonReload,
} from '../lib/daemon.js';
import { isPromptCancelled } from './utils.js';

// Resource item for tracking new vs existing
interface ResourceItem {
  type: 'command' | 'skill' | 'hook' | 'mcp' | 'memory' | 'job' | 'drive';
  name: string;
  agents: AgentId[];
  isNew: boolean;
}

// Per-resource conflict decision
type ResourceDecision = 'overwrite' | 'skip';

export function registerPullCommand(program: Command): void {
  program
    .command('pull [source] [agent]')
    .description('Sync config from a .agents repo')
    .option('-y, --yes', 'Skip prompts and keep existing conflicts')
    .option('-f, --force', 'Skip prompts and overwrite conflicts')
    .option('-s, --scope <scope>', 'Target scope', 'user')
    .option('--dry-run', 'Show what would change')
    .option('--skip-clis', 'Do not sync CLI versions')
    .option('--skip-mcp', 'Do not register MCP servers')
    .option('--clean', 'Remove MCPs not in repo')
    .action(async (arg1: string | undefined, arg2: string | undefined, options) => {
      // Parse source and agent filter from positional args
      let targetSource: string | undefined;
      let agentFilter: AgentId | undefined;

      if (arg1) {
        if (isAgentName(arg1)) {
          // agents pull claude
          agentFilter = resolveAgentName(arg1)!;
        } else {
          // agents pull gh:user/repo [agent]
          targetSource = arg1;
          if (arg2 && isAgentName(arg2)) {
            agentFilter = resolveAgentName(arg2)!;
          }
        }
      }

      const repoName = options.scope as RepoName;
      const meta = readMeta();
      const existingRepo = meta.repos[repoName];

      // Try: 1) provided source, 2) existing repo source, 3) fall back to system repo
      targetSource = targetSource || existingRepo?.source;
      let effectiveRepo = repoName;

      if (!targetSource && repoName === 'user') {
        const systemRepo = meta.repos['system'];
        if (systemRepo?.source) {
          targetSource = systemRepo.source;
          effectiveRepo = 'system';
          console.log(chalk.gray(`No user repo configured, using system repo: ${targetSource}\n`));
        }
      }

      if (!targetSource) {
        if (repoName === 'user' && Object.keys(meta.repos).length === 0) {
          console.log(chalk.gray(`First run detected. Initializing from ${DEFAULT_SYSTEM_REPO}...\n`));
          targetSource = DEFAULT_SYSTEM_REPO;
          effectiveRepo = 'system';
        } else {
          console.log(chalk.red(`No source specified for repo '${repoName}'.`));
          const repoHint = repoName === 'user' ? '' : ` --scope ${repoName}`;
          console.log(chalk.gray(`  Usage: agents pull <source>${repoHint}`));
          console.log(chalk.gray('  Example: agents pull gh:username/.agents'));
          process.exit(1);
        }
      }

      const targetRepoConfig = meta.repos[effectiveRepo];
      const isReadonly = targetRepoConfig?.readonly || effectiveRepo === 'system';
      const isUserScope = effectiveRepo === 'user';

      const parsed = parseSource(targetSource);
      const spinner = ora(`Syncing from ${effectiveRepo} repo...`).start();

      try {
        const { localPath, commit, isNew } = await cloneRepo(targetSource);
        spinner.succeed(isNew ? 'Repository cloned' : 'Repository updated');

        const manifest = readManifest(localPath);
        if (!manifest) {
          console.log(chalk.yellow(`No ${MANIFEST_FILENAME} found in repository`));
        }

        // Discover all assets
        const allCommands = discoverCommands(localPath);
        const allSkills = discoverSkillsFromRepo(localPath);
        const discoveredHooks = discoverHooksFromRepo(localPath);
        const allInstructions = discoverInstructionsFromRepo(localPath);
        const allMemoryFiles = discoverMemoryFilesFromRepo(localPath);
        const allDiscoveredJobs = discoverJobsFromRepo(localPath);
        const allDiscoveredDrives = discoverDrivesFromRepo(localPath);

        // Auto-install/upgrade CLI versions
        if (!options.skipClis && manifest?.agents) {
          const cliAgents = (manifest.defaults?.agents || Object.keys(manifest.agents)) as AgentId[];
          for (const agentId of cliAgents) {
            if (agentFilter && agentId !== agentFilter) continue;
            const agent = AGENTS[agentId];
            if (!agent) continue;

            const cliSpinner = ora(`Checking ${agent.name}...`).start();
            const versions = listInstalledVersions(agentId);
            const targetVersion = manifest.agents[agentId] || 'latest';

            const result = await installVersion(agentId, targetVersion, (msg) => { cliSpinner.text = msg; });
            if (result.success) {
              const isNew = versions.length === 0;
              const isUpgrade = !isNew && result.installedVersion !== versions[versions.length - 1];
              if (isNew) {
                cliSpinner.succeed(`Installed ${agent.name}@${result.installedVersion}`);
                createShim(agentId);
              } else if (isUpgrade) {
                cliSpinner.succeed(`Upgraded ${agent.name} to ${result.installedVersion}`);
                createShim(agentId);
              } else {
                cliSpinner.succeed(`${agent.name}@${result.installedVersion} (up to date)`);
              }
            } else {
              cliSpinner.warn(`${agent.name}: ${result.error}`);
            }
          }
        }

        // Determine which agents should share central resources
        let cliStates = await getAllCliStates();
        let selectedAgents: AgentId[];

        // Track version selections per agent: agent -> versions[]
        // Empty array means not version-managed (install directly to ~/.{agent}/)
        const agentVersionSelections = new Map<AgentId, string[]>();

        const formatAgentLabel = (agentId: AgentId): string => {
          const versions = listInstalledVersions(agentId);
          const defaultVer = getGlobalDefault(agentId);
          if (versions.length === 0) return `${AGENTS[agentId].name}  ${chalk.gray('(not installed)')}`;
          if (defaultVer) return `${AGENTS[agentId].name}  ${chalk.gray(`(active: ${defaultVer})`)}`;
          return `${AGENTS[agentId].name}  ${chalk.gray(`(${versions[0]})`)}`;
        };

        if (agentFilter) {
          const versions = listInstalledVersions(agentFilter);
          const defaultVer = getGlobalDefault(agentFilter);

          if (versions.length > 1 && !options.yes && !options.force) {
            const versionEmails = await Promise.all(
              versions.map((v) =>
                getAccountEmail(agentFilter, getVersionHomePath(agentFilter, v)).then((email) => ({ v, email }))
              )
            );
            const versionEmailMap = new Map(versionEmails.map((e) => [e.v, e.email]));

            const maxLabelLen = Math.max(...versions.map((v) => (v === defaultVer ? `${v} (default)` : v).length));
            const versionResult = await checkbox<string>({
              message: `Which versions of ${AGENTS[agentFilter].name} should receive these resources?`,
              choices: [
                { name: chalk.bold('All versions'), value: 'all', checked: false },
                ...versions.map((v) => {
                  const base = v === defaultVer ? `${v} (default)` : v;
                  let label = base.padEnd(maxLabelLen);
                  const email = versionEmailMap.get(v);
                  if (email) label += chalk.cyan(`  ${email}`);
                  return { name: label, value: v, checked: v === defaultVer };
                }),
              ],
            });
            if (versionResult.includes('all')) {
              agentVersionSelections.set(agentFilter, [...versions]);
            } else {
              agentVersionSelections.set(agentFilter, versionResult);
            }
          } else if (versions.length === 1) {
            agentVersionSelections.set(agentFilter, [versions[0]]);
          } else if (versions.length > 1) {
            // --yes/--force: select default or all
            agentVersionSelections.set(agentFilter, defaultVer ? [defaultVer] : [...versions]);
          }
          // else: no versions installed, not version-managed

          selectedAgents = [agentFilter];
          const selectedVers = agentVersionSelections.get(agentFilter);
          if (selectedVers && selectedVers.length > 0) {
            console.log(`\nTarget: ${AGENTS[agentFilter].name} ${chalk.gray(`(${selectedVers.join(', ')})`)}\n`);
          } else {
            console.log(`\nTarget: ${AGENTS[agentFilter].name}\n`);
          }
        } else if (options.yes || options.force) {
          selectedAgents = (manifest?.defaults?.agents || ALL_AGENT_IDS) as AgentId[];
          const installed = selectedAgents.filter((id) => cliStates[id]?.installed || id === 'cursor');
          // Auto-select default version for each agent
          for (const agentId of installed) {
            const versions = listInstalledVersions(agentId);
            if (versions.length > 0) {
              const defaultVer = getGlobalDefault(agentId);
              agentVersionSelections.set(agentId, defaultVer ? [defaultVer] : [versions[versions.length - 1]]);
            }
          }
          if (installed.length > 0) {
            console.log(chalk.bold('\nTarget agents:\n'));
            for (const agentId of installed) {
              console.log(`  ${formatAgentLabel(agentId)}`);
            }
            console.log();
          }
        } else {
          const installedAgents = ALL_AGENT_IDS.filter((id) => cliStates[id]?.installed || id === 'cursor');
          const defaultAgents = (manifest?.defaults?.agents || ALL_AGENT_IDS) as AgentId[];
          const allDefaulted = installedAgents.every((id) => defaultAgents.includes(id));

          const checkboxResult = await checkbox<string>({
            message: 'Which agents should receive these resources?',
            choices: [
              { name: chalk.bold('All'), value: 'all', checked: allDefaulted },
              ...installedAgents.map((id) => ({
                name: `  ${formatAgentLabel(id)}`,
                value: id,
                checked: !allDefaulted && defaultAgents.includes(id),
              })),
            ],
          });

          if (checkboxResult.includes('all')) {
            selectedAgents = [...installedAgents];
          } else {
            selectedAgents = checkboxResult as AgentId[];
          }

          // Version selection per agent (only for version-managed agents)
          for (const agentId of selectedAgents) {
            const versions = listInstalledVersions(agentId);
            if (versions.length === 0) continue; // not version-managed
            if (versions.length === 1) {
              agentVersionSelections.set(agentId, [versions[0]]);
              continue;
            }
            const defaultVer = getGlobalDefault(agentId);
            const versionEmails = await Promise.all(
              versions.map((v) =>
                getAccountEmail(agentId, getVersionHomePath(agentId, v)).then((email) => ({ v, email }))
              )
            );
            const versionEmailMap = new Map(versionEmails.map((e) => [e.v, e.email]));

            const maxLabelLen = Math.max(...versions.map((v) => (v === defaultVer ? `${v} (default)` : v).length));
            const versionResult = await checkbox<string>({
              message: `Which versions of ${AGENTS[agentId].name} should receive these resources?`,
              choices: [
                { name: chalk.bold('All versions'), value: 'all', checked: false },
                ...versions.map((v) => {
                  const base = v === defaultVer ? `${v} (default)` : v;
                  let label = base.padEnd(maxLabelLen);
                  const email = versionEmailMap.get(v);
                  if (email) label += chalk.cyan(`  ${email}`);
                  return { name: label, value: v, checked: v === defaultVer };
                }),
              ],
            });
            if (versionResult.includes('all')) {
              agentVersionSelections.set(agentId, [...versions]);
            } else {
              agentVersionSelections.set(agentId, versionResult);
            }
          }
        }

        // Filter agents to only installed ones (plus cursor which doesn't need CLI)
        selectedAgents = selectedAgents.filter((id) => cliStates[id]?.installed || id === 'cursor');

        if (selectedAgents.length === 0) {
          console.log(chalk.yellow('\nNo agents selected or installed. Nothing to sync.'));
          return;
        }

        // Build resource items with conflict detection
        const newItems: ResourceItem[] = [];
        const existingItems: ResourceItem[] = [];
        const upToDateItems: ResourceItem[] = [];

        // Process commands
        for (const command of allCommands) {
          const sourcePath = resolveCommandSource(localPath, command.name);
          if (!sourcePath) continue;

          const newAgents = selectedAgents.filter((agentId) => !commandExists(agentId, command.name));
          const upToDateAgents = selectedAgents.filter((agentId) => {
            if (!commandExists(agentId, command.name)) return false;
            return commandContentMatches(agentId, command.name, sourcePath);
          });
          const conflictingAgents = selectedAgents.filter((agentId) => {
            if (!commandExists(agentId, command.name)) return false;
            return !commandContentMatches(agentId, command.name, sourcePath);
          });

          if (newAgents.length > 0) {
            newItems.push({ type: 'command', name: command.name, agents: newAgents, isNew: true });
          }
          if (upToDateAgents.length > 0) {
            upToDateItems.push({ type: 'command', name: command.name, agents: upToDateAgents, isNew: false });
          }
          if (conflictingAgents.length > 0) {
            existingItems.push({ type: 'command', name: command.name, agents: conflictingAgents, isNew: false });
          }
        }

        // Process skills
        const skillAgents = SKILLS_CAPABLE_AGENTS.filter((id) => selectedAgents.includes(id));
        for (const skill of allSkills) {
          const newAgents = skillAgents.filter((agentId) => !skillExists(agentId, skill.name));
          const upToDateAgents = skillAgents.filter((agentId) => {
            if (!skillExists(agentId, skill.name)) return false;
            return skillContentMatches(agentId, skill.name, skill.path);
          });
          const conflictingAgents = skillAgents.filter((agentId) => {
            if (!skillExists(agentId, skill.name)) return false;
            return !skillContentMatches(agentId, skill.name, skill.path);
          });

          if (newAgents.length > 0) {
            newItems.push({ type: 'skill', name: skill.name, agents: newAgents, isNew: true });
          }
          if (upToDateAgents.length > 0) {
            upToDateItems.push({ type: 'skill', name: skill.name, agents: upToDateAgents, isNew: false });
          }
          if (conflictingAgents.length > 0) {
            existingItems.push({ type: 'skill', name: skill.name, agents: conflictingAgents, isNew: false });
          }
        }

        // Process hooks
        const hookAgents = selectedAgents.filter(
          (id) => HOOKS_CAPABLE_AGENTS.includes(id as typeof HOOKS_CAPABLE_AGENTS[number]) && cliStates[id]?.installed
        );
        const uniqueHookNames = [...new Set(discoveredHooks)];

        for (const hookName of uniqueHookNames) {
          const newAgents = hookAgents.filter((agentId) => !hookExists(agentId, hookName));
          const upToDateAgents = hookAgents.filter((agentId) => {
            if (!hookExists(agentId, hookName)) return false;
            const sourceEntry = getSourceHookEntry(localPath, hookName);
            return sourceEntry && hookContentMatches(agentId, hookName, sourceEntry);
          });
          const conflictingAgents = hookAgents.filter((agentId) => {
            if (!hookExists(agentId, hookName)) return false;
            const sourceEntry = getSourceHookEntry(localPath, hookName);
            return !sourceEntry || !hookContentMatches(agentId, hookName, sourceEntry);
          });

          if (newAgents.length > 0) {
            newItems.push({ type: 'hook', name: hookName, agents: newAgents, isNew: true });
          }
          if (upToDateAgents.length > 0) {
            upToDateItems.push({ type: 'hook', name: hookName, agents: upToDateAgents, isNew: false });
          }
          if (conflictingAgents.length > 0) {
            existingItems.push({ type: 'hook', name: hookName, agents: conflictingAgents, isNew: false });
          }
        }

        // Process MCPs (no content comparison - just existence check)
        if (!options.skipMcp && manifest?.mcp) {
          for (const [name, config] of Object.entries(manifest.mcp)) {
            if (config.transport === 'http' || !config.command) continue;
            const eligible = config.agents?.length ? config.agents : selectedAgents;
            const mcpAgents = eligible.filter((agentId) => selectedAgents.includes(agentId) && cliStates[agentId]?.installed);
            if (mcpAgents.length === 0) continue;

            const registrationChecks = await Promise.all(
              mcpAgents.map(async (agentId) => ({
                agentId,
                isRegistered: await isMcpRegistered(agentId, name),
              }))
            );
            const conflictingAgents = registrationChecks.filter((r) => r.isRegistered).map((r) => r.agentId);
            const newAgents = registrationChecks.filter((r) => !r.isRegistered).map((r) => r.agentId);

            if (conflictingAgents.length > 0) {
              existingItems.push({ type: 'mcp', name, agents: conflictingAgents, isNew: false });
            }
            if (newAgents.length > 0) {
              newItems.push({ type: 'mcp', name, agents: newAgents, isNew: true });
            }
          }
        }

        // Process agent-specific memory files
        for (const instr of allInstructions) {
          if (!selectedAgents.includes(instr.agentId)) continue;

          const hasExisting = instructionsExists(instr.agentId, 'user');
          if (!hasExisting) {
            newItems.push({ type: 'memory', name: AGENTS[instr.agentId].instructionsFile, agents: [instr.agentId], isNew: true });
          } else if (instructionsContentMatches(instr.agentId, instr.sourcePath, 'user')) {
            upToDateItems.push({ type: 'memory', name: AGENTS[instr.agentId].instructionsFile, agents: [instr.agentId], isNew: false });
          } else {
            existingItems.push({ type: 'memory', name: AGENTS[instr.agentId].instructionsFile, agents: [instr.agentId], isNew: false });
          }
        }

        // Process additional repo memory files (for example SOUL.md)
        const normalizedMemoryContent = (content: string) => content.replace(/\r\n/g, '\n').trim();
        const agentMemoryNames = new Set(
          allInstructions.map((instr) => AGENTS[instr.agentId].instructionsFile)
        );
        const centralMemoryDir = getMemoryDir();

        for (const memoryFile of allMemoryFiles) {
          if (agentMemoryNames.has(memoryFile)) continue;

          const sourcePath = path.join(localPath, 'memory', memoryFile);
          const targetPath = path.join(centralMemoryDir, memoryFile);

          if (!fs.existsSync(targetPath)) {
            newItems.push({ type: 'memory', name: memoryFile, agents: [], isNew: true });
            continue;
          }

          try {
            const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
            const targetContent = fs.readFileSync(targetPath, 'utf-8');
            if (normalizedMemoryContent(sourceContent) === normalizedMemoryContent(targetContent)) {
              upToDateItems.push({ type: 'memory', name: memoryFile, agents: [], isNew: false });
            } else {
              existingItems.push({ type: 'memory', name: memoryFile, agents: [], isNew: false });
            }
          } catch {
            existingItems.push({ type: 'memory', name: memoryFile, agents: [], isNew: false });
          }
        }

        // Process jobs
        for (const discoveredJob of allDiscoveredJobs) {
          if (!jobExists(discoveredJob.name)) {
            newItems.push({ type: 'job', name: discoveredJob.name, agents: [], isNew: true });
          } else if (jobContentMatches(discoveredJob.name, discoveredJob.path)) {
            upToDateItems.push({ type: 'job', name: discoveredJob.name, agents: [], isNew: false });
          } else {
            existingItems.push({ type: 'job', name: discoveredJob.name, agents: [], isNew: false });
          }
        }

        // Process drives
        for (const discoveredDrive of allDiscoveredDrives) {
          if (!driveExists(discoveredDrive.name)) {
            newItems.push({ type: 'drive', name: discoveredDrive.name, agents: [], isNew: true });
          } else if (driveContentMatches(discoveredDrive.name, discoveredDrive.path)) {
            upToDateItems.push({ type: 'drive', name: discoveredDrive.name, agents: [], isNew: false });
          } else {
            existingItems.push({ type: 'drive', name: discoveredDrive.name, agents: [], isNew: false });
          }
        }

        // Display overview
        console.log(chalk.bold('\nOverview\n'));

        const formatAgentList = (agents: AgentId[]) =>
          agents.map((id) => AGENTS[id].name).join(', ');

        const syncedAgentNames = selectedAgents.map((id) => AGENTS[id].name).join(', ');
        console.log(`  Target: ${chalk.cyan(syncedAgentNames)}\n`);

        if (newItems.length > 0) {
          console.log(chalk.green('  NEW (will install):\n'));
          const byType = { command: [] as ResourceItem[], skill: [] as ResourceItem[], hook: [] as ResourceItem[], mcp: [] as ResourceItem[], memory: [] as ResourceItem[], job: [] as ResourceItem[], drive: [] as ResourceItem[] };
          for (const item of newItems) byType[item.type].push(item);

          // Central resources - shared across all synced agents
          if (byType.command.length > 0) {
            console.log(`    Commands ${chalk.gray('(~/.agents/commands/)')}:`);
            for (const item of byType.command) {
              console.log(`      ${chalk.cyan(item.name)}`);
            }
          }
          if (byType.skill.length > 0) {
            console.log(`    Skills ${chalk.gray('(~/.agents/skills/)')}:`);
            for (const item of byType.skill) {
              console.log(`      ${chalk.cyan(item.name)}`);
            }
          }
          if (byType.hook.length > 0) {
            console.log(`    Hooks ${chalk.gray('(~/.agents/hooks/)')}:`);
            for (const item of byType.hook) {
              console.log(`      ${chalk.cyan(item.name)}`);
            }
          }
          if (byType.memory.length > 0) {
            console.log(`    Memory ${chalk.gray('(~/.agents/memory/)')}:`);
            for (const item of byType.memory) {
              console.log(`      ${chalk.cyan(item.name)}`);
            }
          }

          // Per-agent resources
          if (byType.mcp.length > 0) {
            console.log(`    MCP Servers:`);
            for (const item of byType.mcp) {
              console.log(`      ${chalk.cyan(item.name)}`);
            }
          }
          if (byType.job.length > 0) {
            console.log(`    Jobs ${chalk.gray('(~/.agents/jobs/)')}:`);
            for (const item of byType.job) {
              console.log(`      ${chalk.cyan(item.name)}`);
            }
          }
          if (byType.drive.length > 0) {
            console.log(`    Drives ${chalk.gray('(~/.agents/drives/)')}:`);
            for (const item of byType.drive) {
              console.log(`      ${chalk.cyan(item.name)}`);
            }
          }
          console.log();
        }


        if (existingItems.length > 0) {
          console.log(chalk.yellow('  CONFLICTS (will prompt):\n'));
          const byType = { command: [] as ResourceItem[], skill: [] as ResourceItem[], hook: [] as ResourceItem[], mcp: [] as ResourceItem[], memory: [] as ResourceItem[], job: [] as ResourceItem[], drive: [] as ResourceItem[] };
          for (const item of existingItems) byType[item.type].push(item);

          // Central resources
          if (byType.command.length > 0) {
            console.log(`    Commands: ${chalk.yellow(byType.command.map(i => i.name).join(', '))}`);
          }
          if (byType.skill.length > 0) {
            console.log(`    Skills: ${chalk.yellow(byType.skill.map(i => i.name).join(', '))}`);
          }
          if (byType.hook.length > 0) {
            console.log(`    Hooks: ${chalk.yellow(byType.hook.map(i => i.name).join(', '))}`);
          }
          if (byType.memory.length > 0) {
            console.log(`    Memory: ${chalk.yellow(byType.memory.map(i => i.name).join(', '))}`);
          }

          // Per-agent resources
          if (byType.mcp.length > 0) {
            console.log(`    MCP Servers:`);
            for (const item of byType.mcp) {
              console.log(`      ${chalk.yellow(item.name.padEnd(20))} ${chalk.gray(formatAgentList(item.agents))}`);
            }
          }
          if (byType.job.length > 0) {
            console.log(`    Jobs: ${chalk.yellow(byType.job.map(i => i.name).join(', '))}`);
          }
          if (byType.drive.length > 0) {
            console.log(`    Drives: ${chalk.yellow(byType.drive.map(i => i.name).join(', '))}`);
          }
          console.log();
        }

        if (newItems.length === 0 && existingItems.length === 0) {
          console.log(chalk.gray('  Already up to date.\n'));
          return;
        }

        if (options.dryRun) {
          console.log(chalk.yellow('Dry run - no changes made'));
          return;
        }

        // Confirmation prompt
        if (!options.yes && !options.force) {
          const proceed = await confirm({
            message: 'Proceed with installation?',
            default: true,
          });
          if (!proceed) {
            console.log(chalk.yellow('\nCancelled'));
            return;
          }
        }

        // Per-resource conflict decisions
        const decisions = new Map<string, ResourceDecision>();

        if (existingItems.length > 0 && !options.force && !options.yes) {
          console.log(chalk.bold('\nResolve conflicts:\n'));

          for (const item of existingItems) {
            const typeLabel = item.type.charAt(0).toUpperCase() + item.type.slice(1);
            const agentList = formatAgentList(item.agents);
            const conflictContext = agentList ? ` (${agentList})` : '';

            const decision = await select({
              message: `${typeLabel} '${item.name}' exists${conflictContext}`,
              choices: [
                { name: 'Overwrite', value: 'overwrite' as const },
                { name: 'Skip', value: 'skip' as const },
                { name: 'Cancel all', value: 'cancel' as const },
              ],
            });

            if (decision === 'cancel') {
              console.log(chalk.yellow('\nCancelled'));
              return;
            }

            decisions.set(`${item.type}:${item.name}`, decision);
          }
        } else if (options.force) {
          // Force mode: overwrite all
          for (const item of existingItems) {
            decisions.set(`${item.type}:${item.name}`, 'overwrite');
          }
        } else if (options.yes) {
          // Yes mode: skip all conflicts
          for (const item of existingItems) {
            decisions.set(`${item.type}:${item.name}`, 'skip');
          }
        }

        // Install new items (no conflicts)
        console.log();
        let installed = { commands: 0, skills: 0, hooks: 0, mcps: 0, memory: 0, jobs: 0, drives: 0 };
        let skipped = { commands: 0, skills: 0, hooks: 0, mcps: 0, memory: 0, jobs: 0, drives: 0 };

        // Install commands to central ~/.agents/commands/
        const cmdSpinner = ora('Installing commands to central storage...').start();
        const seenCommands = new Set<string>();
        for (const item of [...newItems, ...existingItems].filter((i) => i.type === 'command')) {
          if (seenCommands.has(item.name)) continue;
          seenCommands.add(item.name);

          const decision = item.isNew ? 'overwrite' : decisions.get(`command:${item.name}`);
          if (decision === 'skip') {
            skipped.commands++;
            continue;
          }

          // Find source path
          const sourcePath = resolveCommandSource(localPath, item.name);
          if (sourcePath) {
            const result = installCommandCentrally(sourcePath, item.name);
            if (result.error) {
              console.log(chalk.yellow(`\n  Warning: ${item.name}: ${result.error}`));
            } else {
              installed.commands++;
            }
          }
        }
        if (skipped.commands > 0) {
          cmdSpinner.succeed(`Installed ${installed.commands} commands (skipped ${skipped.commands})`);
        } else if (installed.commands > 0) {
          cmdSpinner.succeed(`Installed ${installed.commands} commands`);
        } else {
          cmdSpinner.info('No commands to install');
        }

        // Install skills to central ~/.agents/skills/
        const skillItems = [...newItems, ...existingItems].filter((i) => i.type === 'skill');
        if (skillItems.length > 0) {
          const skillSpinner = ora('Installing skills to central storage...').start();
          for (const item of skillItems) {
            const decision = item.isNew ? 'overwrite' : decisions.get(`skill:${item.name}`);
            if (decision === 'skip') {
              skipped.skills++;
              continue;
            }

            const skill = allSkills.find((s) => s.name === item.name);
            if (skill) {
              const result = installSkillCentrally(skill.path, skill.name);
              if (result.success) installed.skills++;
            }
          }
          if (skipped.skills > 0) {
            skillSpinner.succeed(`Installed ${installed.skills} skills (skipped ${skipped.skills})`);
          } else if (installed.skills > 0) {
            skillSpinner.succeed(`Installed ${installed.skills} skills`);
          } else {
            skillSpinner.info('No skills to install');
          }
        }

        // Install hooks to central ~/.agents/hooks/
        const hookItems = [...newItems, ...existingItems].filter((i) => i.type === 'hook');
        if (hookItems.length > 0) {
          const hookSpinner = ora('Installing hooks to central storage...').start();
          const result = await installHooksCentrally(localPath);
          if (result.installed.length > 0) {
            hookSpinner.succeed(`Installed ${result.installed.length} hooks`);
            installed.hooks = result.installed.length;
          } else {
            hookSpinner.info('No hooks to install');
          }
        }

        // Register MCP servers
        const mcpItems = [...newItems, ...existingItems].filter((i) => i.type === 'mcp');
        if (mcpItems.length > 0 && manifest?.mcp) {
          const mcpSpinner = ora('Registering MCP servers...').start();
          for (const item of mcpItems) {
            const decision = item.isNew ? 'overwrite' : decisions.get(`mcp:${item.name}`);
            if (decision === 'skip') {
              skipped.mcps++;
              continue;
            }

            const config = manifest.mcp[item.name];
            if (!config || !config.command) continue;

            for (const agentId of item.agents) {
              if (!item.isNew) {
                const vl = agentVersionSelections.get(agentId) || [];
                if (vl.length > 0) {
                  for (const ver of vl) {
                    const home = getVersionHomePath(agentId, ver);
                    const binary = getBinaryPath(agentId, ver);
                    await unregisterMcp(agentId, item.name, { home, binary });
                  }
                } else {
                  await unregisterMcp(agentId, item.name);
                }
              }
              const versionsList = agentVersionSelections.get(agentId) || [];
              if (versionsList.length > 0) {
                // Version-managed: register MCP into each selected version's HOME
                // Use the actual binary to bypass the shim (shim uses $HOME/.agents which breaks with HOME override)
                for (const ver of versionsList) {
                  const home = getVersionHomePath(agentId, ver);
                  const binary = getBinaryPath(agentId, ver);
                  const result = await registerMcp(agentId, item.name, config.command, config.scope, config.transport || 'stdio', { home, binary });
                  if (result.success) {
                    installed.mcps++;
                  } else {
                    mcpSpinner.stop();
                    console.log(chalk.yellow(`  Warning: ${item.name} (${AGENTS[agentId].name}@${ver}): ${result.error}`));
                    mcpSpinner.start();
                  }
                }
              } else {
                // Not version-managed: register normally to ~/.{agent}/
                const result = await registerMcp(agentId, item.name, config.command, config.scope, config.transport || 'stdio');
                if (result.success) {
                  installed.mcps++;
                } else {
                  mcpSpinner.stop();
                  console.log(chalk.yellow(`  Warning: ${item.name} (${AGENTS[agentId].name}): ${result.error}`));
                  mcpSpinner.start();
                }
              }
            }
          }
          if (skipped.mcps > 0) {
            mcpSpinner.succeed(`Registered ${installed.mcps} MCP servers (skipped ${skipped.mcps})`);
          } else if (installed.mcps > 0) {
            mcpSpinner.succeed(`Registered ${installed.mcps} MCP servers`);
          } else {
            mcpSpinner.info('No MCP servers to register');
          }
        }

        // --clean: remove MCPs not in manifest
        if (options.clean && manifest?.mcp) {
          const manifestMcpNames = new Set(Object.keys(manifest.mcp));
          let removed = 0;

          for (const agentId of selectedAgents) {
            const versionsList = agentVersionSelections.get(agentId) || [];

            if (versionsList.length > 0) {
              for (const ver of versionsList) {
                const home = getVersionHomePath(agentId, ver);
                const configPath = getMcpConfigPathForHome(agentId, home);
                const installedMcps = parseMcpConfig(agentId, configPath);
                const binary = getBinaryPath(agentId, ver);

                for (const name of Object.keys(installedMcps)) {
                  if (!manifestMcpNames.has(name)) {
                    await unregisterMcp(agentId, name, { home, binary });
                    removed++;
                  }
                }
              }
            } else {
              const installedList = listInstalledMcpsWithScope(agentId, process.cwd(), { home: getEffectiveHome(agentId) });
              for (const mcp of installedList.filter(m => m.scope === 'user')) {
                if (!manifestMcpNames.has(mcp.name)) {
                  await unregisterMcp(agentId, mcp.name);
                  removed++;
                }
              }
            }
          }

          if (removed > 0) {
            console.log(chalk.green(`  Removed ${removed} MCP servers not in repo`));
          }
        }

        // Install memory files to central ~/.agents/memory/
        const memoryItems = [...newItems, ...existingItems].filter((i) => i.type === 'memory');
        if (memoryItems.length > 0) {
          const memoryNames = [...new Set(memoryItems.map((item) => item.name))];
          const selectedMemoryNames = memoryNames.filter((name) => {
            const memoryItem = memoryItems.find((item) => item.name === name);
            if (!memoryItem || memoryItem.isNew) return true;
            const decision = decisions.get(`memory:${name}`);
            return decision !== 'skip';
          });

          skipped.memory = memoryNames.length - selectedMemoryNames.length;

          if (selectedMemoryNames.length === 0) {
            const instrSpinner = ora('Installing memory files to central storage...').start();
            instrSpinner.info('No memory files to install');
          } else {
            const instrSpinner = ora('Installing memory files to central storage...').start();
            const memResult = installInstructionsCentrally(localPath, selectedMemoryNames);
            if (memResult.installed.length > 0) {
              if (skipped.memory > 0) {
                instrSpinner.succeed(`Installed ${memResult.installed.length} memory files (skipped ${skipped.memory})`);
              } else {
                instrSpinner.succeed(`Installed ${memResult.installed.length} memory files`);
              }
              installed.memory = memResult.installed.length;
            } else {
              instrSpinner.info('No memory files to install');
            }
          }
        }

        // Install jobs
        const jobItems = [...newItems, ...existingItems].filter((i) => i.type === 'job');
        if (jobItems.length > 0) {
          const jobSpinner = ora('Installing jobs...').start();
          for (const item of jobItems) {
            const decision = item.isNew ? 'overwrite' : decisions.get(`job:${item.name}`);
            if (decision === 'skip') {
              skipped.jobs++;
              continue;
            }

            const discovered = allDiscoveredJobs.find((j) => j.name === item.name);
            if (discovered) {
              const result = installJobFromSource(discovered.path, discovered.name);
              if (result.success) {
                installed.jobs++;
              } else {
                console.log(chalk.yellow(`\n  Warning: job ${item.name}: ${result.error}`));
              }
            }
          }
          if (skipped.jobs > 0) {
            jobSpinner.succeed(`Installed ${installed.jobs} jobs (skipped ${skipped.jobs})`);
          } else if (installed.jobs > 0) {
            jobSpinner.succeed(`Installed ${installed.jobs} jobs`);
          } else {
            jobSpinner.info('No jobs to install');
          }

          if (installed.jobs > 0 && isDaemonRunning()) {
            signalDaemonReload();
          }
        }

        // Install drives
        const driveItems = [...newItems, ...existingItems].filter((i) => i.type === 'drive');
        if (driveItems.length > 0) {
          const driveSpinner = ora('Installing drives...').start();
          for (const item of driveItems) {
            const decision = item.isNew ? 'overwrite' : decisions.get(`drive:${item.name}`);
            if (decision === 'skip') {
              skipped.drives++;
              continue;
            }

            const discovered = allDiscoveredDrives.find((d) => d.name === item.name);
            if (discovered) {
              const result = installDriveFromSource(discovered.path, discovered.name);
              if (result.success) {
                installed.drives++;
              } else {
                console.log(chalk.yellow(`\n  Warning: drive ${item.name}: ${result.error}`));
              }
            }
          }
          if (skipped.drives > 0) {
            driveSpinner.succeed(`Installed ${installed.drives} drives (skipped ${skipped.drives})`);
          } else if (installed.drives > 0) {
            driveSpinner.succeed(`Installed ${installed.drives} drives`);
          } else {
            driveSpinner.info('No drives to install');
          }
        }

        // Sync central resources into version-managed agent homes
        const versionSyncedAgents: string[] = [];
        for (const agentId of selectedAgents) {
          const versionsList = agentVersionSelections.get(agentId) || [];
          for (const ver of versionsList) {
            syncResourcesToVersion(agentId, ver);
            versionSyncedAgents.push(`${AGENTS[agentId].name}@${ver}`);
          }
        }
        if (versionSyncedAgents.length > 0) {
          const syncSpinner = ora('Linking resources to version homes...').start();
          syncSpinner.succeed(`Linked resources to ${versionSyncedAgents.join(', ')}`);
        }

        // Update scope config
        if (!isReadonly) {
          const priority = getRepoPriority(effectiveRepo);
          setRepo(effectiveRepo, {
            source: targetSource,
            branch: parsed.ref || 'main',
            commit,
            lastSync: new Date().toISOString(),
            priority,
            readonly: false,
          });
        }

        console.log(chalk.green(`\nPull complete`));
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          process.exit(0);
        }
        spinner.fail('Failed to sync');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
