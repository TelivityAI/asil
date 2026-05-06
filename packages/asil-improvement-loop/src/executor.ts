import { randomBytes } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  ExecutionResult,
  FailedStep,
  ImprovementTask,
  LLMCaller,
  LLMResponse,
} from './types.js';
import { CATEGORY_SKILL_MAP } from './types.js';
import type { CommandRunner } from './scanner.js';

/**
 * Structured logger contract. Defaults to stderr via `console.error`,
 * but tests (and the CLI) can inject a spy/mock to capture events.
 */
export interface ExecutorLogger {
  error(event: ExecutorFailureEvent): void;
}

export interface ExecutorFailureEvent {
  taskId: string;
  category: string;
  failedStep: FailedStep;
  /** Single-line human summary — what went wrong. */
  message: string;
  /** Absolute worktree (or repoRoot) path so operators can cd in and inspect. */
  workDir: string;
  /** The diff the LLM produced — empty string when failedStep === 'llm-no-diff'. */
  diff: string;
  /** Captured output from the failing shell invocation, if any. */
  stdout?: string;
  stderr?: string;
  /** Raw LLM text — retained only for llm-no-diff so the operator can
   *  see what the model said instead of a valid diff. */
  llmResponse?: string;
}

export interface DiffApplier {
  /** Applies a unified diff in the repo. Returns true on success. */
  apply(diff: string, repoRoot: string): Promise<{ applied: boolean; error?: string }>;
  /** Reverts a previously applied diff so a failed task doesn't dirty the tree. */
  revert(diff: string, repoRoot: string): Promise<void>;
}

export interface FileFetcher {
  read(filePath: string, repoRoot: string): Promise<string>;
}

export interface ExecutorDeps {
  llm: LLMCaller;
  diff: DiffApplier;
  runner: CommandRunner;
  files: FileFetcher;
  /** Optional override for reading the Markdown skill content. */
  loadSkill?: (skillsPath: string, skillName: string) => Promise<string>;
  /** Optional logger for failure diagnostics. Defaults to stderr. */
  logger?: ExecutorLogger;
  /**
   * Optional reader used by `buildPatchFromFiles` to fetch the CURRENT
   * content of each file-block target (for diffing against the LLM's
   * proposed new content). Defaults to readFileSync on disk. Tests
   * inject a fake-filesystem reader so workDir can be a stub path.
   */
  readCurrent?: (absPath: string) => string | null;
  /**
   * Optional pre-built "Domain context from Dušan" block that gets
   * injected into the user prompt. Built by the loop from stored
   * domain-question answers — keeps the LLM consistent with prior
   * domain decisions in files it touches.
   */
  domainContext?: string;
}

const DEFAULT_LOGGER: ExecutorLogger = {
  error(event) {
    // One human-readable block per failure — easy to grep, easy to
    // follow. Written to stderr so it does not mix with the runner's
    // stdout summary.
    const lines: string[] = [];
    lines.push(
      `\n[executor] ✖ ${event.failedStep} failed — task ${event.taskId} (${event.category})`,
    );
    lines.push(`  message:  ${event.message}`);
    lines.push(`  workDir:  ${event.workDir}`);
    if (event.stdout && event.stdout.trim()) {
      lines.push('  stdout:');
      lines.push(indent(event.stdout.trimEnd(), '    '));
    }
    if (event.stderr && event.stderr.trim()) {
      lines.push('  stderr:');
      lines.push(indent(event.stderr.trimEnd(), '    '));
    }
    if (event.llmResponse) {
      lines.push('  llm response:');
      lines.push(indent(event.llmResponse.trimEnd(), '    '));
    }
    if (event.diff) {
      lines.push('  diff:');
      lines.push(indent(event.diff.trimEnd(), '    '));
    }
    // eslint-disable-next-line no-console
    console.error(lines.join('\n'));
  },
};

