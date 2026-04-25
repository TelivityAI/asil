import { randomUUID } from 'node:crypto';
import type { ImprovementTask, TaskCategory, Severity } from './types.js';

/** Directories that every recursive grep in the scanner must skip.
 *  Without these, grep crawls node_modules (thousands of .ts files)
 *  and dist (compiled duplicates), making scans take 10+ minutes. */
const GREP_EXCLUDE_DIRS = [
  '--exclude-dir=node_modules',
  '--exclude-dir=dist',
  '--exclude-dir=.git',
  '--exclude-dir=.next',
  '--exclude-dir=coverage',
  '--exclude-dir=design',
];

/** Runs a shell command and returns stdout+stderr plus the exit code. */
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    opts: { cwd: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Reads a text file or returns null if missing. */
export interface FileReader {
  read(path: string): Promise<string | null>;
  /** List files matching a glob, rooted at cwd. */
  glob(pattern: string, opts: { cwd: string }): Promise<string[]>;
}

export interface ScanResult {
  tasks: ImprovementTask[];
  scannedAt: Date;
  scanDurationMs: number;
}

export interface ScannerDeps {
  runner: CommandRunner;
  fs: FileReader;
}

export async function scanCodebase(
  repoRoot: string,
  deps: ScannerDeps,
): Promise<ScanResult> {
  const start = Date.now();
  const results = await Promise.all([
    scanTestFailures(repoRoot, deps),
    scanTypeErrors(repoRoot, deps),
    scanTodos(repoRoot, deps),
    scanCoverageGaps(repoRoot, deps),
    scanDeadCode(repoRoot, deps),
  ]);
  return {
    tasks: results.flat(),
    scannedAt: new Date(),
    scanDurationMs: Date.now() - start,
  };
}

export async function scanTestFailures(
  repoRoot: string,
  deps: ScannerDeps,
): Promise<ImprovementTask[]> {
  const { stdout, exitCode } = await deps.runner.run(
    'pnpm',
    ['test', '--reporter=json'],
    { cwd: repoRoot },
  );
  if (exitCode === 0) return [];

  const tasks: ImprovementTask[] = [];
  const parsed = tryParseVitestJson(stdout);
  if (!parsed) return tasks;

  const files = Array.isArray(parsed.testResults) ? parsed.testResults : [];
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const f = file as Record<string, unknown>;
    const failures = Array.isArray(f.assertionResults)
      ? (f.assertionResults as Array<Record<string, unknown>>).filter(
          (a) => a.status === 'failed',
        )
      : [];
    if (failures.length === 0) continue;

    const filePath = normalizePath(
      typeof f.name === 'string' ? f.name : 'unknown',
    );
    tasks.push(
      makeTask({
        category: 'test-failure',
        severity: 'critical',
        title: `Fix ${failures.length} failing test(s) in ${shortPath(filePath)}`,
        description: failures
          .map((a) => String(a.fullName ?? a.title ?? 'unnamed'))
          .join('\n'),
        filePaths: [filePath],
        estimatedTokens: 50_000,
      }),
    );
  }
  return tasks;
}

export async function scanTypeErrors(
  repoRoot: string,
  deps: ScannerDeps,
): Promise<ImprovementTask[]> {
  const { stdout, stderr, exitCode } = await deps.runner.run(
    'pnpm',
    ['typecheck'],
    { cwd: repoRoot },
  );
  if (exitCode === 0) return [];

  const output = `${stdout}\n${stderr}`;
  // tsc line format: path/to/file.ts(12,3): error TS2322: ...
  const errorRegex = /^(.+?\.tsx?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  const byFile = new Map<string, string[]>();

  let match: RegExpExecArray | null;
  while ((match = errorRegex.exec(output)) !== null) {
    const [, file, line, , code, message] = match;
    if (!file) continue;
    const key = normalizePath(file);
    const arr = byFile.get(key) ?? [];
    arr.push(`${code} at :${line} — ${message}`);
    byFile.set(key, arr);
  }

  const tasks: ImprovementTask[] = [];
  for (const [file, msgs] of byFile) {
    tasks.push(
      makeTask({
        category: 'type-error',
        severity: 'high',
        title: `Fix ${msgs.length} TS error(s) in ${shortPath(file)}`,
        description: msgs.join('\n'),
        filePaths: [file],
        estimatedTokens: 40_000,
      }),
    );
  }
  return tasks;
}

export async function scanTodos(
  repoRoot: string,
  deps: ScannerDeps,
): Promise<ImprovementTask[]> {
  // Use grep through the runner so it's mockable in tests.
  const { stdout } = await deps.runner.run(
    'grep',
    [
      '-rn',
      ...GREP_EXCLUDE_DIRS,
      '--include=*.ts',
      '--include=*.tsx',
      '-E',
      '(TODO|FIXME|HACK|DOMAIN_QUESTION)[: ]',
      '.',
    ],
    { cwd: repoRoot },
  );
  if (!stdout.trim()) return [];

  const byFile = new Map<string, string[]>();
  // grep line: ./path/file.ts:42:    // TODO: fix me
  const lineRe = /^(.+?):(\d+):(.*)$/;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    const [, file, ln, txt] = m;
    if (!file) continue;
    const key = normalizePath(file);
    const arr = byFile.get(key) ?? [];
    arr.push(`:${ln} — ${txt?.trim() ?? ''}`);
    byFile.set(key, arr);
  }

  const tasks: ImprovementTask[] = [];
  for (const [file, markers] of byFile) {
    tasks.push(
      makeTask({
        category: 'todo-resolution',
        severity: markers.some((m) => /DOMAIN_QUESTION/.test(m))
          ? 'high'
          : 'medium',
        title: `Resolve ${markers.length} TODO/FIXME in ${shortPath(file)}`,
        description: markers.join('\n'),
        filePaths: [file],
        estimatedTokens: 40_000,
      }),
    );
  }
  return tasks;
}

