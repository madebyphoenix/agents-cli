import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

import {
  AGENTS,
  ALL_AGENT_IDS,
  MCP_CAPABLE_AGENTS,
  getAllCliStates,
  registerMcp,
} from '../lib/agents.js';
import type { AgentId, RegistryType } from '../lib/types.js';
import { DEFAULT_REGISTRIES } from '../lib/types.js';
import {
  getRegistries,
  setRegistry,
  removeRegistry,
  search as searchRegistries,
  resolvePackage,
} from '../lib/registry.js';
import { cloneRepo } from '../lib/git.js';
import {
  discoverCommands,
  resolveCommandSource,
  installCommand,
} from '../lib/commands.js';
import {
  discoverSkillsFromRepo,
  installSkill,
} from '../lib/skills.js';
import {
  discoverHooksFromRepo,
  installHooks,
} from '../lib/hooks.js';
import { listInstalledVersions } from '../lib/versions.js';

export function registerPackagesCommands(program: Command): void {
  // ==========================================================================
  // REGISTRY COMMANDS
  // ==========================================================================

  const registryCmd = program
    .command('registry')
    .description('Manage package registries');

  registryCmd
    .command('list')
    .description('List configured registries')
    .option('-t, --type <type>', 'Filter by type: mcp or skill')
    .action((options) => {
      const types: RegistryType[] = options.type ? [options.type] : ['mcp', 'skill'];

      console.log(chalk.bold('Configured Registries\n'));

      for (const type of types) {
        console.log(chalk.bold(`  ${type.toUpperCase()}`));

        const registries = getRegistries(type);
        const entries = Object.entries(registries);

        if (entries.length === 0) {
          console.log(chalk.gray('    No registries configured'));
        } else {
          for (const [name, config] of entries) {
            const status = config.enabled ? chalk.green('enabled') : chalk.gray('disabled');
            const isDefault = DEFAULT_REGISTRIES[type]?.[name] ? chalk.gray(' (default)') : '';
            console.log(`    ${name}${isDefault}: ${status}`);
            console.log(chalk.gray(`      ${config.url}`));
          }
        }
        console.log();
      }
    });

  registryCmd
    .command('add <type> <name> <url>')
    .description('Add a registry (type: mcp or skill)')
    .option('--api-key <key>', 'API key for authentication')
    .action((type: string, name: string, url: string, options) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      setRegistry(type as RegistryType, name, {
        url,
        enabled: true,
        apiKey: options.apiKey,
      });

      console.log(chalk.green(`Added ${type} registry '${name}'`));
    });

  registryCmd
    .command('remove <type> <name>')
    .description('Remove a registry')
    .action((type: string, name: string) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      // Check if it's a default registry
      if (DEFAULT_REGISTRIES[type as RegistryType]?.[name]) {
        console.log(chalk.yellow(`Cannot remove default registry '${name}'. Use 'agents registry disable' instead.`));
        process.exit(1);
      }

      if (removeRegistry(type as RegistryType, name)) {
        console.log(chalk.green(`Removed ${type} registry '${name}'`));
      } else {
        console.log(chalk.yellow(`Registry '${name}' not found`));
      }
    });

  registryCmd
    .command('enable <type> <name>')
    .description('Enable a registry')
    .action((type: string, name: string) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      const registries = getRegistries(type as RegistryType);
      if (!registries[name]) {
        console.log(chalk.yellow(`Registry '${name}' not found`));
        process.exit(1);
      }

      setRegistry(type as RegistryType, name, { enabled: true });
      console.log(chalk.green(`Enabled ${type} registry '${name}'`));
    });

  registryCmd
    .command('disable <type> <name>')
    .description('Disable a registry')
    .action((type: string, name: string) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      const registries = getRegistries(type as RegistryType);
      if (!registries[name]) {
        console.log(chalk.yellow(`Registry '${name}' not found`));
        process.exit(1);
      }

      setRegistry(type as RegistryType, name, { enabled: false });
      console.log(chalk.green(`Disabled ${type} registry '${name}'`));
    });

  registryCmd
    .command('config <type> <name>')
    .description('Configure a registry')
    .option('--api-key <key>', 'Set API key')
    .option('--url <url>', 'Update URL')
    .action((type: string, name: string, options) => {
      if (type !== 'mcp' && type !== 'skill') {
        console.log(chalk.red(`Invalid type '${type}'. Use 'mcp' or 'skill'.`));
        process.exit(1);
      }

      const registries = getRegistries(type as RegistryType);
      if (!registries[name]) {
        console.log(chalk.yellow(`Registry '${name}' not found`));
        process.exit(1);
      }

      const updates: Record<string, unknown> = {};
      if (options.apiKey) updates.apiKey = options.apiKey;
      if (options.url) updates.url = options.url;

      if (Object.keys(updates).length === 0) {
        console.log(chalk.yellow('No options provided. Use --api-key or --url.'));
        process.exit(1);
      }

      setRegistry(type as RegistryType, name, updates);
      console.log(chalk.green(`Updated ${type} registry '${name}'`));
    });

  // ==========================================================================
  // SEARCH COMMAND
  // ==========================================================================

  program
    .command('search <query>')
    .description('Search package registries')
    .option('-t, --type <type>', 'Filter by type: mcp or skill')
    .option('-r, --registry <name>', 'Search specific registry')
    .option('-l, --limit <n>', 'Max results', '20')
    .action(async (query: string, options) => {
      const spinner = ora('Searching registries...').start();

      try {
        const results = await searchRegistries(query, {
          type: options.type as RegistryType | undefined,
          registry: options.registry,
          limit: parseInt(options.limit, 10),
        });

        spinner.stop();

        if (results.length === 0) {
          console.log(chalk.yellow('\nNo packages found.'));

          if (!options.type) {
            console.log(chalk.gray('\nTip: skill registries not yet available. Use gh:user/repo for skills.'));
          }
          return;
        }

        console.log(chalk.bold(`Found ${results.length} packages`));

        // Group by type
        const mcpResults = results.filter((r) => r.type === 'mcp');
        const skillResults = results.filter((r) => r.type === 'skill');

        if (mcpResults.length > 0) {
          console.log(chalk.bold('\n  MCP Servers'));
          for (const result of mcpResults) {
            const desc = result.description
              ? chalk.gray(` - ${result.description.slice(0, 50)}${result.description.length > 50 ? '...' : ''}`)
              : '';
            console.log(`    ${chalk.cyan(result.name)}${desc}`);
            console.log(chalk.gray(`      Registry: ${result.registry}  Install: agents add mcp:${result.name}`));
          }
        }

        if (skillResults.length > 0) {
          console.log(chalk.bold('\n  Skills'));
          for (const result of skillResults) {
            const desc = result.description
              ? chalk.gray(` - ${result.description.slice(0, 50)}${result.description.length > 50 ? '...' : ''}`)
              : '';
            console.log(`    ${chalk.cyan(result.name)}${desc}`);
            console.log(chalk.gray(`      Registry: ${result.registry}  Install: agents add skill:${result.name}`));
          }
        }
      } catch (err) {
        spinner.fail('Search failed');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  // ==========================================================================
  // INSTALL COMMAND (unified package installation)
  // ==========================================================================

  program
    .command('install <identifier>')
    .description('Install a package from a registry or Git source')
    .option('-a, --agents <list>', 'Comma-separated agents to install to')
    .action(async (identifier: string, options) => {
      const spinner = ora('Resolving package...').start();

      try {
        const resolved = await resolvePackage(identifier);

        if (!resolved) {
          spinner.fail('Package not found');
          console.log(chalk.gray('\nTip: Use explicit prefix (mcp:, skill:, gh:) or check the identifier.'));
          process.exit(1);
        }

        spinner.succeed(`Found ${resolved.type} package`);

        if (resolved.type === 'mcp') {
          // Install MCP server
          const entry = resolved.mcpEntry;
          if (!entry) {
            console.log(chalk.red('Failed to get MCP server details'));
            process.exit(1);
          }

          console.log(chalk.bold(`\n${entry.name}`));
          if (entry.description) {
            console.log(chalk.gray(`  ${entry.description}`));
          }
          if (entry.repository?.url) {
            console.log(chalk.gray(`  ${entry.repository.url}`));
          }

          // Get package info
          const pkg = entry.packages?.[0];
          if (!pkg) {
            console.log(chalk.yellow('\nNo installable package found for this server.'));
            console.log(chalk.gray('You may need to install it manually.'));
            process.exit(1);
          }

          console.log(chalk.bold('\nPackage:'));
          console.log(`  Name: ${pkg.name || pkg.registry_name}`);
          console.log(`  Runtime: ${pkg.runtime || 'unknown'}`);
          console.log(`  Transport: ${pkg.transport || 'stdio'}`);

          if (pkg.packageArguments && pkg.packageArguments.length > 0) {
            console.log(chalk.bold('\nRequired arguments:'));
            for (const arg of pkg.packageArguments) {
              const req = arg.required ? chalk.red('*') : '';
              console.log(`  ${arg.name}${req}: ${arg.description || ''}`);
            }
          }

          // Determine command based on runtime
          let command: string;
          if (pkg.runtime === 'node') {
            command = `npx -y ${pkg.name || pkg.registry_name}`;
          } else if (pkg.runtime === 'python') {
            command = `uvx ${pkg.name || pkg.registry_name}`;
          } else {
            command = pkg.name || pkg.registry_name;
          }

          const cliStates = await getAllCliStates();
          const agents = options.agents
            ? (options.agents.split(',') as AgentId[])
            : MCP_CAPABLE_AGENTS.filter((id) => cliStates[id]?.installed);

          if (agents.length === 0) {
            console.log(chalk.yellow('\nNo MCP-capable agents installed.'));
            process.exit(1);
          }

          console.log(chalk.bold('\nInstalling to agents...'));
          for (const agentId of agents) {
            if (!cliStates[agentId]?.installed) continue;

            const result = await registerMcp(agentId, entry.name, command, 'user');
            if (result.success) {
              console.log(`  ${chalk.green('+')} ${AGENTS[agentId].name}`);
            } else {
              console.log(`  ${chalk.red('x')} ${AGENTS[agentId].name}: ${result.error}`);
            }
          }

          console.log(chalk.green('\nMCP server installed.'));
        } else if (resolved.type === 'git' || resolved.type === 'skill') {
          // Install from git source (skills/commands/hooks)
          console.log(chalk.bold(`\nInstalling from ${resolved.source}`));

          const { localPath } = await cloneRepo(resolved.source);

          // Discover what's in the repo
          const commands = discoverCommands(localPath);
          const skills = discoverSkillsFromRepo(localPath);
          const hooks = discoverHooksFromRepo(localPath);

          const hasCommands = commands.length > 0;
          const hasSkills = skills.length > 0;
          const hasHooks = hooks.length > 0;

          if (!hasCommands && !hasSkills && !hasHooks) {
            console.log(chalk.yellow('No installable content found in repository.'));
            process.exit(1);
          }

          console.log(chalk.bold('\nFound:'));
          if (hasCommands) console.log(`  ${commands.length} commands`);
          if (hasSkills) console.log(`  ${skills.length} skills`);
          if (hasHooks) console.log(`  ${hooks.length} hooks`);

          const agents = options.agents
            ? (options.agents.split(',') as AgentId[])
            : ALL_AGENT_IDS;

          const gitCliStates = await getAllCliStates();
          // Install commands
          if (hasCommands) {
            console.log(chalk.bold('\nInstalling commands...'));
            let installed = 0;
            let failed = 0;
            for (const command of commands) {
              for (const agentId of agents) {
                if (!gitCliStates[agentId]?.installed && listInstalledVersions(agentId).length === 0) continue;

                const sourcePath = resolveCommandSource(localPath, command.name);
                if (sourcePath) {
                  const result = installCommand(sourcePath, agentId, command.name, 'symlink');
                  if (result.error) {
                    failed++;
                  } else {
                    installed++;
                  }
                }
              }
            }
            if (failed > 0) {
              console.log(`  Installed ${installed} command instances (${failed} failed)`);
            } else {
              console.log(`  Installed ${installed} command instances`);
            }
          }

          // Install skills
          if (hasSkills) {
            console.log(chalk.bold('\nInstalling skills...'));
            for (const skill of skills) {
              const result = installSkill(skill.path, skill.name, agents);
              if (result.success) {
                console.log(`  ${chalk.green('+')} ${skill.name}`);
              } else {
                console.log(`  ${chalk.red('x')} ${skill.name}: ${result.error}`);
              }
            }
          }

          // Install hooks
          if (hasHooks) {
            console.log(chalk.bold('\nInstalling hooks...'));
            const hookAgents = agents.filter((id) => AGENTS[id].supportsHooks) as AgentId[];
            const result = await installHooks(localPath, hookAgents, { scope: 'user' });
            console.log(`  Installed ${result.installed.length} hooks`);
          }

          console.log(chalk.green('\nPackage installed.'));
        }
      } catch (err) {
        spinner.fail('Installation failed');
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
