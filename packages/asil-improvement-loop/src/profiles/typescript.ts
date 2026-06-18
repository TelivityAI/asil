/**
 * TypeScript LanguageProfile — extracted verbatim from scanner.ts's
 * pre-PR-#6 hardcoded behaviour. This is the reference implementation;
 * the regexes and parsers below are the ones that ship in production
 * and have been hardened by Issue #1 (pnpm-prefix stripping) +
 * Issue #2 (executor guards).
 */
import type {
  CoverageEntry,
  LanguageProfile,
  TestFailure,
  TypeError,
} from '../language-profile.js';

/** tsc-shape detector used by the pnpm-prefix strip. */
const TSC_SHAPE = /^.+?\.tsx?\(\d+,\d+\):\s+error\s+TS\d+:/;

/** tsc error line format: `path/to/file.ts(12,3): error TS2322: …`. */
const TSC_ERROR_RE =
  /^(.+?\.tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;

function normalizePath(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}

export const typescriptProfile: LanguageProfile = {
  name: 'ts',

  testCommand: { cmd: 'pnpm', args: ['test', '--reporter=json'] },

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
    const files = Array.isArray(parsed.testResults) ? parsed.testResults : [];
    const out: TestFailure[] = [];
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const f = file as Record<string, unknown>;
      const failures = Array.isArray(f.assertionResults)
        ? (f.assertionResults as Array<Record<string, unknown>>).filter(
            (a) => a.status === 'failed',
          )
        : [];
      if (failures.length === 0) continue;
      out.push({
        filePath: normalizePath(typeof f.name === 'string' ? f.name : 'unknown'),
        failureNames: failures.map(
          (a) => String(a.fullName ?? a.title ?? 'unnamed'),
        ),
      });
    }
    return out;
  },

  typecheckCommand: { cmd: 'pnpm', args: ['typecheck'] },

  parseTypeErrors(output: string): TypeError[] {
    TSC_ERROR_RE.lastIndex = 0;
    const out: TypeError[] = [];
    let match: RegExpExecArray | null;
    while ((match = TSC_ERROR_RE.exec(output)) !== null) {
      const [, file, line, , code, message] = match;
      if (!file || !code || !message) continue;
      out.push({
        filePath: normalizePath(file),
        line: Number.parseInt(line ?? '0', 10),
        code,
        message,
      });
    }
    return out;
  },

  /**
   * Strip pnpm-recursive's `<pkg-path-or-name> <script-name>: ` prefix
   * when the rest of the line is a tsc error. See Issue #1 history for
   * why this exists. Conservative — only strips lines that ALREADY look
   * like tsc errors, so non-error pnpm output passes through unchanged.
   */
  stripOutputPrefix(line: string): string | null {
    const m = line.match(/^([^\s:][^\s]*)\s+([A-Za-z][\w:-]*):\s+(.+)$/);
    if (!m) return null;
    const tail = m[3];
    return tail && TSC_SHAPE.test(tail) ? tail : null;
  },

  todoFileExtensions: ['ts', 'tsx'],

  coverage: {
    reportPath: 'coverage/coverage-summary.json',
    extract(json: unknown): CoverageEntry[] {
      if (!json || typeof json !== 'object') return [];
      const parsed = json as Record<string, unknown>;
      const out: CoverageEntry[] = [];
      for (const [rawKey, metrics] of Object.entries(parsed)) {
        if (rawKey === 'total' || !metrics || typeof metrics !== 'object') continue;
        const m = metrics as Record<string, unknown>;
        const branches = (m.branches as Record<string, unknown> | undefined) ?? {};
        const pct = typeof branches.pct === 'number' ? branches.pct : 100;
        out.push({ filePath: normalizePath(rawKey), branchPct: pct });
      }
      return out;
    },
  },

  deadCode: {
    exportRegex:
      /^export\s+(?:abstract\s+)?(?:async\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    fileExtensions: ['ts', 'tsx'],
    usageGrep(symbol: string, excludeDirArgs: string[]) {
      return {
        cmd: 'grep',
        args: [
          '-rln',
          ...excludeDirArgs,
          '--include=*.ts',
          '--include=*.tsx',
          '-E',
          `\\b${symbol}\\b`,
          '.',
        ],
      };
    },
  },
};
