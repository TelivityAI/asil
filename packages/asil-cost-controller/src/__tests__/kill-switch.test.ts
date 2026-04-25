import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetManager } from '../budget-manager.js';
import { KillSwitch } from '../kill-switch.js';
import { TokenTracker } from '../token-tracker.js';
import type { TokenUsage } from '../types.js';

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

describe('KillSwitch', () => {
  let dir: string;
  let tracker: TokenTracker;
  let bm: BudgetManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ks-'));
    tracker = new TokenTracker(join(dir, 'usage.json'), { autoPersist: false });
    bm = new BudgetManager(tracker);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sweep() kills tasks whose spend exceeded their cap', () => {
    bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
    // 1M Sonnet input = $3 — way over the $2 task cap.
    tracker.record(usage({ taskId: 't1', inputTokens: 1_000_000 }));
    const ks = new KillSwitch(tracker, bm);
    const killed = ks.sweep();
    expect(killed).toHaveLength(1);
    expect(killed[0]?.taskId).toBe('t1');
    expect(killed[0]?.reason).toMatch(/sweep/);
    expect(tracker.getTaskUsage('t1')?.status).toBe('killed');
  });

  it('sweep() leaves healthy tasks alone', () => {
    bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
    tracker.record(usage({ taskId: 't1', inputTokens: 1000 }));
    const ks = new KillSwitch(tracker, bm);
    expect(ks.sweep()).toHaveLength(0);
    expect(tracker.getTaskUsage('t1')?.status).toBe('running');
  });

  it('sweep() kills expired tasks', async () => {
    bm.allocate('t1', 'B', 'test-coverage', 'sonnet', { ttlMs: 10 });
    await new Promise((r) => setTimeout(r, 20));
    const ks = new KillSwitch(tracker, bm);
    const killed = ks.sweep();
    expect(killed).toHaveLength(1);
    expect(killed[0]?.reason).toMatch(/expired/i);
  });

  it('killAll() terminates every active task regardless of budget', () => {
    bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
    bm.allocate('t2', 'A', 'code-simplification', 'sonnet');
    tracker.record(usage({ taskId: 't1', inputTokens: 1000 }));
    tracker.record(usage({ taskId: 't2', inputTokens: 1000, systemId: 'A' }));
    const ks = new KillSwitch(tracker, bm);
    const killed = ks.killAll('panic: daily cap exceeded');
    expect(killed.map((k) => k.taskId).sort()).toEqual(['t1', 't2']);
    expect(tracker.getTaskUsage('t1')?.status).toBe('killed');
    expect(tracker.getTaskUsage('t2')?.status).toBe('killed');
  });

  it('getKillLog() accumulates events across calls', () => {
    bm.allocate('t1', 'B', 'test-coverage', 'sonnet');
    tracker.record(usage({ taskId: 't1', inputTokens: 1_000_000 }));
    const ks = new KillSwitch(tracker, bm);
    ks.sweep();
    ks.killAll('panic');
    const log = ks.getKillLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[0]?.taskId).toBe('t1');
  });
});
