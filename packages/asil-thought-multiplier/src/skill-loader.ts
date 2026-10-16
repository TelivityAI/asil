/**
 * Resolve Markdown skill content from a skills directory.
 *
 * `skillsPath` is the directory ASIL is configured to read (default
 * `<repo>/.asil/skills`). See `skillCandidatePaths` for the layouts tried.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Historical thinker filenames that should still resolve when the installed
 * skills use the other name.
 */
export const SKILL_NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'security-review': ['security-and-hardening'],
  'security-and-hardening': ['security-review'],
  'testing-strategy': ['test-driven-development'],
  'test-driven-development': ['testing-strategy'],
  'planning-and-task-breakdown': [],
  'spec-driven-development': [],
};

function layoutsFor(name: string): string[] {
  return [
    `${name}.md`,
    join(name, 'SKILL.md'),
    join('skills', `${name}.md`),
    join('skills', name, 'SKILL.md'),
  ];
}

/** Strip a trailing `.md` so callers can pass either `foo` or `foo.md`. */
function normalizeSkillName(skillFile: string): string {
  return skillFile.replace(/\.md$/i, '');
}

/** Candidate paths relative to `skillsPath` for a skill name. */
export function skillCandidatePaths(skillFile: string): string[] {
  const primary = normalizeSkillName(skillFile);
  const names = [primary, ...(SKILL_NAME_ALIASES[primary] ?? [])];
  const paths: string[] = [];
  for (const name of names) paths.push(...layoutsFor(name));
  return paths;
}

/**
 * Load skill Markdown from disk. Returns `null` when nothing matches so
 * callers can fall back to inline defaults.
 */
export function loadSkillMarkdown(
  skillsPath: string,
  skillFile: string,
): string | null {
  for (const rel of skillCandidatePaths(skillFile)) {
    try {
      return readFileSync(join(skillsPath, rel), 'utf8');
    } catch {
      // try the next candidate
    }
  }
  return null;
}
