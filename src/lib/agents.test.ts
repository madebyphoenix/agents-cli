import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-agents-'));
  tempDirs.push(dir);
  return dir;
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeArgLogger(dir: string): { binary: string; logPath: string } {
  const binary = path.join(dir, 'fake-agent');
  const logPath = path.join(dir, 'argv.log');
  fs.writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `LOG_FILE=${shSingleQuote(logPath)}`,
      'printf "HOME:%s\\n" "$HOME" >> "$LOG_FILE"',
      'for arg do',
      '  printf "ARG:%s\\n" "$arg" >> "$LOG_FILE"',
      'done',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.chmodSync(binary, 0o755);
  return { binary, logPath };
}

function runAgentsModule(expression: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/agents.ts')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerMcp, unregisterMcp } from ${JSON.stringify(moduleUrl)};
    const result = await ${expression};
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MCP CLI execution', () => {
  it('registers MCP servers with argv, not a shell command string', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);
    const pwnedPath = path.join(dir, 'pwned');

    const result = runAgentsModule(
      `registerMcp('codex', ${JSON.stringify(`demo; touch ${pwnedPath}`)}, ${JSON.stringify(`/bin/echo; touch ${pwnedPath}`)}, 'user', 'stdio', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain(`HOME:${dir}`);
    expect(log).toContain('ARG:mcp\nARG:add');
    expect(log).toContain(`ARG:demo; touch ${pwnedPath}`);
    expect(log).toContain('ARG:/bin/echo;');
    expect(log).toContain('ARG:touch');
    expect(log).toContain(`ARG:${pwnedPath}`);
  });

  it('removes MCP servers with argv, not a shell command string', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);
    const pwnedPath = path.join(dir, 'pwned');

    const result = runAgentsModule(
      `unregisterMcp('codex', ${JSON.stringify(`demo"; touch ${pwnedPath}`)}, { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain('ARG:mcp\nARG:remove');
    expect(log).toContain(`ARG:demo"; touch ${pwnedPath}`);
  });

  it('preserves quoted MCP command arguments without invoking a shell', async () => {
    const dir = makeTempDir();
    const { binary, logPath } = writeArgLogger(dir);

    const result = runAgentsModule(
      `registerMcp('claude', 'demo', 'node -e "console.log(1)"', 'project', 'stdio', { binary: ${JSON.stringify(binary)}, home: ${JSON.stringify(dir)} })`
    ) as { success: boolean };

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(log).toContain('ARG:--transport\nARG:stdio\nARG:--scope\nARG:project');
    expect(log).toContain('ARG:node');
    expect(log).toContain('ARG:-e');
    expect(log).toContain('ARG:console.log(1)');
  });
});
