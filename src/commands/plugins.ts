/**
 * Plugin management commands.
 *
 * Registers the `agents plugins` command tree for listing, viewing,
 * syncing, and removing plugin bundles (skills + hooks + permissions)
 * stored in ~/.agents/plugins/.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { checkbox } from '@inquirer/prompts';

import { AGENTS, PLUGINS_CAPABLE_AGENTS, agentLabel } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { discoverPlugins, getPlugin, pluginSupportsAgent, removePluginFromVersion } from '../lib/plugins.js';
import {
  listInstalledVersions,
  syncResourcesToVersion,
  getGlobalDefault,
  getVersionHomePath,
} from '../lib/versions.js';
import { isPluginSynced } from '../lib/plugins.js';
import {
  isPromptCancelled,
  isInteractiveTerminal,
  requireDestructiveArg,
  requireInteractiveSelection,
} from './utils.js';
import { itemPicker } from '../lib/picker.js';
import type { DiscoveredPlugin } from '../lib/types.js';
import {
  showResourceList,
  buildTargetsSection,
  type ResourceRow,
  type SyncTarget,
} from './resource-view.js';
import { getPluginsDir } from '../lib/state.js';

/** Replace the home directory prefix with ~ for display. */
function formatPath(p: string): string {
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

/** Register the `agents plugins` command tree. */
export function registerPluginsCommands(program: Command): void {
  const pluginsCmd = program
    .command('plugins')
    .description('Bundle skills, hooks, and permissions into distributable packages')
    .addHelpText('after', `
Plugins are directories in ~/.agents/plugins/ that bundle skills, hooks, and permission sets into a single installable unit. Each plugin declares which agents it supports and what resources it provides. When you sync a version, agents-cli installs the plugin's contents to that agent's home.

Examples:
  # Interactive picker (TTY) or sync-status table (piped)
  agents plugins list

  # View details for a specific plugin
  agents plugins view rush-toolkit

  # Sync a plugin to specific agents
  agents plugins sync rush-toolkit claude

  # Remove a plugin from all agents and delete its source
  agents plugins remove rush-toolkit

When to use:
  - Distribution: package related skills, hooks, and permissions for easy sharing
  - Version control: sync plugins selectively to different agent versions
  - Team onboarding: distribute a full toolkit via a single plugin directory
`);

  // Shared list implementation — reused by `list` and the bare `agents plugins` default.
  const runList = async () => {
    const plugins = discoverPlugins();

    if (plugins.length === 0) {
      console.log(chalk.gray('No plugins found in ~/.agents/plugins/'));
      console.log(chalk.gray('Plugins are directories with .claude-plugin/plugin.json'));
      return;
    }

    await showResourceList({
      resourcePlural: 'plugins',
      resourceSingular: 'plugin',
      extraLabel: 'Version',
      rows: buildPluginRows(plugins),
      emptyMessage: 'No plugins in ~/.agents/plugins/.',
      centralPath: getPluginsDir(),
    });
  };

  // Bare `agents plugins` → same as `list`.
  pluginsCmd.action(runList);

  // agents plugins list
  pluginsCmd
    .command('list')
    .description('Show plugins in a table with sync status across agent versions')
    .action(runList);

  // agents plugins info [name]
  pluginsCmd
    .command('info [name]')
    .alias('view')
    .description('Show plugin metadata, resources, and installation status across agent versions')
    .addHelpText('after', `
Examples:
  # View details for a plugin
  agents plugins view rush-toolkit

  # 'info' is kept as an alias
  agents plugins info rush-toolkit
`)
    .action(async (nameArg?: string) => {
      let name = nameArg;

      // No name → pick one from the installed plugins.
      if (!name) {
        const discovered = discoverPlugins();
        if (discovered.length === 0) {
          console.log(chalk.gray('No plugins installed in ~/.agents/plugins/'));
          return;
        }
        if (!isInteractiveTerminal()) {
          requireInteractiveSelection('Picking a plugin for `agents plugins info`', [
            'agents plugins info <name>',
            'agents plugins  # to see installed plugins',
          ]);
        }
        try {
          const picked = await itemPicker<DiscoveredPlugin>({
            message: 'Select a plugin:',
            items: discovered,
            filter: (q) => {
              const t = q.trim().toLowerCase();
              if (!t) return discovered;
              return discovered.filter((p) =>
                `${p.name} ${p.manifest.description || ''}`.toLowerCase().includes(t)
              );
            },
            labelFor: (p) => {
              const desc = p.manifest.description ? ` — ${chalk.gray(p.manifest.description)}` : '';
              return `${chalk.cyan(p.name)} ${chalk.gray(`v${p.manifest.version}`)}${desc}`;
            },
            shortIdFor: (p) => p.name,
            pageSize: 10,
            emptyMessage: 'No plugins match.',
            enterHint: 'view info',
          });
          if (!picked) return;
          name = picked.item.name;
        } catch (err) {
          if (isPromptCancelled(err)) return;
          throw err;
        }
      }

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
        .map(a => agentLabel(a));
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
          console.log(`    ${agentLabel(agentId)}@${label}: ${status}`);
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
    .description('Apply a plugin to the default version of an agent (or all supported agents if none specified)')
    .addHelpText('after', `
Examples:
  # Sync a plugin to a specific agent (default version)
  agents plugins sync rush-toolkit claude

  # Sync to all supported agents
  agents plugins sync rush-toolkit
`)
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
          console.log(chalk.red(`Plugin '${name}' does not support ${agentLabel(agentId)}`));
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
            console.log(chalk.green(`Synced ${name} to ${agentLabel(agentId)}@${version}`));
          } else {
            console.log(chalk.gray(`${name} already synced to ${agentLabel(agentId)}@${version}`));
          }
        }
      }
    });

  // agents plugins remove [name]
  pluginsCmd
    .command('remove [name]')
    .description('Unsync a plugin from all agent versions and optionally delete its source directory')
    .option('--keep-source', 'Keep the directory at ~/.agents/plugins/<name> (only unsync from agents)')
    .addHelpText('after', `
Examples:
  # Remove plugin from agents and delete source
  agents plugins remove rush-toolkit

  # Unsync but keep source directory
  agents plugins remove rush-toolkit --keep-source
`)
    .action((nameArg: string | undefined, options: { keepSource?: boolean }) => {
      if (!nameArg) {
        requireDestructiveArg({
          argName: 'name',
          command: 'agents plugins remove',
          itemNoun: 'plugin',
          available: discoverPlugins().map((p) => p.name),
          emptyHint: 'No plugins installed.',
        });
      }
      const name = nameArg;
      const pluginsDir = path.join(process.env.HOME || '', '.agents', 'plugins');
      const pluginRoot = path.join(pluginsDir, name);

      // Use discovered plugin when present; fall back to name+root if source is already gone
      const plugin = getPlugin(name);
      const resolvedRoot = plugin?.root || pluginRoot;

      if (!plugin && !fs.existsSync(pluginRoot)) {
        console.log(chalk.red(`Plugin '${name}' not found`));
        process.exit(1);
      }

      let totalSkills = 0;
      let totalHooks = 0;
      let totalPerms = 0;
      let versionsTouched = 0;

      for (const agentId of PLUGINS_CAPABLE_AGENTS) {
        const versions = listInstalledVersions(agentId);
        for (const version of versions) {
          const versionHome = getVersionHomePath(agentId, version);
          const r = removePluginFromVersion(name, resolvedRoot, agentId, versionHome);
          if (r.skills.length > 0 || r.hooks.length > 0 || r.permissions > 0) {
            versionsTouched += 1;
            totalSkills += r.skills.length;
            totalHooks += r.hooks.length;
            totalPerms += r.permissions;
            console.log(
              chalk.gray(
                `  ${agentLabel(agentId)}@${version}: ${r.skills.length} skill(s), ${r.hooks.length} hook(s), ${r.permissions} perm(s)`
              )
            );
          }
        }
      }

      console.log(
        chalk.green(
          `Unsynced ${name} from ${versionsTouched} version(s) — ${totalSkills} skills, ${totalHooks} hooks, ${totalPerms} permissions`
        )
      );

      if (!options.keepSource) {
        if (fs.existsSync(pluginRoot)) {
          fs.rmSync(pluginRoot, { recursive: true, force: true });
          console.log(chalk.green(`Deleted ${formatPath(pluginRoot)}`));
        }
      } else {
        console.log(chalk.gray(`Kept source at ${formatPath(pluginRoot)}`));
      }
    });
}

