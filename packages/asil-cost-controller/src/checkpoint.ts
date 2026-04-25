/**
 * Checkpoint middleware.
 *
 * The agent-facing API. Every agent creates one `CostCheckpoint` per task
 * and calls `recordAndCheck()` after every API call. The checkpoint
 * batches budget evaluation — it only asks the BudgetManager every N
 * tokens (default 10k) so the check itself doesn't become the overhead.
 *
 * `forceCheck()` is the escape hatch: call it before an expensive
 * operation (e.g. an Opus invocation) to get an immediate verdict.
 */
import type { BudgetCheck, ModelTier, SystemId, TokenUsage } from './types.js';
import type { BudgetManager } from './budget-manager.js';
import type { TokenTracker } from './token-tracker.js';

const DEFAULT_CHECKPOINT_INTERVAL_TOKENS = 10_000;

export interface CostCheckpointOptions {
  taskId: string;
  systemId: SystemId;
  agentId: string;
  tracker: TokenTracker;
  budgetManager: BudgetManager;
  checkpointInterval?: number;
}

export class CostCheckpoint {
  private tokensSinceCheck = 0;
  private readonly interval: number;

  constructor(private readonly opts: CostCheckpointOptions) {
    this.interval = opts.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL_TOKENS;
  }

  /** Record an API call's usage and check if we should continue. */
  recordAndCheck(
    inputTokens: number,
    outputTokens: number,
    model: ModelTier,
    extras: Pick<TokenUsage, 'cacheCreationTokens' | 'cacheReadTokens'> = {},
  ): BudgetCheck {
    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      ...(extras.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: extras.cacheCreationTokens }
        : {}),
      ...(extras.cacheReadTokens !== undefined
        ? { cacheReadTokens: extras.cacheReadTokens }
        : {}),
      model,
      timestamp: new Date(),
      agentId: this.opts.agentId,
      taskId: this.opts.taskId,
      systemId: this.opts.systemId,
    };
    this.opts.tracker.record(usage);
    this.tokensSinceCheck += inputTokens + outputTokens;

    if (this.tokensSinceCheck >= this.interval) {
      this.tokensSinceCheck = 0;
      return this.opts.budgetManager.check(this.opts.taskId);
    }
    // Below the checkpoint interval — skip the budget eval and let the
    // caller continue. Callers wanting a forced check call forceCheck().
    return { allowed: true, recommendation: 'continue' };
  }

  /** Force a budget check regardless of the interval. */
  forceCheck(): BudgetCheck {
    this.tokensSinceCheck = 0;
    return this.opts.budgetManager.check(this.opts.taskId);
  }

  /** Mark the task complete + release its budget allocation. */
  complete(): void {
    this.opts.tracker.markTask(this.opts.taskId, 'completed');
    this.opts.budgetManager.release(this.opts.taskId);
  }

  /** Mark the task killed + release. `_reason` is stored in the kill log
   *  by the kill switch; the tracker only records the terminal status. */
  kill(_reason?: string): void {
    this.opts.tracker.markTask(this.opts.taskId, 'killed');
    this.opts.budgetManager.release(this.opts.taskId);
  }
}
