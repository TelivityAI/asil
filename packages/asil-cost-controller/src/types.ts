import type { Decimal } from 'decimal.js';

/** Which model is being used — determines cost per token. */
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export type SystemId = 'A' | 'B' | 'C';

/** A single token usage record from one API call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  model: ModelTier;
  timestamp: Date;
  agentId: string;
  taskId: string;
  systemId: SystemId;
}

/** Budget allocation for a single task. */
export interface TaskBudget {
  taskId: string;
  systemId: SystemId;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: Decimal;
  checkpointIntervalTokens: number;
  allocated: Date;
  expires: Date;
}

/** Running tally for a task. */
export interface TaskUsage {
  taskId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: Decimal;
  callCount: number;
  startedAt: Date;
  lastCallAt: Date;
  status: 'running' | 'completed' | 'killed' | 'over_budget';
}

/** Global budget config. */
export interface GlobalBudget {
  dailyLimitUsd: Decimal;
  defaultTaskLimitUsd: Decimal;
  maxConcurrentTasks: number;
  /** Held back from allocation so a single task can't empty the daily budget. */
  reservePercent: number;
  systemLimits: Record<SystemId, Decimal>;
}

/** Budget check result. */
export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  remainingTokens?: number;
  remainingUsd?: Decimal;
  recommendation?: 'continue' | 'wrap_up' | 'kill';
}

/** Per-model token totals used in a usage report. */
export interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: Decimal;
}

/** Usage report payload. */
export interface UsageReport {
  period: 'daily' | 'weekly' | 'monthly' | 'task';
  startDate: Date;
  endDate: Date;
  totalCostUsd: Decimal;
  bySystem: Record<SystemId, Decimal>;
  byModel: Record<ModelTier, ModelTotals>;
  taskBreakdown: Array<{
    taskId: string;
    systemId: SystemId;
    costUsd: Decimal;
    status: TaskUsage['status'];
  }>;
  /** 0..1, fraction of daily budget used. */
  budgetUtilization: number;
}
