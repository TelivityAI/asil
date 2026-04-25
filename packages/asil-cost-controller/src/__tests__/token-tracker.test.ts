import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Decimal } from 'decimal.js';
import { TokenTracker } from '../token-tracker.js';
import type { TokenUsage } from '../types.js';

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    model: 'sonnet',
    timestamp: new Date('2026-04-24T12:00:00Z'),
    agentId: 'a1',
    taskId: 't1',
    systemId: 'B',
    ...overrides,
  };
}

describe('TokenTracker', () => {
  let dir: string;
  let persistPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'token-tracker-'));
    persistPath = join(dir, 'usage.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('record() adds a usage row and materializes a task tally', () => {
    const t = new TokenTracker(persistPath);
    t.record(usage());
    const task = t.getTaskUsage('t1');
    expect(task?.totalInputTokens).toBe(1000);
    expect(task?.totalOutputTokens).toBe(500);
    expect(task?.callCount).toBe(1);
    expect(task?.status).toBe('running');
  });

  it('multiple calls on the same task aggregate', () => {
    const t = new TokenTracker(persistPath);
    t.record(usage({ inputTokens: 1000, outputTokens: 500 }));
    t.record(usage({ inputTokens: 2500, outputTokens: 1500 }));
    const task = t.getTaskUsage('t1');
    expect(task?.totalInputTokens).toBe(3500);
    expect(task?.totalOutputTokens).toBe(2000);
    expect(task?.callCount).toBe(2);
  });

  it('getTodaySpend() only counts calls from today', () => {
    const t = new TokenTracker(persistPath);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    t.record(
      usage({
        taskId: 'yesterday',
        timestamp: yesterday,
        inputTokens: 1_000_000,
      }),
    );
    t.record(usage({ taskId: 'today', timestamp: new Date(), inputTokens: 1_000_000 }));
    // Only the "today" record counts — 1M input on Sonnet = $3
    const spend = t.getTodaySpend();
    expect(spend.gte(new Decimal('3'))).toBe(true);
    expect(spend.lt(new Decimal('4'))).toBe(true);
  });

  it('getSpendBySystem() buckets correctly', () => {
    const t = new TokenTracker(persistPath);
    const now = new Date();
    // Zero outputs so each call is exactly $3 (Sonnet 1M in = $3).
    t.record(usage({ taskId: 'a', systemId: 'A', timestamp: now, inputTokens: 1_000_000, outputTokens: 0 }));
    t.record(usage({ taskId: 'b', systemId: 'B', timestamp: now, inputTokens: 1_000_000, outputTokens: 0 }));
    t.record(usage({ taskId: 'c', systemId: 'C', timestamp: now, inputTokens: 1_000_000, outputTokens: 0 }));
    const start = new Date(now.getTime() - 60 * 1000);
    const end = new Date(now.getTime() + 60 * 1000);
    const bySystem = t.getSpendBySystem(start, end);
    expect(bySystem.A.toString()).toBe('3');
    expect(bySystem.B.toString()).toBe('3');
    expect(bySystem.C.toString()).toBe('3');
  });

  it('persists to disk and rehydrates Decimal + Date on reload', () => {
    const first = new TokenTracker(persistPath);
    first.record(usage({ inputTokens: 1_000_000, outputTokens: 500_000 }));
    first.markTask('t1', 'completed');

    expect(existsSync(persistPath)).toBe(true);
    const raw = JSON.parse(readFileSync(persistPath, 'utf8')) as { version: number };
    expect(raw.version).toBe(1);

    const reload = new TokenTracker(persistPath);
    const task = reload.getTaskUsage('t1');
    expect(task?.status).toBe('completed');
    expect(task?.totalCostUsd).toBeInstanceOf(Decimal);
    expect(task?.totalCostUsd.gt(0)).toBe(true);
    expect(task?.startedAt).toBeInstanceOf(Date);
  });

  it('markTask() flips the terminal status and persists', () => {
    const t = new TokenTracker(persistPath);
    t.record(usage());
    t.markTask('t1', 'killed');
    expect(t.getTaskUsage('t1')?.status).toBe('killed');
    const reload = new TokenTracker(persistPath);
    expect(reload.getTaskUsage('t1')?.status).toBe('killed');
  });

  it('autoPersist=false batches writes until flush()', () => {
    const t = new TokenTracker(persistPath, { autoPersist: false });
    t.record(usage());
    expect(existsSync(persistPath)).toBe(false);
    t.flush();
    expect(existsSync(persistPath)).toBe(true);
  });
});
