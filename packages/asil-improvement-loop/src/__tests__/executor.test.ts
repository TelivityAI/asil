import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildExecutionPrompt,
  buildPatchFromFiles,
  executeTask,
  extractAntiRationalization,
  extractDiff,
  extractFileBlocks,
  type ExecutorFailureEvent,
  type ExecutorLogger,
} from '../executor.js';
import {
  CANNED_UNIFIED_DIFF,
  fileBlock,
  mkTask,
  mockDiffApplier,
  mockFileFetcher,
  mockLLM,
  mockRunner,
  SAMPLE_DIFF,
} from './helpers.js';

function mkLogger(): ExecutorLogger & { events: ExecutorFailureEvent[] } {
  const events: ExecutorFailureEvent[] = [];
  return { events, error: vi.fn((e) => events.push(e)) };
}

/** Set up a real tmp dir with the given files on disk — required for
 *  buildPatchFromFiles which reads current content via readFileSync. */
function setupWorkDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'executor-test-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = resolve(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function runnerFor(options: {
  /** Array of canned diff outputs — consumed FIFO per `diff` call. */
  diffOutputs?: string[];
  typecheckExit?: number;
  typecheckStdout?: string;
  typecheckStderr?: string;
  testExit?: number;
  testStdout?: string;
  testStderr?: string;
}) {
  const diffQueue = [...(options.diffOutputs ?? [CANNED_UNIFIED_DIFF])];
  return mockRunner([
    {
      match: (cmd) => cmd === 'diff',
      // `diff` returns 1 when files differ, 0 when identical.
      exitCode: 1,
      // stdout is overridden per-call below; mockRunner API is static
      // per entry so we consume the queue via a closure.
    },
    {
      match: (cmd, args) => cmd === 'pnpm' && args.includes('typecheck'),
      exitCode: options.typecheckExit ?? 0,
      stdout: options.typecheckStdout ?? '',
      stderr: options.typecheckStderr ?? '',
    },
    {
      match: (cmd, args) => cmd === 'pnpm' && args.includes('test'),
      exitCode: options.testExit ?? 0,
      stdout: options.testStdout ?? '',
      stderr: options.testStderr ?? '',
    },
  ]) as ReturnType<typeof mockRunner> & { __diffQueue: string[] };
}

// mockRunner's static table can't handle per-call stdout, so we wrap to
// inject dynamic diff output. (A small helper beats changing the shared
// mockRunner contract.)
function wrapRunnerWithDiffQueue(
  runner: ReturnType<typeof mockRunner>,
  diffQueue: string[],
): typeof runner {
  const originalRun = runner.run.bind(runner);
  return Object.assign(runner, {
    async run(cmd: string, args: string[], opts: { cwd: string }) {
      if (cmd === 'diff') {
        const stdout = diffQueue.shift() ?? '';
        return { stdout, stderr: '', exitCode: stdout ? 1 : 0 };
      }
      return originalRun(cmd, args, opts);
    },
  });
}

