import {
  BudgetManager,
  CostCheckpoint,
  TokenTracker,
} from 'asil-cost-controller';
import { TaskQueue } from './task-queue.js';
import { scanCodebase } from './scanner.js';
import { executeTask } from './executor.js';
import { selfReview } from './self-review.js';
import { adversarialReview } from './adversarial-gate.js';
import { branchNameFor, buildAndOpenPR } from './pr-builder.js';
import { CycleDetector } from './cycle-detector.js';
import {
  buildDomainAnswerContext,
  type DomainAnswerStore,
} from './domain-questions.js';
import type {
  CodexCaller,
  ImprovementLoopConfig,
  LLMCaller,
  TaskOutcome,
} from './types.js';
import type { CommandRunner, FileReader } from './scanner.js';
import type { DiffApplier, FileFetcher } from './executor.js';
import type { GitOperations } from './pr-builder.js';

export interface LoopDeps {
  llm: LLMCaller;
  codex: CodexCaller;
  git: GitOperations;
  tracker: TokenTracker;
  budgetManager: BudgetManager;
  runner: CommandRunner;
  fileReader: FileReader;
  fileFetcher: FileFetcher;
  diff: DiffApplier;
  /** Optional: override the queue (useful for tests). */
  queue?: TaskQueue;
  /** Optional: override the cycle detector (useful for tests). */
  cycleDetector?: CycleDetector;
  /** Optional: override filesystem read for buildPatchFromFiles (tests). */
  readCurrent?: (absPath: string) => string | null;
  /**
   * Files (repo-relative) the loop must NOT touch this run because they
   * carry unresolved `// DOMAIN_QUESTION:` markers OR the operator
   * skipped them during triage. Tasks whose `filePaths` overlap with
   * this set are dropped from the queue at the start of the run.
   */
  blockedFiles?: ReadonlySet<string>;
  /**
   * Domain answer store. Used to (a) inject prior decisions as context
   * into executor LLM calls and (b) skip files whose questions have
   * already been answered (those don't need to block the loop).
   */
  domainAnswerStore?: DomainAnswerStore;
}

export interface LoopResult {
  tasksProcessed: number;
  outcomes: TaskOutcome[];
  prsOpened: number;
  rejected: number;
  budgetExhausted: boolean;
  cyclesDetected: number;
}

