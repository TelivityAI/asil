/**
 * Token tracker.
 *
 * Records every API call's usage, keeps per-task running totals, and
 * persists to a simple JSON file so state survives process restarts.
 * Decimals are serialized as strings through `toJSON`; rehydrated on load.
 *
 * This is intentionally simple: a single in-memory store per process, a
 * single flat JSON file. Concurrent writers are NOT supported — the
 * cost-controller is designed to run inside one long-lived process
 * (System B / A workers). Persistence is for crash recovery, not
 * cross-process coordination.
 */
import { Decimal } from 'decimal.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SystemId, TaskUsage, TokenUsage } from './types.js';
import { calculateCallCost } from './cost-estimator.js';

interface PersistedState {
  version: 1;
  usageLog: Array<
    Omit<TokenUsage, 'timestamp'> & {
      timestamp: string;
    }
  >;
  taskUsage: Array<
    Omit<TaskUsage, 'totalCostUsd' | 'startedAt' | 'lastCallAt'> & {
      totalCostUsd: string;
      startedAt: string;
      lastCallAt: string;
    }
  >;
}

export class TokenTracker {
  private usageLog: TokenUsage[] = [];
  private taskUsage: Map<string, TaskUsage> = new Map();
  private readonly persistPath: string;
  /** When true, `record()` batches writes — tests pass `{ autoPersist: false }` for speed. */
  private readonly autoPersist: boolean;

  constructor(persistPath: string, options: { autoPersist?: boolean } = {}) {
    this.persistPath = persistPath;
    this.autoPersist = options.autoPersist ?? true;
    this.load();
  }

  /** Record a single API call's usage. */
  record(usage: TokenUsage): void {
    this.usageLog.push(usage);
    const cost = calculateCallCost(usage);

    const existing = this.taskUsage.get(usage.taskId);
    if (existing) {
      existing.totalInputTokens += usage.inputTokens;
      existing.totalOutputTokens += usage.outputTokens;
      existing.totalCostUsd = existing.totalCostUsd.plus(cost);
      existing.callCount += 1;
      existing.lastCallAt = usage.timestamp;
    } else {
      this.taskUsage.set(usage.taskId, {
        taskId: usage.taskId,
        totalInputTokens: usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        totalCostUsd: cost,
        callCount: 1,
        startedAt: usage.timestamp,
        lastCallAt: usage.timestamp,
        status: 'running',
      });
    }

    if (this.autoPersist) this.persist();
  }

  getTaskUsage(taskId: string): TaskUsage | undefined {
    return this.taskUsage.get(taskId);
  }

  /** Iterate over every task usage record (for sweeps / reporting). */
  listTaskUsage(): TaskUsage[] {
    return Array.from(this.taskUsage.values());
  }

  /** Iterate over every raw API call record (for reports). */
  listUsage(): TokenUsage[] {
    return [...this.usageLog];
  }

  /** Sum cost for a date range (inclusive). */
  getSpend(startDate: Date, endDate: Date): Decimal {
    let total = new Decimal(0);
    for (const u of this.usageLog) {
      if (u.timestamp >= startDate && u.timestamp <= endDate) {
        total = total.plus(calculateCallCost(u));
      }
    }
    return total;
  }

  /** Sum cost per system for a date range. */
  getSpendBySystem(startDate: Date, endDate: Date): Record<SystemId, Decimal> {
    const out: Record<SystemId, Decimal> = {
      A: new Decimal(0),
      B: new Decimal(0),
      C: new Decimal(0),
    };
    for (const u of this.usageLog) {
      if (u.timestamp >= startDate && u.timestamp <= endDate) {
        out[u.systemId] = out[u.systemId].plus(calculateCallCost(u));
      }
    }
    return out;
  }

  getTodaySpend(): Decimal {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.getSpend(start, new Date());
  }

  markTask(taskId: string, status: Exclude<TaskUsage['status'], 'running'>): void {
    const task = this.taskUsage.get(taskId);
    if (task) {
      task.status = status;
      if (this.autoPersist) this.persist();
    }
  }

  /** Force an immediate write. Useful when `autoPersist` is off. */
  flush(): void {
    this.persist();
  }

  private persist(): void {
    const state: PersistedState = {
      version: 1,
      usageLog: this.usageLog.map((u) => ({ ...u, timestamp: u.timestamp.toISOString() })),
      taskUsage: Array.from(this.taskUsage.values()).map((t) => ({
        ...t,
        totalCostUsd: t.totalCostUsd.toString(),
        startedAt: t.startedAt.toISOString(),
        lastCallAt: t.lastCallAt.toISOString(),
      })),
    };
    const dir = dirname(this.persistPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.persistPath, JSON.stringify(state, null, 2), 'utf8');
  }

  private load(): void {
    if (!existsSync(this.persistPath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.persistPath, 'utf8');
    } catch {
      return;
    }
    if (!raw.trim()) return;
    const state = JSON.parse(raw) as PersistedState;
    if (state.version !== 1) return;

    this.usageLog = state.usageLog.map((u) => ({ ...u, timestamp: new Date(u.timestamp) }));
    this.taskUsage.clear();
    for (const t of state.taskUsage) {
      this.taskUsage.set(t.taskId, {
        ...t,
        totalCostUsd: new Decimal(t.totalCostUsd),
        startedAt: new Date(t.startedAt),
        lastCallAt: new Date(t.lastCallAt),
      });
    }
  }
}
