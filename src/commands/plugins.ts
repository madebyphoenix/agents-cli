import type { Command } from 'commander';
import chalk from 'chalk';
import { checkbox } from '@inquirer/prompts';

import { AGENTS, PLUGINS_CAPABLE_AGENTS } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { discoverPlugins, getPlugin, pluginSupportsAgent } from '../lib/plugins.js';
import {
  listInstalledVersions,
  syncResourcesToVersion,
  getGlobalDefault,
  getVersionHomePath,
} from '../lib/versions.js';
import { isPluginSynced } from '../lib/plugins.js';
import { isPromptCancelled } from './utils.js';

function formatPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

export function registerPluginsCommands(program: Command): void {
  const pluginsCmd = program
    .command('plugins')
    .description('Manage agent plugins');

  // agents plugins (default: list)
  pluginsCmd
    .action(() => {
      const plugins = discoverPlugins();

      if (plugins.length === 0) {
        console.log(chalk.gray('No plugins found in ~/.agents/plugins/'));
        console.log(chalk.gray('Plugins are directories with .claude-plugin/plugin.json'));
        return;
      }

      console.log(chalk.bold('\nPlugins'));
      console.log();

      for (const plugin of plugins) {
        const agents = PLUGINS_CAPABLE_AGENTS
          .filter(a => pluginSupportsAgent(plugin, a))
          .map(a => AGENTS[a].name);

        console.log(`  ${chalk.cyan(plugin.name)} ${chalk.gray(`v${plugin.manifest.version}`)}`);
        console.log(`    ${plugin.manifest.description}`);
        console.log(`    ${chalk.gray(`Agents: ${agents.join(', ')}`)}`);

        if (plugin.skills.length > 0) {
          console.log(`    ${chalk.gray(`Skills: ${plugin.skills.join(', ')}`)}`);
        }
        if (plugin.hooks.length > 0) {
          console.log(`    ${chalk.gray(`Hooks: ${plugin.hooks.join(', ')}`)}`);
        }
        if (plugin.scripts.length > 0) {
          console.log(`    ${chalk.gray(`Scripts: ${plugin.scripts.join(', ')}`)}`);
        }

        // Show which versions have this plugin installed
        for (const agentId of PLUGINS_CAPABLE_AGENTS) {
          if (!pluginSupportsAgent(plugin, agentId)) continue;
          const versions = listInstalledVersions(agentId);
          const synced: string[] = [];
          for (const v of versions) {
            const versionHome = getVersionHomePath(agentId, v);
            if (isPluginSynced(plugin, agentId, versionHome)) {
              const defaultVer = getGlobalDefault(agentId);
              synced.push(v === defaultVer ? `${v} (active)` : v);
            }
          }
          if (synced.length > 0) {
            console.log(`    ${chalk.green(`${AGENTS[agentId].name}: ${synced.join(', ')}`)}`);
          }
        }

        console.log();
      }
    });

  // agents plugins info <name>
  pluginsCmd
    .command('info <name>')
    .description('Show plugin details')
    .action((name: string) => {
      const plugin = getPlugin(name);
      if (!plugin) {
        console.log(chalk.red(`Plugin '${name}' not found`));
        console.log(chalk.gray('Run "agents plugins" to list available plugins'));
        process.exit(1);
      }

      console.log(chalk.bold(`\n${plugin.name}`));
      console.log(`  ${plugin.manifest.description}`);
      console.log(`  ${chalk.gray(`Version: ${plugin.manifest.version}`)}`);
      console.log(`  ${chalk.gray(`Path: ${formatPath(plugin.root)}`)}`);

      const agents = PLUGINS_CAPABLE_AGENTS
        .filter(a => pluginSupportsAgent(plugin, a))
        .map(a => AGENTS[a].name);
      console.log(`  ${chalk.gray(`Agents: ${agents.join(', ')}`)}`);

      if (plugin.skills.length > 0) {
        console.log(chalk.bold('\n  Skills'));
        for (const skill of plugin.skills) {
          console.log(`    ${chalk.cyan(`${plugin.name}:${skill}`)}`);
        }
      }

      if (plugin.hooks.length > 0) {
        console.log(chalk.bold('\n  Hooks'));
        for (const hook of plugin.hooks) {
          console.log(`    ${chalk.yellow(hook)}`);
        }
      }

      if (plugin.scripts.length > 0) {
        console.log(chalk.bold('\n  Scripts'));
        for (const script of plugin.scripts) {
          console.log(`    ${chalk.gray(script)}`);
        }
      }

      // Show installation status per agent version
      console.log(chalk.bold('\n  Installation Status'));
      let anyInstalled = false;
      for (const agentId of PLUGINS_CAPABLE_AGENTS) {
        if (!pluginSupportsAgent(plugin, agentId)) continue;
        const versions = listInstalledVersions(agentId);
        if (versions.length === 0) continue;

        for (const v of versions) {
          const versionHome = getVersionHomePath(agentId, v);
          const synced = isPluginSynced(plugin, agentId, versionHome);
          const defaultVer = getGlobalDefault(agentId);
          const label = v === defaultVer ? `${v} (active)` : v;
          const status = synced ? chalk.green('installed') : chalk.gray('not installed');
          console.log(`    ${AGENTS[agentId].name}@${label}: ${status}`);
          if (synced) anyInstalled = true;
        }
      }
      if (!anyInstalled) {
        console.log(chalk.gray('    Not installed to any version'));
        console.log(chalk.gray('    Run "agents use <agent>@<version>" to sync plugins'));
      }

      console.log();
    });

  // agents plugins sync <name> [agent]
  pluginsCmd
    .command('sync <name> [agent]')
    .description('Sync a plugin to agent versions')
    .action(async (name: string, agentArg?: string) => {
      const plugin = getPlugin(name);
      if (!plugin) {
        console.log(chalk.red(`Plugin '${name}' not found`));
        process.exit(1);
      }

      // Determine target agents
      let targetAgents: AgentId[];
      if (agentArg) {
        const agentId = agentArg as AgentId;
        if (!PLUGINS_CAPABLE_AGENTS.includes(agentId)) {
          console.log(chalk.red(`Agent '${agentArg}' does not support plugins`));
          process.exit(1);
        }
        if (!pluginSupportsAgent(plugin, agentId)) {
          console.log(chalk.red(`Plugin '${name}' does not support ${AGENTS[agentId].name}`));
          process.exit(1);
        }
        targetAgents = [agentId];
      } else {
        targetAgents = PLUGINS_CAPABLE_AGENTS.filter(a => pluginSupportsAgent(plugin, a));
      }

      for (const agentId of targetAgents) {
        const versions = listInstalledVersions(agentId);
        if (versions.length === 0) continue;

        const defaultVer = getGlobalDefault(agentId);
        const targetVersions = defaultVer ? [defaultVer] : [versions[versions.length - 1]];

        for (const version of targetVersions) {
          const syncResult = syncResourcesToVersion(agentId, version, { plugins: [name] });
          if (syncResult.plugins.length > 0) {
            console.log(chalk.green(`Synced ${name} to ${AGENTS[agentId].name}@${version}`));
          } else {
            console.log(chalk.gray(`${name} already synced to ${AGENTS[agentId].name}@${version}`));
          }
        }
      }
    });
}
