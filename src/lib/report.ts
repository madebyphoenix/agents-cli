// Daemon report functionality - reports local sessions to Factory Floor
// This runs as a long-running process that syncs sessions every 30 seconds

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import { discoverSessions } from './session/discover.js';
import type { SessionMeta } from './session/types.js';
import {
  FactoryClient,
  loadDaemonConfig,
  saveDaemonConfig,
  type SessionData,
  type SyncRequest,
} from './factory.js';
import { getAgentsDir, readMeta } from './state.js';

const SYNC_INTERVAL_MS = 30_000; // 30 seconds
const REPORT_LOG_FILE = 'report.log';
const REPORT_PID_FILE = 'report.pid';

function getLogPath(): string {
  return path.join(getAgentsDir(), REPORT_LOG_FILE);
}

function getPidPath(): string {
  return path.join(getAgentsDir(), REPORT_PID_FILE);
}

export function log(level: string, message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  fs.appendFileSync(getLogPath(), line, 'utf-8');
  if (process.env.AGENTS_REPORT_VERBOSE === '1') {
    process.stdout.write(line);
  }
}

export function isReportRunning(): boolean {
  const pidPath = getPidPath();
  if (!fs.existsSync(pidPath)) return false;

  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    try { fs.unlinkSync(pidPath); } catch {}
    return false;
  }
}

export function readReportPid(): number | null {
  const pidPath = getPidPath();
  if (!fs.existsSync(pidPath)) return null;
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function readReportLog(lines?: number): string {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) return '(no log file)';

  const content = fs.readFileSync(logPath, 'utf-8');
  if (!lines) return content;

  const allLines = content.split('\n');
  return allLines.slice(-lines).join('\n');
}

/**
 * Convert SessionMeta to SessionData for syncing.
 */
function sessionMetaToData(meta: SessionMeta): SessionData {
  return {
    id: meta.id,
    agent: meta.agent,
    version: meta.version,
    project: meta.project,
    branch: meta.gitBranch,
    workingDir: meta.cwd,
    startedAt: new Date(meta.timestamp).getTime(),
    // summary will be added by generateSessionSummary if needed
  };
}

/**
 * Get installed agent versions from the meta file.
 */
function getAgentVersions(): Record<string, string> {
  try {
    const meta = readMeta();
    return meta.agents || {};
  } catch {
    return {};
  }
}

/**
 * Get basic machine stats (CPU usage is expensive, skip for now).
 */
function getMachineStats(): SyncRequest['machineStats'] {
  return {
    memoryUsage: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    agentVersions: getAgentVersions(),
  };
}

/**
 * Discover OpenClaw sessions by running openclaw CLI commands.
 * This only works on machines where OpenClaw is installed.
 */
