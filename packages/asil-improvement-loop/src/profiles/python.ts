/**
 * Python LanguageProfile.
 *
 * Commands assume the host repo has `pytest`, `mypy`, and (if coverage
 * is wanted) `coverage` on PATH. The scanner does NOT auto-detect
 * poetry/pdm/conda environments — that's a rabbit hole. Users invoking
 * Python tasks from inside a Poetry shell get poetry's environment
 * implicitly; users on bare-metal venvs activate before running.
 *
 * pytest JSON output requires the `pytest-json-report` plugin
 * (https://github.com/numirias/pytest-json-report). Document this as a
 * prerequisite of the Python profile.
 */
import type {
  CoverageEntry,
  LanguageProfile,
  TestFailure,
  TypeError,
} from '../language-profile.js';

/** mypy error line format: `path/to/file.py:LINE: error: MESSAGE  [code]`
 *  (with optional `:COL` between LINE and the colon — `--show-column-numbers`). */
const MYPY_ERROR_RE =
  /^(.+?\.pyi?):(\d+)(?::\d+)?:\s+error:\s+(.+?)(?:\s+\[([a-z][\w-]*)\])?\s*$/gm;

function normalizePath(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

export const pythonProfile: LanguageProfile = {
  name: 'python',

  // pytest-json-report writes the report to a file (default: .report.json).
  // Setting --json-report-file=- streams the report to stdout so we can
  // parse it in-process without touching disk.
  testCommand: {
    cmd: 'pytest',
    args: ['--json-report', '--json-report-file=-', '-q'],
  },

  parseTestFailures(stdout: string): TestFailure[] {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return [];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return [];
    }
    const tests = Array.isArray(parsed.tests) ? parsed.tests : [];
    const byFile = new Map<string, string[]>();
    for (const t of tests) {
      if (!t || typeof t !== 'object') continue;
      const test = t as Record<string, unknown>;
      const outcome = test.outcome;
      if (outcome !== 'failed' && outcome !== 'error') continue;
      // nodeid looks like `tests/test_foo.py::test_bar` or
      // `tests/test_foo.py::TestClass::test_bar`.
      const nodeid = typeof test.nodeid === 'string' ? test.nodeid : '';
      const sepIdx = nodeid.indexOf('::');
      if (sepIdx === -1) continue;
      const filePath = normalizePath(nodeid.slice(0, sepIdx));
      const failureName = nodeid.slice(sepIdx + 2);
      const arr = byFile.get(filePath) ?? [];
      arr.push(failureName);
      byFile.set(filePath, arr);
    }
    return Array.from(byFile.entries()).map(([filePath, failureNames]) => ({
      filePath,
      failureNames,
    }));
  },

  typecheckCommand: {
    cmd: 'mypy',
    args: ['--show-error-codes', '--no-pretty', '.'],
  },

  parseTypeErrors(output: string): TypeError[] {
    MYPY_ERROR_RE.lastIndex = 0;
    const out: TypeError[] = [];
    let match: RegExpExecArray | null;
    while ((match = MYPY_ERROR_RE.exec(output)) !== null) {
      const [, file, line, message, code] = match;
      if (!file || !message) continue;
      out.push({
        filePath: normalizePath(file),
        line: Number.parseInt(line ?? '0', 10),
        // mypy emits the bracketed code only when --show-error-codes is set.
        // When missing, default to `error` so the task description still
        // carries the message.
        code: code ?? 'error',
        message: message.trim(),
      });
    }
    return out;
  },

  todoFileExtensions: ['py', 'pyi'],

  coverage: {
    // coverage.py emits this when invoked as `coverage json -o coverage.json`.
    reportPath: 'coverage.json',
    extract(json: unknown): CoverageEntry[] {
      if (!json || typeof json !== 'object') return [];
      const root = json as Record<string, unknown>;
      const files = (root.files as Record<string, unknown> | undefined) ?? {};
      const out: CoverageEntry[] = [];
      for (const [rawKey, metrics] of Object.entries(files)) {
        if (!metrics || typeof metrics !== 'object') continue;
        const m = metrics as Record<string, unknown>;
        const summary = (m.summary as Record<string, unknown> | undefined) ?? {};
        // coverage.py's branch-coverage % field. Falls back to 100 when
        // the report doesn't include branch metrics (i.e. user ran
        // `coverage` without `--branch`).
        const pct =
          typeof summary.percent_covered_branch === 'number'
            ? summary.percent_covered_branch
            : typeof summary.percent_covered === 'number'
              ? summary.percent_covered
              : 100;
        out.push({ filePath: normalizePath(rawKey), branchPct: pct });
      }
      return out;
    },
  },

  deadCode: {
    // Match top-level `def` and `class` definitions. Skips methods
    // (indented `def`) which are typically protected by their owning
    // class even if not externally referenced.
    exportRegex: /^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    fileExtensions: ['py', 'pyi'],
    usageGrep(symbol: string, excludeDirArgs: string[]) {
      return {
        cmd: 'grep',
        args: [
          '-rln',
          ...excludeDirArgs,
          '--include=*.py',
          '--include=*.pyi',
          '-E',
          `\\b${symbol}\\b`,
          '.',
        ],
      };
    },
  },
};
