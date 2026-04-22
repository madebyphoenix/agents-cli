import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { LocalDiskLedger } from '../local.js';
import type { LedgerRegistry } from '../types.js';

let tmpRoot: string;
let ledger: LocalDiskLedger;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  ledger = new LocalDiskLedger(tmpRoot);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('LocalDiskLedger putArtifact + read', () => {
  it('writes and reads a diff artifact', async () => {
    await ledger.putArtifact('team1', 'task1', 'diff', 'diff --git a/x b/x\n+foo\n');
    const view = await ledger.read('team1', 'task1', 'diff');
    expect(view.artifacts).toHaveLength(1);
    expect(view.artifacts[0].kind).toBe('diff');
    expect(view.artifacts[0].content).toContain('+foo');
  });

  it('overwrites the same (task, kind) on re-write', async () => {
    await ledger.putArtifact('team1', 'task1', 'test-output', 'run 1\n');
    await ledger.putArtifact('team1', 'task1', 'test-output', 'run 2\n');
    const view = await ledger.read('team1', 'task1', 'test-output');
    expect(view.artifacts[0].content).toBe('run 2\n');
  });

  it('returns empty artifacts for an unknown task', async () => {
    const view = await ledger.read('team1', 'never-written');
    expect(view.artifacts).toEqual([]);
    expect(view.task_id).toBe('never-written');
  });

  it('read without kind gathers every artifact under a task_id', async () => {
    await ledger.putArtifact('team1', 'task1', 'diff', 'diff-content');
    await ledger.putArtifact('team1', 'task1', 'test-output', 'test-content');
    await ledger.appendSession('team1', 'task1', 'alice', JSON.stringify({ msg: 'hi' }));
    await ledger.putArtifact('team1', 'task1', 'bug', '# bug');

    const view = await ledger.read('team1', 'task1');
    const kinds = view.artifacts.map((a) => a.kind).sort();
    expect(kinds).toEqual(['bug', 'diff', 'session', 'test-output']);
  });

  it('keeps bug under bugs/ not artifacts/', async () => {
    await ledger.putArtifact('team1', 'task1', 'bug', '# login broken\n');
    const bugPath = path.join(tmpRoot, 'teams', 'team1', 'bugs', 'task1.md');
    const artBugPath = path.join(tmpRoot, 'teams', 'team1', 'artifacts', 'task1', 'bug.txt');
    expect(fs.existsSync(bugPath)).toBe(true);
    expect(fs.existsSync(artBugPath)).toBe(false);
  });
});

