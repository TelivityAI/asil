import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetManager, TokenTracker } from 'asil-cost-controller';
import { runLoop } from '../loop.js';
import { TaskQueue } from '../task-queue.js';
import { CycleDetector } from '../cycle-detector.js';
import type { ImprovementLoopConfig } from '../types.js';
import {
  allPersonas,
  CANNED_UNIFIED_DIFF,
  fileBlock,
  mkTask,
  mockCodex,
  mockDiffApplier,
  mockFileFetcher,
  mockFileReader,
  mockGit,
  mockLLM,
  mockRunner,
  personaResponse,
} from './helpers.js';

// Tests run under worktree isolation → workDir is a non-existent mock path.
// This reader stands in for readFileSync so buildPatchFromFiles can diff
// against SOMETHING when computing the patch. The actual diff output is
// supplied by the mocked `diff` shell command below.
function fakeReadCurrent(_absPath: string): string | null {
  return 'const existing = 1;\n';
}

describe('runLoop — integration', () => {
  let dir: string;
  let queuePath: string;
  let tracker: TokenTracker;
  let budgetManager: BudgetManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loop-'));
    queuePath = join(dir, 'queue.json');
    tracker = new TokenTracker(join(dir, 'usage.json'), { autoPersist: false });
    budgetManager = new BudgetManager(tracker);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function cfg(overrides: Partial<ImprovementLoopConfig> = {}): ImprovementLoopConfig {
    return {
      executionModel: 'sonnet',
      reviewModel: 'sonnet',
      maxTasksPerRun: 3,
      maxAttempts: 2,
      taskCooldownMs: 0,
      markdownSkillsPath: '/skills',
      repoRoot: '/repo',
      queuePath,
      skipCategories: [],
      codexConfig: { apiKey: 'CODEX_KEY', model: 'codex-mini' },
      ...overrides,
    };
  }

  function goodLLM() {
    // Executor prompt asks for the new file-block output format.
    const executorReply = {
      content: fileBlock('packages/foo/src/foo.ts', 'const existing = 2;\n'),
      inputTokens: 200,
      outputTokens: 100,
    };
    return mockLLM(
      [
        { match: /Anti-Rationalization Enforcement/, response: executorReply },
        ...allPersonas({
          'code-reviewer': personaResponse({ approved: true }),
          'security-auditor': personaResponse({ approved: true }),
          'test-engineer': personaResponse({ approved: true }),
        }),
      ],
      { content: '', inputTokens: 10, outputTokens: 5 },
    );
  }

  function goodRunner() {
    return mockRunner([
      // `diff` drives buildPatchFromFiles — returns a non-empty patch
      // so downstream code treats it as a real change.
      {
        match: (cmd) => cmd === 'diff',
        exitCode: 1,
        stdout: CANNED_UNIFIED_DIFF,
      },
      { match: (cmd) => cmd === 'pnpm', exitCode: 0 },
      { match: (cmd) => cmd === 'grep', exitCode: 0 },
    ]);
  }

  it('full flow: queued task → worktree created → PR opened → worktree cleaned up', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-happy' }));

    const git = mockGit('https://example.com/pr/1');
    const result = await runLoop(cfg(), {
      llm: goodLLM(),
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });

    expect(result.prsOpened).toBe(1);
    expect(result.outcomes[0]?.status).toBe('pr-opened');
    // Worktree must be created up-front AND cleaned up, even on the happy path.
    expect(git.operations.some((op) => op.startsWith('createBranch:'))).toBe(true);
    expect(git.cleanedUp.length).toBe(1);
    expect(git.cleanedUp[0]).toMatch(/asil-auto-/);
  });

  it('reports total token usage including self-review + adversarial, not just the executor (Codex #2)', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-tokens' }));

    const git = mockGit('https://example.com/pr/2');
    const result = await runLoop(cfg(), {
      llm: goodLLM(), // executor reply = 200 in / 100 out; personas add more
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });

    expect(result.outcomes[0]?.status).toBe('pr-opened');
    // The executor alone reported 200 input tokens. The reported total
    // must EXCEED that — proving the three persona self-review calls were
    // added to the accounted total rather than silently dropped.
    expect(result.outcomes[0]?.totalTokenUsage.inputTokens).toBeGreaterThan(200);
    expect(result.outcomes[0]?.totalTokenUsage.outputTokens).toBeGreaterThan(100);
  });

  it('pnpm install failure in the worktree → task aborts as infra-failed, LLM never called, worktree cleaned (Codex #6)', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-install-fail' }));

    // install fails; the LLM would only run AFTER a successful bootstrap.
    const llm = goodLLM();

    const runner = mockRunner([
      { match: (cmd, args) => cmd === 'pnpm' && args.includes('install'), exitCode: 1, stderr: 'ERR_PNPM_LOCKFILE' },
      { match: (cmd) => cmd === 'diff', exitCode: 1, stdout: CANNED_UNIFIED_DIFF },
      { match: (cmd) => cmd === 'pnpm', exitCode: 0 },
      { match: (cmd) => cmd === 'grep', exitCode: 0 },
    ]);

    const git = mockGit();
    const result = await runLoop(cfg(), {
      llm,
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git,
      tracker,
      budgetManager,
      runner,
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });

    expect(result.outcomes[0]?.status).toBe('infra-failed');
    expect(result.outcomes[0]?.failureReason).toMatch(/install failed/i);
    expect(result.prsOpened).toBe(0);
    // The executor LLM must NOT have run — we aborted before execution.
    expect(llm.calls.length).toBe(0);
    // Worktree still cleaned up on the abort path.
    expect(git.cleanedUp.length).toBe(1);
  });

  it('self-review reject → task marked FAILED (not completed) + worktree cleaned', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-reject' }));

    const llm = mockLLM([
      {
        match: /Anti-Rationalization Enforcement/,
        response: {
          content: fileBlock('packages/foo/src/foo.ts', 'const existing = 2;\n'),
          inputTokens: 200,
          outputTokens: 100,
        },
      },
      ...allPersonas({
        'code-reviewer': personaResponse({ approved: false, concerns: ['bad'] }),
        'security-auditor': personaResponse({
          approved: false,
          concerns: ['unsafe'],
        }),
        'test-engineer': personaResponse({ approved: true }),
      }),
    ]);

    const git = mockGit();
    const result = await runLoop(cfg(), {
      llm,
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });

    expect(result.rejected).toBe(1);
    expect(result.outcomes[0]?.status).toBe('rejected-self-review');
    // Rejected tasks must end up `failed` in the queue, not `completed`
    // — otherwise retries never fire and the task silently disappears.
    const stored = queue.snapshot().find((i) => i.task.id === 't-reject');
    expect(stored?.status).toBe('failed');
    // Worktree must be cleaned regardless of review verdict.
    expect(git.cleanedUp.length).toBe(1);
  });

  it('adversarial reject → task marked FAILED (not completed) + worktree cleaned', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-adv' }));

    const git = mockGit();
    const result = await runLoop(cfg(), {
      llm: goodLLM(),
      codex: mockCodex(
        JSON.stringify({
          approved: false,
          reasoning: 'security issue',
          issuesFound: ['x'],
          severity: 'major-issues',
        }),
      ),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });
    expect(result.rejected).toBe(1);
    expect(result.outcomes[0]?.status).toBe('rejected-adversarial');
    const stored = queue.snapshot().find((i) => i.task.id === 't-adv');
    expect(stored?.status).toBe('failed');
    expect(git.cleanedUp.length).toBe(1);
  });

  it('PR push failure → task marked FAILED + worktree cleaned', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-push-fail' }));

    const git = mockGit();
    git.failPush = true;
    const result = await runLoop(cfg(), {
      llm: goodLLM(),
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });
    expect(result.prsOpened).toBe(0);
    expect(result.outcomes[0]?.status).toBe('execution-failed');
    const stored = queue.snapshot().find((i) => i.task.id === 't-push-fail');
    expect(stored?.status).toBe('failed');
    expect(git.cleanedUp.length).toBe(1);
  });

  it('execution failure (no diff) → task marked FAILED + worktree cleaned', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-no-diff' }));

    const llm = mockLLM([
      {
        match: /Anti-Rationalization Enforcement/,
        response: { content: 'I cannot produce a diff.' },
      },
    ]);

    const git = mockGit();
    const result = await runLoop(cfg(), {
      llm,
      codex: mockCodex(''),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });
    expect(result.outcomes[0]?.status).toBe('execution-failed');
    expect(git.cleanedUp.length).toBe(1);
  });

  it('worktree creation failure → task marked FAILED, no cleanup attempted', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-wt-fail' }));

    const git = mockGit();
    git.failCreateBranch = true;
    const result = await runLoop(cfg(), {
      llm: goodLLM(),
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });
    expect(result.outcomes[0]?.status).toBe('execution-failed');
    // No cleanup when createBranch itself failed — there's no worktree
    // path to clean up.
    expect(git.cleanedUp.length).toBe(0);
    const stored = queue.snapshot().find((i) => i.task.id === 't-wt-fail');
    expect(stored?.status).toBe('failed');
  });

  it('cycle detection → task skipped + no worktree created', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(
      mkTask({ id: 't-cyc', filePaths: ['a.ts'], category: 'complexity' }),
    );

    const cycleDetector = new CycleDetector(60_000, 3);
    cycleDetector.record('prev1', 'complexity', ['a.ts']);
    cycleDetector.record('prev2', 'complexity', ['a.ts']);
    cycleDetector.record('prev3', 'complexity', ['a.ts']);

    const git = mockGit();
    const result = await runLoop(cfg(), {
      llm: goodLLM(),
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
      cycleDetector,
    });
    expect(result.cyclesDetected).toBe(1);
    expect(result.outcomes[0]?.status).toBe('cycle-skipped');
    // Cycle-skipped tasks never reach createBranch.
    expect(git.operations.some((op) => op.startsWith('createBranch:'))).toBe(
      false,
    );
    expect(git.cleanedUp.length).toBe(0);
  });

  it('empty queue returns immediately (no outcomes)', async () => {
    const result = await runLoop(cfg(), {
      llm: goodLLM(),
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git: mockGit(),
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
    });
    expect(result.tasksProcessed).toBe(0);
  });

  it('maxTasksPerRun caps work and cleans up every worktree it opened', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-a' }));
    queue.enqueue(mkTask({ id: 't-b' }));
    queue.enqueue(mkTask({ id: 't-c' }));

    const git = mockGit();
    const result = await runLoop(cfg({ maxTasksPerRun: 2 }), {
      llm: goodLLM(),
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });
    expect(result.tasksProcessed).toBe(2);
    expect(git.cleanedUp.length).toBe(2);
  });

  it('skipCategories filters discovered tasks from the queue', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-docs', category: 'documentation' }));

    const result = await runLoop(
      cfg({ skipCategories: ['documentation'] }),
      {
        llm: goodLLM(),
        codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
        git: mockGit(),
        tracker,
        budgetManager,
        runner: goodRunner(),
        fileReader: mockFileReader(),
        fileFetcher: mockFileFetcher(),
        diff: mockDiffApplier(),
        readCurrent: fakeReadCurrent,
        queue,
      },
    );
    // skipCategories now filters BOTH scan-discovered AND pre-enqueued tasks.
    // The pre-enqueued 'documentation' task is skipped, so nothing runs.
    expect(result.tasksProcessed).toBe(0);
  });

  it('budget exhaustion during fan-out still cleans up the in-flight worktree', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-budget-blow' }));

    // Huge token response blows through the task-level budget cap.
    const executorReply = {
      content: fileBlock('packages/foo/src/foo.ts', 'const existing = 2;\n'),
      inputTokens: 5_000_000,
      outputTokens: 5_000_000,
    };
    const llm = mockLLM([
      { match: /Anti-Rationalization Enforcement/, response: executorReply },
      ...allPersonas({
        'code-reviewer': personaResponse({ approved: true }),
        'security-auditor': personaResponse({ approved: true }),
        'test-engineer': personaResponse({ approved: true }),
      }),
    ]);

    const git = mockGit();
    const result = await runLoop(cfg(), {
      llm,
      codex: mockCodex(JSON.stringify({ approved: true, severity: 'pass' })),
      git,
      tracker,
      budgetManager,
      runner: goodRunner(),
      fileReader: mockFileReader(),
      fileFetcher: mockFileFetcher(),
      diff: mockDiffApplier(),
      readCurrent: fakeReadCurrent,
      queue,
    });
    expect(result.budgetExhausted).toBe(true);
    // Worktree still cleaned even when we bail early on a budget kill.
    expect(git.cleanedUp.length).toBe(1);
  });
});
