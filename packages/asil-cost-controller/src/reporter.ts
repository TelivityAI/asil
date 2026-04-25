/**
 * Usage reporter.
 *
 * Aggregates the token tracker's log into daily / weekly / per-task
 * `UsageReport` payloads and formats them as Markdown for Dušan's
 * review. Pure read-only — never mutates state.
 */
import { Decimal } from 'decimal.js';
import type { TokenTracker } from './token-tracker.js';
import type { BudgetManager } from './budget-manager.js';
import type {
  ModelTier,
  ModelTotals,
  SystemId,
  UsageReport,
} from './types.js';
import { calculateCallCost } from './cost-estimator.js';

const MODELS: ModelTier[] = ['opus', 'sonnet', 'haiku'];
const SYSTEMS: SystemId[] = ['A', 'B', 'C'];

export class UsageReporter {
  constructor(
    private readonly tracker: TokenTracker,
    private readonly budgetManager?: BudgetManager,
  ) {}

  daily(date: Date = new Date()): UsageReport {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return this.buildReport('daily', start, end);
  }

  weekly(weekEndDate: Date = new Date()): UsageReport {
    const end = new Date(weekEndDate);
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    return this.buildReport('weekly', start, end);
  }

  monthly(monthEndDate: Date = new Date()): UsageReport {
    const end = new Date(monthEndDate);
    const start = new Date(end);
    start.setMonth(start.getMonth() - 1);
    return this.buildReport('monthly', start, end);
  }

  /** Single-task report. Returns null if the task id is unknown. */
  task(taskId: string): UsageReport | null {
    const task = this.tracker.getTaskUsage(taskId);
    if (!task) return null;
    return this.buildReport('task', task.startedAt, task.lastCallAt, taskId);
  }

  /** Human-readable summary for Dušan's inbox. */
  formatMarkdown(report: UsageReport, killLog: Array<{ taskId: string; reason: string; costAtKill: string; timestamp: Date }> = []): string {
    const lines: string[] = [];
    lines.push(`# Cost report — ${report.period}`);
    lines.push('');
    lines.push(
      `**Window:** ${report.startDate.toISOString()} → ${report.endDate.toISOString()}`,
    );
    lines.push(`**Total spend:** $${report.totalCostUsd.toFixed(4)}`);
    lines.push(
      `**Budget utilization:** ${(report.budgetUtilization * 100).toFixed(1)}%`,
    );
    lines.push('');

    lines.push('## By system');
    for (const sys of SYSTEMS) {
      lines.push(`- System ${sys}: $${report.bySystem[sys].toFixed(4)}`);
    }
    lines.push('');

    lines.push('## By model');
    for (const model of MODELS) {
      const m = report.byModel[model];
      if (m.inputTokens === 0 && m.outputTokens === 0) continue;
      lines.push(
        `- ${model}: ${m.inputTokens.toLocaleString()} in / ${m.outputTokens.toLocaleString()} out · $${m.costUsd.toFixed(4)}`,
      );
    }
    lines.push('');

    if (report.taskBreakdown.length > 0) {
      lines.push('## Top tasks by cost');
      const top = [...report.taskBreakdown]
        .sort((a, b) => b.costUsd.comparedTo(a.costUsd))
        .slice(0, 10);
      for (const t of top) {
        lines.push(
          `- \`${t.taskId}\` (System ${t.systemId}, ${t.status}) — $${t.costUsd.toFixed(4)}`,
        );
      }
      lines.push('');
    }

    if (killLog.length > 0) {
      lines.push('## Kill log');
      for (const k of killLog) {
        lines.push(
          `- \`${k.taskId}\` at ${k.timestamp.toISOString()} — cost \$${k.costAtKill} — ${k.reason}`,
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private buildReport(
    period: UsageReport['period'],
    start: Date,
    end: Date,
    scopedTaskId?: string,
  ): UsageReport {
    const byModel: Record<ModelTier, ModelTotals> = {
      opus: { inputTokens: 0, outputTokens: 0, costUsd: new Decimal(0) },
      sonnet: { inputTokens: 0, outputTokens: 0, costUsd: new Decimal(0) },
      haiku: { inputTokens: 0, outputTokens: 0, costUsd: new Decimal(0) },
    };
    const bySystem: Record<SystemId, Decimal> = {
      A: new Decimal(0),
      B: new Decimal(0),
      C: new Decimal(0),
    };
    let totalCostUsd = new Decimal(0);

    for (const u of this.tracker.listUsage()) {
      if (u.timestamp < start || u.timestamp > end) continue;
      if (scopedTaskId && u.taskId !== scopedTaskId) continue;
      const cost = calculateCallCost(u);
      totalCostUsd = totalCostUsd.plus(cost);
      bySystem[u.systemId] = bySystem[u.systemId].plus(cost);
      byModel[u.model].inputTokens += u.inputTokens;
      byModel[u.model].outputTokens += u.outputTokens;
      byModel[u.model].costUsd = byModel[u.model].costUsd.plus(cost);
    }

    const taskBreakdown = this.tracker
      .listTaskUsage()
      .filter((t) => {
        if (scopedTaskId) return t.taskId === scopedTaskId;
        // Include tasks that touched the window.
        return t.lastCallAt >= start && t.startedAt <= end;
      })
      .map((t) => {
        // Look up the last usage row for this task in the window to know
        // which system it came from. Fallback to 'C' if we can't find it.
        const firstInWindow = this.tracker
          .listUsage()
          .find((u) => u.taskId === t.taskId);
        return {
          taskId: t.taskId,
          systemId: (firstInWindow?.systemId ?? 'C') as SystemId,
          costUsd: t.totalCostUsd,
          status: t.status,
        };
      });

    // Budget utilization is always against the daily limit — weekly /
    // monthly reports show the ratio for their equivalent-day spend
    // so long runs still compare against today's guardrail.
    const util = this.budgetManager?.getUtilization();
    const budgetUtilization = util
      ? totalCostUsd.div(util.dailyLimit).toNumber()
      : 0;

    return {
      period,
      startDate: start,
      endDate: end,
      totalCostUsd,
      bySystem,
      byModel,
      taskBreakdown,
      budgetUtilization,
    };
  }
}
