import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BudgetManager } from '../budget-manager.js';
import { TokenTracker } from '../token-tracker.js';
import { UsageReporter } from '../reporter.js';
import type { TokenUsage } from '../types.js';

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 1_000_000,
    outputTokens: 0,
    model: 'sonnet',
    timestamp: new Date(),
    agentId: 'a1',
    taskId: 't1',
    systemId: 'B',
    ...overrides,
  };
}

describe('UsageReporter', () => {
  let dir: string;
  let tracker: TokenTracker;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rep-'));
    tracker = new TokenTracker(join(dir, 'usage.json'), { autoPersist: false });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('daily() aggregates totals by system + model', () => {
    tracker.record(usage({ taskId: 'ta', systemId: 'A', model: 'opus' })); // 1M Opus in = $15
    tracker.record(usage({ taskId: 'tb', systemId: 'B', model: 'sonnet' })); // 1M Sonnet in = $3
    tracker.record(usage({ taskId: 'tc', systemId: 'C', model: 'haiku' })); // 1M Haiku in = $0.25
    const reporter = new UsageReporter(tracker);
    const report = reporter.daily();
    expect(report.period).toBe('daily');
    expect(report.totalCostUsd.toString()).toBe('18.25');
    expect(report.bySystem.A.toString()).toBe('15');
    expect(report.bySystem.B.toString()).toBe('3');
    expect(report.bySystem.C.toString()).toBe('0.25');
    expect(report.byModel.opus.inputTokens).toBe(1_000_000);
    expect(report.byModel.opus.costUsd.toString()).toBe('15');
  });

  it('task() scopes to one task and returns null for unknown ids', () => {
    tracker.record(usage({ taskId: 't1' }));
    tracker.record(usage({ taskId: 't2', systemId: 'A' }));
    const reporter = new UsageReporter(tracker);
    const report = reporter.task('t1');
    expect(report?.period).toBe('task');
    expect(report?.totalCostUsd.toString()).toBe('3');
    expect(report?.taskBreakdown).toHaveLength(1);
    expect(reporter.task('unknown-task')).toBeNull();
  });

  it('budgetUtilization reflects spend against the configured daily limit', () => {
    tracker.record(usage({ model: 'sonnet' })); // $3
    const bm = new BudgetManager(tracker);
    const reporter = new UsageReporter(tracker, bm);
    const report = reporter.daily();
    // $3 / $20 = 0.15
    expect(report.budgetUtilization).toBeCloseTo(0.15, 5);
  });

  it('formatMarkdown() includes totals, system breakdown, and kill log', () => {
    tracker.record(usage({ model: 'sonnet' }));
    const reporter = new UsageReporter(tracker);
    const report = reporter.daily();
    const md = reporter.formatMarkdown(report, [
      {
        taskId: 't1',
        reason: 'sweep: budget exhausted',
        costAtKill: '2.50',
        timestamp: new Date('2026-04-24T12:00:00Z'),
      },
    ]);
    expect(md).toContain('# Cost report — daily');
    expect(md).toContain('Total spend:');
    expect(md).toContain('System A');
    expect(md).toContain('sonnet:');
    expect(md).toContain('Kill log');
    expect(md).toContain('sweep: budget exhausted');
  });

  it('weekly() uses a 7-day window', () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    tracker.record(usage({ taskId: 't-recent', timestamp: threeDaysAgo }));
    tracker.record(usage({ taskId: 't-old', timestamp: tenDaysAgo }));
    const reporter = new UsageReporter(tracker);
    const weekly = reporter.weekly();
    // Only the 3-days-ago call counts
    expect(weekly.totalCostUsd.toString()).toBe('3');
  });
});