async function discoverOpenClawSessions(): Promise<SessionMeta[]> {
  const sessions: SessionMeta[] = [];

  try {
    // Check if openclaw is available
    execSync('which openclaw', { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    // OpenClaw not installed
    return sessions;
  }

  // Try to get active channels (each channel can be a "session")
  try {
    const output = execSync('openclaw channels status --json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const data = JSON.parse(output);

    // Convert OpenClaw channels to sessions
    if (data.channels && Array.isArray(data.channels)) {
      for (const channel of data.channels) {
        if (channel.connected) {
          sessions.push({
            id: `openclaw-${channel.id || channel.name}`,
            shortId: (channel.id || channel.name || '').slice(0, 8),
            agent: 'openclaw',
            timestamp: channel.connectedAt || new Date().toISOString(),
            project: channel.workspace || 'openclaw',
            filePath: '', // OpenClaw doesn't have session files
          });
        }
      }
    }
  } catch {
    // OpenClaw command failed or not available
  }

  // Also check cron jobs as "background sessions"
  try {
    const output = execSync('openclaw cron list --json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const data = JSON.parse(output);

    if (data.jobs && Array.isArray(data.jobs)) {
      for (const job of data.jobs) {
        if (job.enabled && job.lastRun) {
          sessions.push({
            id: `openclaw-cron-${job.id || job.name}`,
            shortId: (job.id || job.name || '').slice(0, 8),
            agent: 'openclaw' as any,
            timestamp: job.lastRun,
            project: job.name || 'cron',
            filePath: '',
            topic: job.schedule,
          });
        }
      }
    }
  } catch {
    // OpenClaw cron command failed
  }

  return sessions;
}

/**
 * Run the report daemon loop.
 * This should be called in a long-running process.
 */
export async function runReportDaemon(options: {
  nodeToken: string;
  endpoint: string;
}): Promise<void> {
  // Write PID file
  fs.writeFileSync(getPidPath(), String(process.pid), 'utf-8');
  log('INFO', `Report daemon started (PID: ${process.pid})`);
  log('INFO', `Endpoint: ${options.endpoint}`);

  const client = new FactoryClient(options.endpoint, options.nodeToken);
  let nodeId: string | null = null;

  // Check if we're already registered
  const config = loadDaemonConfig();
  if (config.nodeId && config.nodeToken) {
    const valid = await client.validateRegistration(config.nodeId);
    if (valid) {
      nodeId = config.nodeId;
      log('INFO', `Resumed with existing node ID: ${nodeId}`);
    }
  }

  // Register if needed
  if (!nodeId) {
    try {
      nodeId = await client.register();
      log('INFO', `Registered as node: ${nodeId}`);
    } catch (err) {
      log('ERROR', `Failed to register: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Track sessions we've seen to detect completions
  let lastSessionIds = new Set<string>();

  // Main sync loop
  const handleShutdown = () => {
    log('INFO', 'Report daemon shutting down');
    try { fs.unlinkSync(getPidPath()); } catch {}
    process.exit(0);
  };

  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);

  while (true) {
    try {
      // Discover sessions from all agents
      const standardSessions = await discoverSessions({ limit: 100 });
      const openClawSessions = await discoverOpenClawSessions();
      const allSessions = [...standardSessions, ...openClawSessions];

      // Convert to SessionData
      const activeSessions = allSessions.map(sessionMetaToData);
      const currentIds = new Set(activeSessions.map(s => s.id));

      // Detect completed sessions (were active before, not anymore)
      const completedSessions: SessionData[] = [];
      for (const id of lastSessionIds) {
        if (!currentIds.has(id)) {
          // Session was active before but not now - mark as completed
          completedSessions.push({ id, agent: 'unknown' });
        }
      }
      lastSessionIds = currentIds;

      // Sync with Factory Floor
      const syncReq: SyncRequest = {
        activeSessions,
        completedSessions: completedSessions.length > 0 ? completedSessions : undefined,
        machineStats: getMachineStats(),
      };

      const result = await client.sync(nodeId, syncReq);
      log('INFO', `Synced ${activeSessions.length} sessions (ack: ${result.acknowledged})`);

      // Handle any commands from Factory Floor
      if (result.commands && result.commands.length > 0) {
        for (const cmd of result.commands) {
          log('INFO', `Received command: ${cmd.type}`);
          // Future: implement command handling (stop_session, start_task)
        }
      }

      // Update last sync time
      saveDaemonConfig({
        ...loadDaemonConfig(),
        lastSync: Date.now(),
      });
    } catch (err) {
      log('ERROR', `Sync failed: ${(err as Error).message}`);
    }

    // Wait before next sync
    await new Promise(resolve => setTimeout(resolve, SYNC_INTERVAL_MS));
  }
}

/**
 * Start the report daemon as a background process.
 */
export function startReportDaemon(options: {
  nodeToken: string;
  endpoint: string;
}): { pid: number } {
  if (isReportRunning()) {
    const pid = readReportPid();
    throw new Error(`Report daemon already running (PID: ${pid})`);
  }

  const agentsBin = (() => {
    try {
      return execSync('which agents', { encoding: 'utf-8' }).trim();
    } catch {
      return 'agents';
    }
  })();

  const logPath = getLogPath();
  const logFd = fs.openSync(logPath, 'a');

  const child = spawn(agentsBin, [
    'daemon', '_report',
    '--node-token', options.nodeToken,
    '--endpoint', options.endpoint,
  ], {
    stdio: ['ignore', logFd, logFd],
    detached: true,
    env: { ...process.env, AGENTS_REPORT_VERBOSE: '0' },
  });

  child.unref();
  fs.closeSync(logFd);

  // Wait a moment for the process to write its PID
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const pid = readReportPid();
    if (pid) return { pid };
    // Busy wait
    const waitUntil = Date.now() + 100;
    while (Date.now() < waitUntil) {}
  }

  return { pid: child.pid || 0 };
}

/**
 * Stop the report daemon.
 */
export function stopReportDaemon(): boolean {
  const pid = readReportPid();
  if (!pid) return false;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process might already be gone
  }

  // Clean up PID file
  try { fs.unlinkSync(getPidPath()); } catch {}

  return true;
}
