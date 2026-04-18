import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'dist', 'index.js');

function writeUpdateCache(tempHome: string): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')
  ) as { version: string };

  fs.mkdirSync(path.join(tempHome, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(tempHome, '.agents', '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: packageJson.version }),
    'utf-8'
  );
}

function writeClaudeSession(
  tempHome: string,
  projectKey: string,
  sessionId: string,
  cwd: string,
  content: string,
  timestamp: string,
): void {
  fs.mkdirSync(cwd, { recursive: true });
  const sessionsDir = path.join(tempHome, '.claude', 'projects', projectKey);
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'user',
      timestamp,
      cwd,
      sessionId,
      version: '2.1.110',
      gitBranch: 'main',
      message: { role: 'user', content },
    }) + '\n',
    'utf-8'
  );
}

function runAgents(args: string[], cwd: string, home: string) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });
}

function outputOf(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

describe('agents sessions', () => {
  it('lists only sessions from the current directory by default and shows all with --all', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-list-'));

    try {
      writeUpdateCache(tempHome);

      const swarmifyDir = path.join(tempHome, 'work', 'swarmify');
      const agentsCliDir = path.join(tempHome, 'work', 'agents-cli');
      const swarmifySessionId = '11111111-1111-4111-8111-111111111111';
      const agentsCliSessionId = '22222222-2222-4222-8222-222222222222';

      writeClaudeSession(
        tempHome,
        'swarmify-test',
        swarmifySessionId,
        swarmifyDir,
        'Inspect the swarmify session list',
        '2026-04-17T19:35:30.000Z'
      );
      writeClaudeSession(
        tempHome,
        'agents-cli-test',
        agentsCliSessionId,
        agentsCliDir,
        'Inspect the agents-cli session list',
        '2026-04-17T19:36:30.000Z'
      );

      const localResult = runAgents(['sessions'], swarmifyDir, tempHome);
      expect(localResult.status).toBe(0);

      const localOutput = outputOf(localResult);
      expect(localOutput).toContain(swarmifySessionId.slice(0, 8));
      expect(localOutput).not.toContain(agentsCliSessionId.slice(0, 8));

      const allResult = runAgents(['sessions', '--all'], swarmifyDir, tempHome);
      expect(allResult.status).toBe(0);

      const allOutput = outputOf(allResult);
      expect(allOutput).toContain(swarmifySessionId.slice(0, 8));
      expect(allOutput).toContain(agentsCliSessionId.slice(0, 8));
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('agents sessions view', () => {
  it('resolves explicit IDs across directories even when the default listing is scoped to cwd', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-view-global-'));

    try {
      writeUpdateCache(tempHome);

      const swarmifyDir = path.join(tempHome, 'work', 'swarmify');
      const agentsCliDir = path.join(tempHome, 'work', 'agents-cli');
      const siblingSessionId = '33333333-3333-4333-8333-333333333333';

      writeClaudeSession(
        tempHome,
        'swarmify-test',
        '44444444-4444-4444-8444-444444444444',
        swarmifyDir,
        'Inspect the swarmify session list',
        '2026-04-17T19:35:30.000Z'
      );
      writeClaudeSession(
        tempHome,
        'agents-cli-test',
        siblingSessionId,
        agentsCliDir,
        'Review sibling repo state',
        '2026-04-17T19:36:30.000Z'
      );

      const result = runAgents(['sessions', 'view', siblingSessionId, '--transcript'], swarmifyDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Review sibling repo state');
      expect(output).not.toContain(`No session found matching: ${siblingSessionId}`);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('explains Claude history-only IDs instead of reporting them as missing', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-view-'));

    try {
      writeUpdateCache(tempHome);

      const projectRoot = path.join(tempHome, 'work', 'swarmify');
      const transcriptCwd = path.join(projectRoot, 'extension');
      const transcriptId = '92267176-d991-45c2-a8e5-e851e30a203b';
      const historyOnlyId = 'f6a6cd2d-2138-41c4-b653-d2881ce9cdd3';

      fs.mkdirSync(path.join(tempHome, '.claude', 'projects', 'swarmify-test'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'history.jsonl'),
        JSON.stringify({
          display: '/resume',
          timestamp: Date.parse('2026-04-17T19:30:00.000Z'),
          project: projectRoot,
          sessionId: historyOnlyId,
        }) + '\n',
        'utf-8'
      );
      writeClaudeSession(
        tempHome,
        'swarmify-test',
        transcriptId,
        transcriptCwd,
        'Check the build output',
        '2026-04-17T19:35:30.000Z'
      );

      const result = runAgents(['sessions', 'view', historyOnlyId], repoRoot, tempHome);
      expect(result.status).toBe(1);

      const output = outputOf(result);
      expect(output).toContain(`No transcript session found matching: ${historyOnlyId}`);
      expect(output).toContain('This ID exists in Claude history, but not as a saved transcript session.');
      expect(output).toContain('History entry: /resume');
      expect(output).toContain(`Project root: ${projectRoot}`);
      expect(output).toContain('This looks like a Claude /resume history entry.');
      expect(output).toContain('the resumed conversation continued under a different transcript session ID.');
      expect(output).toContain('Try "agents sessions --agent claude --project swarmify" to find the resumed transcript session.');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
