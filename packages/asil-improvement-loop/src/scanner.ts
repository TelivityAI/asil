import { createHash } from 'node:crypto';
import type { LanguageProfile } from './language-profile.js';
import { typescriptProfile } from './profiles/typescript.js';
import type { ImprovementTask, Severity, TaskCategory } from './types.js';

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
  '--exclude-dir=__pycache__',
  '--exclude-dir=.venv',
  '--exclude-dir=venv',
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

/**
 * Run every sub-scanner under the given language profile. The profile
 * defines the commands and parsers; this function provides the
 * orchestration (parallel fan-out, task assembly).
 *
 * `profile` defaults to TypeScript for backwards compatibility with
 * callers built before the multi-language refactor.
 */
export async function scanCodebase(
  repoRoot: string,
  deps: ScannerDeps,
  profile: LanguageProfile = typescriptProfile,
): Promise<ScanResult> {
  const start = Date.now();
  const results = await Promise.all([
    scanTestFailures(repoRoot, deps, profile),
    scanTypeErrors(repoRoot, deps, profile),
    scanTodos(repoRoot, deps, profile),
    scanCoverageGaps(repoRoot, deps, profile),
    scanDeadCode(repoRoot, deps, profile),
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
  profile: LanguageProfile = typescriptProfile,
): Promise<ImprovementTask[]> {
  const { stdout, stderr, exitCode } = await deps.runner.run(
    profile.testCommand.cmd,
    profile.testCommand.args,
    { cwd: repoRoot },
  );
  if (exitCode === 0) return [];

  const failures = profile.parseTestFailures(stdout, stderr);
  return failures.map((f) =>
    makeTask({
      category: 'test-failure',
      severity: 'critical',
      title: `Fix ${f.failureNames.length} failing test(s) in ${shortPath(f.filePath)}`,
      description: f.failureNames.join('\n'),
      filePaths: [f.filePath],
      estimatedTokens: 50_000,
    }),
  );
}

export async function scanTypeErrors(
  repoRoot: string,
  deps: ScannerDeps,
  profile: LanguageProfile = typescriptProfile,
): Promise<ImprovementTask[]> {
  const { stdout, stderr, exitCode } = await deps.runner.run(
    profile.typecheckCommand.cmd,
    profile.typecheckCommand.args,
    { cwd: repoRoot },
  );
  if (exitCode === 0) return [];

  let output = `${stdout}\n${stderr}`;
  // Apply per-line tool-runner-prefix stripping if the profile defines
  // one (e.g. pnpm-recursive's `<pkg> <script>: ` prefix). Lines the
  // profile doesn't recognize as a tool-prefixed error pass through
  // unchanged.
  if (profile.stripOutputPrefix) {
    output = output
      .split('\n')
      .map((line) => profile.stripOutputPrefix!(line) ?? line)
      .join('\n');
  }

  const errors = profile.parseTypeErrors(output);
  const byFile = new Map<string, string[]>();
  for (const e of errors) {
    const arr = byFile.get(e.filePath) ?? [];
    arr.push(`${e.code} at :${e.line} — ${e.message}`);
    byFile.set(e.filePath, arr);
  }

  return Array.from(byFile.entries()).map(([file, msgs]) =>
    makeTask({
      category: 'type-error',
      severity: 'high',
      title: `Fix ${msgs.length} type error(s) in ${shortPath(file)}`,
      description: msgs.join('\n'),
      filePaths: [file],
      estimatedTokens: 40_000,
    }),
  );
}

export async function scanTodos(
  repoRoot: string,
  deps: ScannerDeps,
  profile: LanguageProfile = typescriptProfile,
): Promise<ImprovementTask[]> {
  const includes = profile.todoFileExtensions.flatMap((ext) => [
    '--include=*.' + ext,
  ]);
  const { stdout } = await deps.runner.run(
    'grep',
    [
      '-rn',
      ...GREP_EXCLUDE_DIRS,
      ...includes,
      '-E',
      // Require the marker to be the FIRST token of a line-start comment
      // (`//`, `#`, or jsdoc `*`). This is ASIL's own DOMAIN_QUESTION
      // convention and it eliminates the false positives a live grind
      // surfaced: marker strings inside string literals / regexes
      // (e.g. `'DOMAIN_QUESTION'`, `/DOMAIN_QUESTION:/`) and mid-comment
      // mentions are no longer matched — only genuine actionable markers.
      // Trade-off: trailing comments (`code; // TODO`) aren't matched,
      // consistent with how DOMAIN_QUESTION markers are already detected.
      '^[ \\t]*(//|\\*|#)[ \\t]*(TODO|FIXME|HACK|DOMAIN_QUESTION)[: ]',
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
    // Skip test files — a TODO/FIXME/DOMAIN_QUESTION marker in a test is
    // almost always test DATA (fixtures exercising the scanner itself),
    // not an actionable task. (Live-grind precision finding.)
    if (isTestFile(key)) continue;
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
  profile: LanguageProfile = typescriptProfile,
): Promise<ImprovementTask[]> {
  const raw = await deps.fs.read(`${repoRoot}/${profile.coverage.reportPath}`);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const entries = profile.coverage.extract(parsed);
  const tasks: ImprovementTask[] = [];
  for (const entry of entries) {
    if (entry.branchPct >= 80) continue;
    // Coverage reporters emit absolute file keys; normalize to
    // repo-relative so the executor doesn't reject the path. (#3)
    const filePath = toRepoRelative(repoRoot, entry.filePath);
    tasks.push(
      makeTask({
        category: 'coverage-gap',
        severity: entry.branchPct < 50 ? 'high' : 'medium',
        title: `Raise branch coverage in ${shortPath(filePath)} (${entry.branchPct}%)`,
        description: `Branch coverage is ${entry.branchPct}% — add tests until >=80%.`,
        filePaths: [filePath],
        estimatedTokens: 50_000,
      }),
    );
  }
  return tasks;
}

export async function scanDeadCode(
  repoRoot: string,
  deps: ScannerDeps,
  profile: LanguageProfile = typescriptProfile,
): Promise<ImprovementTask[]> {
  if (!profile.deadCode) return [];
  const dc = profile.deadCode;
  const includes = dc.fileExtensions.flatMap((ext) => ['--include=*.' + ext]);

  const { stdout: exportsOut } = await deps.runner.run(
    'grep',
    [
      '-rn',
      ...GREP_EXCLUDE_DIRS,
      ...includes,
      '-E',
      // Pass the export regex source as-is to grep -E. The `^` anchor
      // means "start of line" in grep too, which is what we want — a
      // bare `export const` should match only at column 0, not nested
      // inside another statement.
      dc.exportRegex.source,
      '.',
    ],
    { cwd: repoRoot },
  );
  if (!exportsOut.trim()) return [];

  const symbolByFile = new Map<string, Set<string>>();
  // grep -rn line: ./path/file.ts:42:export const Foo = …
  const grepLineRe = /^(.+?):\d+:(.*)$/;
  for (const line of exportsOut.split(/\r?\n/)) {
    const grepM = line.match(grepLineRe);
    if (!grepM) continue;
    const [, rawFile, body] = grepM;
    if (!rawFile || !body) continue;
    // Re-run the profile's export regex (anchored at line start) against
    // the body to extract the symbol name.
    const symMatch = body.match(dc.exportRegex);
    if (!symMatch || !symMatch[1]) continue;
    const file = normalizePath(rawFile);
    const set = symbolByFile.get(file) ?? new Set<string>();
    set.add(symMatch[1]);
    symbolByFile.set(file, set);
  }

  const isEntryPoint = dc.isEntryPoint ?? isEntryPointFile;

  const tasks: ImprovementTask[] = [];
  for (const [file, symbols] of symbolByFile) {
    // Entry-point / barrel files (index.*, __init__.py) are the package's
    // public API. Their consumers can live outside the repo, where the
    // usage grep is blind — so a missing in-repo reference does NOT mean
    // the symbol is dead. Skip them to avoid flagging the whole API surface.
    // (Codex review #10: dead-code analysis was too shallow to tell public
    // API from genuinely unreachable code.)
    if (isEntryPoint(file)) continue;
    const unused: string[] = [];
    for (const sym of symbols) {
      const grep = dc.usageGrep(sym, GREP_EXCLUDE_DIRS);
      const { stdout: usages } = await deps.runner.run(grep.cmd, grep.args, {
        cwd: repoRoot,
      });
      const files = usages.split(/\r?\n/).filter(Boolean);
      const externalUses = files.filter((f) => normalizePath(f) !== file);
      if (externalUses.length === 0) unused.push(sym);
    }
    if (unused.length === 0) continue;
    tasks.push(
      makeTask({
        category: 'dead-code',
        severity: 'low',
        title: `Remove ${unused.length} unused export(s) in ${shortPath(file)}`,
        description:
          `Unused: ${unused.join(', ')}\n\n` +
          'Heuristic: these exports have no in-repo references (grep-based ' +
          'reachability, not type-aware). Confirm they are not reflectively ' +
          'used or part of an external/public API before removing.',
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
    id: stableTaskId(partial.category, partial.filePaths),
    discoveredAt: new Date(),
    ...partial,
  };
}

/**
 * Deterministic task identity: `<category>-<hash(category + sorted file
 * paths)>`. Stable across rescans so the queue's id-dedupe (which only
 * compares `task.id`) actually suppresses re-enqueueing the same issue
 * on every run. Identity is intentionally coarse — "this category of
 * problem in these files" — so a fluctuating error count in the task
 * *description* doesn't mint a new id each scan. The cycle detector,
 * not the id, handles same-file churn. (Refs Codex review #4.)
 */
export function stableTaskId(
  category: TaskCategory,
  filePaths: readonly string[],
): string {
  const key = [category, ...[...filePaths].map(normalizePath).sort()].join(' ');
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 12);
  return `${category}-${hash}`;
}

function shortPath(p: string): string {
  return p.replace(/^.*\//, '');
}

/**
 * True for files that are tests: anything under a `__tests__/` directory
 * or named `*.test.*` / `*.spec.*`. Used to keep TODO/FIXME markers that
 * are test FIXTURES (data exercising the scanner) out of the task queue.
 */
export function isTestFile(p: string): boolean {
  return (
    p.includes('/__tests__/') ||
    p.startsWith('__tests__/') ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
  );
}

/**
 * Convention default for "is this file a public entry point?" — used by the
 * dead-code scanner when a language profile doesn't supply its own
 * `isEntryPoint`. Matches JS/TS barrels (`index.ts`, `index.tsx`,
 * `index.mjs`, …) and Python package roots (`__init__.py`). Symbols declared
 * in these files are treated as public API and never flagged as dead.
 */
export function isEntryPointFile(p: string): boolean {
  const base = shortPath(p);
  return /^index\.[cm]?[jt]sx?$/.test(base) || base === '__init__.py';
}

/**
 * Convert an absolute path under `repoRoot` to a repo-relative path.
 * Coverage tools (vitest's istanbul reporter, coverage.py) emit
 * absolute file keys; left as-is they reach the executor as absolute
 * `<<<FILE: …>>>` paths, which buildPatchFromFiles rejects as
 * suspicious. Paths already relative (or outside repoRoot) are returned
 * unchanged. (Refs Codex review #3.)
 */
export function toRepoRelative(repoRoot: string, p: string): string {
  const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  if (p.startsWith(root)) return p.slice(root.length);
  return normalizePath(p);
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