describe('LocalDiskLedger sessions', () => {
  it('appends multiple lines to the session jsonl', async () => {
    await ledger.appendSession('team1', 'task1', 'alice', '{"a":1}');
    await ledger.appendSession('team1', 'task1', 'alice', '{"b":2}');
    const sessionPath = path.join(
      tmpRoot, 'teams', 'team1', 'sessions', 'task1-alice.jsonl'
    );
    const content = await fsp.readFile(sessionPath, 'utf-8');
    expect(content.trim().split('\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('separates sessions by teammate', async () => {
    await ledger.appendSession('team1', 'task1', 'alice', 'a');
    await ledger.appendSession('team1', 'task1', 'bob', 'b');
    const view = await ledger.read('team1', 'task1', 'session');
    const teammates = view.artifacts.map((a) => a.teammate).sort();
    expect(teammates).toEqual(['alice', 'bob']);
  });
});

describe('LocalDiskLedger note', () => {
  it('appends a teammate-tagged entry to notes.md', async () => {
    await ledger.note('team1', 'task1', 'alice', 'tried approach A');
    await ledger.note('team1', 'task1', 'alice', 'approach B also failed');
    const view = await ledger.read('team1', 'task1', 'notes');
    const notes = view.artifacts[0].content;
    expect(notes).toContain('alice');
    expect(notes).toContain('approach A');
    expect(notes).toContain('approach B');
    const matches = notes.match(/— alice/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
  });
});

describe('LocalDiskLedger registry + recent', () => {
  it('roundtrips registry', async () => {
    const reg: LedgerRegistry = {
      team_id: 'team1',
      updated_at: new Date().toISOString(),
      teammates: [
        {
          agent_id: 'a1', name: 'alice', agent_type: 'claude',
          task_type: 'implement',
          dispatch: 'local', after: [], status: 'completed',
          started_at: new Date(Date.now() - 1000).toISOString(),
          completed_at: new Date().toISOString(),
        },
      ],
    };
    await ledger.putRegistry(reg);
    const got = await ledger.getRegistry('team1');
    expect(got?.teammates[0].name).toBe('alice');
    expect(got?.teammates[0].task_type).toBe('implement');
  });

  it('recent returns tasks newest first', async () => {
    const now = Date.now();
    const reg: LedgerRegistry = {
      team_id: 'team1',
      updated_at: new Date(now).toISOString(),
      teammates: [
        {
          agent_id: 't-old', name: 'old', agent_type: 'claude',
          task_type: 'implement', dispatch: 'local', after: [],
          status: 'completed',
          started_at: new Date(now - 10000).toISOString(),
          completed_at: new Date(now - 9000).toISOString(),
        },
        {
          agent_id: 't-new', name: 'new', agent_type: 'claude',
          task_type: 'test', dispatch: 'local', after: [],
          status: 'completed',
          started_at: new Date(now - 2000).toISOString(),
          completed_at: new Date(now - 1000).toISOString(),
        },
        {
          agent_id: 't-pending', name: 'p', agent_type: 'claude',
          task_type: 'review', dispatch: 'local', after: [],
          status: 'pending',
          started_at: new Date(now).toISOString(),
          completed_at: null,
        },
      ],
    };
    await ledger.putRegistry(reg);
    await ledger.putArtifact('team1', 't-old', 'diff', 'old-diff');
    await ledger.putArtifact('team1', 't-new', 'diff', 'new-diff');

    const views = await ledger.recent('team1', 5);
    expect(views.map((v) => v.task_id)).toEqual(['t-new', 't-old']);
  });
});

describe('LocalDiskLedger search', () => {
  it('finds matches across sessions, notes, bugs, narrative', async () => {
    await ledger.appendSession('team1', 'task1', 'alice', JSON.stringify({ msg: 'migrate the database' }));
    await ledger.note('team1', 'task1', 'alice', 'blocked on db migration tooling');
    await ledger.putArtifact('team1', 'task2', 'bug', 'bug: migration fails on empty rows');
    await ledger.appendNarrative('team1', 'Plan calls for staged migration rollout.');

    const hits = await ledger.search('team1', 'migration');
    const kinds = new Set(hits.map((h) => h.kind));
    // At least notes, bug, narrative should hit. Sessions uses "migrate" not "migration".
    expect(kinds.has('notes')).toBe(true);
    expect(kinds.has('bug')).toBe(true);
    expect(kinds.has('narrative')).toBe(true);
  });

  it('respects the limit', async () => {
    for (let i = 0; i < 10; i++) {
      await ledger.note('team1', `task${i}`, 'alice', 'needle line');
    }
    const hits = await ledger.search('team1', 'needle', 3);
    expect(hits.length).toBe(3);
  });

  it('is case-insensitive', async () => {
    await ledger.note('team1', 'task1', 'alice', 'Migration Guide');
    const hits = await ledger.search('team1', 'migration');
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('LocalDiskLedger narrative', () => {
  it('appends to team.md', async () => {
    await ledger.appendNarrative('team1', 'step 1 done');
    await ledger.appendNarrative('team1', 'step 2 in progress');
    const txt = await ledger.getNarrative('team1');
    expect(txt).toContain('step 1 done');
    expect(txt).toContain('step 2 in progress');
  });

  it('getNarrative returns null when missing', async () => {
    const txt = await ledger.getNarrative('nothing-here');
    expect(txt).toBeNull();
  });
});
