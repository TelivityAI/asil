/**
 * Resolve Markdown skill content from a skills directory.
 *
 * `skillsPath` is the directory ASIL is configured to read (default
 * `<repo>/.asil/skills`). Candidates are tried in order, then the same
 * order for each alias:
 *
 * 1. `{name}.md`
 * 2. `{name}/SKILL.md`
 * 3. `skills/{name}.md` (older installs that nested a skills/ folder)
 * 4. `skills/{name}/SKILL.md`
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * When a category name does not match an upstream skill folder, try these
 * fallbacks after the primary name.
 */
export const SKILL_NAME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'security-review': ['security-and-hardening'],
  'testing-strategy': ['test-driven-development'],
  'test-coverage-improvement': ['test-driven-development'],
  'dead-code-removal': ['code-simplification'],
  'dependency-update': ['deprecation-and-migration'],
  'documentation-generation': ['documentation-and-adrs'],
  'todo-resolution': [
    'incremental-implementation',
    'debugging-and-error-recovery',
  ],
};

function layoutsFor(name: string): string[] {
  return [
    `${name}.md`,
    join(name, 'SKILL.md'),
    join('skills', `${name}.md`),
    join('skills', name, 'SKILL.md'),
  ];
}

/** Candidate paths relative to `skillsPath` for a skill name or `name.md`. */
export function skillCandidatePaths(skillName: string): string[] {
  const primary = skillName.replace(/\.md$/i, '');
  const names = [primary, ...(SKILL_NAME_ALIASES[primary] ?? [])];
  const paths: string[] = [];
  for (const name of names) paths.push(...layoutsFor(name));
  return paths;
}

/**
 * Load skill Markdown from disk. Returns an empty string when nothing
 * matches so callers can fall back to inline defaults.
 */
export function loadSkillMarkdown(skillsPath: string, skillName: string): string {
  for (const rel of skillCandidatePaths(skillName)) {
    try {
      return readFileSync(join(skillsPath, rel), 'utf8');
    } catch {
      // try the next candidate
    }
  }
  return '';
}

/**
 * Extract the anti-rationalization section from a skill.
 *
 * Upstream skill libraries title this "Common Rationalizations". Other
 * copies use "Anti-Rationalization Table". Both are recognized so the
 * table is injected into the executor prompt.
 */
export function extractAntiRationalization(skill: string): string {
  if (!skill) return '';
  const lines = skill.split(/\r?\n/);
  const startIdx = lines.findIndex((l) =>
    /^#{1,6}\s*(?:anti[- ]?rationalization|common\s+rationalizations)\b/i.test(
      l,
    ),
  );
  if (startIdx === -1) return '';
  const afterStart = lines.slice(startIdx);
  const nextHeaderIdx = afterStart
    .slice(1)
    .findIndex((l) => /^#{1,6}\s+/.test(l));
  const slice =
    nextHeaderIdx === -1
      ? afterStart
      : afterStart.slice(0, nextHeaderIdx + 1);
  return slice.join('\n').trim();
}
