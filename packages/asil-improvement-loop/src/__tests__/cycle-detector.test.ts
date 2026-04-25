import { describe, expect, it } from 'vitest';
import { CycleDetector } from '../cycle-detector.js';

describe('CycleDetector', () => {
  it('no history → no cycle', () => {
    const d = new CycleDetector();
    expect(d.wouldCycle('complexity', ['a.ts']).isCycle).toBe(false);
  });

  it('same file + same category 3 times in window → cycle', () => {
    const d = new CycleDetector(60_000, 3);
    d.record('t1', 'complexity', ['a.ts']);
    d.record('t2', 'complexity', ['a.ts']);
    d.record('t3', 'complexity', ['a.ts']);
    const check = d.wouldCycle('complexity', ['a.ts']);
    expect(check.isCycle).toBe(true);
    expect(check.affectedFiles).toEqual(['a.ts']);
  });

  it('same file, different category → no cycle', () => {
    const d = new CycleDetector(60_000, 3);
    d.record('t1', 'complexity', ['a.ts']);
    d.record('t2', 'complexity', ['a.ts']);
    d.record('t3', 'complexity', ['a.ts']);
    expect(d.wouldCycle('test-failure', ['a.ts']).isCycle).toBe(false);
  });

  it('events older than the window are pruned', () => {
    const d = new CycleDetector(10, 3);
    d.record('t1', 'complexity', ['a.ts']);
    d.record('t2', 'complexity', ['a.ts']);
    d.record('t3', 'complexity', ['a.ts']);
    // Wait for window to pass.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(d.wouldCycle('complexity', ['a.ts']).isCycle).toBe(false);
        resolve();
      }, 50);
    });
  });

  it('custom threshold respected', () => {
    const d = new CycleDetector(60_000, 2);
    d.record('t1', 'complexity', ['a.ts']);
    d.record('t2', 'complexity', ['a.ts']);
    expect(d.wouldCycle('complexity', ['a.ts']).isCycle).toBe(true);
  });
});
