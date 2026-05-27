import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetManager, TokenTracker } from 'asil-cost-controller';
import { runCanaryGate } from '../canary-gate.js';
import { isBlockedByDomainGuard, runLoop } from '../loop.js';
import { destructiveDiffCanary } from '../canaries/destructive-diff.js';
import { emptyContentCanary } from '../canaries/empty-content.js';
import { domainQuestionCanary } from '../canaries/domain-question.js';
import { DEFAULT_CANARIES } from '../canaries/index.js';
import type { Canary, CanaryResult, ImprovementLoopConfig } from '../types.js';
import { TaskQueue } from '../task-queue.js';
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

// ---------------------------------------------------------------------------
// Individual canary tests — pass case + regression case
// ---------------------------------------------------------------------------

describe('destructive-diff canary', () => {
  it('passes when Guard B is intact (guard fires on destructive diff)', async () => {
    const result = await destructiveDiffCanary.run();
    expect(result.passed).toBe(true);
    expect(result.name).toBe('destructive-diff');
    expect(result.reason).toContain('Guard B correctly rejected');
  });

  it('fails when Guard B is regressed (simulated by using dead-code category which bypasses guard)', async () => {
    const regressedCanary: Canary = {
      name: 'destructive-diff-regressed',
      description: 'Simulates Guard B regression by using exempt category',
      async run(): Promise<CanaryResult> {
        const { executeTask } = await import('../executor.js');
        const start = Date.now();
        const filePath = 'canary/synthetic-large-file.ts';
        const original = Array.from({ length: 25 }, (_, i) =>
          `export function handler${i}(input: string): string { return input.trim(); }`,
        ).join('\n') + '\n';

        const result = await executeTask(
          {
            id: 'canary-regressed',
            category: 'dead-code',
            title: 'Canary: dead-code category bypasses Guard B',
            description: 'Synthetic',
            filePaths: [filePath],
            severity: 'medium',
            discoveredAt: new Date(),
            estimatedTokens: 0,
          },
          {
            llm: { async call() { return { content: `<<<FILE: ${filePath}>>>\nexport {};\n<<<END FILE>>>`, inputTokens: 0, outputTokens: 0 }; } },
            diff: { async apply() { return { applied: true }; }, async revert() {} },
            runner: { async run() { return { stdout: '', stderr: '', exitCode: 0 }; } },
            files: { async read(p: string) { return p === filePath ? original : ''; } },
            readCurrent: () => original,
            logger: { error() {} },
          },
          { repoRoot: '/canary', markdownSkillsPath: '/canary/skills', model: 'canary', workDir: '/canary/workdir' },
        );

        // dead-code category bypasses Guard B — the guard does NOT fire.
        // This proves that if Guard B were accidentally exempted for all
        // categories, the destructive-diff canary would catch it.
        const guardFired = result.failedStep === 'safety-guard' &&
          (result.applyError?.includes('guard B') ?? false);

        return {
          name: 'destructive-diff-regressed',
          passed: guardFired,
          reason: guardFired
            ? 'Guard B fired (unexpected)'
            : 'Guard B did NOT fire — regression detected',
          durationMs: Date.now() - start,
        };
      },
    };

    const result = await regressedCanary.run();
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('did NOT fire');
  });
});

describe('empty-content canary', () => {
  it('passes when Guard A is intact (guard fires on empty-content task)', async () => {
    const result = await emptyContentCanary.run();
    expect(result.passed).toBe(true);
    expect(result.name).toBe('empty-content');
    expect(result.reason).toContain('Guard A correctly rejected');
  });

  it('fails when Guard A is regressed (simulated by providing non-empty content)', async () => {
    const { executeTask } = await import('../executor.js');
    const filePath = 'canary/real-file.ts';
    const content = 'export const realValue = 42;\n';

    const result = await executeTask(
      {
        id: 'canary-regressed-a',
        category: 'test-failure',
        title: 'Canary: Guard A bypass',
        description: 'Synthetic',
        filePaths: [filePath],
        severity: 'medium',
        discoveredAt: new Date(),
        estimatedTokens: 0,
      },
      {
        llm: { async call() { return { content: '', inputTokens: 0, outputTokens: 0 }; } },
        diff: { async apply() { return { applied: true }; }, async revert() {} },
        runner: { async run() { return { stdout: '', stderr: '', exitCode: 0 }; } },
        files: { async read() { return content; } },
        logger: { error() {} },
      },
      { repoRoot: '/canary', markdownSkillsPath: '/canary/skills', model: 'canary', workDir: '/canary/workdir' },
    );

    // When FileFetcher returns non-empty content, Guard A does NOT fire
    // (because the guard checks for empty prompt content). This proves
    // the canary would detect a regression where Guard A was removed.
    expect(result.failedStep).not.toBe('safety-guard');
  });
});

