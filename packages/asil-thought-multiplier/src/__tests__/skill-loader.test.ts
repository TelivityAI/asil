import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSkillMarkdown } from '../skill-loader.js';
import { loadMarkdownSkill } from '../thinkers/shared.js';

describe('thought-multiplier skill loader', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a flat file directly under the skills directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'think-skills-'));
    writeFileSync(join(dir, 'security-and-hardening.md'), '# direct\n');
    expect(loadSkillMarkdown(dir, 'security-and-hardening.md')).toBe('# direct\n');
    expect(loadMarkdownSkill(dir, 'security-and-hardening.md', 'fallback')).toBe(
      '# direct\n',
    );
  });

  it('loads SKILL.md and historical aliases', () => {
    dir = mkdtempSync(join(tmpdir(), 'think-skills-'));
    mkdirSync(join(dir, 'security-review'));
    writeFileSync(join(dir, 'security-review', 'SKILL.md'), '# legacy\n');
    expect(loadSkillMarkdown(dir, 'security-and-hardening.md')).toBe('# legacy\n');
  });

  it('returns the fallback when no file matches', () => {
    dir = mkdtempSync(join(tmpdir(), 'think-skills-'));
    expect(loadMarkdownSkill(dir, 'security-and-hardening.md', 'fallback')).toBe(
      'fallback',
    );
    expect(loadMarkdownSkill(dir, undefined, 'fallback')).toBe('fallback');
  });
});
