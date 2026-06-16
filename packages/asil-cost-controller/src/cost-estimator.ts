/**
 * Model pricing + cost estimation.
 *
 * Prices are kept in-code so they're version-controlled and reviewable.
 * They are NOT considered canonical — Anthropic changes pricing and the
 * caller can override `DEFAULT_PRICING` on every function call via the
 * optional `pricing` argument.
 *
 * All math is Decimal. `number` is only allowed as input units (token
 * counts from the API response) because those are integers and bounded.
 */
import { Decimal } from 'decimal.js';
import type { ModelTier, TokenUsage } from './types.js';

export interface ModelPricing {
  inputPerMillion: Decimal;
  outputPerMillion: Decimal;
  cacheCreationPerMillion: Decimal;
  cacheReadPerMillion: Decimal;
}

/** As of April 2026 — update here when Anthropic adjusts pricing. */
export const DEFAULT_PRICING: Record<ModelTier, ModelPricing> = {
  opus: {
    inputPerMillion: new Decimal('15'),
    outputPerMillion: new Decimal('75'),
    cacheCreationPerMillion: new Decimal('18.75'),
    cacheReadPerMillion: new Decimal('1.50'),
  },
  sonnet: {
    inputPerMillion: new Decimal('3'),
    outputPerMillion: new Decimal('15'),
    cacheCreationPerMillion: new Decimal('3.75'),
    cacheReadPerMillion: new Decimal('0.30'),
  },
  haiku: {
    inputPerMillion: new Decimal('0.25'),
    outputPerMillion: new Decimal('1.25'),
    cacheCreationPerMillion: new Decimal('0.30'),
    cacheReadPerMillion: new Decimal('0.03'),
  },
};

const ONE_MILLION = new Decimal(1_000_000);

/** Calculate cost for a single API call. */
export function calculateCallCost(
  usage: TokenUsage,
  pricing: Record<ModelTier, ModelPricing> = DEFAULT_PRICING,
): Decimal {
  const p = pricing[usage.model];
  // Local-model mode plumbs arbitrary model ids (e.g. `llama3.1`)
  // through this function via the cost-controller's accounting path.
  // Those ids aren't in the pricing table — they have no wire cost at
  // all (local inference). Returning Decimal(0) here keeps reports
  // honest (zero $) without forcing every caller to special-case
  // local mode upstream.
  if (!p) return new Decimal(0);
  let cost = new Decimal(usage.inputTokens)
    .div(ONE_MILLION)
    .times(p.inputPerMillion)
    .plus(new Decimal(usage.outputTokens).div(ONE_MILLION).times(p.outputPerMillion));

  if (usage.cacheCreationTokens) {
    cost = cost.plus(
      new Decimal(usage.cacheCreationTokens).div(ONE_MILLION).times(p.cacheCreationPerMillion),
    );
  }
  if (usage.cacheReadTokens) {
    cost = cost.plus(
      new Decimal(usage.cacheReadTokens).div(ONE_MILLION).times(p.cacheReadPerMillion),
    );
  }
  return cost.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/** Rough per-task-type estimates. Refined as actuals accumulate. */
export const TASK_ESTIMATES: Record<string, { input: number; output: number }> = {
  'test-coverage': { input: 50_000, output: 20_000 },
  'code-simplification': { input: 40_000, output: 15_000 },
  'security-scan': { input: 60_000, output: 10_000 },
  'performance-audit': { input: 50_000, output: 15_000 },
  'dead-code-removal': { input: 30_000, output: 10_000 },
  'dependency-update': { input: 20_000, output: 10_000 },
  'todo-resolution': { input: 40_000, output: 20_000 },
  'spec-generation': { input: 30_000, output: 40_000 },
  'thought-multiplier': { input: 80_000, output: 60_000 },
  default: { input: 50_000, output: 20_000 },
};

export interface TaskEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: Decimal;
  model: ModelTier;
  confidence: 'low' | 'medium' | 'high';
}

/** Estimate cost for a task before it runs. Confidence is 'low' until
 *  we have enough actuals to refine the table. */
export function estimateTaskCost(
  taskType: string,
  model: ModelTier,
  pricing: Record<ModelTier, ModelPricing> = DEFAULT_PRICING,
): TaskEstimate {
  const est = TASK_ESTIMATES[taskType] ?? TASK_ESTIMATES.default!;
  const usage: TokenUsage = {
    inputTokens: est.input,
    outputTokens: est.output,
    model,
    timestamp: new Date(),
    agentId: 'estimator',
    taskId: 'estimate',
    systemId: 'C',
  };
  return {
    estimatedInputTokens: est.input,
    estimatedOutputTokens: est.output,
    estimatedCostUsd: calculateCallCost(usage, pricing),
    model,
    confidence: 'low',
  };
}
