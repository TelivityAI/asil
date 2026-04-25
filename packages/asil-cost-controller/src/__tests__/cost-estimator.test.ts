import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  DEFAULT_PRICING,
  TASK_ESTIMATES,
  calculateCallCost,
  estimateTaskCost,
} from '../cost-estimator.js';
import type { TokenUsage } from '../types.js';

function usage(overrides: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    model: 'sonnet',
    timestamp: new Date('2026-04-24T12:00:00Z'),
    agentId: 'test',
    taskId: 't1',
    systemId: 'C',
    ...overrides,
  };
}

describe('calculateCallCost', () => {
  it('zero tokens → zero cost', () => {
    expect(calculateCallCost(usage({})).toString()).toBe('0');
  });

  it('Opus pricing: 1M in + 1M out = $15 + $75 = $90', () => {
    const cost = calculateCallCost(
      usage({ model: 'opus', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );
    expect(cost.toString()).toBe('90');
  });

  it('Sonnet pricing: 1M in + 1M out = $3 + $15 = $18', () => {
    const cost = calculateCallCost(
      usage({ model: 'sonnet', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );
    expect(cost.toString()).toBe('18');
  });

  it('Haiku pricing: 1M in + 1M out = $0.25 + $1.25 = $1.50', () => {
    const cost = calculateCallCost(
      usage({ model: 'haiku', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );
    expect(cost.toString()).toBe('1.5');
  });

  it('includes cache creation + cache read components', () => {
    // Sonnet: 1M cache create = $3.75, 1M cache read = $0.30
    const cost = calculateCallCost(
      usage({
        model: 'sonnet',
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    );
    // 0 regular + 3.75 + 0.30 = 4.05
    expect(cost.toString()).toBe('4.05');
  });

  it('no float drift on sub-cent token counts', () => {
    // 0.1 + 0.2 would drift under native floats; Decimal holds.
    const cost = calculateCallCost(
      usage({ model: 'sonnet', inputTokens: 33_333, outputTokens: 66_667 }),
    );
    expect(cost).toBeInstanceOf(Decimal);
    // Output is deterministic at 6dp — snapshot the exact value
    expect(cost.toString()).toBe('1.100004');
  });

  it('respects a caller-supplied pricing table', () => {
    const cheap = {
      ...DEFAULT_PRICING,
      sonnet: {
        inputPerMillion: new Decimal('0'),
        outputPerMillion: new Decimal('0'),
        cacheCreationPerMillion: new Decimal('0'),
        cacheReadPerMillion: new Decimal('0'),
      },
    };
    const cost = calculateCallCost(
      usage({ model: 'sonnet', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      cheap,
    );
    expect(cost.toString()).toBe('0');
  });

  it('all intermediates are Decimal, result rounds to 6dp HALF_UP', () => {
    // 1 input token on Sonnet = $3 / 1,000,000 = $0.000003
    const cost = calculateCallCost(
      usage({ model: 'sonnet', inputTokens: 1, outputTokens: 0 }),
    );
    expect(cost).toBeInstanceOf(Decimal);
    expect(cost.toFixed(6)).toBe('0.000003');
  });
});

describe('estimateTaskCost', () => {
  it('returns a known-type estimate with non-zero cost', () => {
    const est = estimateTaskCost('test-coverage', 'sonnet');
    expect(est.estimatedInputTokens).toBe(TASK_ESTIMATES['test-coverage']!.input);
    expect(est.estimatedOutputTokens).toBe(TASK_ESTIMATES['test-coverage']!.output);
    expect(est.estimatedCostUsd.gt(0)).toBe(true);
  });

  it('falls back to the default estimate for unknown types', () => {
    const est = estimateTaskCost('some-new-task-type', 'sonnet');
    expect(est.estimatedInputTokens).toBe(TASK_ESTIMATES.default!.input);
    expect(est.estimatedOutputTokens).toBe(TASK_ESTIMATES.default!.output);
  });

  it('confidence starts at "low" until actuals accumulate', () => {
    expect(estimateTaskCost('test-coverage', 'sonnet').confidence).toBe('low');
  });
});
