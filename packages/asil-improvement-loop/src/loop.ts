import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  BudgetManager,
  CostCheckpoint,
  TokenTracker,
  type ModelTier,
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
import { runCanaryGate } from './canary-gate.js';
import { isInsideRoot } from './paths.js';
import type {
  CanaryGateResult,
  CodexCaller,
  ImprovementLoopConfig,
  LLMCaller,
  TaskOutcome,
} from './types.js';
import type { CommandRunner, FileReader } from './scanner.js';
import type { DiffApplier, FileFetcher } from './executor.js';
import type { LanguageProfile } from './language-profile.js';
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
  /**
   * Language profile driving the scanner's commands and parsers.
   * Defaults to `typescriptProfile` (the reference) when omitted, so
   * existing callers don't break. Pass `pythonProfile` (or a custom
   * one) to scan Python codebases.
   */
  profile?: LanguageProfile;
}

export interface LoopResult {
  tasksProcessed: number;
  outcomes: TaskOutcome[];
  prsOpened: number;
  rejected: number;
  budgetExhausted: boolean;
  cyclesDetected: number;
  canaryGateAborted?: boolean;
  canaryGateResult?: CanaryGateResult;
}

/**
 * `pnpm --filter` arguments for the workspace package that contains
 * `filePath` and defines a `build` script. Null when no such package
 * exists, so a patch does not trigger a workspace-wide rebuild.
 */