/** Convert discovered plugins into rows suitable for the resource list view. */
function buildPluginRows(plugins: DiscoveredPlugin[]): ResourceRow[] {
  const rows: ResourceRow[] = [];

  // Cache version lists per agent once.
  const versionsByAgent = new Map<AgentId, string[]>();
  const defaultsByAgent = new Map<AgentId, string | null>();
  for (const agent of PLUGINS_CAPABLE_AGENTS) {
    versionsByAgent.set(agent, listInstalledVersions(agent));
    defaultsByAgent.set(agent, getGlobalDefault(agent));
  }

  for (const plugin of plugins) {
    const targets: SyncTarget[] = [];

    for (const agent of PLUGINS_CAPABLE_AGENTS) {
      if (!pluginSupportsAgent(plugin, agent)) continue;
      for (const version of versionsByAgent.get(agent) || []) {
        const versionHome = getVersionHomePath(agent, version);
        const installed = isPluginSynced(plugin, agent, versionHome);
        targets.push({
          agent,
          version,
          isDefault: defaultsByAgent.get(agent) === version,
          status: installed ? 'synced' : 'missing',
        });
      }
    }

    rows.push({
      name: plugin.name,
      description: plugin.manifest.description,
      extra: plugin.manifest.version ? `v${plugin.manifest.version}` : '-',
      targets,
      buildDetail: () => formatPluginDetail(plugin, targets),
    });
  }

  rows.sort((a, b) => {
    const aSynced = a.targets.filter((t) => t.status === 'synced').length;
    const bSynced = b.targets.filter((t) => t.status === 'synced').length;
    if (aSynced !== bSynced) return bSynced - aSynced;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

/** Build the multi-line detail pane shown when a plugin is selected in the picker. */
function formatPluginDetail(plugin: DiscoveredPlugin, targets: SyncTarget[]): string {
  const lines: string[] = [];

  const title = plugin.manifest.version
    ? `${chalk.bold.cyan(plugin.name)} ${chalk.gray(`v${plugin.manifest.version}`)}`
    : chalk.bold.cyan(plugin.name);
  lines.push(title);

  if (plugin.manifest.description) {
    lines.push(chalk.gray(plugin.manifest.description));
  }

  const supported = PLUGINS_CAPABLE_AGENTS
    .filter((a) => pluginSupportsAgent(plugin, a))
    .map((a) => agentLabel(a));
  if (supported.length > 0) {
    lines.push('  ' + chalk.gray('Supports: ') + supported.join(chalk.gray(' · ')));
  }
  lines.push('  ' + chalk.gray(formatPath(plugin.root)));

  if (plugin.skills.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Skills'));
    lines.push('  ' + plugin.skills.map((s) => chalk.cyan(s)).join(chalk.gray(', ')));
  }

  if (plugin.hooks.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Hooks'));
    lines.push('  ' + plugin.hooks.map((h) => chalk.yellow(h)).join(chalk.gray(', ')));
  }

  if (plugin.scripts.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Scripts'));
    lines.push('  ' + plugin.scripts.map((s) => chalk.white(s)).join(chalk.gray(', ')));
  }

  if (targets.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Synced to'));
    lines.push(buildTargetsSection(targets));
  } else {
    lines.push('');
    lines.push(chalk.gray('  No supported agent versions installed.'));
  }

  return lines.join('\n');
}
