/**
 * Rush Cloud provider -- dispatches tasks to the Factory Floor via api.prix.dev.
 *
 * Auth: reads the session token from ~/.rush/user.yaml (written by `rush login`).
 * Requires the Rush GitHub App installed on the target repo.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
} from './types.js';
import { resolveDispatchRepos } from './types.js';
import { parseSSE } from './stream.js';

const PROXY_BASE = 'https://api.prix.dev';
const USER_YAML = path.join(os.homedir(), '.rush', 'user.yaml');

interface UserYaml {
  session?: {
    email?: string;
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
  };
}

interface Installation {
  id: number;
  account_login: string;
  repositories?: { name: string; full_name: string }[];
  repository_selection?: string;
}

/** Map a Factory Floor status string to the canonical CloudTaskStatus enum. */
function mapStatus(s: string): CloudTaskStatus {
  switch (s) {
    case 'allocating': return 'allocating';
    case 'running': return 'running';
    case 'needs_review': return 'input_required';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'running';
  }
}

/** Read the Rush session access token from ~/.rush/user.yaml. */
function readToken(): string {
  if (!fs.existsSync(USER_YAML)) {
    throw new Error('Not logged in to Rush. Run `rush login` first.');
  }
  const raw = fs.readFileSync(USER_YAML, 'utf-8');
  const data = yaml.parse(raw) as UserYaml;
  const token = data?.session?.access_token;
  if (!token) {
    throw new Error('No session token in ~/.rush/user.yaml. Run `rush login` first.');
  }
  return token;
}

/** Read the user's email from the Rush session config, if available. */
function readEmail(): string | undefined {
  try {
    const raw = fs.readFileSync(USER_YAML, 'utf-8');
    const data = yaml.parse(raw) as UserYaml;
    return data?.session?.email;
  } catch {
    return undefined;
  }
}

/** Make an authenticated request to the Rush API proxy. */
async function api(method: string, endpoint: string, token: string, body?: unknown): Promise<Response> {
  const url = endpoint.startsWith('http') ? endpoint : `${PROXY_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Find the GitHub App installation ID for a given owner/repo pair. */
async function findInstallation(token: string, owner: string, repo: string): Promise<number> {
  const res = await api('GET', '/api/v1/github/app/installations', token);
  if (!res.ok) {
    throw new Error(`Failed to fetch GitHub installations (${res.status}). Is the Rush GitHub App installed?`);
  }
  const data = await res.json() as { installations: Installation[] };

  for (const inst of data.installations ?? []) {
    if (inst.account_login?.toLowerCase() === owner.toLowerCase()) {
      if (inst.repository_selection === 'all') return inst.id;
      if (inst.repositories?.some(r => r.name.toLowerCase() === repo.toLowerCase())) {
        return inst.id;
      }
    }
  }

  throw new Error(
    `No GitHub App installation found for ${owner}/${repo}. Install the Rush GitHub App at https://github.com/apps/prix-cloud.`,
  );
}

/**
 * Build the POST body for /api/v1/cloud-runs. Exported so tests can verify
 * the back-compat shape (singular fields + repos[]) without needing real
 * GitHub installations or a live Rush session. `findInstallation` is the
 * only other I/O and it's tested by the halo/proxy integration suite.
 */
export function buildDispatchBody(input: {
  agent?: string;
  prompt: string;
  mode?: string;
  resolvedRepos: Array<{ installation_id: number; repo_owner: string; repo_name: string }>;
}): Record<string, unknown> {
  if (input.resolvedRepos.length === 0) {
    throw new Error('buildDispatchBody: resolvedRepos must have at least one entry');
  }
  const primary = input.resolvedRepos[0];
  const body: Record<string, unknown> = {
    agent: input.agent ?? 'claude',
    prompt: input.prompt,
    repos: input.resolvedRepos,
    mode: input.mode,
  };
  if (input.resolvedRepos.length === 1) {
    body.installation_id = primary.installation_id;
    body.repo_owner = primary.repo_owner;
    body.repo_name = primary.repo_name;
  }
  return body;
}

export class RushCloudProvider implements CloudProvider {
  id = 'rush' as const;
  name = 'Rush Cloud';

  supports(_options: DispatchOptions): boolean {
    return fs.existsSync(USER_YAML);
  }

