import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

describe('agents sessions view', () => {
  it('explains Claude history-only IDs instead of reporting them as missing', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-view-'));

    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')
      ) as { version: string };

      fs.mkdirSync(path.join(tempHome, '.agents'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.agents', '.update-check'),
        JSON.stringify({ lastCheck: Date.now(), latestVersion: packageJson.version }),
        'utf-8'
      );

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
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'projects', 'swarmify-test', `${transcriptId}.jsonl`),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-17T19:35:30.000Z',
          cwd: transcriptCwd,
          sessionId: transcriptId,
          version: '2.1.110',
          gitBranch: 'main',
          message: { role: 'user', content: 'Check the build output' },
        }) + '\n',
        'utf-8'
      );

      const tsxPath = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const result = spawnSync(
        tsxPath,
        ['src/index.ts', 'sessions', 'view', historyOnlyId],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: tempHome },
          encoding: 'utf-8',
        }
      );

      expect(result.status).toBe(1);

      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(`No transcript session found matching: ${historyOnlyId}`);
      expect(output).toContain('This ID exists in Claude history, but not as a saved transcript session.');
      expect(output).toContain('History entry: /resume');
      expect(output).toContain(`Project root: ${projectRoot}`);
      expect(output).toContain(transcriptId);
      expect(output).toContain('Claude uses history-only IDs for commands like /resume.');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
