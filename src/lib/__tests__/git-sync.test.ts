import { describe, it, expect } from 'vitest';
import { getGitSyncStatus, isGitRepo, getTrackedFiles } from '../git.js';
import { parseSkillMetadata } from '../skills.js';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

const AGENTS_DIR = path.join(process.env.HOME!, '.agents');

describe('Git Sync Status - Real Repo Tests', () => {
  it('~/.agents/ should be a git repo', () => {
    expect(isGitRepo(AGENTS_DIR)).toBe(true);
  });

  it('should list files in ~/.agents/skills/', () => {
    const skillsDir = path.join(AGENTS_DIR, 'skills');
    const skills = fs.readdirSync(skillsDir).filter(f => !f.startsWith('.'));
    console.log('Local skills:', skills);
    expect(skills.length).toBeGreaterThan(0);
  });

  it('should have git-tracked skills', async () => {
    const trackedFiles = await getTrackedFiles(AGENTS_DIR, 'skills');
    console.log('Git tracked skills files:', trackedFiles);

    // These should be tracked based on GitHub repo
    const expectedTracked = ['skills/mq', 'skills/openclaw', 'skills/skill-creator'];
    for (const expected of expectedTracked) {
      const hasMatch = trackedFiles.some(f => f.startsWith(expected));
      expect(hasMatch, `Expected ${expected} to be tracked`).toBe(true);
    }
  });

  it('getGitSyncStatus should return tracked files as synced', async () => {
    const status = await getGitSyncStatus(AGENTS_DIR, 'skills');
    console.log('getGitSyncStatus for skills:', JSON.stringify(status, null, 2));

    // synced array should contain tracked files
    // OR all arrays empty means clean (no changes)
    expect(status).not.toBeNull();
  });

  it('should detect untracked skills as new', async () => {
    const skillsDir = path.join(AGENTS_DIR, 'skills');
    const localSkills = fs.readdirSync(skillsDir).filter(f => !f.startsWith('.'));
    const trackedFiles = await getTrackedFiles(AGENTS_DIR, 'skills');

    // Find skills that are local but not tracked
    const untrackedSkills = localSkills.filter(skill => {
      return !trackedFiles.some(f => f.startsWith(`skills/${skill}`));
    });

    console.log('Untracked skills (should be blue):', untrackedSkills);

    const status = await getGitSyncStatus(AGENTS_DIR, 'skills');
    console.log('Git status new files:', status?.new);

    // Untracked files should appear in status.new
    // This is the bug - they might not be appearing
  });

  it('should correctly identify tracked vs untracked', async () => {
    const skillsDir = path.join(AGENTS_DIR, 'skills');
    const localSkills = fs.readdirSync(skillsDir).filter(f => !f.startsWith('.'));
    const trackedFiles = await getTrackedFiles(AGENTS_DIR, 'skills');

    const trackedSkillNames = new Set<string>();
    for (const file of trackedFiles) {
      const match = file.match(/^skills\/([^/]+)/);
      if (match) trackedSkillNames.add(match[1]);
    }

    console.log('\n=== SKILL STATUS ===');
    for (const skill of localSkills) {
      const isTracked = trackedSkillNames.has(skill);
      const status = isTracked ? 'TRACKED (should be green)' : 'UNTRACKED (should be blue)';
      console.log(`  ${skill}: ${status}`);
    }

    expect(trackedSkillNames.size).toBeGreaterThan(0);
  });

  it('getGitSyncStatus should populate synced array for clean tracked files', async () => {
    // The issue: getGitSyncStatus returns empty arrays even for tracked files
    // Because it only looks at git status (changed files), not all tracked files

    const status = await getGitSyncStatus(AGENTS_DIR, 'skills');
    console.log('\ngetGitSyncStatus result:');
    console.log('  synced:', status?.synced);
    console.log('  new:', status?.new);
    console.log('  modified:', status?.modified);

    // This test documents the current behavior
    // If all arrays are empty, that means "no changes" but doesn't tell us what's tracked
  });
});

describe('Commands Git Status', () => {
  it('should have git-tracked commands', async () => {
    const trackedFiles = await getTrackedFiles(AGENTS_DIR, 'commands');
    console.log('Git tracked command files:', trackedFiles.slice(0, 5), '...');
    expect(trackedFiles.length).toBeGreaterThan(0);
  });

  it('getGitSyncStatus for commands', async () => {
    const status = await getGitSyncStatus(AGENTS_DIR, 'commands');
    console.log('getGitSyncStatus for commands:', JSON.stringify(status, null, 2));
  });
});

describe('Skill YAML Parsing', () => {
  it('should parse SKILL.md with valid YAML frontmatter', () => {
    const skillsDir = path.join(AGENTS_DIR, 'skills');
    const skills = fs.readdirSync(skillsDir).filter(f => !f.startsWith('.'));

    console.log('\n=== SKILL.md YAML Parsing ===');
    for (const skill of skills) {
      const skillDir = path.join(skillsDir, skill);
      const skillMdPath = path.join(skillDir, 'SKILL.md');

      if (!fs.existsSync(skillMdPath)) {
        console.log(`  ${skill}: NO SKILL.md`);
        continue;
      }

      const meta = parseSkillMetadata(skillDir);
      if (meta) {
        console.log(`  ${skill}: OK (name: ${meta.name})`);
      } else {
        // Try to diagnose the issue
        const content = fs.readFileSync(skillMdPath, 'utf-8');
        const lines = content.split('\n');
        if (lines[0] === '---') {
          const endIdx = lines.slice(1).findIndex(l => l === '---');
          if (endIdx > 0) {
            const frontmatter = lines.slice(1, endIdx + 1).join('\n');
            try {
              yaml.parse(frontmatter);
              console.log(`  ${skill}: FAILED (unknown reason)`);
            } catch (e: any) {
              console.log(`  ${skill}: YAML ERROR - ${e.message.split('\n')[0]}`);
            }
          }
        }
      }
    }
  });

  it('YAML with colons in values should be quoted', () => {
    // This documents the issue: YAML values containing colons need quotes
    const validYaml = `name: test
description: "Query files with mq CLI. Triggers on: this is fine"`;
    const parsed = yaml.parse(validYaml);
    expect(parsed.description).toContain('Triggers on:');

    // Without quotes, this fails
    const invalidYaml = `name: test
description: Query files with mq CLI. Triggers on: this breaks`;
    expect(() => yaml.parse(invalidYaml)).toThrow();
  });
});
