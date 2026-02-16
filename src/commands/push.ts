import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';

import {
  AGENTS,
  ALL_AGENT_IDS,
  MCP_CAPABLE_AGENTS,
  getAllCliStates,
  listInstalledMcpsWithScope,
} from '../lib/agents.js';
import {
  readManifest,
  writeManifest,
  createDefaultManifest,
  MANIFEST_FILENAME,
} from '../lib/manifest.js';
import {
  getRepoLocalPath,
  getMemoryDir,
  getSkillsDir,
  getCommandsDir,
  getHooksDir,
  getRepo,
  setRepo,
  getRepoPriority,
} from '../lib/state.js';
import type { AgentId, RepoName } from '../lib/types.js';
import {
  getGitHubUsername,
  getRemoteUrl,
  setRemoteUrl,
  checkGitHubRepoExists,
  commitAndPush,
  hasUncommittedChanges,
  parseSource,
} from '../lib/git.js';
import { getEffectiveHome } from '../lib/versions.js';
import { isPromptCancelled } from './utils.js';

export function registerPushCommand(program: Command): void {
  program
    .command('push')
    .description('Export local config and push to your .agents repo')
    .option('-s, --scope <scope>', 'Target repo name', 'user')
    .option('--export-only', 'Export to local repo only (skip git push)')
    .option('-m, --message <msg>', 'Commit message', 'Update agent configuration')
    .action(async (options) => {
      try {
        const repoName = options.scope as RepoName;
        const repoConfig = getRepo(repoName);

        if (!repoConfig) {
          console.log(chalk.red(`Repo '${repoName}' not configured.`));
          console.log(chalk.gray('  Run: agents pull'));
          process.exit(1);
        }

        if (repoConfig.readonly) {
          console.log(chalk.red(`Repo '${repoName}' is readonly. Cannot push.`));
          process.exit(1);
        }

        const localPath = getRepoLocalPath(repoConfig.source);
        const manifest = readManifest(localPath) || createDefaultManifest();

        console.log(chalk.bold('\nExporting local configuration...\n'));

        const cliStates = await getAllCliStates();
        let exported = 0;

        for (const agentId of ALL_AGENT_IDS) {
          const agent = AGENTS[agentId];
          const cli = cliStates[agentId];

          if (cli?.installed && cli.version) {
            manifest.agents = manifest.agents || {};
            manifest.agents[agentId] = cli.version;
            console.log(`  ${chalk.green('+')} ${agent.name} @ ${cli.version}`);
            exported++;
          }
        }

        // Export MCP servers from installed agents
        console.log();
        let mcpExported = 0;
        const mcpByName = new Map<string, { command: string; agents: AgentId[] }>();

        for (const agentId of MCP_CAPABLE_AGENTS) {
          if (!cliStates[agentId]?.installed) continue;

          const mcps = listInstalledMcpsWithScope(agentId, process.cwd(), { home: getEffectiveHome(agentId) });
          for (const mcp of mcps) {
            if (mcp.scope !== 'user') continue; // Only export user-scoped MCPs

            const existing = mcpByName.get(mcp.name);
            if (existing) {
              if (!existing.agents.includes(agentId)) {
                existing.agents.push(agentId);
              }
            } else {
              mcpByName.set(mcp.name, {
                command: mcp.command || '',
                agents: [agentId],
              });
            }
          }
        }

        if (mcpByName.size > 0) {
          manifest.mcp = manifest.mcp || {};
          for (const [name, config] of mcpByName) {
            manifest.mcp[name] = {
              command: config.command,
              transport: 'stdio',
              agents: config.agents,
              scope: 'user',
            };
            console.log(`  ${chalk.green('+')} MCP: ${name} (${config.agents.map((id) => AGENTS[id].name).join(', ')})`);
            mcpExported++;
          }
        }

        // Export central resources to repo
        console.log();
        let resourcesExported = 0;

        const centralSkills = getSkillsDir();
        const centralCommands = getCommandsDir();
        const centralHooks = getHooksDir();
        const centralMemory = getMemoryDir();

        // Export skills to shared/skills/
        if (fs.existsSync(centralSkills)) {
          const skillNames = fs.readdirSync(centralSkills).filter((f) =>
            fs.statSync(path.join(centralSkills, f)).isDirectory()
          );
          if (skillNames.length > 0) {
            const targetDir = path.join(localPath, 'shared', 'skills');
            fs.mkdirSync(targetDir, { recursive: true });
            for (const name of skillNames) {
              const src = path.join(centralSkills, name);
              const dst = path.join(targetDir, name);
              fs.cpSync(src, dst, { recursive: true });
              console.log(`  ${chalk.green('+')} Skill: ${name}`);
              resourcesExported++;
            }
          }
        }

        // Export commands to shared/commands/
        if (fs.existsSync(centralCommands)) {
          const cmdFiles = fs.readdirSync(centralCommands).filter((f) => f.endsWith('.md'));
          if (cmdFiles.length > 0) {
            const targetDir = path.join(localPath, 'shared', 'commands');
            fs.mkdirSync(targetDir, { recursive: true });
            for (const file of cmdFiles) {
              const src = path.join(centralCommands, file);
              const dst = path.join(targetDir, file);
              fs.copyFileSync(src, dst);
              console.log(`  ${chalk.green('+')} Command: ${file.replace('.md', '')}`);
              resourcesExported++;
            }
          }
        }

        // Export hooks to shared/hooks/
        if (fs.existsSync(centralHooks)) {
          const hookFiles = fs.readdirSync(centralHooks);
          if (hookFiles.length > 0) {
            const targetDir = path.join(localPath, 'shared', 'hooks');
            fs.mkdirSync(targetDir, { recursive: true });
            for (const file of hookFiles) {
              const src = path.join(centralHooks, file);
              const dst = path.join(targetDir, file);
              const stat = fs.statSync(src);
              if (stat.isDirectory()) {
                fs.cpSync(src, dst, { recursive: true });
              } else {
                fs.copyFileSync(src, dst);
              }
              console.log(`  ${chalk.green('+')} Hook: ${file}`);
              resourcesExported++;
            }
          }
        }

        // Export memory files to memory/
        if (fs.existsSync(centralMemory)) {
          const memoryFiles = fs.readdirSync(centralMemory).filter((f) => f.endsWith('.md'));
          if (memoryFiles.length > 0) {
            const targetDir = path.join(localPath, 'memory');
            fs.mkdirSync(targetDir, { recursive: true });
            for (const file of memoryFiles) {
              const src = path.join(centralMemory, file);
              const dst = path.join(targetDir, file);
              fs.copyFileSync(src, dst);
              console.log(`  ${chalk.green('+')} Memory: ${file}`);
              resourcesExported++;
            }
          }
        }

        if (resourcesExported > 0) {
          console.log(chalk.gray(`\n  Exported ${resourcesExported} resources`));
        }

        writeManifest(localPath, manifest);
        console.log(chalk.bold(`\nUpdated ${MANIFEST_FILENAME}`));

        if (options.exportOnly) {
          console.log(chalk.bold('\nExport complete. Changes saved locally.'));
          console.log(chalk.gray(`  Path: ${localPath}`));
          return;
        }

        // Check if there are changes to push
        const hasChanges = await hasUncommittedChanges(localPath);
        if (!hasChanges) {
          console.log(chalk.green('\nNo changes to push.'));
          return;
        }

        // Get GitHub username
        const spinner = ora('Checking GitHub authentication...').start();
        const username = await getGitHubUsername();

        if (!username) {
          spinner.fail('GitHub CLI not authenticated');
          console.log(chalk.yellow('\nTo push changes, authenticate with GitHub:'));
          console.log(chalk.gray('  gh auth login'));
          console.log(chalk.gray('\nOr push manually:'));
          console.log(chalk.gray(`  cd ${localPath}`));
          console.log(chalk.gray('  git add -A && git commit -m "Update" && git push'));
          return;
        }

        spinner.text = 'Checking remote configuration...';

        // Check if remote is set to user's repo
        const currentRemote = await getRemoteUrl(localPath);
        const userRepoUrl = `https://github.com/${username}/.agents.git`;
        const isUserRepo = currentRemote?.includes(`${username}/.agents`);

        if (!isUserRepo) {
          // Check if user's repo exists on GitHub
          spinner.text = `Checking if ${username}/.agents exists...`;
          const repoExists = await checkGitHubRepoExists(username, '.agents');

          if (!repoExists) {
            spinner.fail(`Repository ${username}/.agents does not exist`);
            console.log(chalk.yellow('\nCreate your .agents repo on GitHub:'));
            console.log(chalk.cyan(`  gh repo create .agents --public --description "My agent configurations"`));
            console.log(chalk.gray('\nThen run: agents push'));
            return;
          }

          // Update remote to user's repo
          spinner.text = `Switching remote to ${username}/.agents...`;
          await setRemoteUrl(localPath, userRepoUrl);
        }

        // Commit and push
        spinner.text = 'Pushing changes...';
        const result = await commitAndPush(localPath, options.message);

        if (result.success) {
          spinner.succeed(`Pushed to ${username}/.agents`);
          console.log(chalk.green(`\nView: https://github.com/${username}/.agents`));
        } else {
          spinner.fail('Failed to push');
          console.log(chalk.red(result.error || 'Unknown error'));

          if (result.error?.includes('rejected')) {
            console.log(chalk.yellow('\nTry pulling first: agents pull'));
          }
        }
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          process.exit(0);
        }
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
