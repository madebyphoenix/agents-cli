/**
 * Remote drive sync for agent sessions and config.
 *
 * Provides rsync-based push/pull between the local ~/.agents/drive/
 * directory and a remote host, plus attach/detach to swap the active
 * agent's config directory symlink to the drive directory (for working
 * with a remote machine's session data locally).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDriveDir } from './state.js';
import { AGENTS } from './agents.js';
import type { AgentId } from './types.js';

const execFileAsync = promisify(execFile);

const AGENT: AgentId = 'claude';

/** Persisted drive configuration stored at ~/.agents/drive/config.json. */
export interface DriveConfig {
  remote: string | null;
  attached: boolean;
  previousTargets: {
    configDir: string;
    homeFiles: Record<string, string>;
  } | null;
  lastPull: string | null;
  lastPush: string | null;
}

function configPath(): string {
  return path.join(getDriveDir(), 'config.json');
}

/** Read drive config from disk, returning defaults if missing. */
export function readDriveConfig(): DriveConfig {
  const p = configPath();
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      // Fall through to default
    }
  }
  return { remote: null, attached: false, previousTargets: null, lastPull: null, lastPush: null };
}

/** Write drive config to disk. */
export function writeDriveConfig(config: DriveConfig): void {
  const dir = getDriveDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

/** Set the remote target (user@host) for rsync operations. */
export function setRemote(target: string): void {
  if (!target.match(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/)) {
    throw new Error(`Invalid remote: ${target}. Expected: user@host`);
  }
  const config = readDriveConfig();
  config.remote = target;
  writeDriveConfig(config);
}

/** Pull drive data from the remote host via rsync. */
export async function pull(): Promise<void> {
  const config = readDriveConfig();
  if (!config.remote) throw new Error('No remote configured. Run: agents drive remote <user@host>');

  const localDir = getDriveDir() + '/';
  const remote = `${config.remote}:~/.agents/drive/`;

  await execFileAsync('rsync', ['-az', '--exclude=config.json', remote, localDir]);

  config.lastPull = new Date().toISOString();
  writeDriveConfig(config);
}

/** Push local drive data to the remote host via rsync. */
export async function push(): Promise<void> {
  const config = readDriveConfig();
  if (!config.remote) throw new Error('No remote configured. Run: agents drive remote <user@host>');

  const localDir = getDriveDir() + '/';
  const remote = `${config.remote}:~/.agents/drive/`;

  // Ensure remote directory exists
  await execFileAsync('ssh', [config.remote, 'mkdir -p ~/.agents/drive']);
  await execFileAsync('rsync', ['-az', '--exclude=config.json', localDir, remote]);

  config.lastPush = new Date().toISOString();
  writeDriveConfig(config);
}

/** Attach drive by swapping the agent's config directory symlink to the drive directory. */
export function attach(): void {
  const config = readDriveConfig();
  if (config.attached) throw new Error('Drive is already attached');

  const home = os.homedir();
  const agentConfig = AGENTS[AGENT];
  const driveDir = getDriveDir();

  const configDirPath = agentConfig.configDir; // ~/.claude
  const driveConfigDir = path.join(driveDir, `.${AGENT}`); // ~/.agents/drive/.claude

  // Read current symlink target
  let prevConfigDir: string | null = null;
  try {
    const stat = fs.lstatSync(configDirPath);
    if (stat.isSymbolicLink()) {
      prevConfigDir = fs.readlinkSync(configDirPath);
    }
  } catch {
    // Path doesn't exist
  }

  if (!prevConfigDir) {
    throw new Error(`${configDirPath} is not a symlink. Run 'agents use claude' first.`);
  }

  // Save previous targets for home files
  const prevHomeFiles: Record<string, string> = {};
  for (const hf of agentConfig.homeFiles || []) {
    const hfPath = path.join(home, hf);
    try {
      const stat = fs.lstatSync(hfPath);
      if (stat.isSymbolicLink()) {
        prevHomeFiles[hf] = fs.readlinkSync(hfPath);
      }
    } catch {
      // File doesn't exist
    }
  }

  config.previousTargets = {
    configDir: prevConfigDir,
    homeFiles: prevHomeFiles,
  };

  // Ensure drive config dir exists
  if (!fs.existsSync(driveConfigDir)) {
    fs.mkdirSync(driveConfigDir, { recursive: true });
  }

  // Swap config dir symlink
  fs.unlinkSync(configDirPath);
  fs.symlinkSync(driveConfigDir, configDirPath);

  // Swap home files
  for (const hf of agentConfig.homeFiles || []) {
    const hfPath = path.join(home, hf);
    const driveHfPath = path.join(driveDir, hf);
    if (!fs.existsSync(driveHfPath)) {
      fs.writeFileSync(driveHfPath, '{}');
    }
    try { fs.unlinkSync(hfPath); } catch { /* doesn't exist */ }
    fs.symlinkSync(driveHfPath, hfPath);
  }

  config.attached = true;
  writeDriveConfig(config);
}

/** Detach drive by restoring the agent's config directory to its previous symlink target. */
export function detach(): void {
  const config = readDriveConfig();
  if (!config.attached) throw new Error('Drive is not attached');
  if (!config.previousTargets) throw new Error('No previous targets saved');

  const home = os.homedir();
  const agentConfig = AGENTS[AGENT];

  // Restore config dir symlink
  const configDirPath = agentConfig.configDir;
  fs.unlinkSync(configDirPath);
  fs.symlinkSync(config.previousTargets.configDir, configDirPath);

  // Restore home files
  for (const hf of agentConfig.homeFiles || []) {
    const hfPath = path.join(home, hf);
    const prevTarget = config.previousTargets.homeFiles[hf];
    if (prevTarget) {
      try { fs.unlinkSync(hfPath); } catch { /* doesn't exist */ }
      fs.symlinkSync(prevTarget, hfPath);
    }
  }

  config.attached = false;
  config.previousTargets = null;
  writeDriveConfig(config);
}

/** Current drive state for display purposes. */
export interface DriveStatus {
  remote: string | null;
  attached: boolean;
  lastPull: string | null;
  lastPush: string | null;
  driveDir: string;
  configDirTarget: string | null;
  homeFileTargets: Record<string, string | null>;
}

/** Gather current drive status by inspecting config, symlinks, and timestamps. */
export function getDriveStatus(): DriveStatus {
  const config = readDriveConfig();
  const home = os.homedir();
  const agentConfig = AGENTS[AGENT];

  let configDirTarget: string | null = null;
  try {
    const stat = fs.lstatSync(agentConfig.configDir);
    if (stat.isSymbolicLink()) {
      configDirTarget = fs.readlinkSync(agentConfig.configDir);
    }
  } catch {
    // Not a symlink or doesn't exist
  }

  const homeFileTargets: Record<string, string | null> = {};
  for (const hf of agentConfig.homeFiles || []) {
    try {
      const stat = fs.lstatSync(path.join(home, hf));
      if (stat.isSymbolicLink()) {
        homeFileTargets[hf] = fs.readlinkSync(path.join(home, hf));
      } else {
        homeFileTargets[hf] = null;
      }
    } catch {
      homeFileTargets[hf] = null;
    }
  }

  return {
    remote: config.remote,
    attached: config.attached,
    lastPull: config.lastPull,
    lastPush: config.lastPush,
    driveDir: getDriveDir(),
    configDirTarget,
    homeFileTargets,
  };
}
