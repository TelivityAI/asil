import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  categoriesToSkip,
  formatSkillStatus,
  interruptibleSleep,
  parseFlags,
  scanCategoriesFor,
  skillStatuses,
} from '../run-a.js';

describe('parseFlags', () => {
  it('does not publish unless --apply is set', () => {
    const flags = parseFlags(['--max-tasks', '1']);
    expect(flags?.apply).toBe(false);
    expect(flags?.dryRun).toBe(false);
  });

  it('sets apply when --apply is passed', () => {
    const flags = parseFlags(['--apply', '--max-tasks', '2']);
    expect(flags?.apply).toBe(true);
    expect(flags?.maxTasks).toBe(2);
  });

  it('keeps --dry-run from executing even if --apply is also passed', () => {
    const flags = parseFlags(['--dry-run', '--apply']);
    expect(flags?.dryRun).toBe(true);
    expect(flags?.apply).toBe(true);
  });

  it('requires skills only when --require-skills is set', () => {
    expect(parseFlags([])?.requireSkills).toBe(false);
    expect(parseFlags(['--require-skills'])?.requireSkills).toBe(true);
  });

  it('defaults to one task and skips test, coverage, and dead-code scanners', () => {
    const flags = parseFlags([]);
    expect(flags?.maxTasks).toBe(1);
    expect(flags?.full).toBe(false);
    expect(scanCategoriesFor(flags!)).toEqual(['type-error', 'todo-resolution']);
    expect(categoriesToSkip(flags!)).toEqual([
      'test-failure',
      'coverage-gap',
      'dead-code',
    ]);
  });

  it('scans every category when --full is set', () => {
    const flags = parseFlags(['--full', '--skip', 'dead-code']);
    expect(scanCategoriesFor(flags!)).toEqual([
      'test-failure',
      'type-error',
      'todo-resolution',
      'coverage-gap',
    ]);
    expect(categoriesToSkip(flags!)).toContain('dead-code');
    expect(categoriesToSkip(flags!)).not.toContain('test-failure');
  });

  it('parses --fresh and --interval, and forces skip-questions for interval mode', () => {
    expect(parseFlags([])?.fresh).toBe(false);
    expect(parseFlags([])?.intervalSec).toBeNull();
    expect(parseFlags(['--fresh'])?.fresh).toBe(true);
    const interval = parseFlags(['--interval', '45']);
    expect(interval?.intervalSec).toBe(45);
    expect(interval?.skipQuestions).toBe(true);
    expect(parseFlags(['--interval', '0'])).toBeNull();
  });
});

describe('interruptibleSleep', () => {
  it('returns early when shouldStop becomes true', async () => {
    let stop = false;
    const started = Date.now();
    setTimeout(() => {
      stop = true;
    }, 40);
    await interruptibleSleep(5_000, () => stop);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('skillStatuses', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a loaded file and a missing skill', () => {
    dir = mkdtempSync(join(tmpdir(), 'asil-skills-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'code-simplification.md'), '# skill\n');
    const rows = skillStatuses(dir, ['test-failure', 'todo-resolution', 'coverage-gap', 'dead-code']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe('type-error');
    expect(rows[0]?.path).toBe(join(dir, 'code-simplification.md'));
    expect(formatSkillStatus(rows[0]!)).toContain('code-simplification.md');

    const missing = skillStatuses(dir, ['type-error', 'test-failure', 'coverage-gap', 'dead-code']);
    expect(missing[0]?.path).toBeNull();
    expect(formatSkillStatus(missing[0]!)).toContain('missing, using built-in instructions');
  });
});
