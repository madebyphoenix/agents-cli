import type { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import * as os from 'os';

import {
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  readDaemonPid,
  readDaemonLog,
  runDaemon,
  log,
} from '../lib/daemon.js';
import { listJobs as listAllJobs } from '../lib/routines.js';
import { JobScheduler } from '../lib/scheduler.js';
import {
  FactoryClient,
  loadDaemonConfig,
  saveDaemonConfig,
  getMachineStats,
  getAgentVersions,
  type SessionData,
  type SyncRequest,
} from '../lib/factory.js';
import { discoverSessions } from '../lib/session/discover.js';
import type { SessionMeta } from '../lib/session/types.js';

export function registerDaemonCommands(program: Command): void {
  const daemonCmd = program.command('daemon').description('Manage the jobs daemon');

  daemonCmd
    .command('start')
    .description('Start the daemon')
    .action(() => {
      const result = startDaemon();
      if (result.method === 'already-running') {
        console.log(chalk.yellow(`Daemon already running (PID: ${result.pid})`));
      } else {
        console.log(chalk.green(`Daemon started (PID: ${result.pid}, method: ${result.method})`));
      }
    });

  daemonCmd
    .command('stop')
    .description('Stop the daemon')
    .action(() => {
      if (!isDaemonRunning()) {
        console.log(chalk.yellow('Daemon is not running'));
        return;
      }
      stopDaemon();
      console.log(chalk.green('Daemon stopped'));
    });

  daemonCmd
    .command('status')
    .description('Show daemon status')
    .action(() => {
      const running = isDaemonRunning();
      const pid = readDaemonPid();

      console.log(chalk.bold('Daemon Status\n'));
      console.log(`  Status:  ${running ? chalk.green('running') : chalk.gray('stopped')}`);
      if (pid) console.log(`  PID:     ${pid}`);

      const jobs = listAllJobs();
      const enabled = jobs.filter((j) => j.enabled);
      console.log(`  Jobs:    ${enabled.length} enabled / ${jobs.length} total`);

      if (running && enabled.length > 0) {
        const scheduler = new JobScheduler(async () => {});
        scheduler.loadAll();
        const scheduled = scheduler.listScheduled();
        console.log(chalk.bold('\n  Scheduled Jobs\n'));
        for (const job of scheduled) {
          const next = job.nextRun ? job.nextRun.toLocaleString() : 'unknown';
          console.log(`    ${chalk.cyan(job.name.padEnd(24))} next: ${chalk.gray(next)}`);
        }
        scheduler.stopAll();
      }
    });

  daemonCmd
    .command('logs')
    .description('Show daemon logs')
    .option('-n, --lines <number>', 'Number of lines to show', '50')
    .option('-f, --follow', 'Follow log output')
    .action(async (options) => {
      if (options.follow) {
        const { exec: execCb } = await import('child_process');
        const { getAgentsDir } = await import('../lib/state.js');
        const logPath = path.join(getAgentsDir(), 'daemon.log');
        const child = execCb(`tail -f "${logPath}"`);
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
        child.on('exit', () => process.exit(0));
        process.on('SIGINT', () => { child.kill(); process.exit(0); });
        return;
      }

      const lines = parseInt(options.lines, 10);
      const output = readDaemonLog(lines);
      if (output) {
        console.log(output);
      } else {
        console.log(chalk.gray('No daemon logs'));
      }
    });

  daemonCmd
    .command('_run', { hidden: true })
    .description('Run daemon in foreground (internal)')
    .action(async () => {
      await runDaemon();
    });

  // ---------------------------------------------------------------------------
  // Factory Floor reporting commands
  // ---------------------------------------------------------------------------

  daemonCmd
    .command('report')
    .description('Report local sessions to Factory Floor')
    .option('--node-token <token>', 'Node token from Factory Floor')
    .option('--endpoint <url>', 'Factory Floor endpoint (or AGENTS_FACTORY_URL env)', process.env.AGENTS_FACTORY_URL || 'https://agents.427yosemite.com')
    .option('--interval <seconds>', 'Sync interval in seconds', '30')
    .option('--once', 'Run once and exit (useful for testing)')
    .action(async (options) => {
      await runReportDaemon(options);
    });

  daemonCmd
    .command('register')
    .description('Register this machine with Factory Floor')
    .option('--endpoint <url>', 'Factory Floor endpoint (or AGENTS_FACTORY_URL env)', process.env.AGENTS_FACTORY_URL || 'https://agents.427yosemite.com')
    .option('--node-token <token>', 'API token for registration')
    .action(async (options) => {
      await registerNode(options);
    });

  daemonCmd
    .command('config')
    .description('Show or update daemon configuration')
    .option('--show', 'Show current configuration')
    .option('--clear', 'Clear stored configuration')
    .action(async (options) => {
      const config = loadDaemonConfig();

      if (options.clear) {
        saveDaemonConfig({});
        console.log(chalk.green('Configuration cleared'));
        return;
      }

      console.log(chalk.bold('Daemon Configuration\n'));
      console.log(`  Node ID:   ${config.nodeId || chalk.gray('(not registered)')}`);
      console.log(`  Endpoint:  ${config.endpoint || chalk.gray('(not set)')}`);
      console.log(`  Token:     ${config.nodeToken ? chalk.green('configured') : chalk.gray('(not set)')}`);
      if (config.lastSync) {
        const lastSync = new Date(config.lastSync).toLocaleString();
        console.log(`  Last Sync: ${lastSync}`);
      }
    });
}

// Convert SessionMeta to SessionData for API
function sessionMetaToData(meta: SessionMeta): SessionData {
  return {
    id: meta.id,
    agent: meta.agent,
    project: meta.project,
    branch: meta.gitBranch,
    workingDir: meta.cwd,
    startedAt: new Date(meta.timestamp).getTime(),
  };
}

async function registerNode(options: { endpoint: string; nodeToken?: string }): Promise<void> {
  const endpoint = options.endpoint;
  const token = options.nodeToken;

  if (!token) {
    console.error(chalk.red('Error: --node-token is required'));
    console.error(chalk.gray('Get a token from Factory Floor: Add Machine -> Copy Token'));
    process.exit(1);
  }

  console.log(`Registering with ${endpoint}...`);

  const client = new FactoryClient(endpoint, token);

  try {
    const result = await client.register();

    // Save to config
    saveDaemonConfig({
      nodeId: result.nodeId,
      nodeToken: result.token,
      endpoint,
    });

    console.log(chalk.green('\nRegistration successful!'));
    console.log(`  Node ID: ${result.nodeId}`);
    console.log(`  Token saved to ~/.agents/daemon.json`);
    console.log(chalk.gray('\nTo start reporting:'));
    console.log(chalk.cyan('  agents daemon report'));
  } catch (err) {
    console.error(chalk.red(`Registration failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

// Track consecutive failures for exponential backoff
let consecutiveFailures = 0;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes max

function getBackoffMs(failures: number): number {
  if (failures === 0) return 0;
  // Exponential backoff: 2^failures seconds, capped at MAX_BACKOFF_MS
  const backoffMs = Math.min(Math.pow(2, failures) * 1000, MAX_BACKOFF_MS);
  return backoffMs;
}

async function runReportDaemon(options: {
  nodeToken?: string;
  endpoint: string;
  interval: string;
  once?: boolean;
}): Promise<void> {
  // Load config, allowing CLI args to override
  const config = loadDaemonConfig();
  const nodeToken = options.nodeToken || config.nodeToken;
  const endpoint = options.endpoint || config.endpoint || 'https://agents.427yosemite.com';
  const interval = parseInt(options.interval, 10) * 1000;
  let nodeId = config.nodeId;

  if (!nodeToken) {
    console.error(chalk.red('Error: Node token required'));
    console.error(chalk.gray('Either:'));
    console.error(chalk.gray('  1. Register first: agents daemon register --node-token <token>'));
    console.error(chalk.gray('  2. Pass token directly: agents daemon report --node-token <token>'));
    process.exit(1);
  }

  let client = new FactoryClient(endpoint, nodeToken, nodeId);

  // Health check
  const healthy = await client.healthCheck();
  if (!healthy) {
    console.error(chalk.red(`Error: Cannot reach Factory Floor at ${endpoint}`));
    process.exit(1);
  }

  // Register if not already registered
  if (!nodeId) {
    console.log('No node ID found, registering...');
    try {
      const result = await client.register();
      nodeId = result.nodeId;
      saveDaemonConfig({
        ...config,
        nodeId: result.nodeId,
        nodeToken: result.token,
        endpoint,
      });
      // Recreate client with the returned node token (ntk_xxx)
      // The initial token was the API token used for registration
      client = new FactoryClient(endpoint, result.token, nodeId);
      console.log(chalk.green(`Registered as node ${nodeId}`));
    } catch (err) {
      console.error(chalk.red(`Registration failed: ${(err as Error).message}`));
      process.exit(1);
    }
  }

  console.log(chalk.bold('Factory Floor Reporter\n'));
  console.log(`  Node:     ${nodeId}`);
  console.log(`  Endpoint: ${endpoint}`);
  console.log(`  Interval: ${options.interval}s`);
  console.log(`  Machine:  ${os.hostname()} (${os.platform()}/${os.arch()})`);
  console.log('');

  if (options.once) {
    await syncOnce(client, nodeId!);
    return;
  }

  // Start sync loop
  console.log(chalk.gray('Starting sync loop... (Ctrl+C to stop)\n'));

  const handleShutdown = () => {
    console.log(chalk.yellow('\nShutting down...'));
    process.exit(0);
  };

  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);

  // Initial sync
  await syncOnce(client, nodeId!);

  // Periodic sync with exponential backoff on failures
  const runSyncLoop = async () => {
    while (true) {
      const backoffMs = getBackoffMs(consecutiveFailures);
      const waitMs = interval + backoffMs;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      await syncOnce(client, nodeId!);
    }
  };

  // Run the sync loop (never resolves)
  await runSyncLoop();
}

async function syncOnce(client: FactoryClient, nodeId: string): Promise<void> {
  try {
    // Discover local sessions
    const sessions = await discoverSessions({ limit: 100 });

    // For now, treat all discovered sessions as "active" (we don't have a reliable way
    // to detect completed sessions without tracking state)
    const activeSessions = sessions.map(sessionMetaToData);

    // Get machine stats
    const stats = getMachineStats();
    const versions = await getAgentVersions();

    const request: SyncRequest = {
      activeSessions,
      machineStats: {
        ...stats,
        agentVersions: versions,
      },
    };

    const response = await client.sync(nodeId, request);

    // Reset failure counter on success
    consecutiveFailures = 0;

    const config = loadDaemonConfig();
    saveDaemonConfig({ ...config, lastSync: Date.now() });

    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] Synced ${activeSessions.length} sessions (ack: ${response.acknowledged})`);

    // Handle commands from Factory Floor
    if (response.commands && response.commands.length > 0) {
      for (const cmd of response.commands) {
        console.log(chalk.cyan(`  Command: ${cmd.type} ${cmd.sessionId || ''}`));
        // TODO: Implement command handling (stop session, start task)
      }
    }
  } catch (err) {
    consecutiveFailures++;
    const backoffMs = getBackoffMs(consecutiveFailures);
    const timestamp = new Date().toLocaleTimeString();
    const backoffSec = Math.round(backoffMs / 1000);
    console.error(chalk.red(`[${timestamp}] Sync failed: ${(err as Error).message}`));
    if (backoffMs > 0) {
      console.error(chalk.yellow(`  Next retry in ${backoffSec}s (failure #${consecutiveFailures})`));
    }
    log('ERROR', `Sync failed: ${(err as Error).message}`);
  }
}
