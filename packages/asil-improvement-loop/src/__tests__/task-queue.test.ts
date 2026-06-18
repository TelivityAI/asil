import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskQueue, priorityFor, meetsSeverityFloor } from '../task-queue.js';
import { mkCategoryTask, mkTask } from './helpers.js';

describe('TaskQueue', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queue-'));
    path = join(dir, 'queue.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('enqueue adds a task, stats reflect it', () => {
    const q = new TaskQueue(path);
    q.enqueue(mkTask());
    expect(q.stats().queued).toBe(1);
  });

  it('dequeue returns highest-priority task first (test-failure before type-error)', () => {
    const q = new TaskQueue(path);
    q.enqueue(mkCategoryTask('type-error', 'medium', 'type'));
    q.enqueue(mkCategoryTask('test-failure', 'medium', 'fail'));
    const first = q.dequeue();
    expect(first?.task.category).toBe('test-failure');
  });

  it('priority category ordering: test-failure < type-error < vulnerability < ... < documentation', () => {
    const order = [
      'test-failure',
      'type-error',
      'vulnerability',
      'todo-resolution',
      'coverage-gap',
      'complexity',
      'dead-code',
      'dependency-update',
      'documentation',
    ] as const;
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(priorityFor(order[i]!, 'medium')).toBeLessThan(
        priorityFor(order[i + 1]!, 'medium'),
      );
    }
  });

  it('critical severity bumps a task above the same-category medium one', () => {
    const q = new TaskQueue(path);
    q.enqueue(mkCategoryTask('type-error', 'medium', 'med'));
    q.enqueue(mkCategoryTask('type-error', 'critical', 'crit'));
    const first = q.dequeue();
    expect(first?.task.id).toBe('crit');
  });

  it('duplicate task IDs are not enqueued twice', () => {
    const q = new TaskQueue(path);
    q.enqueue(mkTask({ id: 'same' }));
    q.enqueue(mkTask({ id: 'same', title: 'other title' }));
    expect(q.stats().total).toBe(1);
  });

  it('dequeue marks running and increments attempts', () => {
    const q = new TaskQueue(path);
    q.enqueue(mkTask({ id: 't1' }));
    const item = q.dequeue();
    expect(item?.status).toBe('running');
    expect(item?.attempts).toBe(1);
  });

  it('complete marks the task status correctly', () => {
    const q = new TaskQueue(path);
    q.enqueue(mkTask({ id: 't1' }));
    q.dequeue();
    q.complete('t1', 'completed');
    expect(q.stats().completed).toBe(1);
  });

  it('tasks that hit maxAttempts are not dequeued again', () => {
    const q = new TaskQueue(path, { maxAttempts: 1 });
    q.enqueue(mkTask({ id: 't1' }));
    q.dequeue();
    q.complete('t1', 'queued'); // put back queued but attempts=1
    expect(q.dequeue()).toBeNull();
  });

  it('persists to disk and reloads', () => {
    const q1 = new TaskQueue(path);
    q1.enqueue(mkTask({ id: 't-persist' }));
    const fileRaw = readFileSync(path, 'utf8');
    expect(fileRaw).toContain('t-persist');

    const q2 = new TaskQueue(path);
    const item = q2.dequeue();
    expect(item?.task.id).toBe('t-persist');
  });

  it('prune removes completed tasks older than cutoff', () => {
    const q = new TaskQueue(path);
    q.enqueue(mkTask({ id: 't-old' }));
    q.dequeue();
    q.complete('t-old', 'completed');
    // Force lastAttemptAt into the past.
    const snap = q.snapshot();
    const persisted = snap.find((i) => i.task.id === 't-old');
    if (persisted) {
      persisted.lastAttemptAt = new Date(Date.now() - 10 * 86_400_000);
    }
    const removed = q.prune(5);
    expect(removed).toBe(1);
  });

  it('corrupted queue file falls back to empty', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(path, '{not json', 'utf8');
    const q = new TaskQueue(path);
    expect(q.stats().total).toBe(0);
  });

  describe('minSeverity floor (Codex #3)', () => {
    it('drops below-floor tasks at enqueue, keeps at-or-above-floor', () => {
      const q = new TaskQueue(path, { minSeverity: 'high' });
      q.enqueue(mkCategoryTask('type-error', 'critical', 'crit'));
      q.enqueue(mkCategoryTask('type-error', 'high', 'high'));
      q.enqueue(mkCategoryTask('type-error', 'medium', 'med'));
      q.enqueue(mkCategoryTask('type-error', 'low', 'low'));
      expect(q.stats().queued).toBe(2);
      const ids = q.snapshot().map((i) => i.task.id).sort();
      expect(ids).toEqual(['crit', 'high']);
    });

    it('default floor (low) accepts every severity — backwards compatible', () => {
      const q = new TaskQueue(path);
      for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
        q.enqueue(mkCategoryTask('type-error', sev, sev));
      }
      expect(q.stats().queued).toBe(4);
    });

    it('skips below-floor tasks persisted under an older lower floor', () => {
      // Persist a medium task with the default (low) floor.
      const lenient = new TaskQueue(path);
      lenient.enqueue(mkCategoryTask('type-error', 'medium', 'med'));
      lenient.enqueue(mkCategoryTask('type-error', 'critical', 'crit'));

      // Reload with a stricter floor — the medium one must not be served.
      const strict = new TaskQueue(path, { minSeverity: 'high' });
      const first = strict.dequeue();
      expect(first?.task.id).toBe('crit');
      expect(strict.dequeue()).toBeNull();
    });
  });

  describe('round-robin dequeue (Codex #4)', () => {
    it('rotates across categories instead of draining the top one first', () => {
      const q = new TaskQueue(path, { dequeueMode: 'round-robin' });
      // Three test-failures (top priority) + one type-error + one vulnerability.
      q.enqueue(mkCategoryTask('test-failure', 'medium', 'tf1'));
      q.enqueue(mkCategoryTask('test-failure', 'medium', 'tf2'));
      q.enqueue(mkCategoryTask('test-failure', 'medium', 'tf3'));
      q.enqueue(mkCategoryTask('type-error', 'medium', 'te1'));
      q.enqueue(mkCategoryTask('vulnerability', 'medium', 'vu1'));

      const cats = [
        q.dequeue()?.task.category,
        q.dequeue()?.task.category,
        q.dequeue()?.task.category,
      ];
      // First full cycle visits each category-with-work exactly once.
      expect(cats).toEqual(['test-failure', 'type-error', 'vulnerability']);
    });

    it('falls back to remaining categories once others are exhausted', () => {
      const q = new TaskQueue(path, { dequeueMode: 'round-robin' });
      q.enqueue(mkCategoryTask('test-failure', 'medium', 'tf1'));
      q.enqueue(mkCategoryTask('test-failure', 'medium', 'tf2'));
      q.enqueue(mkCategoryTask('type-error', 'medium', 'te1'));

      const order = [
        q.dequeue()?.task.id,
        q.dequeue()?.task.id,
        q.dequeue()?.task.id,
      ];
      // tf, te (rotation), then back to the leftover tf.
      expect(order).toEqual(['tf1', 'te1', 'tf2']);
      expect(q.dequeue()).toBeNull();
    });

    it('within a category, still serves the highest-severity task first', () => {
      const q = new TaskQueue(path, { dequeueMode: 'round-robin' });
      q.enqueue(mkCategoryTask('test-failure', 'low', 'tf-low'));
      q.enqueue(mkCategoryTask('test-failure', 'critical', 'tf-crit'));
      expect(q.dequeue()?.task.id).toBe('tf-crit');
    });

    it('priority mode (default) drains the top category first', () => {
      const q = new TaskQueue(path); // default: priority
      q.enqueue(mkCategoryTask('test-failure', 'medium', 'tf1'));
      q.enqueue(mkCategoryTask('test-failure', 'medium', 'tf2'));
      q.enqueue(mkCategoryTask('type-error', 'medium', 'te1'));
      expect(q.dequeue()?.task.category).toBe('test-failure');
      expect(q.dequeue()?.task.category).toBe('test-failure');
      expect(q.dequeue()?.task.category).toBe('type-error');
    });
  });

  describe('meetsSeverityFloor', () => {
    it('passes when severity is at or above the floor', () => {
      expect(meetsSeverityFloor('critical', 'high')).toBe(true);
      expect(meetsSeverityFloor('high', 'high')).toBe(true);
      expect(meetsSeverityFloor('medium', 'high')).toBe(false);
      expect(meetsSeverityFloor('low', 'low')).toBe(true);
      expect(meetsSeverityFloor('critical', 'low')).toBe(true);
    });
  });
});
