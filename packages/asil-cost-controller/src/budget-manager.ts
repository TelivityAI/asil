/**
 * Budget manager — the system's brain.
 *
 * Decides whether a task can start (allocate), how much budget it gets,
 * and when it should stop (check). Wraps all the daily/system/concurrent
 * guardrails in one place so neither the agents nor the checkpoint layer
 * need to re-implement that logic.
 *
 * All dollar math uses Decimal. The `reservePercent` is a hard floor
 * — even with an otherwise-valid allocation, the daily spend can't push
 * past `(100 − reservePercent) %` of the daily limit.
 */
import { Decimal } from 'decimal.js';
import type {
  BudgetCheck,
  GlobalBudget,
  ModelTier,
  SystemId,
  TaskBudget,
} from './types.js';
import type { TokenTracker } from './token-tracker.js';
import { estimateTaskCost } from './cost-estimator.js';

export const DEFAULT_GLOBAL_BUDGET: GlobalBudget = {
  dailyLimitUsd: new Decimal('20'),
  defaultTaskLimitUsd: new Decimal('2'),
  maxConcurrentTasks: 5,
  reservePercent: 15,
  systemLimits: {
    A: new Decimal('10'),
    B: new Decimal('8'),
    C: new Decimal('2'),
  },
};

const DEFAULT_CHECKPOINT_INTERVAL_TOKENS = 10_000;
const TASK_BUDGET_TTL_MS = 30 * 60 * 1000; // 30 min
const WRAP_UP_RATIO = 0.8;

export interface AllocationOptions {
  /** Override the default 30-minute expiry. */
  ttlMs?: number;
  /** Override the default 10k-token checkpoint interval. */
  checkpointIntervalTokens?: number;
}

export class BudgetManager {
  private readonly activeBudgets: Map<string, TaskBudget> = new Map();

  constructor(
    private readonly tracker: TokenTracker,
    private readonly config: GlobalBudget = DEFAULT_GLOBAL_BUDGET,
  ) {}

  /**
   * Request a budget for a new task. Returns `null` when:
   *   - daily limit (minus reserve) is exhausted
   *   - system limit for this systemId is exhausted
   *   - concurrent-task cap is already at the max
   *
   * The returned TaskBudget captures the allocation — the caller MUST
   * call `release(taskId)` on completion (or rely on `expires` for GC).
   */
  allocate(
    taskId: string,
    systemId: SystemId,
    taskType: string,
    model: ModelTier,
    options: AllocationOptions = {},
  ): TaskBudget | null {
    const todaySpend = this.tracker.getTodaySpend();
    const effectiveLimit = this.config.dailyLimitUsd.times(
      new Decimal(100 - this.config.reservePercent).div(100),
    );
    if (todaySpend.gte(effectiveLimit)) return null;

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const systemSpend = this.tracker.getSpendBySystem(start, new Date());
    if (systemSpend[systemId].gte(this.config.systemLimits[systemId])) return null;

    const activeRunning = this.countActiveTasks();
    if (activeRunning >= this.config.maxConcurrentTasks) return null;

    const estimate = estimateTaskCost(taskType, model);
    const remainingDaily = effectiveLimit.minus(todaySpend);
    const remainingSystem = this.config.systemLimits[systemId].minus(systemSpend[systemId]);
    const taskCostCap = Decimal.min(
      this.config.defaultTaskLimitUsd,
      remainingDaily,
      remainingSystem,
    );

    // If the cap ends up ≤ 0 we don't allocate — a zero-budget allocation
    // would be a pathological "allowed" that immediately kills on first
    // checkpoint. Reject up front.
    if (taskCostCap.lte(0)) return null;

    const budget: TaskBudget = {
      taskId,
      systemId,
      // 2× estimate as the hard ceiling — agents sometimes run hot.
      maxInputTokens: estimate.estimatedInputTokens * 2,
      maxOutputTokens: estimate.estimatedOutputTokens * 2,
      maxCostUsd: taskCostCap,
      checkpointIntervalTokens:
        options.checkpointIntervalTokens ?? DEFAULT_CHECKPOINT_INTERVAL_TOKENS,
      allocated: new Date(),
      expires: new Date(Date.now() + (options.ttlMs ?? TASK_BUDGET_TTL_MS)),
    };
    this.activeBudgets.set(taskId, budget);
    return budget;
  }

  /** Check a running task. Called at each checkpoint. */
  check(taskId: string): BudgetCheck {
    const budget = this.activeBudgets.get(taskId);
    if (!budget) {
      return { allowed: false, reason: 'No budget allocated for this task' };
    }

    if (new Date() > budget.expires) {
      return { allowed: false, reason: 'Task budget expired', recommendation: 'kill' };
    }

    const usage = this.tracker.getTaskUsage(taskId);
    if (!usage) {
      // No usage yet — full budget remains.
      return {
        allowed: true,
        remainingUsd: budget.maxCostUsd,
        remainingTokens: budget.maxInputTokens,
        recommendation: 'continue',
      };
    }

    if (usage.totalCostUsd.gte(budget.maxCostUsd)) {
      return {
        allowed: false,
        reason: `Cost $${usage.totalCostUsd.toFixed(4)} exceeds budget $${budget.maxCostUsd.toFixed(4)}`,
        recommendation: 'kill',
      };
    }

    if (
      usage.totalInputTokens >= budget.maxInputTokens ||
      usage.totalOutputTokens >= budget.maxOutputTokens
    ) {
      return {
        allowed: false,
        reason: 'Token limit exceeded',
        recommendation: 'kill',
      };
    }

    const costRatio = usage.totalCostUsd.div(budget.maxCostUsd).toNumber();
    const remainingUsd = budget.maxCostUsd.minus(usage.totalCostUsd);
    const remainingTokens = Math.max(0, budget.maxInputTokens - usage.totalInputTokens);

    if (costRatio >= WRAP_UP_RATIO) {
      return { allowed: true, remainingUsd, remainingTokens, recommendation: 'wrap_up' };
    }
    return { allowed: true, remainingUsd, remainingTokens, recommendation: 'continue' };
  }

  /** Release a task's budget (on completion or kill). */
  release(taskId: string): void {
    this.activeBudgets.delete(taskId);
  }

  /** Read-only snapshot of every active budget. Used by the kill switch. */
  listActiveBudgets(): TaskBudget[] {
    return Array.from(this.activeBudgets.values());
  }

  /** Overall utilization summary — powers the reporter. */
  getUtilization(): {
    dailySpend: Decimal;
    dailyLimit: Decimal;
    utilization: number;
    activeTasks: number;
    maxTasks: number;
  } {
    const dailySpend = this.tracker.getTodaySpend();
    return {
      dailySpend,
      dailyLimit: this.config.dailyLimitUsd,
      utilization: dailySpend.div(this.config.dailyLimitUsd).toNumber(),
      activeTasks: this.countActiveTasks(),
      maxTasks: this.config.maxConcurrentTasks,
    };
  }

  private countActiveTasks(): number {
    let n = 0;
    for (const b of this.activeBudgets.values()) {
      const u = this.tracker.getTaskUsage(b.taskId);
      if (!u || u.status === 'running') n += 1;
    }
    return n;
  }
}
