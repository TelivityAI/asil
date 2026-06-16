/**
 * LanguageProfile — pluggable shape for the scanner's per-language
 * commands, parsers, and conventions.
 *
 * The scanner sub-functions (test failures, type errors, todos,
 * coverage gaps, dead code) are language-agnostic in their structure
 * but language-specific in the commands they run and the output they
 * parse. A LanguageProfile carries those specifics so adding a new
 * language is "write a profile" rather than "fork the scanner."
 */

export interface CommandSpec {
  cmd: string;
  args: string[];
}

export interface TestFailure {
  /** Repo-relative file path. */
  filePath: string;
  /** Human-readable failure names — joined into the task description. */
  failureNames: string[];
}

export interface TypeError {
  /** Repo-relative file path. */
  filePath: string;
  /** Error code (e.g. `TS2322`, `arg-type` for mypy). */
  code: string;
  /** 1-based line number, or 0 if unknown. */
  line: number;
  message: string;
}

export interface CoverageEntry {
  /** Repo-relative file path. */
  filePath: string;
  /** Branch coverage percentage, 0–100. */
  branchPct: number;
}

/**
 * Profile authors return the on-disk path the scanner should read for
 * coverage data, plus a function that parses the file's parsed JSON
 * into per-file branch percentages.
 */
export interface CoverageProfile {
  /** Path to the coverage report, relative to the repo root. */
  reportPath: string;
  /** Parse the (already-JSON.parsed) report into per-file entries. */
  extract(json: unknown): CoverageEntry[];
}

export interface DeadCodeProfile {
  /** Regex matched at line-start; must capture the exported symbol's
   *  name as the FIRST capture group. */
  exportRegex: RegExp;
  /** Build the symbol-usage grep command for a given symbol. */
  usageGrep(symbol: string, excludeDirArgs: string[]): CommandSpec;
  /** File extensions to scan (e.g. ['ts', 'tsx'] or ['py', 'pyi']).
   *  Excludes the leading dot. */
  fileExtensions: string[];
}

export interface LanguageProfile {
  /** Display name; used in task IDs and CLI output (e.g. "ts", "python"). */
  readonly name: string;

  /** Command to run the test suite. The scanner calls this; a non-zero
   *  exit indicates failures to parse. */
  testCommand: CommandSpec;
  /** Parse the test command's stdout into per-file failures. */
  parseTestFailures(stdout: string, stderr: string): TestFailure[];

  /** Command to run the type checker. Non-zero exit = errors. */
  typecheckCommand: CommandSpec;
  /** Parse type-check output (stdout ++ stderr) into per-file errors. */
  parseTypeErrors(output: string): TypeError[];

  /** Optional: strip a tool-runner prefix from a single output line
   *  (e.g. pnpm-recursive's `<pkg> <script>: `). Return null to leave
   *  the line unchanged, or the cleaned line. */
  stripOutputPrefix?(line: string): string | null;

  /** File extensions for TODO/FIXME grep (no leading dot). */
  todoFileExtensions: string[];

  /** Coverage report config. */
  coverage: CoverageProfile;

  /** Dead-code detection config. Set to `null` to disable. */
  deadCode: DeadCodeProfile | null;
}
