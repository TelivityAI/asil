import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Decimal } from 'decimal.js';
import { BudgetManager, DEFAULT_GLOBAL_BUDGET } from '../budget-manager.js';
import { TokenTracker } from '../token-tracker.js';
import type { GlobalBudget, TokenUsage } from '../types.js';

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    model: 'sonnet',
    timestamp: new Date(),
    agentId: 'a1',
    taskId: 't1',
    systemId: 'B',
    ...overrides,
  };
}

describe('BudgetManager.allocate', () => {
  let dir: string;
  let tracker: TokenTracker;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bm-'));
    tracker = new TokenTracker(join(dir, 'usage.json'), { autoPersist: false });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns a budget when everything is under limits', () => {
    const bm = new BudgetManager(tracker);
    const budget = bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
    expect(budget).not.toBeNull();
    expect(budget?.taskId).toBe('t1');
    expect(budget?.maxCostUsd.gt(0)).toBe(true);
  });

  it('caps task cost at the defaultTaskLimitUsd', () => {
    const bm = new BudgetManager(tracker);
    const budget = bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
    expect(budget?.maxCostUsd.lte(DEFAULT_GLOBAL_BUDGET.defaultTaskLimitUsd)).toBe(true);
  });

  it('denies allocation when daily spend has crossed the effective limit (reserve held back)', () => {
    // 1M Sonnet input = $3 per call. The default daily limit is $20,
    // reserve 15%, so effective limit = $17. Six calls = $18 > $17 → next allocation denied.
    for (let i = 0; i < 6; i++) {
      tracker.record(
        usage({ taskId: `prior-${i}`, inputTokens: 1_000_000, outputTokens: 0 }),
      );
    }
    const bm = new BudgetManager(tracker);
    expect(bm.allocate('new', 'B', 'test-coverage', 'sonnet')).toBeNull();
  });

  it('denies allocation when the system daily limit is exhausted', () => {
    // System C has a $2/day limit. One 1M input call on Opus = $15 — blows past C's cap.
    tracker.record(
      usage({
        taskId: 'prior-c',
        systemId: 'C',
        model: 'opus',
        inputTokens: 1_000_000,
      }),
    );
    const bm = new BudgetManager(tracker);
    expect(bm.allocate('new', 'C', 'test-coverage', 'sonnet')).toBeNull();
  });

  it('denies when concurrent task cap is reached', () => {
    const tight: GlobalBudget = { ...DEFAULT_GLOBAL_BUDGET, maxConcurrentTasks: 2 };
    const bm = new BudgetManager(tracker, tight);
    expect(bm.allocate('t1', 'B', 'test-coverage', 'sonnet')).not.toBeNull();
    expect(bm.allocate('t2', 'B', 'test-coverage', 'sonnet')).not.toBeNull();
    expect(bm.allocate('t3', 'B', 'test-coverage', 'sonnet')).toBeNull();
  });

  it('never issues a budget whose cost cap pushes past the daily reserve', () => {
    // Use a custom global budget that makes the daily reserve the binding
    // constraint (rather than a system cap).
    const loose: GlobalBudget = {
      ...DEFAULT_GLOBAL_BUDGET,
      systemLimits: {
        A: new Decimal('20'),
        B: new Decimal('20'),
        C: new Decimal('20'),
      },
    };
    // Spend $15 pre-existing on system B. Effective daily = 20 × 0.85 = $17.
    // Remaining daily = $2. System B cap ($20) not binding.
    for (let i = 0; i < 5; i++) {
      tracker.record(
        usage({ taskId: `prior-${i}`, inputTokens: 1_000_000, outputTokens: 0 }),
      );
    }
    const bm = new BudgetManager(tracker, loose);
    const budget = bm.allocate('next', 'B', 'test-coverage', 'sonnet');
    expect(budget).not.toBeNull();
    // Cap is min(defaultTaskLimit=$2, remainingDaily=$2, remainingSystem=$5) = $2
    expect(budget!.maxCostUsd.lte(new Decimal('2'))).toBe(true);
  });

  it('respects a caller-supplied TTL + checkpoint interval', () => {
    const bm = new BudgetManager(tracker);
    const budget = bm.allocate('t1', 'B', 'test-coverage', 'sonnet', {
      ttlMs: 1000,
      checkpointIntervalTokens: 5_000,
    });
    expect(budget).not.toBeNull();
    expect(budget!.checkpointIntervalTokens).toBe(5_000);
    expect(budget!.expires.getTime() - budget!.allocated.getTime()).toBeLessThanOrEqual(1500);
  });
});

describe('BudgetManager.check', () => {
  let dir: string;
  let tracker: TokenTracker;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bm-'));
    tracker = new TokenTracker(join(dir, 'usage.json'), { autoPersist: false });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('no allocation → allowed=false with an explanatory reason', () => {
    const bm = new BudgetManager(tracker);
    const r = bm.check('nope');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no budget/i);
  });

  it('under budget → continue', () => {
    const bm = new BudgetManager(tracker);
    bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
    tracker.record(usage({ taskId: 't1', inputTokens: 1000, outputTokens: 500 }));
    const r = bm.check('t1');
    expect(r.allowed).toBe(true);
    expect(r.recommendation).toBe('continue');
  });

  it('past 80% of the cost cap → wrap_up', () => {
    const bm = new BudgetManager(tracker);
    // thought-multiplier gives a wider 2×80k input / 2×60k output window —
    // big enough to cross 80% cost without tripping the token caps.
    const budget = bm.allocate('t1', 'B', 'thought-multiplier', 'sonnet');
    // $2 task cap; 80% = $1.60. 50k input + 100k output Sonnet =
    // $0.15 + $1.50 = $1.65 = 82.5%. Both under token caps (160k, 120k).
    tracker.record(usage({ taskId: 't1', inputTokens: 50_000, outputTokens: 100_000 }));
    const r = bm.check('t1');
    expect(budget!.maxCostUsd.toString()).toBe('2');
    expect(r.allowed).toBe(true);
    expect(r.recommendation).toBe('wrap_up');
  });

  it('over cost → kill', () => {
    const bm = new BudgetManager(tracker);
    const budget = bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
    // 1M input Sonnet = $3; way over $2 task cap.
    tracker.record(usage({ taskId: 't1', inputTokens: 1_000_000 }));
    const r = bm.check('t1');
    expect(r.allowed).toBe(false);
    expect(r.recommendation).toBe('kill');
    expect(r.reason).toContain(budget!.maxCostUsd.toFixed(4));
  });

  it('expired → kill', async () => {
    const bm = new BudgetManager(tracker);
    bm.allocate('t1', 'B', 'test-coverage', 'sonnet', { ttlMs: 10 });
    await new Promise((r) => setTimeout(r, 20));
    const r = bm.check('t1');
    expect(r.allowed).toBe(false);
    expect(r.recommendation).toBe('kill');
    expect(r.reason).toMatch(/expired/i);
  });

  it('release() drops the budget so a subsequent check has no allocation', () => {
    const bm = new BudgetManager(tracker);
    bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
    bm.release('t1');
    expect(bm.check('t1').allowed).toBe(false);
  });
});
