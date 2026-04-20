import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

import {
  AGENTS,
  ALL_AGENT_IDS,
  MCP_CAPABLE_AGENTS,
  getAllCliStates,
  listInstalledMcpsWithScope,
  agentLabel,
} from '../lib/agents.js';
import {
  readManifest,
  writeManifest,
  createDefaultManifest,
  MANIFEST_FILENAME,
} from '../lib/manifest.js';
import {
  getAgentsDir,
  ensureAgentsDir,
} from '../lib/state.js';
import type { AgentId } from '../lib/types.js';
import {
  isGitRepo,
  isSystemRepoOrigin,
  getGitHubUsername,
  checkGitHubRepoExists,
  initRepo,
  setRemoteUrl,
  commitAndPush,
  hasUncommittedChanges,
} from '../lib/git.js';
import { getEffectiveHome } from '../lib/versions.js';
import { isPromptCancelled } from './utils.js';

export function registerPushCommand(program: Command): void {
  program
    .command('push')
    .description('Save your local config changes to GitHub. Commits and pushes to your .agents repo.')
    .option('-m, --message <msg>', 'Commit message describing what changed', 'Update agent configuration')
    .option('--init', 'Initialize ~/.agents/ as a git repo if it is not already one')
    .addHelpText('after', `
Examples:
  # Push your changes with default commit message
  agents push

  # Push with a descriptive commit message
  agents push -m "Add custom skill for API testing"

  # Initialize git and push (first push ever)
  agents push --init

When to use:
  - After customizing commands, skills, hooks, or MCP configs
  - After installing new agent versions you want to track in agents.yaml
  - To sync your setup to another machine (push here, pull there)
  - Before switching machines so you don't lose local changes

What it pushes:
  - All files in ~/.agents/ (commands, skills, hooks, memory, mcp, plugins)
  - Updated agents.yaml with current CLI versions
  - Updated MCP server configs from each agent's settings

Blocked if:
  - Origin is the default system repo (run 'agents fork' first to create your own fork)
  - No GitHub remote configured (use --init to set one up)
`)
    .action(async (options) => {
      try {
        const agentsDir = getAgentsDir();
        ensureAgentsDir();

        // Check if ~/.agents/ is a git repo
        if (!isGitRepo(agentsDir)) {
          if (!options.init) {
            console.log(chalk.yellow('~/.agents/ is not a git repository.'));
            console.log(chalk.gray('\nTo initialize:'));
            console.log(chalk.cyan('  agents push --init'));
            console.log(chalk.gray('\nOr pull from existing repo first:'));
            console.log(chalk.cyan('  agents pull gh:username/.agents'));
            return;
          }

          // Initialize git repo
          const spinner = ora('Initializing git repository...').start();

          // Get GitHub username
          const username = await getGitHubUsername();
          if (!username) {
            spinner.fail('GitHub CLI not authenticated');
            console.log(chalk.gray('\nTo authenticate:'));
            console.log(chalk.cyan('  gh auth login'));
            return;
          }

          // Check if user's .agents repo exists
          const repoExists = await checkGitHubRepoExists(username, '.agents');
          if (!repoExists) {
            spinner.info(`Creating ${username}/.agents on GitHub...`);
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            try {
              await execAsync('gh repo create .agents --public --description "My agent configurations"');
              spinner.succeed(`Created ${username}/.agents`);
            } catch (err) {
              spinner.fail(`Failed to create repo: ${(err as Error).message}`);
              return;
            }
          }

          // Initialize and set remote
          await initRepo(agentsDir);
          await setRemoteUrl(agentsDir, `https://github.com/${username}/.agents.git`);
          spinner.succeed(`Initialized git repo with remote ${username}/.agents`);
        }

        // Check if origin is system repo (can't push there)
        if (await isSystemRepoOrigin(agentsDir)) {
          console.log(chalk.red("Can't push to the system repo."));
          console.log(chalk.gray('\nTo save your changes, fork the repo first:'));
          console.log(chalk.cyan('  agents fork'));
          return;
        }

        // Update manifest with current CLI versions and MCPs
        console.log(chalk.bold('\nUpdating manifest...\n'));

        const manifest = readManifest(agentsDir) || createDefaultManifest();
        const cliStates = await getAllCliStates();

        // Update CLI versions
        manifest.agents = manifest.agents || {};
        for (const agentId of ALL_AGENT_IDS) {
          const cli = cliStates[agentId];
          if (cli?.installed && cli.version) {
            manifest.agents[agentId] = cli.version;
            console.log(`  ${agentLabel(agentId)} @ ${cli.version}`);
          }
        }

        // Update MCP servers
        const mcpByName = new Map<string, { command: string; agents: AgentId[] }>();
        for (const agentId of MCP_CAPABLE_AGENTS) {
          if (!cliStates[agentId]?.installed) continue;

          const mcps = listInstalledMcpsWithScope(agentId, process.cwd(), { home: getEffectiveHome(agentId) });
          for (const mcp of mcps) {
            if (mcp.scope !== 'user' || !mcp.command) continue;

            const existing = mcpByName.get(mcp.name);
            if (existing) {
              if (!existing.agents.includes(agentId)) {
                existing.agents.push(agentId);
              }
            } else {
              mcpByName.set(mcp.name, {
                command: mcp.command,
                agents: [agentId],
              });
            }
          }
        }

        if (mcpByName.size > 0) {
          console.log();
          manifest.mcp = manifest.mcp || {};
          for (const [name, config] of mcpByName) {
            const existing = manifest.mcp[name];
            manifest.mcp[name] = {
              command: config.command,
              transport: 'stdio',
              agents: config.agents,
              ...(existing?.agentVersions ? { agentVersions: existing.agentVersions } : {}),
              scope: 'user',
            };
            console.log(`  ${chalk.cyan('MCP:')} ${name}`);
          }
        }

        writeManifest(agentsDir, manifest);
        console.log(chalk.gray(`\nUpdated ${MANIFEST_FILENAME}`));

        // Check for changes
        const hasChanges = await hasUncommittedChanges(agentsDir);
        if (!hasChanges) {
          console.log(chalk.green('\nNo changes to push.'));
          return;
        }

        // Commit and push
        const spinner = ora('Pushing changes...').start();

        const username = await getGitHubUsername();
        const result = await commitAndPush(agentsDir, options.message);

        if (result.success) {
          spinner.succeed('Pushed to GitHub');
          if (username) {
            console.log(chalk.green(`\nView: https://github.com/${username}/.agents`));
          }
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
