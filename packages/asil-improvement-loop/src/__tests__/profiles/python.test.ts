import { describe, expect, it } from 'vitest';
import { pythonProfile } from '../../profiles/python.js';
import { mockFileReader, mockRunner } from '../helpers.js';
import {
  scanCoverageGaps,
  scanDeadCode,
  scanTestFailures,
  scanTodos,
  scanTypeErrors,
} from '../../scanner.js';

describe('pythonProfile', () => {
  describe('parseTestFailures', () => {
    it('parses pytest --json-report output, groups failures by file', () => {
      const json = JSON.stringify({
        tests: [
          { nodeid: 'tests/test_foo.py::test_one', outcome: 'failed' },
          { nodeid: 'tests/test_foo.py::test_two', outcome: 'failed' },
          { nodeid: 'tests/test_bar.py::TestClass::test_x', outcome: 'failed' },
          { nodeid: 'tests/test_foo.py::test_three', outcome: 'passed' },
        ],
      });
      const r = pythonProfile.parseTestFailures(json, '');
      expect(r.length).toBe(2);
      const foo = r.find((f) => f.filePath === 'tests/test_foo.py');
      expect(foo?.failureNames).toEqual(['test_one', 'test_two']);
      const bar = r.find((f) => f.filePath === 'tests/test_bar.py');
      expect(bar?.failureNames).toEqual(['TestClass::test_x']);
    });

    it('returns [] for malformed json', () => {
      expect(pythonProfile.parseTestFailures('not json', '')).toEqual([]);
    });

    it('treats "error" outcome as failure too', () => {
      const json = JSON.stringify({
        tests: [{ nodeid: 'tests/x.py::test_y', outcome: 'error' }],
      });
      const r = pythonProfile.parseTestFailures(json, '');
      expect(r.length).toBe(1);
    });
  });

  describe('parseTypeErrors', () => {
    it('parses mypy --show-error-codes output', () => {
      const out = [
        'src/foo.py:12: error: Incompatible return value type (got "str", expected "int")  [return-value]',
        "src/bar.py:5: error: Cannot find implementation or library stub for module named 'unknown_pkg'  [import-not-found]",
        'src/foo.py:20: error: Name "undefined_name" is not defined  [name-defined]',
      ].join('\n');
      const r = pythonProfile.parseTypeErrors(out);
      expect(r.length).toBe(3);
      expect(r[0]).toEqual({
        filePath: 'src/foo.py',
        line: 12,
        code: 'return-value',
        message: 'Incompatible return value type (got "str", expected "int")',
      });
      expect(r[1]?.code).toBe('import-not-found');
    });

    it('handles mypy output without --show-error-codes (no bracket suffix)', () => {
      const out = 'src/foo.py:7: error: Unsupported operand types';
      const r = pythonProfile.parseTypeErrors(out);
      expect(r.length).toBe(1);
      expect(r[0]?.code).toBe('error'); // fallback
      expect(r[0]?.message).toBe('Unsupported operand types');
    });

    it('handles --show-column-numbers (file.py:LINE:COL)', () => {
      const out = 'src/foo.py:12:5: error: Bad type  [arg-type]';
      const r = pythonProfile.parseTypeErrors(out);
      expect(r.length).toBe(1);
      expect(r[0]?.line).toBe(12);
    });

    it('returns [] on irrelevant output (no `error:` lines)', () => {
      expect(pythonProfile.parseTypeErrors('Success: no issues found in 12 files')).toEqual(
        [],
      );
    });
  });

  describe('coverage.extract', () => {
    it('reads coverage.py JSON output, uses percent_covered_branch when present', () => {
      const json = {
        files: {
          'src/foo.py': { summary: { percent_covered_branch: 65 } },
          'src/bar.py': { summary: { percent_covered_branch: 95 } },
          'src/baz.py': { summary: { percent_covered: 40 } }, // fallback path
        },
      };
      const r = pythonProfile.coverage.extract(json);
      const foo = r.find((e) => e.filePath === 'src/foo.py');
      const baz = r.find((e) => e.filePath === 'src/baz.py');
      expect(foo?.branchPct).toBe(65);
      expect(baz?.branchPct).toBe(40);
    });

    it('returns [] for missing files key', () => {
      expect(pythonProfile.coverage.extract({})).toEqual([]);
    });
  });

  describe('deadCode.usageGrep', () => {
    it('produces a grep -rln with --include=*.py and --include=*.pyi', () => {
      const grep = pythonProfile.deadCode!.usageGrep('FooSymbol', [
        '--exclude-dir=node_modules',
      ]);
      expect(grep.cmd).toBe('grep');
      expect(grep.args).toContain('--include=*.py');
      expect(grep.args).toContain('--include=*.pyi');
      expect(grep.args).toContain('--exclude-dir=node_modules');
      // The symbol shows up inside the -E pattern.
      expect(grep.args.some((a) => a.includes('FooSymbol'))).toBe(true);
    });
  });
});

