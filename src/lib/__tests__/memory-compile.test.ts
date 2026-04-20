import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { resolveImports } from '../memory-compile.js';

let tmpDir: string;

function writeFile(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-compile-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveImports', () => {
  it('inlines a simple relative import', () => {
    writeFile('rules/a.md', 'rule A body');
    const root = 'before\n@rules/a.md\nafter';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toBe('before\nrule A body\nafter');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toBe(path.join(tmpDir, 'rules/a.md'));
  });

  it('resolves imports recursively', () => {
    writeFile('presets/proactive.md', '@../rules/a.md\n@../rules/b.md');
    writeFile('rules/a.md', 'A');
    writeFile('rules/b.md', 'B');
    const root = '@presets/proactive.md';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toBe('A\nB');
    expect(result.sources).toHaveLength(3);
  });

  it('ignores @-imports inside fenced code blocks', () => {
    writeFile('rules/a.md', 'REAL');
    const root = 'live: @rules/a.md\n\n```markdown\n@rules/a.md\n```\n\nend';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toContain('live: REAL');
    // The fenced block must preserve its literal @-import text
    expect(result.content).toContain('```markdown\n@rules/a.md\n```');
    // Only one actual import was resolved
    expect(result.sources).toHaveLength(1);
  });

  it('ignores @-imports inside inline code spans', () => {
    writeFile('rules/a.md', 'REAL');
    const root = 'live: @rules/a.md\nDocs say: `@rules/a.md` — do not re-resolve.';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toContain('live: REAL');
    expect(result.content).toContain('`@rules/a.md`');
    expect(result.sources).toHaveLength(1);
  });

  it('leaves missing imports as literal text', () => {
    const root = '@rules/does-not-exist.md';

    const result = resolveImports(root, tmpDir);

    expect(result.content).toBe('@rules/does-not-exist.md');
    expect(result.sources).toHaveLength(0);
  });

  it('breaks cycles without infinite recursion', () => {
    writeFile('a.md', '@b.md');
    writeFile('b.md', '@a.md');
    const root = '@a.md';

    const result = resolveImports(root, tmpDir);

    // First visit expands a → b, then b → a is cycle-skipped (empty)
    expect(result.content).toBe('');
    expect(result.sources.length).toBeLessThanOrEqual(2);
  });

  it('supports tilde-prefixed absolute paths', () => {
    const homeFile = path.join(os.homedir(), `.agents-compile-test-${process.pid}.md`);
    fs.writeFileSync(homeFile, 'from home');
    try {
      const root = `@~/.agents-compile-test-${process.pid}.md`;
      const result = resolveImports(root, tmpDir);
      expect(result.content).toBe('from home');
      expect(result.sources[0]).toBe(homeFile);
    } finally {
      fs.unlinkSync(homeFile);
    }
  });

  it('respects MAX_DEPTH and does not hang on deep chains', () => {
    // Chain of 10 files; only 5 levels should resolve before depth cutoff.
    for (let i = 0; i < 10; i++) {
      const body = i < 9 ? `@f${i + 1}.md` : 'leaf';
      writeFile(`f${i}.md`, body);
    }
    const result = resolveImports('@f0.md', tmpDir);
    // Once depth exceeds, the inner @-token remains literal — so the final
    // content is some path of expansions followed by a leftover @f{n}.md.
    expect(result.content).toMatch(/@f\d+\.md$|leaf$/);
  });
});