function indent(text: string, prefix: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export interface ExecuteOptions {
  repoRoot: string;
  markdownSkillsPath: string;
  model: string;
  /**
   * Isolated working directory for diff apply + checks. When provided
   * (the autonomous loop hands in a `git worktree`-backed path), all
   * filesystem mutations and `pnpm typecheck|test` runs happen here
   * instead of in `repoRoot`. Omitted in tests / one-off invocations
   * that can safely operate directly on repoRoot.
   */
  workDir?: string;
}

export async function executeTask(
  task: ImprovementTask,
  deps: ExecutorDeps,
  opts: ExecuteOptions,
): Promise<ExecutionResult> {
  const skillName = CATEGORY_SKILL_MAP[task.category];
  const skill = await (deps.loadSkill ?? defaultSkillLoader)(
    opts.markdownSkillsPath,
    skillName,
  );
  const antiRationalization = extractAntiRationalization(skill);

  const fileContents: Record<string, string> = {};
  for (const path of task.filePaths) {
    try {
      fileContents[path] = await deps.files.read(path, opts.repoRoot);
    } catch {
      fileContents[path] = '';
    }
  }

  // Guard A — pre-flight (Issue #2): if the prompt-side cache is empty
  // for any file path whose on-disk version is non-empty, the LLM would
  // be asked to "fix" a file it cannot see. Best case it refuses; worst
  // case (observed 6/10 in the 2026-05-05 sandbox run on HAIP) it
  // produces a destructive minimal-replacement diff. Refuse before the
  // LLM call so the path that produces the bad diff never opens.
  const guardWorkDir = opts.workDir ?? opts.repoRoot;
  for (const path of task.filePaths) {
    const cached = fileContents[path] ?? '';
    if (cached.trim().length > 0) continue;
    let onDiskBytes = -1;
    try {
      onDiskBytes = statSync(resolve(guardWorkDir, path)).size;
    } catch {
      // Path may not resolve on disk (e.g. malformed by Issue #1, or a
      // brand-new file the executor doesn't support). Fall through —
      // downstream patch builder produces a clearer error in those cases.
      continue;
    }
    if (onDiskBytes > 0) {
      const message = `executor refused: scanner provided empty content for "${path}" but on-disk file has ${onDiskBytes} bytes — the LLM would be inventing replacement content (Issue #2 guard A)`;
      const failedStep: FailedStep = 'safety-guard';
      const logger = deps.logger ?? DEFAULT_LOGGER;
      logger.error({
        taskId: task.id,
        category: task.category,
        failedStep,
        message,
        workDir: guardWorkDir,
        diff: '',
      });
      return {
        taskId: task.id,
        success: false,
        diff: '',
        filesChanged: task.filePaths,
        testsRun: false,
        testsPassed: false,
        typeCheckPassed: false,
        executionLog: '',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        applyError: message,
        failedStep,
      };
    }
  }

  const systemPrompt = buildExecutionPrompt(skill, antiRationalization);
  const baseUserPrompt = buildTaskPrompt(task, fileContents);
  // Splice in any Dušan-supplied domain context for the files this
  // task touches. Goes BEFORE the file listing so the LLM reads the
  // human-anchored facts before it considers the code.
  const userPrompt = deps.domainContext
    ? `${deps.domainContext}\n\n${baseUserPrompt}`
    : baseUserPrompt;

  // Where mutations + checks run. The loop passes a git-worktree path so
  // the user's main checkout is never touched. Tests fall back to repoRoot.
  const workDir = opts.workDir ?? opts.repoRoot;
  // When running inside an isolated worktree the caller cleans up the
  // whole directory on exit, so manual revert on failure is redundant.
  const isIsolated = Boolean(opts.workDir);
  const logger = deps.logger ?? DEFAULT_LOGGER;

  // Two-pass LLM loop: the model outputs COMPLETE FILE contents between
  // sentinel blocks, we compute the actual unified diff programmatically
  // with `diff -u` against the worktree's current state, then validate
  // with `git apply --check`. Asking LLMs to emit valid unified diffs
  // (correct @@ line counts, context matching) is historically
  // unreliable — this flow removes that burden entirely. On the rare
  // case the model still produces something unparseable or generates no
  // changes, we retry ONCE with the failure reason fed back.
  type Attempt = {
    response: LLMResponse;
    diff: string;
    applyResult: { applied: boolean; error?: string };
  };

  const runPass = async (retryError?: string): Promise<Attempt> => {
    const promptThisPass = retryError
      ? `${userPrompt}\n\n## Retry context\nYour previous attempt failed with:\n${retryError}\n\nTry again. Remember to output the COMPLETE modified file between <<<FILE: ...>>> and <<<END FILE>>> sentinels. Do not output a unified diff.`
      : userPrompt;

    const response = await deps.llm.call(
      systemPrompt,
      promptThisPass,
      opts.model,
    );

    const blocks = extractFileBlocks(response.content);
    if (blocks.length === 0) {
      return {
        response,
        diff: '',
        applyResult: {
          applied: false,
          error:
            'LLM response contained no <<<FILE: ...>>> ... <<<END FILE>>> blocks',
        },
      };
    }

    // Guard B — destructive-diff rejection (Issue #2). If the LLM's
    // proposed file content net-deletes more than 50% of the original
    // (chars or lines), refuse to even build the patch. Compares
    // against fileContents (populated above) — that's exactly what
    // the LLM was shown, and it avoids a re-read race window between
    // guard check and apply. dead-code tasks are exempt: net-deletion
    // is the whole point of that category.
    //
    // Size floor: the guard only applies when the original file has
    // BOTH ≥ MIN_GUARD_B_BYTES of content AND ≥ MIN_GUARD_B_LINES.
    // Tiny files (a 14-byte one-liner) can legitimately be rewritten
    // to a comparable size and a 50% threshold there fires on noise.
    // The destructive pattern observed in the sandbox run was a
    // ~10-byte `export {};` replacing 466 lines — comfortably above
    // both floors.
    const MIN_GUARD_B_BYTES = 200;
    const MIN_GUARD_B_LINES = 10;
    if (task.category !== 'dead-code') {
      for (const block of blocks) {
        const original = fileContents[block.path] ?? '';
        if (!original) continue;
        const oldChars = original.length;
        const oldLines = original.split('\n').length;
        if (oldChars < MIN_GUARD_B_BYTES && oldLines < MIN_GUARD_B_LINES) continue;
        const newChars = block.content.length;
        const newLines = block.content.split('\n').length;
        const charLoss = oldChars > 0 ? (oldChars - newChars) / oldChars : 0;
        const lineLoss = oldLines > 0 ? (oldLines - newLines) / oldLines : 0;
        if (charLoss > 0.5 || lineLoss > 0.5) {
          const pct = Math.round(Math.max(charLoss, lineLoss) * 100);
          return {
            response,
            diff: '',
            applyResult: {
              applied: false,
              error: `destructive diff rejected: proposed content for "${block.path}" net-deletes ${pct}% of an existing file (category=${task.category}, not dead-code) (Issue #2 guard B)`,
            },
          };
        }
      }
    }

    const { patch, error: patchError } = await buildPatchFromFiles(
      blocks,
      workDir,
      deps.runner,
      deps.readCurrent,
      task.filePaths,
    );
    if (patchError) {
      return {
        response,
        diff: patch,
        applyResult: { applied: false, error: patchError },
      };
    }
    if (!patch.trim()) {
      return {
        response,
        diff: '',
        applyResult: {
          applied: false,
          error: 'LLM output matched current files verbatim — no changes produced',
        },
      };
    }

    const applyResult = await deps.diff.apply(patch, workDir);
    return { response, diff: patch, applyResult };
  };

  let attempt = await runPass();
  let tokenUsage = {
    inputTokens: attempt.response.inputTokens,
    outputTokens: attempt.response.outputTokens,
  };

  if (!attempt.applyResult.applied) {
    // One retry. Feeds the previous failure reason back to the model so
    // it can correct course (most common cause: output drifted from the
    // sentinel format, or one of the file blocks had lossy whitespace).
    const retry = await runPass(attempt.applyResult.error);
    tokenUsage = {
      inputTokens: tokenUsage.inputTokens + retry.response.inputTokens,
      outputTokens: tokenUsage.outputTokens + retry.response.outputTokens,
    };
    attempt = retry;
  }

  if (!attempt.applyResult.applied) {
    // Terminal — both passes failed. Classify as safety-guard (a guard
    // B rejection from this file) vs llm-no-diff (model couldn't
    // produce usable output) vs diff-apply (patch generated but failed
    // validation), based on the error sentinel and whether we have a
    // diff at all.
    const message = attempt.applyResult.error ?? 'git apply failed';
    const failedStep: FailedStep = message.includes('Issue #2 guard')
      ? 'safety-guard'
      : attempt.diff
        ? 'diff-apply'
        : 'llm-no-diff';
    logger.error({
      taskId: task.id,
      category: task.category,
      failedStep,
      message,
      workDir,
      diff: attempt.diff,
      llmResponse: attempt.diff ? undefined : attempt.response.content,
    });
    return {
      taskId: task.id,
      success: false,
      diff: attempt.diff,
      filesChanged: task.filePaths,
      testsRun: false,
      testsPassed: false,
      typeCheckPassed: false,
      executionLog: attempt.response.content,
      tokenUsage,
      applyError: message,
      failedStep,
    };
  }

  const diff = attempt.diff;
  const response = attempt.response;

  const typeCheck = await runCheck(deps.runner, workDir, ['typecheck']);
  if (!typeCheck.passed) {
    logger.error({
      taskId: task.id,
      category: task.category,
      failedStep: 'typecheck',
      message: `pnpm typecheck exited with code ${typeCheck.exitCode}`,
      workDir,
      diff,
      stdout: typeCheck.stdout,
      stderr: typeCheck.stderr,
    });
    if (!isIsolated) await deps.diff.revert(diff, workDir);
    return {
      taskId: task.id,
      success: false,
      diff,
      filesChanged: task.filePaths,
      testsRun: false,
      testsPassed: false,
      typeCheckPassed: false,
      executionLog: response.content,
      tokenUsage,
      failedStep: 'typecheck',
      stepOutput: { stdout: typeCheck.stdout, stderr: typeCheck.stderr },
    };
  }

  const tests = await runCheck(deps.runner, workDir, ['test']);
  if (!tests.passed) {
    logger.error({
      taskId: task.id,
      category: task.category,
      failedStep: 'tests',
      message: `pnpm test exited with code ${tests.exitCode}`,
      workDir,
      diff,
      stdout: tests.stdout,
      stderr: tests.stderr,
    });
    if (!isIsolated) await deps.diff.revert(diff, workDir);
    return {
      taskId: task.id,
      success: false,
      diff,
      filesChanged: task.filePaths,
      testsRun: true,
      testsPassed: false,
      typeCheckPassed: true,
      executionLog: response.content,
      tokenUsage,
      failedStep: 'tests',
      stepOutput: { stdout: tests.stdout, stderr: tests.stderr },
    };
  }

  return {
    taskId: task.id,
    success: true,
    diff,
    filesChanged: task.filePaths,
    testsRun: true,
    testsPassed: true,
    typeCheckPassed: true,
    executionLog: response.content,
    tokenUsage,
  };
}

interface CheckResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCheck(
  runner: CommandRunner,
  cwd: string,
  args: string[],
): Promise<CheckResult> {
  const { exitCode, stdout, stderr } = await runner.run('pnpm', args, { cwd });
  return { passed: exitCode === 0, exitCode, stdout, stderr };
}

async function defaultSkillLoader(
  skillsPath: string,
  skillName: string,
): Promise<string> {
  try {
    return readFileSync(join(skillsPath, 'skills', `${skillName}.md`), 'utf8');
  } catch {
    return '';
  }
}

function defaultReadFile(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

/** Extracts the anti-rationalization table — a section commonly titled
 *  "Anti-Rationalization Table" in the configured skills. Returns the skill
 *  content unchanged if we can't locate it. */
export function extractAntiRationalization(skill: string): string {
  if (!skill) return '';
  const lines = skill.split(/\r?\n/);
  const startIdx = lines.findIndex((l) =>
    /^#{1,6}\s*anti[- ]?rationalization/i.test(l),
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

export function buildExecutionPrompt(
  skillContent: string,
  antiRationalization: string,
): string {
  return [
    '# Autonomous Improvement Task',
    '',
    '## Markdown Skill',
    skillContent || '(skill content not available — apply the request carefully)',
    '',
    '## Project Rules',
    '- TypeScript strict. No `any`. No undocumented `as` casts.',
    '- `decimal.js` for all money math. No `number` for currency.',
    '- Tests verify real behavior, not `toBeDefined()`.',
    '- No invented domain logic — if unsure, add a `// DOMAIN_QUESTION:` comment.',
    '',
    '## CRITICAL: Anti-Rationalization Enforcement',
    antiRationalization ||
      'Do not skip edge cases. Do not write shallow tests. Do not rationalize away security concerns. If the task cannot be completed properly, say so — do not produce half-measures.',
    '',
    '## Output Format',
    'Do NOT output a unified diff. Unified diffs require exact line numbers',
    'and context matching, which is unreliable.',
    '',
    'Instead, for EACH file you change, output a block in this exact form:',
    '',
    '    <<<FILE: relative/path/from/repo/root.ts>>>',
    '    <the COMPLETE contents of the file AFTER your changes>',
    '    <<<END FILE>>>',
    '',
    'Rules:',
    '- Output the full file contents, not just the changed parts.',
    '- Preserve existing indentation, trailing newline, and line endings.',
    '- One block per file. Multiple files are allowed — one block each.',
    '- Only include files you actually changed. Do not echo unchanged files.',
    '- No prose before, between, or after the blocks. Sentinels are the only framing.',
    '- File paths must EXACTLY match the paths shown in the "## Files" section below.',
    '  Copy the path character-for-character. Do not guess, shorten, or restructure paths.',
    '',
    'We will compute the actual diff programmatically via `diff -u` against the',
    'current working copy, then validate with `git apply --check` before applying.',
  ].join('\n');
}

export function buildTaskPrompt(
  task: ImprovementTask,
  fileContents: Record<string, string>,
): string {
  const paths = Object.keys(fileContents);
  const files = paths
    .map(
      (path) =>
        `### ${path}\n\`\`\`typescript\n${fileContents[path] ?? ''}\n\`\`\``,
    )
    .join('\n\n');

  // Explicit reminder of the exact sentinel paths — the LLM otherwise
  // has a tendency to drop a path segment (e.g. `autonomous/src/x` vs
  // `autonomous/runners/src/x`), which breaks buildPatchFromFiles when
  // it tries to read the current file content to diff against.
  const pathList =
    paths.length > 0
      ? `\n\nExact file paths to use in <<<FILE: path>>> sentinels:\n${paths
          .map((p) => `- \`${p}\``)
          .join('\n')}`
      : '';

  return [
    `## Task: ${task.title}`,
    '',
    `Category: ${task.category}  |  Severity: ${task.severity}`,
    '',
    task.description,
    '',
    '## Files',
    '',
    files || '(no file contents were supplied)',
    pathList,
  ].join('\n');
}

/**
 * Legacy: parse a unified diff out of an LLM response. Kept as a named
 * export for backwards compatibility with any external tooling — the
 * executor no longer uses it, having moved to file-block output +
 * programmatic patch generation.
 */
export function extractDiff(content: string): string {
  if (!content) return '';
  const fence = content.match(/```(?:diff|patch)\s*([\s\S]*?)```/);
  const candidate = fence?.[1]?.trim() ?? content.trim();
  // A unified diff starts with "diff --git", "--- ", or "@@".
  if (/^(diff --git |--- |\+\+\+ |@@ )/m.test(candidate)) return candidate;
  return '';
}

export interface FileBlock {
  path: string;
  content: string;
}

/**
 * Parse `<<<FILE: path>>> ... <<<END FILE>>>` blocks out of an LLM
 * response. Contents between the sentinels are treated as opaque — the
 * LLM doesn't have to escape anything, we just echo the bytes into the
 * new file. Returns [] when no blocks are found (caller decides whether
 * to retry or fail).
 *
 * Tolerates:
 *   - Optional prose before the first block (LLMs sometimes preamble).
 *   - Trailing whitespace around paths.
 *   - Windows-style line endings (normalised to \n in the captured content).
 */
export function extractFileBlocks(content: string): FileBlock[] {
  if (!content) return [];
  // Non-greedy match between the two sentinels. Use [\s\S] so newlines
  // inside the captured content don't break the match.
  const re = /<<<FILE:\s*(.+?)\s*>>>\s*\n([\s\S]*?)\n<<<END FILE>>>/g;
  const blocks: FileBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const path = match[1]?.trim() ?? '';
    const raw = match[2] ?? '';
    if (!path) continue;
    // Normalise CRLF → LF so the patch generator doesn't emit spurious
    // line-ending diffs when the source is LF. Strip ALL carriage
    // returns (not just CRLF pairs) because the regex may have
    // consumed the trailing `\n` before `<<<END FILE>>>`, leaving a
    // lone `\r` at the end of the captured content.
    let content = raw.replace(/\r/g, '');
    // Re-append the trailing newline that the regex's `\n<<<END FILE>>>`
    // consumed. POSIX convention is files end in `\n`, and the
    // pre-existing version of every file we touch follows that. Without
    // this, every produced diff carries a `\ No newline at end of file`
    // tail — `git apply` accepts it but the resulting file loses its
    // trailing newline, which is wrong and ugly.
    if (!content.endsWith('\n')) content += '\n';
    blocks.push({ path, content });
  }
  return blocks;
}

