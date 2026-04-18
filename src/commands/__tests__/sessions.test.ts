import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const cliEntry = path.join(repoRoot, 'src', 'index.ts');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

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

function writeCodexSession(
  tempHome: string,
  sessionId: string,
  cwd: string,
  prompt: string,
  timestamp: string,
): void {
  fs.mkdirSync(cwd, { recursive: true });
  const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '04', '17');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const filePath = path.join(
    sessionsDir,
    `rollout-${timestamp.replace(/[:.]/g, '-')}-${sessionId}.jsonl`
  );

  const lines = [
    JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp,
        cwd,
        originator: 'codex_cli_rs',
        cli_version: '0.113.0',
        source: 'cli',
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '<permissions instructions>\nFilesystem sandboxing.\n</permissions instructions>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/tmp/project</cwd>\n  <shell>zsh</shell>\n</environment_context>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<collaboration_mode># Collaboration Mode: Default\n</collaboration_mode>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nDo work.\n</INSTRUCTIONS>' }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    }),
    JSON.stringify({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Looking into it now.' }],
      },
    }),
  ];

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

function writeGeminiSession(
  tempHome: string,
  sessionId: string,
  cwd: string,
  prompt: string,
  timestamp: string,
  version = '0.29.5',
): void {
  const versionHome = path.join(tempHome, '.agents', 'versions', 'gemini', version, 'home');
  const geminiHome = path.join(versionHome, '.gemini');
  const projectHash = crypto.createHash('sha256').update(cwd).digest('hex');
  const chatsDir = path.join(geminiHome, 'tmp', projectHash, 'chats');

  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(chatsDir, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(tempHome, '.gemini')), { recursive: true });

  const activeGeminiHome = path.join(tempHome, '.gemini');
  if (!fs.existsSync(activeGeminiHome)) {
    fs.symlinkSync(geminiHome, activeGeminiHome);
  }

  fs.writeFileSync(
    path.join(geminiHome, 'projects.json'),
    JSON.stringify({ projects: [cwd] }),
    'utf-8'
  );

  fs.writeFileSync(
    path.join(chatsDir, `session-${timestamp.replace(/[:.]/g, '-')}-${sessionId.slice(0, 8)}.json`),
    JSON.stringify({
      sessionId,
      projectHash,
      startTime: timestamp,
      lastUpdated: timestamp,
      messages: [
        {
          id: `${sessionId}-user`,
          timestamp,
          type: 'user',
          content: [{ text: prompt }],
        },
        {
          id: `${sessionId}-assistant`,
          timestamp,
          type: 'gemini',
          content: 'Investigating now.',
          model: 'gemini-3-flash-preview',
          tokens: { total: 1234 },
        },
      ],
    }, null, 2),
    'utf-8'
  );
}

