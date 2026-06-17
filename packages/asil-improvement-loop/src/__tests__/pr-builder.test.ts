import { describe, expect, it } from 'vitest';
import { branchNameFor, buildAndOpenPR, buildPRBody } from '../pr-builder.js';
import type {
  AdversarialReviewResult,
  ExecutionResult,
  SelfReviewResult,
} from '../types.js';
import { mkTask, mockGit, SAMPLE_DIFF } from './helpers.js';

const execution: ExecutionResult = {
  taskId: 't1',
  success: true,
  diff: SAMPLE_DIFF,
  filesChanged: ['packages/foo/src/foo.ts'],
  testsRun: true,
  testsPassed: true,
  typeCheckPassed: true,
  executionLog: 'ok',
  tokenUsage: { inputTokens: 10, outputTokens: 5 },
};

const self: SelfReviewResult = {
  taskId: 't1',
  reviews: [
    {
      persona: 'code-reviewer',
      approved: true,
      concerns: [],
      suggestions: [],
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      persona: 'security-auditor',
      approved: true,
      concerns: ['watch out for injection'],
      suggestions: [],
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      persona: 'test-engineer',
      approved: true,
      concerns: [],
      suggestions: [],
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
    },
  ],
  allApproved: true,
  aggregatedConcerns: ['watch out for injection'],
  recommendation: 'proceed',
  tokenUsage: { inputTokens: 3, outputTokens: 3 },
};

const adversarial: AdversarialReviewResult = {
  taskId: 't1',
  approved: true,
  reasoning: 'looks ok',
  issuesFound: [],
  severity: 'pass',
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
};

describe('pr-builder', () => {
  it('branchNameFor produces auto/<category>/<id8>', () => {
    expect(
      branchNameFor(
        mkTask({ id: 'abcdef1234567890', category: 'test-failure' }),
      ),
    ).toBe('auto/test-failure/abcdef12');
  });

  it('branchNameFor strips the scanner-style "<category>-" prefix from IDs so each task gets a UNIQUE branch (regression: every dead-code task used to share auto/dead-code/dead-cod)', () => {
    const a = branchNameFor(
      mkTask({
        id: 'dead-code-a9c1f93b-09fd-40df-934f-d4fee10c2863',
        category: 'dead-code',
      }),
    );
    const b = branchNameFor(
      mkTask({
        id: 'dead-code-6b59fab7-9739-4866-84da-1e7a75149350',
        category: 'dead-code',
      }),
    );
    const c = branchNameFor(
      mkTask({
        id: 'dead-code-e45227ff-d7ac-4a93-967d-fcc49e06418c',
        category: 'dead-code',
      }),
    );
    expect(a).toBe('auto/dead-code/a9c1f93b');
    expect(b).toBe('auto/dead-code/6b59fab7');
    expect(c).toBe('auto/dead-code/e45227ff');
    // Three different tasks → three different branches. No collisions.
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('commits + pushes from the worktree and opens the PR (no createBranch/applyDiff call — executor already applied diff in worktree)', async () => {
    const git = mockGit('https://example.com/pr/99');
    const workDir = '/tmp/asil-auto-test-failure-abcdef12';
    const outcome = await buildAndOpenPR(
      mkTask({ id: 'abcdef1234567890', category: 'test-failure' }),
      execution,
      self,
      adversarial,
      git,
      workDir,
    );
    expect(outcome.status).toBe('pr-opened');
    expect(outcome.prUrl).toBe('https://example.com/pr/99');
    expect(outcome.prBranch).toBe('auto/test-failure/abcdef12');
    // Operations happen in the worktree, not the main repoRoot.
    expect(git.operations).toEqual([
      `commit:auto(test-failure): Fix tests@${workDir}`,
      `push:auto/test-failure/abcdef12@${workDir}`,
      'createPR:auto/test-failure/abcdef12',
    ]);
    // PR builder does NOT call applyDiff — the executor already applied
    // the diff inside the worktree during verification.
    expect(git.operations.some((op) => op.startsWith('applyDiff:'))).toBe(false);
    // PR builder does NOT call createBranch — the loop creates the
    // worktree up-front and hands in its path.
    expect(git.operations.some((op) => op.startsWith('createBranch:'))).toBe(
      false,
    );
  });

  it('returns execution-failed when push throws AND captures the underlying error in failureReason', async () => {
    const git = mockGit();
    git.failPush = true;
    const outcome = await buildAndOpenPR(
      mkTask(),
      execution,
      self,
      adversarial,
      git,
      '/tmp/wd',
    );
    expect(outcome.status).toBe('execution-failed');
    expect(outcome.prUrl).toBeUndefined();
    // The failure reason must surface BOTH the stage and the inner
    // error message so the runner's summary tells the user what to fix.
    expect(outcome.failureReason).toMatch(/push failed/);
    expect(outcome.failureReason).toMatch(/push failed:/);
  });

  it('returns execution-failed when createPR throws AND captures the underlying error', async () => {
    const git = mockGit();
    git.failCreatePR = true;
    const outcome = await buildAndOpenPR(
      mkTask(),
      execution,
      self,
      adversarial,
      git,
      '/tmp/wd',
    );
    expect(outcome.status).toBe('execution-failed');
    expect(outcome.prUrl).toBeUndefined();
    expect(outcome.failureReason).toMatch(/gh pr create failed/);
    expect(outcome.failureReason).toMatch(/createPR failed/);
  });

  it('PR body includes task details, check results, and review summaries', () => {
    const body = buildPRBody(mkTask(), execution, self, adversarial);
    expect(body).toContain('Autonomous Improvement');
    expect(body).toContain('code-reviewer');
    expect(body).toContain('security-auditor');
    expect(body).toContain('test-engineer');
    expect(body).toContain('Typecheck: PASS');
    expect(body).toContain('Tests: PASS');
    expect(body).toContain('APPROVED');
    expect(body).toContain('Generated by System A');
  });
});
