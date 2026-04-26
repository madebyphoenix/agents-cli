import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPermissionsFromGroups, convertDenyToCodexRules } from './permissions.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-perms-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('permission path handling', () => {
  it('rejects traversal in permission group names', async () => {
    makeTempHome();

    expect(() => buildPermissionsFromGroups(['../outside'])).toThrow('Invalid name: ../outside.yaml');
  });

  it('escapes deny rules before writing Codex Starlark string literals', async () => {
    const rules = convertDenyToCodexRules(['Bash(git "status":*)']);

    expect(rules).toContain('"git", "\\"status\\""');
    expect(rules).not.toContain('"git", ""status""');
  });
});