describe('executor', () => {
  describe('extractDiff (legacy)', () => {
    it('extracts a unified diff from a ```diff fence', () => {
      const wrapped = '```diff\n' + SAMPLE_DIFF + '```';
      expect(extractDiff(wrapped)).toMatch(/^diff --git/);
    });

    it('accepts a raw diff with no fence', () => {
      expect(extractDiff(SAMPLE_DIFF)).toMatch(/^diff --git/);
    });

    it('returns empty string when no diff markers are present', () => {
      expect(extractDiff('just some words')).toBe('');
    });
  });

  describe('extractFileBlocks', () => {
    it('parses a single <<<FILE: ... >>> ... <<<END FILE>>> block', () => {
      const input = fileBlock('src/foo.ts', 'export const x = 1;\n');
      const blocks = extractFileBlocks(input);
      expect(blocks).toEqual([{ path: 'src/foo.ts', content: 'export const x = 1;\n' }]);
    });

    it('parses multiple blocks in one response', () => {
      const input = [
        fileBlock('a.ts', 'const a = 1;'),
        fileBlock('nested/b.ts', 'const b = 2;'),
      ].join('\n\n');
      const blocks = extractFileBlocks(input);
      expect(blocks.length).toBe(2);
      expect(blocks[0]?.path).toBe('a.ts');
      expect(blocks[1]?.path).toBe('nested/b.ts');
    });

    it('tolerates prose preamble before the first block', () => {
      const input = `Here's my change:\n\n${fileBlock('foo.ts', 'x')}\n\nDone!`;
      // Trailing `\n` enforced by extractFileBlocks (POSIX convention).
      expect(extractFileBlocks(input)).toEqual([{ path: 'foo.ts', content: 'x\n' }]);
    });

    it('normalises CRLF to LF in block contents and ensures a trailing newline', () => {
      const input = '<<<FILE: foo.ts>>>\r\nconst x = 1;\r\n<<<END FILE>>>';
      const blocks = extractFileBlocks(input);
      // No carriage returns AND a trailing newline (POSIX convention,
      // matches what git/diff expect on the original side).
      expect(blocks[0]?.content).toBe('const x = 1;\n');
    });

    it('appends a trailing newline when the captured content does not have one', () => {
      const input = '<<<FILE: foo.ts>>>\nconst x = 1;\n<<<END FILE>>>';
      const blocks = extractFileBlocks(input);
      expect(blocks[0]?.content).toBe('const x = 1;\n');
    });

    it('returns [] on empty or malformed input', () => {
      expect(extractFileBlocks('')).toEqual([]);
      expect(extractFileBlocks('no blocks here')).toEqual([]);
      expect(extractFileBlocks('<<<FILE: x>>> no end sentinel')).toEqual([]);
    });

    it('skips blocks with empty paths', () => {
      const input = '<<<FILE:  >>>\ncontent\n<<<END FILE>>>';
      expect(extractFileBlocks(input)).toEqual([]);
    });
  });

  describe('buildPatchFromFiles', () => {
    let workDir: string;
    beforeEach(() => {
      workDir = setupWorkDir({ 'foo.ts': 'const x = 1;\n' });
    });
    afterEach(() => rmSync(workDir, { recursive: true, force: true }));

    it('invokes `diff -u` with a/<path> b/<path> labels and returns the unified patch', async () => {
      const diffCalls: Array<{ args: string[] }> = [];
      const runner = {
        async run(cmd: string, args: string[]) {
          diffCalls.push({ args });
          if (cmd === 'diff') {
            return { stdout: CANNED_UNIFIED_DIFF, stderr: '', exitCode: 1 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const { patch, error } = await buildPatchFromFiles(
        [{ path: 'foo.ts', content: 'const x = 2;\n' }],
        workDir,
        runner,
      );
      expect(error).toBeUndefined();
      expect(patch).toBe(CANNED_UNIFIED_DIFF);
      const call = diffCalls[0];
      expect(call?.args).toContain('-u');
      expect(call?.args).toContain('--label');
      expect(call?.args).toContain('a/foo.ts');
      expect(call?.args).toContain('b/foo.ts');
    });

    it('returns empty patch when file content is identical to current', async () => {
      const runner = {
        async run(cmd: string) {
          if (cmd === 'diff') {
            // Identical files → diff exits 0 with no stdout.
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const { patch, error } = await buildPatchFromFiles(
        [{ path: 'foo.ts', content: 'const x = 1;\n' }],
        workDir,
        runner,
      );
      expect(error).toBeUndefined();
      expect(patch).toBe('');
    });

    it('concatenates per-file patches when multiple blocks supplied', async () => {
      writeFileSync(resolve(workDir, 'bar.ts'), 'const y = 1;\n');
      const diffFooA = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x1\n+x2\n';
      const diffBarB = '--- a/bar.ts\n+++ b/bar.ts\n@@ -1 +1 @@\n-y1\n+y2\n';
      const outputs = [diffFooA, diffBarB];
      const runner = {
        async run(cmd: string) {
          if (cmd === 'diff') {
            return {
              stdout: outputs.shift() ?? '',
              stderr: '',
              exitCode: 1,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const { patch } = await buildPatchFromFiles(
        [
          { path: 'foo.ts', content: 'new foo' },
          { path: 'bar.ts', content: 'new bar' },
        ],
        workDir,
        runner,
      );
      expect(patch).toContain('--- a/foo.ts');
      expect(patch).toContain('--- a/bar.ts');
    });

    it('rejects absolute paths as suspicious', async () => {
      const runner = { async run() { return { stdout: '', stderr: '', exitCode: 0 }; } };
      const { error } = await buildPatchFromFiles(
        [{ path: '/etc/passwd', content: 'evil' }],
        workDir,
        runner,
      );
      expect(error).toMatch(/suspicious path/);
    });

    it('rejects paths containing ..', async () => {
      const runner = { async run() { return { stdout: '', stderr: '', exitCode: 0 }; } };
      const { error } = await buildPatchFromFiles(
        [{ path: '../outside.ts', content: 'x' }],
        workDir,
        runner,
      );
      expect(error).toMatch(/suspicious path/);
    });

    it('rejects blocks pointing to files that do not exist in the workDir', async () => {
      const runner = { async run() { return { stdout: '', stderr: '', exitCode: 0 }; } };
      const { error } = await buildPatchFromFiles(
        [{ path: 'does-not-exist.ts', content: 'x' }],
        workDir,
        runner,
      );
      expect(error).toMatch(/does not exist/);
    });

    describe('knownPaths suffix remap', () => {
      it('remaps an LLM-shortened block path via suffix-match against knownPaths', async () => {
        // File exists at nested path on disk; LLM emits just the tail.
        mkdirSync(resolve(workDir, 'autonomous/runners/src'), {
          recursive: true,
        });
        writeFileSync(
          resolve(workDir, 'autonomous/runners/src/wiring.ts'),
          'export const wired = 1;\n',
        );

        const calls: Array<{ args: string[] }> = [];
        const runner = {
          async run(cmd: string, args: string[]) {
            calls.push({ args });
            if (cmd === 'diff') {
              return {
                stdout:
                  '--- a/autonomous/runners/src/wiring.ts\n+++ b/autonomous/runners/src/wiring.ts\n@@ -1 +1 @@\n-export const wired = 1;\n+export const wired = 2;\n',
                stderr: '',
                exitCode: 1,
              };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };

        const { patch, error } = await buildPatchFromFiles(
          [{ path: 'src/wiring.ts', content: 'export const wired = 2;\n' }],
          workDir,
          runner,
          undefined,
          ['autonomous/runners/src/wiring.ts'],
        );
        expect(error).toBeUndefined();
        // Patch uses the REMAPPED full path in its a/ b/ labels.
        expect(patch).toContain('a/autonomous/runners/src/wiring.ts');
        // The diff command was invoked with the remapped path as labels.
        const diffCall = calls.find((c) => c.args.includes('-u'));
        expect(diffCall?.args).toContain('a/autonomous/runners/src/wiring.ts');
        expect(diffCall?.args).toContain('b/autonomous/runners/src/wiring.ts');
      });

      it('returns the normal file-not-found error when no knownPath has a matching suffix', async () => {
        const runner = {
          async run() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };
        const { error } = await buildPatchFromFiles(
          [{ path: 'src/foo.ts', content: 'x' }],
          workDir,
          runner,
          undefined,
          ['packages/bar/src/other.ts'], // basename doesn't match
        );
        expect(error).toMatch(/does not exist/);
      });

      it('exact matches skip remapping and work as before', async () => {
        mkdirSync(resolve(workDir, 'autonomous/runners/src'), {
          recursive: true,
        });
        writeFileSync(
          resolve(workDir, 'autonomous/runners/src/wiring.ts'),
          'x',
        );
        const runner = {
          async run(cmd: string) {
            if (cmd === 'diff') {
              return {
                stdout: '--- a/autonomous/runners/src/wiring.ts\n',
                stderr: '',
                exitCode: 1,
              };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };
        const { patch, error } = await buildPatchFromFiles(
          [{ path: 'autonomous/runners/src/wiring.ts', content: 'y' }],
          workDir,
          runner,
          undefined,
          ['autonomous/runners/src/wiring.ts'],
        );
        expect(error).toBeUndefined();
        expect(patch).toContain('a/autonomous/runners/src/wiring.ts');
      });

      it('no knownPaths passed → still returns file-not-found (backward compat)', async () => {
        const runner = {
          async run() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };
        // No knownPaths argument at all — existing callers unaffected.
        const { error } = await buildPatchFromFiles(
          [{ path: 'src/missing.ts', content: 'x' }],
          workDir,
          runner,
        );
        expect(error).toMatch(/does not exist/);
      });

      it('multiple shortened blocks remap to their respective full paths', async () => {
        mkdirSync(resolve(workDir, 'pkg-a/src'), { recursive: true });
        mkdirSync(resolve(workDir, 'pkg-b/src'), { recursive: true });
        writeFileSync(resolve(workDir, 'pkg-a/src/alpha.ts'), 'a\n');
        writeFileSync(resolve(workDir, 'pkg-b/src/beta.ts'), 'b\n');

        const outputs = [
          '--- a/pkg-a/src/alpha.ts\n+++ b/pkg-a/src/alpha.ts\n@@ -1 +1 @@\n-a\n+A\n',
          '--- a/pkg-b/src/beta.ts\n+++ b/pkg-b/src/beta.ts\n@@ -1 +1 @@\n-b\n+B\n',
        ];
        const runner = {
          async run(cmd: string) {
            if (cmd === 'diff') {
              return {
                stdout: outputs.shift() ?? '',
                stderr: '',
                exitCode: 1,
              };
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };

        const { patch, error } = await buildPatchFromFiles(
          [
            { path: 'src/alpha.ts', content: 'A\n' },
            { path: 'src/beta.ts', content: 'B\n' },
          ],
          workDir,
          runner,
          undefined,
          ['pkg-a/src/alpha.ts', 'pkg-b/src/beta.ts'],
        );
        expect(error).toBeUndefined();
        expect(patch).toContain('a/pkg-a/src/alpha.ts');
        expect(patch).toContain('a/pkg-b/src/beta.ts');
      });

      it('skips a suffix match when the remapped file also does not exist (avoids false-positive remap)', async () => {
        // knownPath ends in the block suffix but the file isn't on disk.
        // The remap must not succeed — still a file-not-found.
        const runner = {
          async run() {
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        };
        const { error } = await buildPatchFromFiles(
          [{ path: 'src/ghost.ts', content: 'x' }],
          workDir,
          runner,
          undefined,
          ['packages/foo/src/ghost.ts'], // matches suffix, not on disk
        );
        expect(error).toMatch(/does not exist/);
      });
    });
  });

  describe('extractAntiRationalization', () => {
    it('pulls the anti-rationalization section out of a skill markdown', () => {
      const skill = [
        '# Skill X',
        '',
        '## Instructions',
        'Do the thing.',
        '',
        '## Anti-Rationalization Table',
        '- Do not skip edge cases',
        '- Do not write shallow tests',
        '',
        '## Examples',
        'xxx',
      ].join('\n');
      const section = extractAntiRationalization(skill);
      expect(section).toMatch(/Anti-Rationalization/i);
      expect(section).toMatch(/Do not skip edge cases/);
      expect(section).not.toMatch(/Examples/);
    });

    it('returns empty string when the section is missing', () => {
      expect(extractAntiRationalization('# Just a skill\n\nNo table here.')).toBe('');
    });
  });

  describe('buildExecutionPrompt', () => {
    it('instructs the LLM to use <<<FILE: ...>>> sentinels, NOT a unified diff', () => {
      const prompt = buildExecutionPrompt('# Skill body', '- Do not skip edge cases');
      expect(prompt).toContain('<<<FILE:');
      expect(prompt).toContain('<<<END FILE>>>');
      expect(prompt).toContain('Do NOT output a unified diff');
      expect(prompt).toContain('decimal.js');
      expect(prompt).toContain('Anti-Rationalization Enforcement');
    });

    it('tells the LLM to copy file paths EXACTLY, character-for-character', () => {
      const prompt = buildExecutionPrompt('', '');
      expect(prompt).toMatch(/EXACTLY match/i);
      expect(prompt).toMatch(/character-for-character/i);
      expect(prompt).toMatch(/Do not guess, shorten, or restructure paths/i);
    });
  });

  describe('buildTaskPrompt', () => {
    it('appends an explicit "Exact file paths" list when files are supplied', async () => {
      const { buildTaskPrompt } = await import('../executor.js');
      const prompt = buildTaskPrompt(mkTask({ filePaths: ['a.ts', 'b.ts'] }), {
        'packages/foo/src/a.ts': 'contents of a',
        'packages/foo/src/b.ts': 'contents of b',
      });
      expect(prompt).toMatch(/Exact file paths to use in <<<FILE: path>>> sentinels:/);
      expect(prompt).toContain('`packages/foo/src/a.ts`');
      expect(prompt).toContain('`packages/foo/src/b.ts`');
    });

    it('omits the path list when no files were supplied', async () => {
      const { buildTaskPrompt } = await import('../executor.js');
      const prompt = buildTaskPrompt(mkTask({ filePaths: [] }), {});
      expect(prompt).not.toMatch(/Exact file paths to use/);
    });
  });

  describe('executeTask', () => {
    let workDir: string;
    beforeEach(() => {
      workDir = setupWorkDir({ 'foo.ts': 'const x = 1;\n' });
    });
    afterEach(() => rmSync(workDir, { recursive: true, force: true }));

    it('succeeds when LLM returns a file block → programmatic diff → apply passes checks', async () => {
      const llm = mockLLM([
        {
          match: /.*/,
          response: {
            content: fileBlock('foo.ts', 'const x = 2;\n'),
            inputTokens: 200,
            outputTokens: 100,
          },
        },
      ]);
      const runner = wrapRunnerWithDiffQueue(
        runnerFor({ diffOutputs: [CANNED_UNIFIED_DIFF] }),
        [CANNED_UNIFIED_DIFF],
      );
      const diff = mockDiffApplier();
      const result = await executeTask(
        mkTask({ filePaths: ['foo.ts'] }),
        {
          llm,
          runner,
          diff,
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async () => '## Anti-Rationalization\n- Be rigorous',
        },
        {
          repoRoot: workDir,
          markdownSkillsPath: '/skills',
          model: 'sonnet',
          workDir,
        },
      );
      expect(result.success).toBe(true);
      expect(result.typeCheckPassed).toBe(true);
      expect(result.testsPassed).toBe(true);
      expect(result.tokenUsage).toEqual({ inputTokens: 200, outputTokens: 100 });
      expect(diff.applied.length).toBe(1);
      expect(llm.calls.length).toBe(1); // no retry needed
    });

    it('retries the LLM once when git apply --check rejects the first patch, succeeds on retry', async () => {
      let call = 0;
      const llm = {
        calls: [] as Array<{ system: string; user: string; model: string }>,
        async call(system: string, user: string, model: string) {
          llm.calls.push({ system, user, model });
          call += 1;
          return {
            content: fileBlock('foo.ts', call === 1 ? 'bad' : 'const x = 2;\n'),
            inputTokens: 100,
            outputTokens: 50,
          };
        },
      };
      const runner = wrapRunnerWithDiffQueue(
        runnerFor({ diffOutputs: [CANNED_UNIFIED_DIFF, CANNED_UNIFIED_DIFF] }),
        [CANNED_UNIFIED_DIFF, CANNED_UNIFIED_DIFF],
      );
      const diff = mockDiffApplier({ appliedValues: [false, true], error: 'patch does not apply' });
      const result = await executeTask(
        mkTask({ filePaths: ['foo.ts'] }),
        {
          llm,
          runner,
          diff,
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async () => '',
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      expect(result.success).toBe(true);
      // Two LLM calls total — initial + retry.
      expect(llm.calls.length).toBe(2);
      // Retry prompt must include the previous failure reason.
      expect(llm.calls[1]?.user).toMatch(/Retry context/);
      expect(llm.calls[1]?.user).toMatch(/patch does not apply/);
      // Token usage aggregated across both passes.
      expect(result.tokenUsage).toEqual({ inputTokens: 200, outputTokens: 100 });
    });

    it('classifies failure as diff-apply when the patch is generated but both pass + retry fail git apply --check', async () => {
      const llm = mockLLM([
        {
          match: /.*/,
          response: { content: fileBlock('foo.ts', 'const x = 2;\n'), inputTokens: 10, outputTokens: 5 },
        },
      ]);
      const runner = wrapRunnerWithDiffQueue(
        runnerFor({ diffOutputs: [CANNED_UNIFIED_DIFF, CANNED_UNIFIED_DIFF] }),
        [CANNED_UNIFIED_DIFF, CANNED_UNIFIED_DIFF],
      );
      const diff = mockDiffApplier({ appliedValues: [false, false], error: 'patch corrupted' });
      const logger = mkLogger();
      const result = await executeTask(
        mkTask({ filePaths: ['foo.ts'] }),
        {
          llm,
          runner,
          diff,
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async () => '',
          logger,
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      expect(result.success).toBe(false);
      expect(result.failedStep).toBe('diff-apply');
      expect(result.applyError).toBe('patch corrupted');
      expect(logger.events.length).toBe(1);
      expect(logger.events[0]?.failedStep).toBe('diff-apply');
      expect(logger.events[0]?.diff).toContain('--- a/packages/foo/src/foo.ts');
    });

    it('classifies failure as llm-no-diff when the LLM produces no file blocks after retry', async () => {
      const llm = mockLLM([
        { match: /.*/, response: { content: 'I cannot complete this task.' } },
      ]);
      const logger = mkLogger();
      const result = await executeTask(
        mkTask({ filePaths: ['foo.ts'] }),
        {
          llm,
          runner: mockRunner([]),
          diff: mockDiffApplier(),
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async () => '',
          logger,
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      expect(result.success).toBe(false);
      expect(result.failedStep).toBe('llm-no-diff');
      expect(result.applyError).toMatch(/no <<<FILE:/);
      expect(logger.events[0]?.llmResponse).toContain('cannot complete');
      // Retry still happened: LLM called twice.
      expect(llm.calls.length).toBe(2);
    });

    it('revert is NOT called after failure when running under worktree isolation', async () => {
      const llm = mockLLM([
        { match: /.*/, response: { content: fileBlock('foo.ts', 'const x = 2;\n') } },
      ]);
      const runner = wrapRunnerWithDiffQueue(
        runnerFor({ diffOutputs: [CANNED_UNIFIED_DIFF], testExit: 1 }),
        [CANNED_UNIFIED_DIFF],
      );
      const diff = mockDiffApplier();
      const result = await executeTask(
        mkTask({ filePaths: ['foo.ts'] }),
        {
          llm,
          runner,
          diff,
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async () => '',
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      expect(result.success).toBe(false);
      expect(result.failedStep).toBe('tests');
      // worktree isolation → loop nukes the whole dir; executor skips revert
      expect(diff.reverted.length).toBe(0);
    });

    it('revert IS called after failure when NOT under worktree isolation (shared tree)', async () => {
      const llm = mockLLM([
        { match: /.*/, response: { content: fileBlock('foo.ts', 'const x = 2;\n') } },
      ]);
      const runner = wrapRunnerWithDiffQueue(
        runnerFor({ diffOutputs: [CANNED_UNIFIED_DIFF], testExit: 1 }),
        [CANNED_UNIFIED_DIFF],
      );
      const diff = mockDiffApplier();
      const result = await executeTask(
        mkTask({ filePaths: ['foo.ts'] }),
        {
          llm,
          runner,
          diff,
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async () => '',
        },
        // No workDir option → shared-tree mode → revert on failure
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet' },
      );
      expect(result.success).toBe(false);
      expect(diff.reverted.length).toBe(1);
    });

    it('loads the skill mapped to the task category', async () => {
      let requested: { path: string; name: string } | null = null;
      const llm = mockLLM([{ match: /.*/, response: { content: 'no blocks' } }]);
      await executeTask(
        mkTask({ category: 'dead-code', filePaths: ['foo.ts'] }),
        {
          llm,
          runner: mockRunner([]),
          diff: mockDiffApplier(),
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async (path, name) => {
            requested = { path, name };
            return '';
          },
        },
        { repoRoot: workDir, markdownSkillsPath: '/skills', model: 'sonnet', workDir },
      );
      expect(requested).toEqual({ path: '/skills', name: 'dead-code-removal' });
    });

    it('safety-guard A: refuses when on-disk file has content but the prompt cache is empty (Issue #2)', async () => {
      // workDir already has foo.ts with `const x = 1;\n` (non-empty).
      // mockFileFetcher with no entries returns '' for every path —
      // simulating the silent fetch-failure that produced 6/10
      // destructive-replacement diffs in the 2026-05-05 sandbox run.
      const llm = mockLLM([
        {
          match: /.*/,
          response: { content: fileBlock('foo.ts', 'export {};\n') },
        },
      ]);
      const result = await executeTask(
        mkTask({ id: 't-guard-a', category: 'type-error', filePaths: ['foo.ts'] }),
        {
          llm,
          runner: mockRunner([]),
          diff: mockDiffApplier(),
          files: mockFileFetcher(), // empty — read() returns ''
          loadSkill: async () => '',
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      expect(result.success).toBe(false);
      expect(result.failedStep).toBe('safety-guard');
      expect(result.applyError).toContain('Issue #2 guard A');
      expect(result.applyError).toContain('foo.ts');
      // The LLM must NEVER have been called — guard A fires pre-flight.
      expect(llm.calls.length).toBe(0);
      // Token usage must be zero — no API spend wasted on a doomed prompt.
      expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('safety-guard B: rejects a non-dead-code diff that net-deletes >50% of the file (Issue #2)', async () => {
      // Set up a 200-line on-disk file AND populate the file fetcher
      // with the same content (so guard A is satisfied — the LLM saw
      // the real file). Then have the LLM respond with a 1-line
      // `export {};` body — the destructive minimal-replacement
      // signature observed in the 2026-05-05 sandbox run.
      const big = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
      writeFileSync(resolve(workDir, 'foo.ts'), big);
      const llm = mockLLM([
        {
          match: /.*/,
          response: { content: fileBlock('foo.ts', 'export {};\n') },
        },
      ]);
      const result = await executeTask(
        mkTask({ id: 't-guard-b', category: 'type-error', filePaths: ['foo.ts'] }),
        {
          llm,
          runner: mockRunner([]),
          diff: mockDiffApplier(),
          files: mockFileFetcher({ 'foo.ts': big }),
          loadSkill: async () => '',
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      expect(result.success).toBe(false);
      expect(result.failedStep).toBe('safety-guard');
      expect(result.applyError).toContain('Issue #2 guard B');
      expect(result.applyError).toContain('foo.ts');
      // The LLM was called (guard B is post-LLM, pre-apply).
      expect(llm.calls.length).toBeGreaterThanOrEqual(1);
      // The on-disk file MUST be unchanged.
      expect(readFileSync(resolve(workDir, 'foo.ts'), 'utf8')).toBe(big);
    });

    it('safety-guard B does NOT trigger for dead-code tasks (Issue #2 opt-out)', async () => {
      // Same destructive-shape diff, but task.category = 'dead-code'.
      // Net-deletion is the whole point of dead-code, so the guard
      // must let it through. The patch will fail downstream for other
      // reasons (no diff produced from the canned runner), but the
      // applyError must NOT mention "guard B".
      const big = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
      writeFileSync(resolve(workDir, 'foo.ts'), big);
      const llm = mockLLM([
        {
          match: /.*/,
          response: { content: fileBlock('foo.ts', 'export {};\n') },
        },
      ]);
      const result = await executeTask(
        mkTask({ id: 't-dead', category: 'dead-code', filePaths: ['foo.ts'] }),
        {
          llm,
          runner: mockRunner([]),
          diff: mockDiffApplier(),
          files: mockFileFetcher({ 'foo.ts': big }),
          loadSkill: async () => '',
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      // The guard is the test target — not the eventual outcome. We
      // assert only that guard B did NOT fire on this category.
      expect(result.applyError ?? '').not.toContain('Issue #2 guard B');
      expect(result.failedStep).not.toBe('safety-guard');
    });
  });

  describe('failure logging', () => {
    let workDir: string;
    beforeEach(() => {
      workDir = setupWorkDir({ 'foo.ts': 'const x = 1;\n' });
    });
    afterEach(() => rmSync(workDir, { recursive: true, force: true }));

    it('llm-no-diff (after retry): logs step, workDir, and raw LLM response', async () => {
      const llm = mockLLM([
        { match: /.*/, response: { content: 'Sorry, cannot help.' } },
      ]);
      const logger = mkLogger();
      await executeTask(
        mkTask({ id: 't-no-diff', category: 'complexity', filePaths: ['foo.ts'] }),
        {
          llm,
          runner: mockRunner([]),
          diff: mockDiffApplier(),
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async () => '',
          logger,
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      expect(logger.events.length).toBe(1);
      const e = logger.events[0]!;
      expect(e.failedStep).toBe('llm-no-diff');
      expect(e.workDir).toBe(workDir);
      expect(e.llmResponse).toContain('Sorry, cannot help.');
      expect(e.diff).toBe('');
    });

    it('typecheck: logs diff + captured stdout/stderr; does NOT run tests', async () => {
      const llm = mockLLM([
        { match: /.*/, response: { content: fileBlock('foo.ts', 'const x = 2;\n') } },
      ]);
      const runner = wrapRunnerWithDiffQueue(
        runnerFor({
          diffOutputs: [CANNED_UNIFIED_DIFF],
          typecheckExit: 2,
          typecheckStdout: 'Found 3 errors.',
          typecheckStderr: "TS2322: Type 'string' not assignable",
        }),
        [CANNED_UNIFIED_DIFF],
      );
      const logger = mkLogger();
      const result = await executeTask(
        mkTask({ id: 't-tc', category: 'type-error', filePaths: ['foo.ts'] }),
        {
          llm,
          runner,
          diff: mockDiffApplier(),
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async () => '',
          logger,
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      expect(result.failedStep).toBe('typecheck');
      expect(result.testsRun).toBe(false);
      expect(result.stepOutput?.stdout).toContain('Found 3 errors');
      expect(logger.events[0]?.failedStep).toBe('typecheck');
      expect(logger.events[0]?.stderr).toContain('TS2322');
      // Sanity: test never ran.
      const testCalls = runner.calls.filter((c) => c.args.includes('test'));
      expect(testCalls.length).toBe(0);
    });

    it('success path: logger.error is never called', async () => {
      const llm = mockLLM([
        { match: /.*/, response: { content: fileBlock('foo.ts', 'const x = 2;\n') } },
      ]);
      const runner = wrapRunnerWithDiffQueue(
        runnerFor({ diffOutputs: [CANNED_UNIFIED_DIFF] }),
        [CANNED_UNIFIED_DIFF],
      );
      const logger = mkLogger();
      const result = await executeTask(
        mkTask({ filePaths: ['foo.ts'] }),
        {
          llm,
          runner,
          diff: mockDiffApplier(),
          files: mockFileFetcher({ 'foo.ts': 'const x = 1;\n' }),
          loadSkill: async () => '',
          logger,
        },
        { repoRoot: workDir, markdownSkillsPath: '/s', model: 'sonnet', workDir },
      );
      expect(result.success).toBe(true);
      expect(result.failedStep).toBeUndefined();
      expect(logger.events.length).toBe(0);
    });
  });
});
