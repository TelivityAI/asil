import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractAntiRationalization,
  loadSkillMarkdown,
  skillCandidatePaths,
} from '../skill-loader.js';

describe('skillCandidatePaths', () => {
  it('tries the skill file directly under skillsPath before nested layouts and aliases', () => {
    expect(skillCandidatePaths('dead-code-removal')).toEqual([
      'dead-code-removal.md',
      join('dead-code-removal', 'SKILL.md'),
      join('skills', 'dead-code-removal.md'),
      join('skills', 'dead-code-removal', 'SKILL.md'),
      'code-simplification.md',
      join('code-simplification', 'SKILL.md'),
      join('skills', 'code-simplification.md'),
      join('skills', 'code-simplification', 'SKILL.md'),
    ]);
  });
});

describe('loadSkillMarkdown', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads {name}.md directly under the skills directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
    writeFileSync(join(dir, 'code-simplification.md'), '# direct\n');
    expect(loadSkillMarkdown(dir, 'type-error')).toBe('');
    expect(loadSkillMarkdown(dir, 'code-simplification')).toBe('# direct\n');
  });

  it('reads {name}/SKILL.md', () => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
    mkdirSync(join(dir, 'code-simplification'));
    writeFileSync(join(dir, 'code-simplification', 'SKILL.md'), '# skillmd\n');
    expect(loadSkillMarkdown(dir, 'code-simplification')).toBe('# skillmd\n');
  });

  it('falls back to a nested skills/ directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(dir, 'skills', 'code-simplification.md'), '# nested\n');
    expect(loadSkillMarkdown(dir, 'code-simplification')).toBe('# nested\n');
  });

  it('resolves category aliases onto upstream skill names', () => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
    mkdirSync(join(dir, 'security-and-hardening'));
    writeFileSync(
      join(dir, 'security-and-hardening', 'SKILL.md'),
      '# hardening\n',
    );
    expect(loadSkillMarkdown(dir, 'security-review')).toBe('# hardening\n');
  });

  it('returns an empty string when nothing matches', () => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
    expect(loadSkillMarkdown(dir, 'missing')).toBe('');
  });
});

describe('extractAntiRationalization', () => {
  it('extracts a Common Rationalizations section', () => {
    const skill = [
      '# Skill',
      '',
      '## Common Rationalizations',
      '- Skipping tests is fine',
      '',
      '## Next',
      'ignore',
    ].join('\n');
    const section = extractAntiRationalization(skill);
    expect(section).toMatch(/Common Rationalizations/);
    expect(section).toMatch(/Skipping tests is fine/);
    expect(section).not.toMatch(/ignore/);
  });

  it('returns an empty string when the section is absent', () => {
    expect(extractAntiRationalization('# Skill\n\nNo table.')).toBe('');
  });
});
