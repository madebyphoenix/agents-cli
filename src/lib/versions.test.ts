import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-versions-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runVersionSync(home: string, expression: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/versions.ts')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { syncResourcesToVersion } from ${JSON.stringify(moduleUrl)};
    const home = ${JSON.stringify(home)};
    const result = ${expression};
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });

  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim());
}

describe('version resource sync path handling', () => {
  it('intersects explicit resource selections with discovered resources before syncing', async () => {
    const home = makeTempHome();

    fs.mkdirSync(path.join(home, '.agents', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'commands', 'safe.md'), 'safe command', 'utf-8');

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', { commands: ['../escape', 'safe'] }, { cwd: home })"
    ) as { commands: boolean };

    expect(result.commands).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', 'versions', 'codex', '0.1.0', 'home', '.codex', 'prompts', 'safe.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', 'versions', 'codex', '0.1.0', 'home', '.codex', 'escape.md'))).toBe(false);
  });

  it('does not follow symlinks inside copied skill resources', async () => {
    const home = makeTempHome();

    const skillDir = path.join(home, '.agents', 'skills', 'leaky');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'skill body', 'utf-8');
    const secretPath = path.join(home, 'secret.txt');
    fs.writeFileSync(secretPath, 'secret', 'utf-8');
    fs.symlinkSync(secretPath, path.join(skillDir, 'secret-link'));

    const result = runVersionSync(
      home,
      "syncResourcesToVersion('codex', '0.1.0', { skills: ['leaky'] }, { cwd: home })"
    ) as { skills: boolean };

    const syncedSkillDir = path.join(home, '.agents', 'versions', 'codex', '0.1.0', 'home', '.codex', 'skills', 'leaky');
    expect(result.skills).toBe(true);
    expect(fs.existsSync(path.join(syncedSkillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(syncedSkillDir, 'secret-link'))).toBe(false);
  });
});
