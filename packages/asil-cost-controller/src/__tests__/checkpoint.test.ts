import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetManager } from '../budget-manager.js';
import { CostCheckpoint } from '../checkpoint.js';
import { TokenTracker } from '../token-tracker.js';

describe('CostCheckpoint', () => {
  let dir: string;
  let tracker: TokenTracker;
  let bm: BudgetManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-'));
    tracker = new TokenTracker(join(dir, 'usage.json'), { autoPersist: false });
    bm = new BudgetManager(tracker);
    bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records usage under the interval and skips the budget check', () => {
    const cp = new CostCheckpoint({
      taskId: 't1',
      systemId: 'B',
      agentId: 'a',
      tracker,
      budgetManager: bm,
      checkpointInterval: 10_000,
    });
    const r = cp.recordAndCheck(1000, 500, 'sonnet');
    expect(r.allowed).toBe(true);
    expect(r.recommendation).toBe('continue');
    // No budget-check remainingUsd because we skipped the check
    expect(r.remainingUsd).toBeUndefined();
    // But the tracker did record
    expect(tracker.getTaskUsage('t1')?.callCount).toBe(1);
  });

  it('once cumulative tokens cross the interval it invokes the budget check', () => {
    const cp = new CostCheckpoint({
      taskId: 't1',
      systemId: 'B',
      agentId: 'a',
      tracker,
      budgetManager: bm,
      checkpointInterval: 10_000,
    });
    // 3× 4k tokens = 12k, crossing the 10k interval on the third call.
    cp.recordAndCheck(3000, 1000, 'sonnet');
    cp.recordAndCheck(3000, 1000, 'sonnet');
    const r = cp.recordAndCheck(3000, 1000, 'sonnet');
    expect(r.allowed).toBe(true);
    expect(r.remainingUsd).toBeDefined();
  });

  it('forceCheck() always evaluates the budget', () => {
    const cp = new CostCheckpoint({
      taskId: 't1',
      systemId: 'B',
      agentId: 'a',
      tracker,
      budgetManager: bm,
    });
    const r = cp.forceCheck();
    expect(r.allowed).toBe(true);
    expect(r.remainingUsd).toBeDefined();
  });

  it('complete() marks the task completed and releases the allocation', () => {
    const cp = new CostCheckpoint({
      taskId: 't1',
      systemId: 'B',
      agentId: 'a',
      tracker,
      budgetManager: bm,
    });
    cp.recordAndCheck(500, 100, 'sonnet');
    cp.complete();
    expect(tracker.getTaskUsage('t1')?.status).toBe('completed');
    expect(bm.check('t1').allowed).toBe(false); // allocation gone
  });

  it('kill() marks the task killed and releases', () => {
    const cp = new CostCheckpoint({
      taskId: 't1',
      systemId: 'B',
      agentId: 'a',
      tracker,
      budgetManager: bm,
    });
    cp.recordAndCheck(500, 100, 'sonnet');
    cp.kill('runaway');
    expect(tracker.getTaskUsage('t1')?.status).toBe('killed');
    expect(bm.check('t1').allowed).toBe(false);
  });

  it('passes cache tokens through to the tracker', () => {
    const cp = new CostCheckpoint({
      taskId: 't1',
      systemId: 'B',
      agentId: 'a',
      tracker,
      budgetManager: bm,
    });
    cp.recordAndCheck(1000, 500, 'sonnet', {
      cacheCreationTokens: 200,
      cacheReadTokens: 100,
    });
    const row = tracker.listUsage()[0];
    expect(row?.cacheCreationTokens).toBe(200);
    expect(row?.cacheReadTokens).toBe(100);
  });
});