export async function scanCoverageGaps(
  repoRoot: string,
  deps: ScannerDeps,
): Promise<ImprovementTask[]> {
  // Look for an existing coverage-summary.json instead of running the full
  // test+coverage pipeline inside a scan (that would recurse into our own
  // changes). If there's no coverage report yet, return nothing — the first
  // run emits no coverage tasks.
  const raw = await deps.fs.read(`${repoRoot}/coverage/coverage-summary.json`);
  if (!raw) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }

  const tasks: ImprovementTask[] = [];
  for (const [rawKey, metrics] of Object.entries(parsed)) {
    if (rawKey === 'total' || !metrics || typeof metrics !== 'object') continue;
    const m = metrics as Record<string, unknown>;
    const branches = (m.branches as Record<string, unknown> | undefined) ?? {};
    const pct = typeof branches.pct === 'number' ? branches.pct : 100;
    if (pct >= 80) continue;

    const file = normalizePath(rawKey);
    tasks.push(
      makeTask({
        category: 'coverage-gap',
        severity: pct < 50 ? 'high' : 'medium',
        title: `Raise branch coverage in ${shortPath(file)} (${pct}%)`,
        description: `Branch coverage is ${pct}% — add tests until >=80%.`,
        filePaths: [file],
        estimatedTokens: 50_000,
      }),
    );
  }
  return tasks;
}

export async function scanDeadCode(
  repoRoot: string,
  deps: ScannerDeps,
): Promise<ImprovementTask[]> {
  // Heuristic: grep all exported symbols, then check if any other file
  // imports that symbol. Anything with zero inbound imports is a candidate.
  // We stay keyword-driven to avoid pulling in ts-morph.
  // Both the export-discovery grep AND the usage-search grep must
  // include `.tsx` — without it, React component files (which freely
  // import types from neighboring `actions.ts`/`types.ts` modules)
  // are invisible to the scanner. False-positive dead-code: the
  // scanner saw an `export interface InviteState` in actions.ts, found
  // no .ts file using it, and flagged it as unused — but invite-form.tsx
  // imports it for `useActionState<InviteState, FormData>`. Removing
  // the export broke the build.
  const TS_INCLUDES = ['--include=*.ts', '--include=*.tsx'];

  const { stdout: exportsOut } = await deps.runner.run(
    'grep',
    [
      '-rn',
      ...GREP_EXCLUDE_DIRS,
      ...TS_INCLUDES,
      '-E',
      '^export\\s+(const|function|class|interface|type)\\s+[A-Za-z_][A-Za-z0-9_]*',
      '.',
    ],
    { cwd: repoRoot },
  );
  if (!exportsOut.trim()) return [];

  const symbolByFile = new Map<string, Set<string>>();
  for (const line of exportsOut.split(/\r?\n/)) {
    const m = line.match(/^(.+?):\d+:export\s+\w+\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!m) continue;
    const [, rawFile, sym] = m;
    if (!rawFile || !sym) continue;
    const file = normalizePath(rawFile);
    const set = symbolByFile.get(file) ?? new Set<string>();
    set.add(sym);
    symbolByFile.set(file, set);
  }

  const tasks: ImprovementTask[] = [];
  for (const [file, symbols] of symbolByFile) {
    const unused: string[] = [];
    for (const sym of symbols) {
      const { stdout: usages } = await deps.runner.run(
        'grep',
        ['-rln', ...GREP_EXCLUDE_DIRS, ...TS_INCLUDES, '-E', `\\b${sym}\\b`, '.'],
        { cwd: repoRoot },
      );
      const files = usages.split(/\r?\n/).filter(Boolean);
      // `file` is always a match (self-reference). Needs at least one other.
      // Both sides must be normalized — grep prefixes `./`, but `file`
      // in our map has already been normalized above.
      const externalUses = files.filter((f) => normalizePath(f) !== file);
      if (externalUses.length === 0) unused.push(sym);
    }
    if (unused.length === 0) continue;
    tasks.push(
      makeTask({
        category: 'dead-code',
        severity: 'low',
        title: `Remove ${unused.length} unused export(s) in ${shortPath(file)}`,
        description: `Unused: ${unused.join(', ')}`,
        filePaths: [file],
        estimatedTokens: 30_000,
      }),
    );
  }
  return tasks;
}

function makeTask(partial: {
  category: TaskCategory;
  severity: Severity;
  title: string;
  description: string;
  filePaths: string[];
  estimatedTokens: number;
}): ImprovementTask {
  return {
    id: `${partial.category}-${randomUUID()}`,
    discoveredAt: new Date(),
    ...partial,
  };
}

function tryParseVitestJson(raw: string): Record<string, unknown> | null {
  // vitest prints a JSON block sometimes wrapped in other output.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function shortPath(p: string): string {
  return p.replace(/^.*\//, '');
}

/**
 * Strip the leading `./` that `grep -rn .` and some tsc/vitest outputs
 * produce. Scanners must return repo-root-relative paths (e.g.
 * `packages/foo/src/bar.ts`) — the `./` prefix confuses the LLM, which
 * then hallucinates shortened or restructured paths in its <<<FILE:>>>
 * sentinels. Keep the function intentionally simple: just peel `./`.
 * Absolute paths and `../` are left alone and caught downstream by the
 * buildPatchFromFiles path-safety guard.
 */
export function normalizePath(p: string): string {
  return p.startsWith('./') ? p.slice(2) : p;
}