describe('scanner with pythonProfile', () => {
  describe('scanTestFailures', () => {
    it('runs pytest --json-report and produces a task per failing file', async () => {
      const runner = mockRunner([
        {
          match: (cmd) => cmd === 'pytest',
          stdout: JSON.stringify({
            tests: [
              { nodeid: 'tests/test_x.py::test_one', outcome: 'failed' },
              { nodeid: 'tests/test_x.py::test_two', outcome: 'failed' },
            ],
          }),
          exitCode: 1,
        },
      ]);
      const tasks = await scanTestFailures(
        '/repo',
        { runner, fs: mockFileReader() },
        pythonProfile,
      );
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.filePaths).toEqual(['tests/test_x.py']);
      expect(tasks[0]?.description).toContain('test_one');
      expect(tasks[0]?.description).toContain('test_two');
    });
  });

  describe('scanTypeErrors', () => {
    it('runs mypy and groups errors by file', async () => {
      const out = [
        'src/foo.py:10: error: Bad return  [return-value]',
        'src/foo.py:20: error: Bad arg  [arg-type]',
        'src/bar.py:3: error: Bad import  [import-not-found]',
      ].join('\n');
      const runner = mockRunner([
        { match: (cmd) => cmd === 'mypy', stdout: out, exitCode: 1 },
      ]);
      const tasks = await scanTypeErrors(
        '/repo',
        { runner, fs: mockFileReader() },
        pythonProfile,
      );
      expect(tasks.length).toBe(2);
      const foo = tasks.find((t) => t.filePaths[0] === 'src/foo.py');
      expect(foo?.description).toContain('return-value');
      expect(foo?.description).toContain('arg-type');
    });
  });

  describe('scanTodos', () => {
    it('greps only .py and .pyi for TODO/FIXME', async () => {
      const includesArgs: string[][] = [];
      const runner = mockRunner([
        {
          match: (cmd, args) => {
            includesArgs.push(args);
            return cmd === 'grep';
          },
          stdout: './src/foo.py:42:# TODO: refactor',
        },
      ]);
      const tasks = await scanTodos(
        '/repo',
        { runner, fs: mockFileReader() },
        pythonProfile,
      );
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.filePaths).toEqual(['src/foo.py']);
      // Confirm the include args were Python-only.
      const args = includesArgs[0]!;
      expect(args).toContain('--include=*.py');
      expect(args).toContain('--include=*.pyi');
      expect(args).not.toContain('--include=*.ts');
    });
  });

  describe('scanCoverageGaps', () => {
    it('reads coverage.json (not coverage-summary.json) and emits per-file tasks', async () => {
      const fs = mockFileReader({
        '/repo/coverage.json': JSON.stringify({
          files: {
            'src/foo.py': { summary: { percent_covered_branch: 30 } },
            'src/bar.py': { summary: { percent_covered_branch: 90 } },
          },
        }),
      });
      const runner = mockRunner([]);
      const tasks = await scanCoverageGaps(
        '/repo',
        { runner, fs },
        pythonProfile,
      );
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.filePaths).toEqual(['src/foo.py']);
      expect(tasks[0]?.severity).toBe('high'); // <50
    });
  });

  describe('scanDeadCode', () => {
    it('finds top-level def/class with no external usages', async () => {
      const runner = mockRunner([
        {
          // Exports grep — emits one top-level def
          match: (cmd, args) => cmd === 'grep' && args.some((a) => a.includes('def|class')),
          stdout: './src/foo.py:1:def lonely_function():',
        },
        {
          // Usage grep — only references its own file
          match: (cmd, args) => cmd === 'grep' && args.some((a) => a.includes('lonely_function')),
          stdout: './src/foo.py',
        },
      ]);
      const tasks = await scanDeadCode(
        '/repo',
        { runner, fs: mockFileReader() },
        pythonProfile,
      );
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.description).toContain('lonely_function');
    });
  });
});