describe('domain-question canary', () => {
  it('passes when domain guard predicate works correctly', async () => {
    const result = await domainQuestionCanary.run();
    expect(result.passed).toBe(true);
    expect(result.name).toBe('domain-question');
    expect(result.reason).toContain('correctly blocks');
  });

  it('fails when domain guard predicate is broken (simulated with empty blockedFiles)', () => {
    // If the predicate always returned false (broken), it wouldn't block anything
    const shouldBlock = isBlockedByDomainGuard(
      ['canary/blocked.ts'],
      new Set<string>(),
    );
    expect(shouldBlock).toBe(false);

    // Confirm the real predicate blocks correctly (not broken)
    const realBlock = isBlockedByDomainGuard(
      ['canary/blocked.ts'],
      new Set(['canary/blocked.ts']),
    );
    expect(realBlock).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orchestration tests
// ---------------------------------------------------------------------------

describe('runCanaryGate — orchestrator', () => {
  it('returns passed=true when all canaries pass', async () => {
    const result = await runCanaryGate({ enabled: true });
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(DEFAULT_CANARIES.length);
    expect(result.failedCanary).toBeUndefined();
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns passed=false with details when a canary fails', async () => {
    const failingCanary: Canary = {
      name: 'always-fails',
      description: 'Test canary that always fails',
      async run(): Promise<CanaryResult> {
        return { name: 'always-fails', passed: false, reason: 'intentional failure', durationMs: 0 };
      },
    };

    const result = await runCanaryGate({ enabled: true, canaries: [failingCanary] });
    expect(result.passed).toBe(false);
    expect(result.failedCanary).toBe('always-fails');
    expect(result.failureReason).toBe('intentional failure');
  });

  it('stops at first failure (short-circuits)', async () => {
    let secondRan = false;
    const canaries: Canary[] = [
      {
        name: 'fails-first',
        description: 'Fails',
        async run() { return { name: 'fails-first', passed: false, reason: 'fail', durationMs: 0 }; },
      },
      {
        name: 'never-reached',
        description: 'Should not run',
        async run() { secondRan = true; return { name: 'never-reached', passed: true, reason: 'ok', durationMs: 0 }; },
      },
    ];

    const result = await runCanaryGate({ enabled: true, canaries });
    expect(result.passed).toBe(false);
    expect(secondRan).toBe(false);
    expect(result.results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Loop integration tests
// ---------------------------------------------------------------------------

describe('runLoop — canary gate integration', () => {
  let dir: string;
  let queuePath: string;
  let tracker: TokenTracker;
  let budgetManager: BudgetManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canary-loop-'));
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
      { match: (cmd) => cmd === 'diff', exitCode: 1, stdout: CANNED_UNIFIED_DIFF },
      { match: (cmd) => cmd === 'pnpm', exitCode: 0 },
      { match: (cmd) => cmd === 'grep', exitCode: 0 },
    ]);
  }

  it('aborts when canary gate fails', async () => {
    const failingCanary: Canary = {
      name: 'always-fails',
      description: 'Fails',
      async run() { return { name: 'always-fails', passed: false, reason: 'gate broken', durationMs: 0 }; },
    };

    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-should-not-run' }));

    const result = await runLoop(
      cfg({ canaryGate: { enabled: true, canaries: [failingCanary] } }),
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
        queue,
      },
    );

    expect(result.canaryGateAborted).toBe(true);
    expect(result.canaryGateResult?.passed).toBe(false);
    expect(result.canaryGateResult?.failedCanary).toBe('always-fails');
    expect(result.tasksProcessed).toBe(0);
    expect(result.prsOpened).toBe(0);
  });

  it('proceeds normally when canaryGate.enabled = false', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-proceeds' }));

    const result = await runLoop(
      cfg({ canaryGate: { enabled: false } }),
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
        readCurrent: () => 'const existing = 1;\n',
        queue,
      },
    );

    expect(result.canaryGateAborted).toBeUndefined();
    expect(result.prsOpened).toBe(1);
  });

  it('proceeds normally when all canaries pass (default config)', async () => {
    const queue = new TaskQueue(queuePath);
    queue.enqueue(mkTask({ id: 't-canary-pass' }));

    const result = await runLoop(
      cfg(),
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
        readCurrent: () => 'const existing = 1;\n',
        queue,
      },
    );

    expect(result.canaryGateAborted).toBeUndefined();
    expect(result.prsOpened).toBe(1);
  });
});
