// Factory Floor API client for daemon reporting
// Reports local agent sessions to the Factory Floor at factory.prix.dev

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAgentsDir } from './state.js';

const CONFIG_FILE = 'daemon.json';

export interface DaemonConfig {
  nodeId?: string;
  nodeToken?: string;
  endpoint?: string;
  lastSync?: number;
}

function getConfigPath(): string {
  return path.join(getAgentsDir(), CONFIG_FILE);
}

export function loadDaemonConfig(): DaemonConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveDaemonConfig(config: DaemonConfig): void {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// NOTE: This interface must stay in sync with SyncSessionData in
// infra/sandbox/service/src/nodes.ts
export interface SessionData {
  id: string;
  agent: string;
  version?: string;
  project?: string;
  branch?: string;
  prompt?: string;
  workingDir?: string;
  pid?: number;
  startedAt?: number;
  summary?: string;
}

// NOTE: This interface must stay in sync with SyncRequest in
// infra/sandbox/service/src/nodes.ts
export interface SyncRequest {
  activeSessions: SessionData[];
  completedSessions?: SessionData[];
  machineStats?: {
    cpuUsage?: number;
    memoryUsage?: number;
    agentVersions?: Record<string, string>;
  };
}

export interface SyncResponse {
  acknowledged: number;
  commands?: Array<{
    type: 'stop_session' | 'start_task';
    sessionId?: string;
    prompt?: string;
  }>;
}

export interface RegisterResponse {
  nodeId: string;
  token: string;
  message: string;
}

export class FactoryClient {
  private endpoint: string;
  private nodeToken: string;
  private nodeId?: string;

  constructor(endpoint: string, nodeToken: string, nodeId?: string) {
    this.endpoint = endpoint.replace(/\/$/, ''); // Remove trailing slash
    this.nodeToken = nodeToken;
    this.nodeId = nodeId;
  }

  async register(): Promise<RegisterResponse> {
    const hostname = os.hostname();
    const response = await fetch(`${this.endpoint}/nodes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.nodeToken}`,
      },
      body: JSON.stringify({
        name: hostname,
        os: os.platform(),
        arch: os.arch(),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Registration failed: ${response.status} ${body}`);
    }

    return response.json() as Promise<RegisterResponse>;
  }

  async sync(nodeId: string, data: SyncRequest): Promise<SyncResponse> {
    const response = await fetch(`${this.endpoint}/nodes/${nodeId}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.nodeToken}`,
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sync failed: ${response.status} ${body}`);
    }

    return response.json() as Promise<SyncResponse>;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Get machine stats (CPU and memory usage)
export function getMachineStats(): { cpuUsage?: number; memoryUsage?: number } {
  const totalmem = os.totalmem();
  const freemem = os.freemem();
  const memoryUsage = ((totalmem - freemem) / totalmem) * 100;

  // CPU usage requires sampling over time, so we just return memory for now
  return {
    memoryUsage: Math.round(memoryUsage * 10) / 10,
  };
}

// Get installed agent versions (runs in parallel for efficiency)
export async function getAgentVersions(): Promise<Record<string, string>> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const agents = ['claude', 'codex', 'gemini'];

  const results = await Promise.allSettled(
    agents.map(async (agent) => {
      const { stdout } = await execAsync(`${agent} --version 2>/dev/null`);
      const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
      return { agent, version: match?.[1] };
    })
  );

  const versions: Record<string, string> = {};
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.version) {
      versions[result.value.agent] = result.value.version;
    }
  }

  return versions;
}
