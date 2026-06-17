import { describe, expect, it } from 'vitest';
import {
  normalizePath,
  scanCodebase,
  scanTestFailures,
  scanTypeErrors,
  scanTodos,
  scanCoverageGaps,
  scanDeadCode,
  stableTaskId,
  toRepoRelative,
} from '../scanner.js';
import { mockFileReader, mockRunner } from './helpers.js';

describe('scanner', () => {
  describe('stableTaskId (Codex #4 — deterministic identity)', () => {
    it('is deterministic for the same category + file paths across calls', () => {
      const a = stableTaskId('type-error', ['src/foo.ts']);
      const b = stableTaskId('type-error', ['src/foo.ts']);
      expect(a).toBe(b);
      expect(a.startsWith('type-error-')).toBe(true);
    });

    it('is order-insensitive on file paths', () => {
      expect(stableTaskId('test-failure', ['a.ts', 'b.ts'])).toBe(
        stableTaskId('test-failure', ['b.ts', 'a.ts']),
      );
    });

    it('normalizes ./ before hashing so ./foo and foo collide', () => {
      expect(stableTaskId('dead-code', ['./src/x.ts'])).toBe(
        stableTaskId('dead-code', ['src/x.ts']),
      );
    });

    it('differs by category and by file set', () => {
      expect(stableTaskId('type-error', ['src/foo.ts'])).not.toBe(
        stableTaskId('test-failure', ['src/foo.ts']),
      );
      expect(stableTaskId('type-error', ['src/foo.ts'])).not.toBe(
        stableTaskId('type-error', ['src/bar.ts']),
      );
    });
  });

  describe('toRepoRelative (Codex #3)', () => {
    it('strips a repoRoot prefix to yield a repo-relative path', () => {
      expect(toRepoRelative('/repo', '/repo/src/foo.ts')).toBe('src/foo.ts');
      expect(toRepoRelative('/repo/', '/repo/src/foo.ts')).toBe('src/foo.ts');
    });
    it('leaves already-relative paths alone (and strips ./)', () => {
      expect(toRepoRelative('/repo', 'src/foo.ts')).toBe('src/foo.ts');
      expect(toRepoRelative('/repo', './src/foo.ts')).toBe('src/foo.ts');
    });
    it('leaves paths outside repoRoot unchanged', () => {
      expect(toRepoRelative('/repo', '/other/x.ts')).toBe('/other/x.ts');
    });
  });

  describe('scanTestFailures', () => {
    it('returns [] when tests pass (exit 0)', async () => {
      const runner = mockRunner([
        { match: (cmd) => cmd === 'pnpm', stdout: '{"testResults":[]}', exitCode: 0 },
      ]);
      const tasks = await scanTestFailures('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks).toEqual([]);
    });

    it('parses vitest JSON for failing tests', async () => {
      const vitestOut = JSON.stringify({
        testResults: [
          {
            name: '/repo/packages/foo/src/foo.test.ts',
            assertionResults: [
              { status: 'failed', fullName: 'foo returns 1' },
              { status: 'failed', fullName: 'foo handles empty input' },
              { status: 'passed', fullName: 'foo returns 2' },
            ],
          },
        ],
      });
      const runner = mockRunner([
        { match: () => true, stdout: vitestOut, exitCode: 1 },
      ]);
      const tasks = await scanTestFailures('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.category).toBe('test-failure');
      expect(tasks[0]?.severity).toBe('critical');
      expect(tasks[0]?.description).toContain('foo returns 1');
    });
  });

  describe('scanTypeErrors', () => {
    it('parses tsc output grouped by file', async () => {
      const tscOut =
        'packages/foo/src/foo.ts(12,3): error TS2322: Type string is not assignable to number.\n' +
        'packages/foo/src/foo.ts(20,5): error TS2339: Property bar does not exist.\n' +
        'packages/bar/src/bar.ts(4,4): error TS2304: Cannot find name qux.\n';
      const runner = mockRunner([
        { match: () => true, stdout: tscOut, exitCode: 2 },
      ]);
      const tasks = await scanTypeErrors('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks.length).toBe(2);
      const foo = tasks.find((t) => t.filePaths[0]?.includes('foo.ts'));
      expect(foo?.description).toMatch(/TS2322/);
      expect(foo?.description).toMatch(/TS2339/);
    });

    it('returns [] on clean typecheck', async () => {
      const runner = mockRunner([{ match: () => true, stdout: '', exitCode: 0 }]);
      const tasks = await scanTypeErrors('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks).toEqual([]);
    });

    it('strips pnpm -r project-label prefix from typecheck output (Issue #1)', async () => {
      // pnpm-recursive output prefixes every line with `<pkg> <script>: `.
      // Without the strip, the file path used to capture as e.g.
      // "apps/api typecheck: src/database/database.module.ts" — a path
      // no executor could satisfy. Refs github.com/telivity-otaip/asil#1.
      const tscOut = [
        'apps/api typecheck: src/database/database.module.ts(5,1): error TS2307: Cannot find module \'@x/db\'.',
        'apps/api typecheck: src/foo.ts(10,2): error TS2322: Type string is not assignable to number.',
        // Mixed: one line that already lacks the prefix should still parse.
        'packages/shared/src/util.ts(4,4): error TS2304: Cannot find name qux.',
        // Junk pnpm header lines are not TS errors and must not be misinterpreted.
        'apps/api typecheck: > tsc --noEmit',
      ].join('\n');
      const runner = mockRunner([
        { match: () => true, stdout: tscOut, exitCode: 2 },
      ]);
      const tasks = await scanTypeErrors('/repo', {
        runner,
        fs: mockFileReader(),
      });
      const paths = tasks.flatMap((t) => t.filePaths);
      expect(paths).toContain('src/database/database.module.ts');
      expect(paths).toContain('src/foo.ts');
      expect(paths).toContain('packages/shared/src/util.ts');
      // None of the captured paths should still carry the pnpm label.
      expect(paths.every((p) => !p.includes('typecheck:'))).toBe(true);
      expect(paths.every((p) => !p.includes(' '))).toBe(true);
    });
  });

  describe('scanTodos', () => {
    it('parses grep output, groups by file, bumps severity for DOMAIN_QUESTION', async () => {
      const grepOut = [
        './packages/foo/src/foo.ts:12:// TODO: handle empty input',
        './packages/foo/src/foo.ts:14:// FIXME: rounding',
        './packages/bar/src/bar.ts:3:// DOMAIN_QUESTION: how do we handle BSP settlement?',
      ].join('\n');
      const runner = mockRunner([{ match: () => true, stdout: grepOut }]);
      const tasks = await scanTodos('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks.length).toBe(2);
      const bar = tasks.find((t) => t.filePaths[0]?.includes('bar.ts'));
      expect(bar?.severity).toBe('high');
      const foo = tasks.find((t) => t.filePaths[0]?.includes('foo.ts'));
      expect(foo?.severity).toBe('medium');
    });
  });

  describe('scanCoverageGaps', () => {
    it('returns [] if no coverage report exists', async () => {
      const tasks = await scanCoverageGaps('/repo', {
        runner: mockRunner([]),
        fs: mockFileReader(),
      });
      expect(tasks).toEqual([]);
    });

    it('flags files with branch coverage below 80% and normalizes absolute keys to repo-relative', async () => {
      // Coverage reporters emit ABSOLUTE file keys. They must be
      // converted to repo-relative or the executor rejects the
      // <<<FILE: …>>> path as suspicious (Codex review #3).
      const summary = JSON.stringify({
        total: { branches: { pct: 90 } },
        '/repo/src/foo.ts': { branches: { pct: 45 } },
        '/repo/src/bar.ts': { branches: { pct: 85 } },
      });
      const tasks = await scanCoverageGaps('/repo', {
        runner: mockRunner([]),
        fs: mockFileReader({ '/repo/coverage/coverage-summary.json': summary }),
      });
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.filePaths[0]).toBe('src/foo.ts');
      expect(tasks[0]?.severity).toBe('high');
    });
  });

  describe('scanDeadCode', () => {
    it('finds exports with no external references', async () => {
      const exportsOut = './pkg/foo.ts:1:export const usedSymbol = 1';
      const usageForUsed = ['./pkg/foo.ts', './pkg/bar.ts'].join('\n');
      const runner = mockRunner([
        {
          match: (_, args) => args.some((a) => a.includes('^export')),
          stdout: exportsOut,
        },
        {
          match: (_, args) => args.some((a) => a.includes('usedSymbol')),
          stdout: usageForUsed,
        },
      ]);
      const tasks = await scanDeadCode('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks).toEqual([]);
    });

    it('emits a dead-code task when an export has no external uses', async () => {
      const exportsOut = './pkg/foo.ts:1:export const lonely = 1';
      const runner = mockRunner([
        {
          match: (_, args) => args.some((a) => a.includes('^export')),
          stdout: exportsOut,
        },
        {
          match: (_, args) => args.some((a) => a.includes('lonely')),
          // Only the defining file references the symbol.
          stdout: './pkg/foo.ts',
        },
      ]);
      const tasks = await scanDeadCode('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.category).toBe('dead-code');
      expect(tasks[0]?.description).toContain('lonely');
    });

    it('searches BOTH .ts and .tsx for exports and usages (regression: missing .tsx made imports from React component files invisible, yielding false-positive dead-code on InviteState)', async () => {
      const includesArgs: string[][] = [];
      const runner = mockRunner([
        {
          // Capture the args for the exports grep.
          match: (_, args) => args.some((a) => a.includes('^export')),
          stdout: './packages/ui/policies/actions.ts:5:export interface InviteState',
        },
        {
          // Capture the args for the usage grep.
          match: (_, args) => args.some((a) => a.includes('InviteState')),
          // Symbol is referenced by a .tsx component AND its defining file.
          stdout: [
            './packages/ui/policies/actions.ts',
            './packages/ui/policies/invite-form.tsx',
          ].join('\n'),
        },
      ]);
      // Wrap runner.run to capture every set of args for assertion.
      const wrapped = {
        async run(cmd: string, args: string[], opts: { cwd: string }) {
          if (cmd === 'grep') includesArgs.push(args);
          return runner.run(cmd, args, opts);
        },
      };
      const tasks = await scanDeadCode('/repo', {
        runner: wrapped,
        fs: mockFileReader(),
      });
      // No dead-code task — InviteState is used externally from invite-form.tsx.
      expect(tasks).toEqual([]);
      // Every grep invocation must include both .ts and .tsx.
      for (const args of includesArgs) {
        expect(args).toContain('--include=*.ts');
        expect(args).toContain('--include=*.tsx');
      }
    });
  });

  it('scanCodebase aggregates all scanners in parallel', async () => {
    const runner = mockRunner([
      { match: () => true, stdout: '', exitCode: 0 },
    ]);
    const result = await scanCodebase('/repo', {
      runner,
      fs: mockFileReader(),
    });
    expect(result.tasks).toEqual([]);
    expect(result.scannedAt).toBeInstanceOf(Date);
    expect(typeof result.scanDurationMs).toBe('number');
  });

  describe('normalizePath', () => {
    it('strips leading ./ prefix', () => {
      expect(normalizePath('./packages/foo/src/bar.ts')).toBe(
        'packages/foo/src/bar.ts',
      );
    });
    it('leaves paths without ./ unchanged', () => {
      expect(normalizePath('packages/foo/src/bar.ts')).toBe(
        'packages/foo/src/bar.ts',
      );
    });
    it('leaves absolute paths alone', () => {
      expect(normalizePath('/repo/src/foo.ts')).toBe('/repo/src/foo.ts');
    });
    it('only strips the FIRST ./ (paths with embedded ./ are pathological — leave them to the traversal guard)', () => {
      // Embedded `./` later in the path would be unusual; we only care
      // about the leading case grep emits.
      expect(normalizePath('./foo/./bar.ts')).toBe('foo/./bar.ts');
    });
  });

  describe('path normalization across scanners', () => {
    it('scanTodos produces filePaths without ./ prefix (grep emits ./)', async () => {
      const grepOut = [
        './packages/foo/src/foo.ts:12:// TODO: handle empty input',
        './packages/bar/src/bar.ts:3:// TODO: rounding',
      ].join('\n');
      const runner = mockRunner([{ match: () => true, stdout: grepOut }]);
      const tasks = await scanTodos('/repo', {
        runner,
        fs: mockFileReader(),
      });
      for (const task of tasks) {
        for (const p of task.filePaths) {
          expect(p.startsWith('./')).toBe(false);
        }
      }
      // Concretely: the normalized paths appear in the task list.
      const all = tasks.flatMap((t) => t.filePaths);
      expect(all).toContain('packages/foo/src/foo.ts');
      expect(all).toContain('packages/bar/src/bar.ts');
    });

    it('scanTypeErrors normalizes tsc output paths', async () => {
      const tscOut =
        './packages/foo/src/foo.ts(12,3): error TS2322: Type string not assignable to number.\n';
      const runner = mockRunner([
        { match: () => true, stdout: tscOut, exitCode: 2 },
      ]);
      const tasks = await scanTypeErrors('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks[0]?.filePaths[0]).toBe('packages/foo/src/foo.ts');
    });

    it('scanTestFailures normalizes vitest JSON `name` paths', async () => {
      const vitestOut = JSON.stringify({
        testResults: [
          {
            name: './packages/foo/src/foo.test.ts',
            assertionResults: [
              { status: 'failed', fullName: 'fails the happy path' },
            ],
          },
        ],
      });
      const runner = mockRunner([
        { match: () => true, stdout: vitestOut, exitCode: 1 },
      ]);
      const tasks = await scanTestFailures('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks[0]?.filePaths[0]).toBe('packages/foo/src/foo.test.ts');
    });

    it('scanCoverageGaps normalizes keys from coverage-summary.json', async () => {
      const summary = JSON.stringify({
        total: { branches: { pct: 90 } },
        './src/foo.ts': { branches: { pct: 45 } },
      });
      const tasks = await scanCoverageGaps('/repo', {
        runner: mockRunner([]),
        fs: mockFileReader({ '/repo/coverage/coverage-summary.json': summary }),
      });
      expect(tasks[0]?.filePaths[0]).toBe('src/foo.ts');
    });

    it('scanDeadCode normalizes both the exports grep and the usage comparison', async () => {
      // Exports grep: `./pkg/foo.ts:1:export const lonely = 1`.
      // Usage grep returns `./pkg/foo.ts` — the only match is the
      // defining file itself. Without normalization on BOTH sides the
      // comparison `'./pkg/foo.ts' !== 'pkg/foo.ts'` is true and the
      // symbol looks externally used; with normalization it's correctly
      // detected as dead.
      const runner = mockRunner([
        {
          match: (_, args) => args.some((a) => a.includes('^export')),
          stdout: './pkg/foo.ts:1:export const lonely = 1',
        },
        {
          match: (_, args) => args.some((a) => a.includes('lonely')),
          stdout: './pkg/foo.ts',
        },
      ]);
      const tasks = await scanDeadCode('/repo', {
        runner,
        fs: mockFileReader(),
      });
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.filePaths[0]).toBe('pkg/foo.ts');
      expect(tasks[0]?.description).toContain('lonely');
    });
  });
});