function runAgents(args: string[], cwd: string, home: string) {
  return spawnSync(tsxBin, [cliEntry, ...args], {
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

  it('shows message and token counts while skipping Claude local-command preambles in the topic', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-stats-'));

    try {
      writeUpdateCache(tempHome);

      const repoDir = path.join(tempHome, 'work', 'agents-cli');
      const projectKey = 'agents-cli-test';
      const sessionId = '77777777-7777-4777-8777-777777777777';

      fs.mkdirSync(repoDir, { recursive: true });
      fs.mkdirSync(path.join(tempHome, '.claude', 'projects', projectKey), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'projects', projectKey, `${sessionId}.jsonl`),
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:00:00.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            isMeta: true,
            message: {
              role: 'user',
              content: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:00:01.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: '<bash-input>pwd</bash-input>' },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:00:02.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: 'Inspect session stats' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:00:03.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              id: 'msg-stats',
              role: 'assistant',
              content: [{ type: 'text', text: 'Looking now.' }],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 0,
              },
            },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:00:04.000Z',
            cwd: repoDir,
            sessionId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              id: 'msg-stats',
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/example' } }],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 0,
              },
            },
          }),
        ].join('\n') + '\n',
        'utf-8'
      );

      const result = runAgents(['sessions'], repoDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Msgs');
      expect(output).toContain('Tokens');

      const row = output.split('\n').find(line => line.includes(sessionId.slice(0, 8))) || '';
      expect(row).toContain('Inspect session stats');
      expect(row).not.toContain('Caveat:');
      expect(row).toMatch(/\b2\s+35\s+Inspect session stats\b/);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('finds matching projects outside the current directory when --project is provided', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-project-'));

    try {
      writeUpdateCache(tempHome);

      const workspaceDir = path.join(tempHome, 'work');
      const swarmifyDir = path.join(workspaceDir, 'swarmify');
      const agentsCliDir = path.join(workspaceDir, 'agents-cli');
      const swarmifySessionId = '55555555-5555-4555-8555-555555555555';
      const agentsCliSessionId = '66666666-6666-4666-8666-666666666666';

      fs.mkdirSync(workspaceDir, { recursive: true });

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

      const result = runAgents(['sessions', '--project', 'agents-cli'], workspaceDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(agentsCliSessionId.slice(0, 8));
      expect(output).not.toContain(swarmifySessionId.slice(0, 8));
      expect(output).not.toContain(`No sessions found for ${workspaceDir}`);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('shows the first human Codex prompt instead of injected session scaffolding', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-codex-topic-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = '99999999-9999-4999-8999-999999999999';
      const prompt = 'Search across sessions by prompt text';

      writeCodexSession(
        tempHome,
        sessionId,
        projectDir,
        prompt,
        '2026-04-17T19:40:30.000Z'
      );

      const result = runAgents(['sessions', '--all'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(sessionId.slice(0, 8));
      expect(output).toContain(prompt);
      expect(output).not.toContain('Collaboration Mode: Default');
      expect(output).not.toContain('# AGENTS.md instructions');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('shows Codex CLI versions in the agent column', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-codex-version-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      writeCodexSession(
        tempHome,
        'abababab-abab-4bab-8bab-abababababab',
        projectDir,
        'Show codex versions in the session list',
        '2026-04-17T19:42:30.000Z'
      );

      const result = runAgents(['sessions', '--agent', 'codex', '--all'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('codex@0.113.0');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('shows Gemini CLI versions in the agent column when sessions come from a managed version home', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-gemini-version-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      writeGeminiSession(
        tempHome,
        'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0',
        projectDir,
        'Show gemini versions in the session list',
        '2026-04-17T19:43:30.000Z'
      );

      const result = runAgents(['sessions', '--agent', 'gemini', '--all'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('gemini@0.29.5');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('session search improvements', () => {
  it('P2: atomic index write leaves no .tmp file after success', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-p2-'));

    try {
      writeUpdateCache(tempHome);
      const projectDir = path.join(tempHome, 'work', 'p2-test');
      writeClaudeSession(tempHome, 'p2-test', 'aaaa1111-0000-4000-8000-000000000001', projectDir, 'atomic write test', '2026-04-18T10:00:00.000Z');

      const result = runAgents(['sessions', '--all'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const sessionsDir = path.join(tempHome, '.agents', 'sessions');
      expect(fs.existsSync(path.join(sessionsDir, 'index.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, 'content_index.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, 'index.jsonl.tmp'))).toBe(false);
      expect(fs.existsSync(path.join(sessionsDir, 'content_index.jsonl.tmp'))).toBe(false);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('P3: --git-branch filter limits results to matching branch', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-p3-'));

    try {
      writeUpdateCache(tempHome);
      const projectDir = path.join(tempHome, 'work', 'p3-test');
      const mainId = 'bb220000-0000-4000-8000-000000000002';
      const featureId = 'cc330000-0000-4000-8000-000000000003';

      fs.mkdirSync(projectDir, { recursive: true });
      const sessionsDir = path.join(tempHome, '.claude', 'projects', 'p3-test');
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Session on main branch
      fs.writeFileSync(
        path.join(sessionsDir, `${mainId}.jsonl`),
        JSON.stringify({ type: 'user', timestamp: '2026-04-18T10:00:00.000Z', cwd: projectDir, sessionId: mainId, version: '2.1.110', gitBranch: 'main', message: { role: 'user', content: 'work on main' } }) + '\n',
        'utf-8'
      );
      // Session on feature branch
      fs.writeFileSync(
        path.join(sessionsDir, `${featureId}.jsonl`),
        JSON.stringify({ type: 'user', timestamp: '2026-04-18T11:00:00.000Z', cwd: projectDir, sessionId: featureId, version: '2.1.110', gitBranch: 'feature/search', message: { role: 'user', content: 'work on feature' } }) + '\n',
        'utf-8'
      );

      const result = runAgents(['sessions', '--all', '--git-branch', 'feature'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(featureId.slice(0, 8));
      expect(output).not.toContain(mainId.slice(0, 8));
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('P5: BM25 index is not rewritten when session set is unchanged', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-p5-'));

    try {
      writeUpdateCache(tempHome);
      const projectDir = path.join(tempHome, 'work', 'p5-test');
      writeClaudeSession(tempHome, 'p5-test', 'aaaa1111-0000-4000-8000-000000000004', projectDir, 'cache test prompt', '2026-04-18T10:00:00.000Z');

      // First run: builds and writes the index
      runAgents(['sessions', '--all'], projectDir, tempHome);

      const indexPath = path.join(tempHome, '.agents', 'sessions', 'content_index.jsonl');
      expect(fs.existsSync(indexPath)).toBe(true);
      const mtime1 = fs.statSync(indexPath).mtimeMs;

      // Second run with identical sessions: index must not be rewritten
      runAgents(['sessions', '--all'], projectDir, tempHome);
      const mtime2 = fs.statSync(indexPath).mtimeMs;

      expect(mtime2).toBe(mtime1);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('P6: multi-term query requires all terms to match', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-p6-'));

    try {
      writeUpdateCache(tempHome);
      const projectDir = path.join(tempHome, 'work', 'p6-test');
      const bothId = 'aaaa1111-0000-4000-8000-000000000005';
      const oneId  = 'aaaa1111-0000-4000-8000-000000000006';

      writeClaudeSession(tempHome, 'p6-test', bothId, projectDir, 'fix the authentication token handling', '2026-04-18T10:00:00.000Z');
      writeClaudeSession(tempHome, 'p6-test', oneId, projectDir, 'update authentication flow only', '2026-04-18T11:00:00.000Z');

      // Search for both terms: only bothId should match
      const result = runAgents(['sessions', 'view', 'authentication token', '--transcript'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('fix the authentication token handling');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('P12: list table shows matched content terms when --project is active', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-p12-'));

    try {
      writeUpdateCache(tempHome);
      const projectDir = path.join(tempHome, 'work', 'search-engine');
      writeClaudeSession(tempHome, 'search-engine', 'aaaa1111-0000-4000-8000-000000000007', projectDir, 'implement full text search ranking', '2026-04-18T10:00:00.000Z');

      const result = runAgents(['sessions', '--project', 'search'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(']');
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

  it('resolves Claude /resume history IDs to the resumed transcript', () => {
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
      fs.mkdirSync(transcriptCwd, { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'projects', 'swarmify-test', `${transcriptId}.jsonl`),
        [
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:00:00.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: 'Earlier context' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:00:05.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Earlier reply' }],
            },
          }),
          JSON.stringify({
            type: 'attachment',
            timestamp: '2026-04-17T19:30:30.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            attachment: {
              type: 'hook_success',
              hookName: 'SessionStart:resume',
              hookEvent: 'SessionStart',
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-04-17T19:30:45.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: { role: 'user', content: 'Continue from where we left off' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-04-17T19:31:00.000Z',
            cwd: transcriptCwd,
            sessionId: transcriptId,
            version: '2.1.110',
            gitBranch: 'main',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Loaded resumed transcript' }],
            },
          }),
        ].join('\n') + '\n',
        'utf-8'
      );

      const result = runAgents(['sessions', 'view', historyOnlyId, '--transcript'], repoRoot, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(`Resolved Claude history entry ${historyOnlyId} to transcript ${transcriptId}.`);
      expect(output).toContain('Loaded resumed transcript');
      expect(output).not.toContain(`No transcript session found matching: ${historyOnlyId}`);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('resolves text queries against session topics, not only IDs', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-view-query-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');
      const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const prompt = 'Search across sessions by prompt text';

      writeCodexSession(
        tempHome,
        sessionId,
        projectDir,
        prompt,
        '2026-04-17T19:41:30.000Z'
      );

      const result = runAgents(['sessions', 'view', 'prompt text', '--transcript'], projectDir, tempHome);
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain(prompt);
      expect(output).not.toContain('No session found matching: prompt text');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('applies --project filters before resolving search queries', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-view-project-filter-'));

    try {
      writeUpdateCache(tempHome);

      const workspaceDir = path.join(tempHome, 'work');
      const agentsDir = path.join(workspaceDir, 'agents');
      const agentsCliDir = path.join(workspaceDir, 'agents-cli');

      writeCodexSession(
        tempHome,
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        agentsDir,
        'Filter scoped search target',
        '2026-04-17T19:42:30.000Z'
      );
      writeCodexSession(
        tempHome,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        agentsCliDir,
        'Filter scoped search decoy',
        '2026-04-17T19:43:30.000Z'
      );

      const result = runAgents(
        ['sessions', 'view', '--project', 'agents-cli', 'scoped search', '--transcript'],
        workspaceDir,
        tempHome,
      );
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Filter scoped search decoy');
      expect(output).not.toContain('Filter scoped search target');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('applies --agent filters before resolving search queries', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-view-agent-filter-'));

    try {
      writeUpdateCache(tempHome);

      const projectDir = path.join(tempHome, 'work', 'agents-cli');

      writeClaudeSession(
        tempHome,
        'agents-cli-claude',
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        projectDir,
        'Shared filter phrase from claude',
        '2026-04-17T19:44:30.000Z'
      );
      writeCodexSession(
        tempHome,
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        projectDir,
        'Shared filter phrase from codex',
        '2026-04-17T19:45:30.000Z'
      );

      const result = runAgents(
        ['sessions', 'view', '--agent', 'codex', 'shared filter phrase', '--transcript'],
        projectDir,
        tempHome,
      );
      expect(result.status).toBe(0);

      const output = outputOf(result);
      expect(output).toContain('Shared filter phrase from codex');
      expect(output).not.toContain('Shared filter phrase from claude');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