export function touchedPackageBuildArgs(
  repoRoot: string,
  filePath: string,
): string[] | null {
  const root = resolve(repoRoot);
  let dir = dirname(resolve(root, filePath));
  while (isInsideRoot(root, dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
          scripts?: { build?: unknown };
        };
        if (typeof parsed.scripts?.build === 'string') {
          if (resolve(dir) === root) return ['run', 'build'];
          return ['--filter', `./${relative(root, dir)}`, 'run', 'build'];
        }
      } catch {
        // Keep walking when the manifest is not JSON.
      }
    }
    if (resolve(dir) === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function isBlockedByDomainGuard(
  filePaths: readonly string[],
  blockedFiles: ReadonlySet<string>,
): boolean {
  return filePaths.some((p) => blockedFiles.has(p));
}

export async function runLoop(
  config: ImprovementLoopConfig,
  deps: LoopDeps,
): Promise<LoopResult> {
  // 0. Pre-flight canary gate — verify safety guards haven't regressed.
  if (config.canaryGate?.enabled !== false) {
    const canaryResult = await runCanaryGate(config.canaryGate);
    if (!canaryResult.passed) {
      return {
        tasksProcessed: 0,
        outcomes: [],
        prsOpened: 0,
        rejected: 0,
        budgetExhausted: false,
        cyclesDetected: 0,
        canaryGateAborted: true,
        canaryGateResult: canaryResult,
      };
    }
  }

  const queue =
    deps.queue ??
    new TaskQueue(config.queuePath, {
      maxAttempts: config.maxAttempts,
      ...(config.minSeverity ? { minSeverity: config.minSeverity } : {}),
      ...(config.dequeueMode ? { dequeueMode: config.dequeueMode } : {}),
    });
  const cycleDetector = deps.cycleDetector ?? new CycleDetector();
  const outcomes: TaskOutcome[] = [];
  let cyclesDetected = 0;
  let budgetExhausted = false;
  // Tasks verified but not published. They are ineligible for the rest
  // of this run, then returned to the queue so --apply can publish them
  // later without consuming an attempt.
  const deferredPublish: string[] = [];

  // 1. Scan for new tasks. Grind points repoRoot at the scratch clone.
  const scan = await scanCodebase(
    config.repoRoot,
    { runner: deps.runner, fs: deps.fileReader },
    deps.profile,
    {
      ...(config.scanCategories ? { categories: config.scanCategories } : {}),
      sequential: config.scanSequential === true,
    },
  );
  const blocked = deps.blockedFiles ?? new Set<string>();
  for (const task of scan.tasks) {
    if (config.skipCategories.includes(task.category)) continue;
    if (isBlockedByDomainGuard(task.filePaths, blocked)) continue;
    queue.enqueue(task);
  }

  // 2. Install and build once in the clone, before any task runs.
  //    Later tasks reuse that node_modules. A patch rebuilds only the
  //    package it edits.
  const restoreBuild: { args: string[] | null } = { args: null };
  if (hasRunnableTask(queue, config.skipCategories)) {
    const boot = await installWorkspace(config.repoRoot, deps.runner);
    if (!boot.ok) {
      return {
        tasksProcessed: 0,
        outcomes: [
          {
            taskId: 'workspace-install',
            status: 'infra-failed',
            totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
            completedAt: new Date(),
            failureReason: boot.reason,
          },
        ],
        prsOpened: 0,
        rejected: 0,
        budgetExhausted: false,
        cyclesDetected: 0,
      };
    }
  }

  // 3. Process up to maxTasksPerRun.
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

    // 3. Check out this task's branch inside the scratch clone. The
    //    open checkout is never a git write target. Cleanup resets the
    //    clone and leaves node_modules in place.
    const branchName = branchNameFor(task);
    let workDir: string;
    try {
      workDir = await deps.git.createBranch(branchName);
    } catch (err) {
      // Surface the actual error — silent "execution-failed" outcomes
      // are useless when debugging why the grind isn't making progress.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `\n[loop] ✖ branch creation failed for task ${task.id} (${task.category})`,
      );
      console.error(`       branch:  ${branchName}`);
      console.error(`       error:   ${msg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      checkpoint.kill('branch creation failed');
      queue.complete(
        task.id,
        'failed',
        `branch creation failed: ${msg}`,
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
      // The previous task's package build may still be in dist/. Rebuild
      // it against the base checkout before this task edits anything.
      if (restoreBuild.args) {
        await deps.runner.run('pnpm', restoreBuild.args, { cwd: workDir });
      }

      // Pre-build the domain context section for this task. Empty
      // string when nothing applies — executor treats falsy as "skip".
      const domainContext = deps.domainAnswerStore
        ? buildDomainAnswerContext(task.filePaths, deps.domainAnswerStore)
        : '';

      // 4. Execute inside the clone.
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
          onPatchApplied: async (patchedDir, filePath) => {
            const args = touchedPackageBuildArgs(patchedDir, filePath);
            if (!args) return;
            restoreBuild.args = args;
            const rebuilt = await deps.runner.run('pnpm', args, { cwd: patchedDir });
            if (rebuilt.exitCode !== 0) {
              console.error(
                `\n[loop] ✖ package build failed after patch for task ${task.id}`,
              );
              console.error(`       stderr: ${rebuilt.stderr.slice(0, 500)}`);
            }
          },
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

      // Running tally of ALL token spend on this task — executor +
      // self-review + adversarial. Reported in the outcome and used to
      // keep the budget honest (Codex review #2: review/adversarial
      // spend used to be invisible to both the report and the cap).
      const taskTokens = {
        inputTokens: execution.tokenUsage.inputTokens,
        outputTokens: execution.tokenUsage.outputTokens,
      };

      // forceCheck before the self-review fan-out: a task already at the
      // ceiling must not launch three more persona calls.
      if (checkpoint.forceCheck().recommendation === 'kill') {
        checkpoint.kill('Budget exceeded before self-review');
        queue.complete(task.id, 'failed', 'Budget exceeded');
        outcomes.push({
          taskId: task.id,
          status: 'budget-exceeded',
          totalTokenUsage: { ...taskTokens },
          completedAt: new Date(),
        });
        budgetExhausted = true;
        break;
      }

      // 5. Self-review.
      const review = await selfReview(execution, deps.llm, config.reviewModel);
      taskTokens.inputTokens += review.tokenUsage.inputTokens;
      taskTokens.outputTokens += review.tokenUsage.outputTokens;
      const reviewCheck = checkpoint.recordAndCheck(
        review.tokenUsage.inputTokens,
        review.tokenUsage.outputTokens,
        config.reviewModel,
      );

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
          totalTokenUsage: { ...taskTokens },
          completedAt: new Date(),
        });
        continue;
      }

      if (reviewCheck.recommendation === 'kill') {
        checkpoint.kill('Budget exceeded after self-review');
        queue.complete(task.id, 'failed', 'Budget exceeded');
        outcomes.push({
          taskId: task.id,
          status: 'budget-exceeded',
          selfReview: review,
          totalTokenUsage: { ...taskTokens },
          completedAt: new Date(),
        });
        budgetExhausted = true;
        break;
      }

      // 6. Adversarial gate.
      const adversarial = await adversarialReview(
        execution,
        review,
        deps.codex,
        config.codexConfig.model,
      );
      taskTokens.inputTokens += adversarial.tokenUsage.inputTokens;
      taskTokens.outputTokens += adversarial.tokenUsage.outputTokens;
      const adversarialCheck = checkpoint.recordAndCheck(
        adversarial.tokenUsage.inputTokens,
        adversarial.tokenUsage.outputTokens,
        // The codex model is a free-form id (e.g. 'gpt-4o'), not a
        // ModelTier. The cost estimator returns $0 for ids absent from
        // the pricing table, so tokens are still tracked even though the
        // wire-cost line is $0. Cast is the localized type bridge.
        config.codexConfig.model as ModelTier,
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
          totalTokenUsage: { ...taskTokens },
          completedAt: new Date(),
        });
        continue;
      }

      if (adversarialCheck.recommendation === 'kill') {
        checkpoint.kill('Budget exceeded after adversarial review');
        queue.complete(task.id, 'failed', 'Budget exceeded');
        outcomes.push({
          taskId: task.id,
          status: 'budget-exceeded',
          selfReview: review,
          adversarialReview: adversarial,
          totalTokenUsage: { ...taskTokens },
          completedAt: new Date(),
        });
        budgetExhausted = true;
        break;
      }

      // 7. All gates passed. Publish only when the caller opted in.
      //    Otherwise leave the task queued. Cleanup resets the clone,
      //    and a later run with --apply can commit and push.
      if (config.openPullRequests === false) {
        console.error(
          `[loop] Gates passed for ${task.id}. No pull request opened. Re-run with --apply to push and open a draft pull request.`,
        );
        checkpoint.complete();
        queue.complete(task.id, 'skipped', 'Awaiting --apply');
        deferredPublish.push(task.id);
        outcomes.push({
          taskId: task.id,
          status: 'publish-skipped',
          selfReview: review,
          adversarialReview: adversarial,
          totalTokenUsage: { ...taskTokens },
          completedAt: new Date(),
          prBranch: branchNameFor(task),
        });
        if (config.taskCooldownMs > 0 && i < config.maxTasksPerRun - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, config.taskCooldownMs),
          );
        }
        continue;
      }

      const outcome = await buildAndOpenPR(
        task,
        execution,
        review,
        adversarial,
        deps.git,
        workDir,
      );
      checkpoint.complete();

      // buildAndOpenPR reports execution-only token usage; replace it
      // with the full task tally (executor + self-review + adversarial)
      // so the success outcome's total matches the budget-accounted
      // spend (Codex review #2).
      outcome.totalTokenUsage = { ...taskTokens };

      if (outcome.status === 'pr-opened') {
        // Only mark completed when the PR actually opened. A silent
        // failure in commit/push/create used to be mis-marked completed.
        queue.complete(task.id, 'completed');
        cycleDetector.record(task.id, task.category, task.filePaths);
      } else if (outcome.status === 'publish-skipped') {
        queue.complete(
          task.id,
          'skipped',
          outcome.failureReason ?? 'branch already exists on origin',
        );
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
      // Reset the clone on every exit path. Cleanup must not delete it:
      // the next task reuses the install. The process removes the clone.
      try {
        await deps.git.cleanup(workDir);
      } catch {
        // Swallow — cleanup best-effort; surfacing here would mask the
        // primary failure reason we already recorded above.
      }
    }
  }

  for (const id of deferredPublish) queue.release(id);

  return {
    tasksProcessed: outcomes.length,
    outcomes,
    prsOpened: outcomes.filter((o) => o.status === 'pr-opened').length,
    rejected: outcomes.filter((o) => o.status.startsWith('rejected')).length,
    budgetExhausted,
    cyclesDetected,
  };
}

function hasRunnableTask(queue: TaskQueue, skip: readonly string[]): boolean {
  return queue.snapshot().some(
    (item) => item.status === 'queued' && !skip.includes(item.task.category),
  );
}

const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
] as const;

/** Fingerprint of the install inputs under `repoRoot`, or null if none. */
export function lockfileFingerprint(repoRoot: string): string | null {
  for (const name of LOCKFILE_NAMES) {
    const path = join(repoRoot, name);
    if (!existsSync(path)) continue;
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    return `${name}:${hash}`;
  }
  const pkg = join(repoRoot, 'package.json');
  if (!existsSync(pkg)) return null;
  const hash = createHash('sha256').update(readFileSync(pkg)).digest('hex');
  return `package.json:${hash}`;
}

export function lockHashMarkerPath(repoRoot: string): string {
  return join(repoRoot, '.asil-scratch', 'lock-hash');
}

/** True when node_modules exists and the lockfile hash matches the marker. */
export function shouldSkipWorkspaceBootstrap(repoRoot: string): boolean {
  if (!existsSync(join(repoRoot, 'node_modules'))) return false;
  const fingerprint = lockfileFingerprint(repoRoot);
  if (!fingerprint) return false;
  const marker = lockHashMarkerPath(repoRoot);
  if (!existsSync(marker)) return false;
  try {
    return readFileSync(marker, 'utf8').trim() === fingerprint;
  } catch {
    return false;
  }
}

function writeLockHashMarker(repoRoot: string): void {
  const fingerprint = lockfileFingerprint(repoRoot);
  if (!fingerprint) return;
  const marker = lockHashMarkerPath(repoRoot);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, fingerprint, 'utf8');
}

async function installWorkspace(
  repoRoot: string,
  runner: CommandRunner,
): Promise<{ ok: true; skipped?: boolean } | { ok: false; reason: string }> {
  if (shouldSkipWorkspaceBootstrap(repoRoot)) {
    console.error(
      '[loop] lockfile unchanged and node_modules present — skipping install and recursive build',
    );
    return { ok: true, skipped: true };
  }

  // --ignore-scripts by default: a target repo's install lifecycle
  // scripts are arbitrary code. Opt back in with
  // ASIL_ALLOW_INSTALL_SCRIPTS=1 when the repository needs them.
  const allowInstallScripts = process.env.ASIL_ALLOW_INSTALL_SCRIPTS === '1';
  const installArgs = allowInstallScripts
    ? ['install', '--frozen-lockfile']
    : ['install', '--frozen-lockfile', '--ignore-scripts'];
  const installResult = await runner.run('pnpm', installArgs, { cwd: repoRoot });
  if (installResult.exitCode !== 0) {
    const stderr = installResult.stderr.slice(0, 500);
    console.error('\n[loop] ✖ pnpm install failed — aborting run (infra failure)');
    console.error(`       stderr: ${stderr}`);
    return { ok: false, reason: `pnpm install failed: ${stderr}` };
  }

  const buildResult = await runner.run('pnpm', ['run', '-r', 'build'], {
    cwd: repoRoot,
  });
  if (buildResult.exitCode !== 0) {
    console.error('\n[loop] ✖ pnpm build failed in the scratch clone');
    console.error(`       stderr: ${buildResult.stderr.slice(0, 500)}`);
  }
  writeLockHashMarker(repoRoot);
  return { ok: true };
}
