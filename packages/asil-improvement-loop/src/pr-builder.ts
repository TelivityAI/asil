import type {
  AdversarialReviewResult,
  ExecutionResult,
  ImprovementTask,
  SelfReviewResult,
  TaskOutcome,
} from './types.js';

/**
 * GitOperations is the git-adjacent surface the autonomous loop depends
 * on. Under worktree isolation:
 *
 * 1. `createBranch(name)` creates an isolated worktree (a checkout of
 *    `name` rooted under a fresh temp dir). It returns that path. All
 *    file-changing operations for the task happen inside it.
 * 2. `applyDiff` / `commit` / `push` operate on the worktree path — the
 *    user's main checkout is never touched.
 * 3. `createPR` calls `gh pr create` and can run from anywhere.
 * 4. `cleanup(workDir)` MUST be called on every exit path (success,
 *    execution failure, review rejection, PR failure). It removes the
 *    worktree — which both discards any applied diff and frees the
 *    branch from the worktree lock.
 *
 * The no-`git reset --hard` rule exists because the loop used to run in
 * the user's live checkout; a hard reset would wipe their uncommitted
 * work. Worktree isolation removes the need entirely — never reintroduce
 * a destructive reset on the main working tree.
 */
export interface GitOperations {
  /** Create an isolated worktree for `name`. Returns the worktree path. */
  createBranch(name: string): Promise<string>;
  /** Apply a unified diff in the given working directory. */
  applyDiff(diff: string, workDir: string): Promise<boolean>;
  /** Stage & commit all changes in the given working directory. */
  commit(message: string, workDir: string): Promise<void>;
  /** Push `branch` from the given working directory. */
  push(branch: string, workDir: string): Promise<void>;
  /** Create a PR. Runs from anywhere; does not need a workDir. */
  createPR(opts: {
    title: string;
    body: string;
    branch: string;
    base: string;
  }): Promise<string>;
  /** Remove the worktree. Call on EVERY exit path — success or failure. */
  cleanup(workDir: string): Promise<void>;
}

/** Compose the canonical autonomous branch name for a task. Exposed so
 *  the loop can create the worktree under this name before the executor
 *  runs, and the PR builder can commit under the same name. */
export function branchNameFor(task: ImprovementTask): string {
  // Scanner-generated IDs are `${category}-${uuid}` (e.g.
  // "dead-code-a9c1f93b-09fd-40df-..."). Slicing the first 8 chars of
  // the raw id yields "dead-cod" for EVERY dead-code task — making
  // every branch identical, the second push failing as non-fast-forward
  // against the first task's commit. Strip the category prefix so the
  // slug is the UUID's first 8 hex chars (≈4 billion collision space
  // per category, fine for a single run's needs).
  const prefix = `${task.category}-`;
  const uuid = task.id.startsWith(prefix)
    ? task.id.slice(prefix.length)
    : task.id;
  return `auto/${task.category}/${uuid.slice(0, 8)}`;
}

export async function buildAndOpenPR(
  task: ImprovementTask,
  execution: ExecutionResult,
  self: SelfReviewResult,
  adversarial: AdversarialReviewResult,
  git: GitOperations,
  workDir: string,
  base = 'main',
): Promise<TaskOutcome> {
  const branch = branchNameFor(task);
  const commitMsg = `auto(${task.category}): ${task.title}`;

  // The executor already applied the diff in the worktree (and verified
  // typecheck + tests). PR builder commits whatever is in the tree — no
  // re-apply needed. If we tried to re-apply, `git apply --check` would
  // fail because the changes are already present.
  let stage: 'commit' | 'push' | 'create-pr' = 'commit';
  try {
    await git.commit(commitMsg, workDir);
    stage = 'push';
    await git.push(branch, workDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`\n[pr-builder] ✖ ${stage} failed for task ${task.id}`);
    console.error(`             branch:  ${branch}`);
    console.error(`             workDir: ${workDir}`);
    console.error(`             reason:  ${reason}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    return {
      taskId: task.id,
      status: 'execution-failed',
      totalTokenUsage: execution.tokenUsage,
      completedAt: new Date(),
      selfReview: self,
      adversarialReview: adversarial,
      prBranch: branch,
      failureReason: `${stage} failed: ${reason}`,
    } satisfies TaskOutcome;
  }

  let prUrl: string;
  try {
    const body = buildPRBody(task, execution, self, adversarial);
    prUrl = await git.createPR({ title: commitMsg, body, branch, base });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`\n[pr-builder] ✖ create-pr failed for task ${task.id}`);
    console.error(`             branch:  ${branch}`);
    console.error(`             workDir: ${workDir}`);
    console.error(`             reason:  ${reason}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    return {
      taskId: task.id,
      status: 'execution-failed',
      totalTokenUsage: execution.tokenUsage,
      completedAt: new Date(),
      selfReview: self,
      adversarialReview: adversarial,
      prBranch: branch,
      failureReason: `gh pr create failed: ${reason}`,
    } satisfies TaskOutcome;
  }

  return {
    taskId: task.id,
    status: 'pr-opened',
    prUrl,
    prBranch: branch,
    selfReview: self,
    adversarialReview: adversarial,
    totalTokenUsage: execution.tokenUsage,
    completedAt: new Date(),
  };
}

export function buildPRBody(
  task: ImprovementTask,
  execution: ExecutionResult,
  self: SelfReviewResult,
  adversarial: AdversarialReviewResult,
): string {
  const lines: string[] = [];

  lines.push(`## Autonomous Improvement — ${task.category}`);
  lines.push('');
  lines.push(`**Task:** ${task.title}`);
  lines.push(
    `**Category:** ${task.category} | **Severity:** ${task.severity}`,
  );
  lines.push(`**Files:** ${task.filePaths.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('### What changed');
  lines.push(task.description);
  lines.push('');
  lines.push('### Checks');
  lines.push(`- Typecheck: ${execution.typeCheckPassed ? 'PASS' : 'FAIL'}`);
  lines.push(`- Tests: ${execution.testsPassed ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('### Self-Review');
  for (const review of self.reviews) {
    lines.push(
      `- **${review.persona}:** ${review.approved ? 'APPROVED' : 'REJECTED'}`,
    );
    if (review.concerns.length > 0) {
      lines.push(`  - Concerns: ${review.concerns.join('; ')}`);
    }
  }
  lines.push('');
  lines.push('### Adversarial Review (Codex)');
  lines.push(
    `- **Result:** ${adversarial.approved ? 'APPROVED' : 'REJECTED'} (${adversarial.severity})`,
  );
  lines.push(`- **Reasoning:** ${adversarial.reasoning}`);
  if (adversarial.issuesFound.length > 0) {
    lines.push(`- **Issues:** ${adversarial.issuesFound.join('; ')}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('*Generated by System A (Autonomous Improvement Loop)*');

  return lines.join('\n');
}
