import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

import { LocalDiskLedger } from '../local.js';
import { syncTeammate, syncOnEviction, type TeammateSnapshot } from '../sync.js';

let tmpRoot: string;
let agentDir: string;
let cwd: string;
let ledger: LocalDiskLedger;

function mkSnap(overrides: Partial<TeammateSnapshot> = {}): TeammateSnapshot {
  return {
    agent_id: 'agent-1',
    team_id: 'team-1',
    teammate_name: 'alice',
    agent_type: 'claude',
    task_type: 'implement',
    status: 'completed',
    started_at: new Date(Date.now() - 5000).toISOString(),
    completed_at: new Date().toISOString(),
    after: [],
    cloud_provider: null,
    cloud_session_id: null,
    cloud_repo: null,
    cloud_branch: null,
    agent_dir: agentDir,
    cwd,
    ...overrides,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
  agentDir = path.join(tmpRoot, 'agent-dir');
  cwd = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  ledger = new LocalDiskLedger(path.join(tmpRoot, 'ledger'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('syncTeammate', () => {
  it('writes session log + registry entry to the ledger', async () => {
    await fsp.writeFile(path.join(agentDir, 'stdout.log'), '{"msg":"first"}\n{"msg":"second"}\n');
    await syncTeammate(mkSnap(), ledger);

    const view = await ledger.read('team-1', 'agent-1');
    const sessionArtifact = view.artifacts.find((a) => a.kind === 'session-log');
    expect(sessionArtifact?.content).toContain('first');

    const reg = await ledger.getRegistry('team-1');
    expect(reg?.teammates[0].name).toBe('alice');
    expect(reg?.teammates[0].task_type).toBe('implement');
    expect(reg?.teammates[0].status).toBe('completed');
  });

  it('captures git diff when cwd is a dirty repo', async () => {
    execSync('git init -q', { cwd });
    execSync('git config user.email you@example.com', { cwd });
    execSync('git config user.name You', { cwd });
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'original\n');
    execSync('git add a.txt && git commit -qm initial', { cwd });
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'modified\n');

    await syncTeammate(mkSnap(), ledger);
    const view = await ledger.read('team-1', 'agent-1', 'diff');
    expect(view.artifacts[0]?.content).toContain('-original');
    expect(view.artifacts[0]?.content).toContain('+modified');
  });

  it('skips diff gracefully when cwd is not a git repo', async () => {
    await syncTeammate(mkSnap(), ledger);
    const view = await ledger.read('team-1', 'agent-1', 'diff');
    expect(view.artifacts).toHaveLength(0);
  });

  it('merges into existing registry without losing siblings', async () => {
    await ledger.putRegistry({
      team_id: 'team-1',
      updated_at: new Date().toISOString(),
      teammates: [
        {
          agent_id: 'agent-0', name: 'prior', agent_type: 'claude',
          task_type: 'plan', dispatch: 'local', after: [], status: 'completed',
          started_at: new Date(Date.now() - 10000).toISOString(),
          completed_at: new Date(Date.now() - 9000).toISOString(),
        },
      ],
    });

    await syncTeammate(mkSnap(), ledger);

    const reg = await ledger.getRegistry('team-1');
    const names = reg?.teammates.map((t) => t.name).sort();
    expect(names).toEqual(['alice', 'prior']);
  });

  it('marks cloud dispatch correctly in the registry', async () => {
    await syncTeammate(
      mkSnap({
        cloud_provider: 'rush',
        cloud_session_id: 'task_abc123',
        cloud_repo: 'foo/bar',
      }),
      ledger
    );
    const reg = await ledger.getRegistry('team-1');
    const d = reg?.teammates[0].dispatch;
    expect(d).not.toBe('local');
    if (typeof d === 'object') {
      expect(d.cloud).toBe('rush');
      expect(d.repo).toBe('foo/bar');
    }
  });
});

describe('syncOnEviction', () => {
  it('writes an eviction note and flips running to evicted', async () => {
    await fsp.writeFile(path.join(agentDir, 'stdout.log'), 'in-flight output');
    await syncOnEviction(mkSnap({ status: 'running' }), ledger);
    const view = await ledger.read('team-1', 'agent-1');
    const notes = view.artifacts.find((a) => a.kind === 'notes');
    expect(notes?.content).toContain('Pod evicted');
    const reg = await ledger.getRegistry('team-1');
    expect(reg?.teammates[0].status).toBe('evicted');
  });
});