export async function runLoop(
  config: ImprovementLoopConfig,
  deps: LoopDeps,
): Promise<LoopResult> {
  const queue = deps.queue ?? new TaskQueue(config.queuePath);
  const cycleDetector = deps.cycleDetector ?? new CycleDetector();
  const outcomes: TaskOutcome[] = [];
  let cyclesDetected = 0;
  let budgetExhausted = false;

  // 1. Scan for new tasks. Scanning reads the real repo — it's
  //    read-only, so no worktree needed here.
  const scan = await scanCodebase(config.repoRoot, {
    runner: deps.runner,
    fs: deps.fileReader,
  });
  const blocked = deps.blockedFiles ?? new Set<string>();
  for (const task of scan.tasks) {
    if (config.skipCategories.includes(task.category)) continue;
    // Drop tasks that touch files with unresolved/skipped domain
    // questions — making code decisions in files Dušan hasn't decided
    // about would just add noise.
    if (task.filePaths.some((p) => blocked.has(p))) continue;
    queue.enqueue(task);
  }

  // 2. Process up to maxTasksPerRun.
  for (let i = 0; i < config.maxTasksPerRun; i += 1) {
    const item = queue.dequeue();
    if (!item) break;

    const task = item.task;

    // Skip categories applies to queued tasks too, not just new scan results.
    if (config.skipCategories.includes(task.category)) {
      queue.complete(task.id, 'skipped', 'category skipped by config');
      i -= 1; // Don't count skipped tasks against maxTasksPerRun.
      continue;
    }

    // Cycle detection.
    const cycleCheck = cycleDetector.wouldCycle(task.category, task.filePaths);
    if (cycleCheck.isCycle) {
      queue.complete(task.id, 'skipped', cycleCheck.reason);
      cyclesDetected += 1;
      outcomes.push({
        taskId: task.id,
        status: 'cycle-skipped',
        totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
        completedAt: new Date(),
      });
      continue;
    }

    // Budget allocation.
    const budget = deps.budgetManager.allocate(
      task.id,
      'A',
      task.category,
      config.executionModel,
    );
    if (!budget) {
      outcomes.push({
        taskId: task.id,
        status: 'budget-exceeded',
        totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
        completedAt: new Date(),
      });
      queue.complete(task.id, 'failed', 'Budget exhausted');
      budgetExhausted = true;
      break;
    }

    const checkpoint = new CostCheckpoint({
      taskId: task.id,
      systemId: 'A',
      agentId: `executor-${task.category}`,
      tracker: deps.tracker,
      budgetManager: deps.budgetManager,
      checkpointInterval: budget.checkpointIntervalTokens,
    });

    // 3. Create an isolated worktree for this task. All mutations happen
    //    inside it; the user's live checkout is never touched. The
    //    `finally` block guarantees cleanup on every exit path.
    const branchName = branchNameFor(task);
    let workDir: string;
    try {
      workDir = await deps.git.createBranch(branchName);
    } catch (err) {
      // Surface the actual error — silent "execution-failed" outcomes
      // are useless when debugging why the grind isn't making progress.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `\n[loop] ✖ worktree creation failed for task ${task.id} (${task.category})`,
      );
      console.error(`       branch:  ${branchName}`);
      console.error(`       error:   ${msg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      checkpoint.kill('worktree creation failed');
      queue.complete(
        task.id,
        'failed',
        `worktree creation failed: ${msg}`,
      );
      outcomes.push({
        taskId: task.id,
        status: 'execution-failed',
        totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
        completedAt: new Date(),
      });
      continue;
    }

    try {
      // 3b. Install dependencies in the worktree so typecheck + tests work.
      //     Without this the clone has no node_modules and every tsc/vitest
      //     call fails with "Cannot find module" errors.
      const installResult = await deps.runner.run(
        'pnpm',
        ['install', '--frozen-lockfile'],
        { cwd: workDir },
      );
      if (installResult.exitCode !== 0) {
        console.error(
          `\n[loop] ✖ pnpm install failed in worktree for task ${task.id}`,
        );
        console.error(`       stderr: ${installResult.stderr.slice(0, 500)}`);
      }

      // 3c. Build workspace packages so their dist/ entries are resolvable.
      //     Without this, vitest can't resolve asil-* imports because
      //     the packages export from dist/index.js (built by tsup).
      const buildResult = await deps.runner.run(
        'pnpm',
        ['run', '-r', 'build'],
        { cwd: workDir },
      );
      if (buildResult.exitCode !== 0) {
        console.error(
          `\n[loop] ✖ pnpm build failed in worktree for task ${task.id}`,
        );
        console.error(`       stderr: ${buildResult.stderr.slice(0, 500)}`);
      }

      // Pre-build the domain context section for this task. Empty
      // string when nothing applies — executor treats falsy as "skip".
      const domainContext = deps.domainAnswerStore
        ? buildDomainAnswerContext(task.filePaths, deps.domainAnswerStore)
        : '';

      // 4. Execute inside the worktree.
      const execution = await executeTask(
        task,
        {
          llm: deps.llm,
          diff: deps.diff,
          runner: deps.runner,
          files: deps.fileFetcher,
          ...(deps.readCurrent ? { readCurrent: deps.readCurrent } : {}),
          ...(domainContext ? { domainContext } : {}),
        },
        {
          repoRoot: config.repoRoot,
          markdownSkillsPath: config.markdownSkillsPath,
          model: config.executionModel,
          workDir,
        },
      );

      const budgetCheck = checkpoint.recordAndCheck(
        execution.tokenUsage.inputTokens,
        execution.tokenUsage.outputTokens,
        config.executionModel,
      );

      if (!execution.success) {
        checkpoint.kill(execution.applyError ?? 'Execution failed');
        queue.complete(
          task.id,
          'failed',
          execution.applyError ?? 'Execution failed',
        );
        outcomes.push({
          taskId: task.id,
          status: 'execution-failed',
          totalTokenUsage: execution.tokenUsage,
          completedAt: new Date(),
        });
        continue;
      }

      if (budgetCheck.recommendation === 'kill') {
        checkpoint.kill('Budget exceeded after execution');
        queue.complete(task.id, 'failed', 'Budget exceeded');
        outcomes.push({
          taskId: task.id,
          status: 'budget-exceeded',
          totalTokenUsage: execution.tokenUsage,
          completedAt: new Date(),
        });
        budgetExhausted = true;
        break;
      }

      // 5. Self-review.
      const review = await selfReview(execution, deps.llm, config.reviewModel);

      if (review.recommendation === 'reject') {
        checkpoint.complete();
        // Rejected → `failed` so maxAttempts retries can still kick in.
        // Previously this was accidentally marked `completed`, which
        // permanently closed tasks that never shipped.
        queue.complete(
          task.id,
          'failed',
          `Self-review rejected: ${review.aggregatedConcerns.join('; ')}`,
        );
        outcomes.push({
          taskId: task.id,
          status: 'rejected-self-review',
          selfReview: review,
          totalTokenUsage: execution.tokenUsage,
          completedAt: new Date(),
        });
        continue;
      }

      // 6. Adversarial gate.
      const adversarial = await adversarialReview(
        execution,
        review,
        deps.codex,
        config.codexConfig.model,
      );

      if (!adversarial.approved) {
        checkpoint.complete();
        // Rejected → `failed`, same reasoning as self-review path.
        queue.complete(
          task.id,
          'failed',
          `Adversarial review rejected: ${adversarial.reasoning}`,
        );
        outcomes.push({
          taskId: task.id,
          status: 'rejected-adversarial',
          selfReview: review,
          adversarialReview: adversarial,
          totalTokenUsage: execution.tokenUsage,
          completedAt: new Date(),
        });
        continue;
      }

      // 7. All gates passed — commit + push from the worktree + open PR.
      const outcome = await buildAndOpenPR(
        task,
        execution,
        review,
        adversarial,
        deps.git,
        workDir,
      );
      checkpoint.complete();

      if (outcome.status === 'pr-opened') {
        // Only mark completed when the PR actually opened. A silent
        // failure in commit/push/create used to be mis-marked completed.
        queue.complete(task.id, 'completed');
        cycleDetector.record(task.id, task.category, task.filePaths);
      } else {
        // Use the actual reason captured by buildAndOpenPR (commit/push/
        // gh pr create error message) instead of the generic placeholder.
        queue.complete(
          task.id,
          'failed',
          outcome.failureReason ?? 'PR build failed',
        );
      }
      outcomes.push(outcome);

      if (config.taskCooldownMs > 0 && i < config.maxTasksPerRun - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.taskCooldownMs),
        );
      }
    } catch (err) {
      // Catch-all for anything the individual steps did not handle —
      // LLM outages, git push auth failures, supabase hiccups, etc.
      // Without this the exception bubbles out and kills the whole run
      // silently under the CLI's outer catch. Print the full stack so
      // the root cause is visible.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `\n[loop] ✖ unexpected failure processing task ${task.id} (${task.category})`,
      );
      console.error(`       workDir: ${workDir}`);
      console.error(`       error:   ${msg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      checkpoint.kill(`unexpected: ${msg}`);
      queue.complete(task.id, 'failed', `unexpected: ${msg}`);
      outcomes.push({
        taskId: task.id,
        status: 'execution-failed',
        totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
        completedAt: new Date(),
      });
    } finally {
      // Non-negotiable: every exit path tears down the worktree. A
      // leaked worktree accumulates across runs and eventually breaks
      // `git worktree add` for the same branch name.
      try {
        await deps.git.cleanup(workDir);
      } catch {
        // Swallow — cleanup best-effort; surfacing here would mask the
        // primary failure reason we already recorded above.
      }
    }
  }

  return {
    tasksProcessed: outcomes.length,
    outcomes,
    prsOpened: outcomes.filter((o) => o.status === 'pr-opened').length,
    rejected: outcomes.filter((o) => o.status.startsWith('rejected')).length,
    budgetExhausted,
    cyclesDetected,
  };
}
