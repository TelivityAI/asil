/**
 * Kill switch.
 *
 * Out-of-band safety net for runaway agents. `sweep()` walks every
 * active budget, asks the BudgetManager for its verdict, and terminates
 * any task the manager says to kill. `killAll()` is the panic button
 * — fires when daily spend crosses a hard ceiling, when Dušan hits
 * a global kill, or when the process shuts down mid-task.
 *
 * Kills are logged (in-memory + any caller-supplied sink) so Reporter
 * can surface them in the daily digest.
 */
import { Decimal } from 'decimal.js';
import type { BudgetManager } from './budget-manager.js';
import type { TokenTracker } from './token-tracker.js';

export interface KillEvent {
  taskId: string;
  reason: string;
  /** Decimal-serialized. */
  costAtKill: string;
  timestamp: Date;
}

export class KillSwitch {
  private readonly killLog: KillEvent[] = [];

  constructor(
    private readonly tracker: TokenTracker,
    private readonly budgetManager: BudgetManager,
  ) {}

  /** Scan every active task and kill any the BudgetManager flags. */
  sweep(reasonPrefix = 'sweep'): KillEvent[] {
    const killed: KillEvent[] = [];
    for (const budget of this.budgetManager.listActiveBudgets()) {
      const verdict = this.budgetManager.check(budget.taskId);
      if (!verdict.allowed && verdict.recommendation === 'kill') {
        killed.push(
          this.performKill(
            budget.taskId,
            `${reasonPrefix}: ${verdict.reason ?? 'budget exhausted'}`,
          ),
        );
      }
    }
    return killed;
  }

  /** Panic: kill every active task, whatever the budget says. */
  killAll(reason: string): KillEvent[] {
    const killed: KillEvent[] = [];
    for (const budget of this.budgetManager.listActiveBudgets()) {
      killed.push(this.performKill(budget.taskId, reason));
    }
    return killed;
  }

  /** Read-only copy of the kill log. */
  getKillLog(): KillEvent[] {
    return [...this.killLog];
  }

  private performKill(taskId: string, reason: string): KillEvent {
    const usage = this.tracker.getTaskUsage(taskId);
    const costAtKill = (usage?.totalCostUsd ?? new Decimal(0)).toString();
    this.tracker.markTask(taskId, 'killed');
    this.budgetManager.release(taskId);
    const event: KillEvent = {
      taskId,
      reason,
      costAtKill,
      timestamp: new Date(),
    };
    this.killLog.push(event);
    return event;
  }
}
