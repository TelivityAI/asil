import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskQueue, priorityFor } from '../task-queue.js';
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
});
