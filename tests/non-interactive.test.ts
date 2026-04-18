import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string };

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-non-interactive-'));
  const agentsDir = path.join(home, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION.version }),
  );
  return home;
}

function writeCentralCommand(home: string, name: string, description = 'Test command'): void {
  const commandsDir = path.join(home, '.agents', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, `${name}.md`),
    `---\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function writeFakeManagedVersion(home: string, agent: string, version: string, cliName: string): void {
  const binaryDir = path.join(home, '.agents', 'versions', agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binaryDir, { recursive: true });
  const binaryPath = path.join(binaryDir, cliName);
  fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(binaryPath, 0o755);
}

function runAgents(home: string, args: string[]) {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      SHELL: '/bin/zsh',
    },
    encoding: 'utf-8',
  });
}

const tempHomes: string[] = [];

afterEach(() => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop()!;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('non-interactive CLI usage', () => {
  it('shows a plain hint instead of opening a picker', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');

    const result = runAgents(home, ['commands', 'view']);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(combined).toContain('Selecting a command to view requires an interactive terminal.');
    expect(combined).toContain('agents commands view README');
  });

  it('syncs central commands with --names in a non-interactive shell', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');

    const result = runAgents(home, ['commands', 'add', '--names', 'README', '--agents', 'codex']);
    const targetPath = path.join(
      home,
      '.agents',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'README.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commands installed.');
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  it('syncs only the requested explicit version target', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    writeFakeManagedVersion(home, 'codex', '0.2.0', 'codex');

    const result = runAgents(home, ['commands', 'add', '--names', 'README', '--agents', 'codex@0.2.0']);
    const requestedPath = path.join(
      home,
      '.agents',
      'versions',
      'codex',
      '0.2.0',
      'home',
      '.codex',
      'prompts',
      'README.md',
    );
    const untouchedPath = path.join(
      home,
      '.agents',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'README.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commands installed.');
    expect(fs.existsSync(requestedPath)).toBe(true);
    expect(fs.existsSync(untouchedPath)).toBe(false);
  });

  it('uses defaults automatically for version switching in a non-interactive shell', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');

    const result = runAgents(home, ['use', 'codex@0.1.0']);
    const agentsYaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    const codexSymlink = path.join(home, '.codex');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Set Codex@0.1.0 as global default');
    expect(agentsYaml).toContain('codex: 0.1.0');
    expect(fs.lstatSync(codexSymlink).isSymbolicLink()).toBe(true);
  });
});
