// Factory Floor API client for daemon reporting
// Reports local agent sessions to the central Factory Floor dashboard

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getAgentsDir } from './state.js';

const CONFIG_FILE = 'daemon.json';
const DEFAULT_ENDPOINT = 'https://agents.427yosemite.com';

export interface DaemonConfig {
  nodeId?: string;
  nodeToken?: string;
  endpoint?: string;
  lastSync?: number;
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
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export function clearDaemonConfig(): void {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

export class FactoryClient {
  private endpoint: string;
  private nodeToken: string;
  private nodeId: string | null = null;

  constructor(endpoint: string, nodeToken: string) {
    this.endpoint = endpoint.replace(/\/$/, ''); // Remove trailing slash
    this.nodeToken = nodeToken;
  }

  /**
   * Register this machine as a node with Factory Floor.
   * Returns the assigned nodeId.
   */
  async register(): Promise<string> {
    const hostname = os.hostname();
    const platform = os.platform();
    const arch = os.arch();

    const res = await fetch(`${this.endpoint}/nodes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.nodeToken}`,
      },
      body: JSON.stringify({
        name: hostname,
        os: platform,
        arch: arch,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to register node: ${res.status} ${text}`);
    }

    const data = await res.json() as RegisterResponse;
    this.nodeId = data.nodeId;

    // Save the new token and nodeId (the server generates a new token)
    saveDaemonConfig({
      nodeId: data.nodeId,
      nodeToken: data.token, // Server returns a different token
      endpoint: this.endpoint,
    });

    // Update our token for subsequent requests
    this.nodeToken = data.token;

    return data.nodeId;
  }

  /**
   * Check if we're already registered by validating our stored nodeId.
   */
  async validateRegistration(nodeId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/nodes/${nodeId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.nodeToken}`,
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Sync active sessions to Factory Floor.
   */
  async sync(nodeId: string, request: SyncRequest): Promise<SyncResponse> {
    const res = await fetch(`${this.endpoint}/nodes/${nodeId}/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.nodeToken}`,
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to sync: ${res.status} ${text}`);
    }

    return await res.json() as SyncResponse;
  }

  /**
   * Deregister this node from Factory Floor.
   */
  async deregister(nodeId: string): Promise<void> {
    const res = await fetch(`${this.endpoint}/nodes/${nodeId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.nodeToken}`,
      },
    });

    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`Failed to deregister: ${res.status} ${text}`);
    }

    clearDaemonConfig();
  }
}

/**
 * Create a Factory client from saved config or provided options.
 */
export function createClient(options?: {
  nodeToken?: string;
  endpoint?: string;
}): { client: FactoryClient; config: DaemonConfig } {
  const config = loadDaemonConfig();

  const endpoint = options?.endpoint || config.endpoint || DEFAULT_ENDPOINT;
  const token = options?.nodeToken || config.nodeToken;

  if (!token) {
    throw new Error('No node token provided. Run: agents daemon report --node-token <token>');
  }

  return {
    client: new FactoryClient(endpoint, token),
    config: { ...config, endpoint },
  };
}