  async dispatch(options: DispatchOptions): Promise<CloudTask> {
    const repos = resolveDispatchRepos(options);
    if (repos.length === 0) {
      throw new Error('Rush Cloud requires --repo <owner/repo> (or --repo repeated for multi-repo).');
    }

    // Validate each repo's shape and resolve its installation_id up front.
    // Any bad entry fails the whole dispatch — we never want a half-started
    // multi-repo run that only found installations for some of the repos.
    const token = readToken();
    const parsed = repos.map((full) => {
      const parts = full.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format: ${JSON.stringify(full)}. Use owner/repo.`);
      }
      return { full, owner: parts[0], name: parts[1] };
    });

    const resolvedRepos = await Promise.all(
      parsed.map(async (r) => ({
        installation_id: await findInstallation(token, r.owner, r.name),
        repo_owner: r.owner,
        repo_name: r.name,
      })),
    );

    const body = buildDispatchBody({
      agent: options.agent,
      prompt: options.prompt,
      mode: options.providerOptions?.mode,
      resolvedRepos,
    });

    const res = await api('POST', '/api/v1/cloud-runs', token, body);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dispatch failed (${res.status}): ${text}`);
    }

    const data = await res.json() as { execution_id: string };
    const now = new Date().toISOString();

    return {
      id: data.execution_id,
      provider: 'rush',
      status: 'queued',
      agent: options.agent ?? 'claude',
      prompt: options.prompt,
      repo: repos[0],
      repos: repos,
      branch: options.branch,
      createdAt: now,
      updatedAt: now,
    };
  }

  async status(taskId: string): Promise<CloudTask> {
    const token = readToken();
    const res = await api('GET', `/api/v1/cloud-runs/${taskId}`, token);
    if (!res.ok) {
      throw new Error(`Failed to get task status (${res.status}).`);
    }
    const data = await res.json() as Record<string, unknown>;
    return {
      id: taskId,
      provider: 'rush',
      status: mapStatus(data.status as string),
      agent: (data.agent as string) || undefined,
      prompt: (data.prompt as string) || '',
      repo: data.repo_owner && data.repo_name ? `${data.repo_owner}/${data.repo_name}` : undefined,
      branch: (data.branch as string) || undefined,
      prUrl: (data.pr_url as string) || undefined,
      summary: (data.summary as string) || undefined,
      createdAt: (data.created_at as string) || new Date().toISOString(),
      updatedAt: (data.updated_at as string) || new Date().toISOString(),
    };
  }

  async list(filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    const token = readToken();
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await api('GET', `/api/v1/cloud-runs${qs}`, token);
    if (!res.ok) {
      throw new Error(`Failed to list tasks (${res.status}).`);
    }
    const data = await res.json() as { executions: Record<string, unknown>[] };
    return (data.executions ?? []).map((e) => ({
      id: e.execution_id as string,
      provider: 'rush' as const,
      status: mapStatus(e.status as string),
      agent: (e.agent as string) || undefined,
      prompt: (e.prompt as string) || '',
      repo: e.repo_owner && e.repo_name ? `${e.repo_owner}/${e.repo_name}` : undefined,
      branch: (e.branch as string) || undefined,
      prUrl: (e.pr_url as string) || undefined,
      summary: (e.summary as string) || undefined,
      createdAt: (e.created_at as string) || '',
      updatedAt: (e.updated_at as string) || '',
    }));
  }

  async *stream(taskId: string): AsyncIterable<CloudEvent> {
    const token = readToken();
    const res = await fetch(`${PROXY_BASE}/api/v1/cloud-runs/${taskId}/stream`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to connect to stream (${res.status}).`);
    }
    yield* parseSSE(res);
  }

  async cancel(taskId: string): Promise<void> {
    const token = readToken();
    const res = await api('DELETE', `/api/v1/cloud-runs/${taskId}`, token);
    if (!res.ok) {
      throw new Error(`Failed to cancel task (${res.status}).`);
    }
  }

  async message(taskId: string, content: string): Promise<void> {
    const token = readToken();
    const res = await api('POST', `/api/v1/cloud-runs/${taskId}/message`, token, { content });
    if (!res.ok) {
      throw new Error(`Failed to send message (${res.status}).`);
    }
  }
}