/**
 * Generate a unified diff by comparing each file block's NEW content
 * against its CURRENT content in `workDir`, using the system `diff -u`
 * tool. Concatenates the per-file patches into one `git apply`-able
 * blob. On any internal failure (missing file, bad path) returns an
 * `error` describing it so the executor can surface the reason.
 *
 * New-file creation is intentionally rejected for now — the current
 * task categories (dead-code, test-coverage, todo-resolution, etc.)
 * all edit existing files. An LLM producing a block for a non-existent
 * path usually means it hallucinated a filename; we'd rather fail loudly.
 *
 * Uses `fileReader` to read the current content so tests can inject a
 * fake file system. Default reader is plain `readFileSync`.
 *
 * `knownPaths` is the task's filePaths list. When an LLM block's path
 * doesn't exist in the workDir, we suffix-match it against knownPaths
 * — in practice the model "helpfully" shortens long paths (e.g. emits
 * `src/wiring.ts` instead of `autonomous/runners/src/wiring.ts`). The
 * prompt asks it not to; this is the defense-in-depth code-level
 * fallback for when it does it anyway. Remapping is deliberately
 * narrow: suffix-match only (`kp.endsWith('/' + block.path)`) plus a
 * content-exists check against the remapped target.
 */
export async function buildPatchFromFiles(
  blocks: readonly FileBlock[],
  workDir: string,
  runner: CommandRunner,
  fileReader: (absPath: string) => string | null = defaultReadFile,
  knownPaths?: readonly string[],
): Promise<{ patch: string; error?: string }> {
  if (blocks.length === 0) return { patch: '', error: 'no file blocks supplied' };

  // Dedicated tmp dir so scratch files don't pollute workDir and so
  // concurrent tasks (future) don't collide. Unique per invocation.
  const scratchDir = mkdtempSync(
    join(tmpdir(), `asil-patch-${randomBytes(4).toString('hex')}-`),
  );

  try {
    const patches: string[] = [];
    for (const block of blocks) {
      // Guard against path traversal / absolute paths. File blocks
      // must reference paths relative to the repo root.
      if (block.path.startsWith('/') || block.path.includes('..')) {
        return {
          patch: '',
          error: `rejected suspicious path in file block: "${block.path}"`,
        };
      }

      let current = fileReader(resolve(workDir, block.path));
      let resolvedPath = block.path;

      // Suffix-remap: the LLM shortened the path. Walk knownPaths for
      // one that either matches exactly or ends with `/` + the block's
      // path, then confirm the remapped target actually exists in the
      // workDir (second validation against coincidental same-basename
      // matches in multi-file tasks).
      if (current === null && knownPaths && knownPaths.length > 0) {
        const suffix = `/${block.path}`;
        const match = knownPaths.find(
          (kp) => kp === block.path || kp.endsWith(suffix),
        );
        if (match) {
          const remapped = fileReader(resolve(workDir, match));
          if (remapped !== null) {
            current = remapped;
            resolvedPath = match;
          }
        }
      }

      if (current === null) {
        return {
          patch: '',
          error: `file block refers to path that does not exist in workDir: "${block.path}" (new-file creation is not supported by this executor pass — edit an existing file or expand buildPatchFromFiles)`,
        };
      }

      // Write old + new to scratch for `diff -u` to chew on. Keep
      // their basenames unique per block so concurrent diff commands
      // couldn't collide if we ever parallelise.
      const safeBase = resolvedPath.replace(/[/\\]/g, '_');
      const oldFile = resolve(scratchDir, `${safeBase}.old`);
      const newFile = resolve(scratchDir, `${safeBase}.new`);
      writeFileSync(oldFile, current, 'utf8');
      writeFileSync(newFile, block.content, 'utf8');

      // --label rewrites the header paths to a/<path> / b/<path>, which
      // is the form `git apply` expects. -u produces unified format.
      // Use `resolvedPath` (the actual file in workDir) for the label
      // so `git apply` targets the right file, not the LLM's shortened
      // version.
      const { stdout, exitCode } = await runner.run(
        'diff',
        [
          '-u',
          '--label',
          `a/${resolvedPath}`,
          '--label',
          `b/${resolvedPath}`,
          oldFile,
          newFile,
        ],
        { cwd: workDir },
      );

      // diff exit codes: 0 = identical, 1 = different, 2+ = error.
      if (exitCode === 0) continue; // file unchanged — skip
      if (exitCode > 1) {
        return {
          patch: '',
          error: `diff -u failed for ${resolvedPath} with exit code ${exitCode}`,
        };
      }
      if (stdout.trim()) patches.push(stdout);
    }

    return { patch: patches.join('\n') };
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Best-effort; a leftover tmp dir is cosmetic.
    }
  }
}
