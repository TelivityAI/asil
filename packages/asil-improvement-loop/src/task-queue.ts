import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  DequeueMode,
  ImprovementTask,
  QueueItem,
  QueueStatus,
  Severity,
  TaskCategory,
} from './types.js';
import { CATEGORY_PRIORITY, SEVERITY_RANK } from './types.js';

/** Categories ordered by priority (most important first). */
const CATEGORIES_BY_PRIORITY = (
  Object.keys(CATEGORY_PRIORITY) as TaskCategory[]
).sort((a, b) => CATEGORY_PRIORITY[a] - CATEGORY_PRIORITY[b]);

/** True when `severity` is at least as severe as `floor`. */
export function meetsSeverityFloor(
  severity: Severity,
  floor: Severity,
): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[floor];
}

interface SerializedQueueItem {
  task: Omit<ImprovementTask, 'discoveredAt'> & { discoveredAt: string };
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: string;
  lastFailureReason?: string;
  status: QueueStatus;
}

export interface TaskQueueOptions {
  /** Default max attempts per task. Default: 2. */
  maxAttempts?: number;
  /**
   * Severity floor. Tasks less severe than this are never enqueued, and any
   * below-floor task persisted under an older, lower floor is skipped at
   * dequeue. Default: `low` (accept everything).
   */
  minSeverity?: Severity;
  /**
   * Task selection strategy. `priority` (default) serves strict priority
   * order; `round-robin` rotates through categories with eligible work so one
   * busy category can't starve the rest.
   */
  dequeueMode?: DequeueMode;
}

export class TaskQueue {
  private items: QueueItem[] = [];
  private readonly persistPath: string;
  private readonly maxAttempts: number;
  private readonly minSeverity: Severity;
  private readonly dequeueMode: DequeueMode;
  /** Last category served, for round-robin rotation (in-memory only). */
  private lastCategory: TaskCategory | null = null;

  constructor(persistPath: string, options: TaskQueueOptions = {}) {
    this.persistPath = persistPath;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.minSeverity = options.minSeverity ?? 'low';
    this.dequeueMode = options.dequeueMode ?? 'priority';
    this.load();
  }

  enqueue(task: ImprovementTask): void {
    if (!meetsSeverityFloor(task.severity, this.minSeverity)) return;
    if (this.items.some((i) => i.task.id === task.id)) return;

    this.items.push({
      task,
      priority: computePriority(task),
      attempts: 0,
      maxAttempts: this.maxAttempts,
      status: 'queued',
    });

    this.sort();
    this.persist();
  }

  /** Whether an item can be served right now. */
  private isEligible(i: QueueItem): boolean {
    return (
      i.status === 'queued' &&
      i.attempts < i.maxAttempts &&
      meetsSeverityFloor(i.task.severity, this.minSeverity)
    );
  }

  /**
   * Round-robin pick: walk the category ring (in priority order) starting
   * just after the last-served category, and return the first eligible task
   * found. This keeps rotation fair even when a category empties mid-cycle —
   * we always advance forward rather than restarting at the top. Within the
   * chosen category, `items` is kept priority-sorted so the first match is
   * the highest-priority one.
   */
  private pickRoundRobin(): QueueItem | undefined {
    const ring = CATEGORIES_BY_PRIORITY;
    const startIdx =
      this.lastCategory === null
        ? 0
        : (ring.indexOf(this.lastCategory) + 1) % ring.length;
    for (let k = 0; k < ring.length; k += 1) {
      const cat = ring[(startIdx + k) % ring.length]!;
      const item = this.items.find(
        (i) => i.task.category === cat && this.isEligible(i),
      );
      if (item) return item;
    }
    return undefined;
  }

  dequeue(): QueueItem | null {
    const next =
      this.dequeueMode === 'round-robin'
        ? this.pickRoundRobin()
        : this.items.find((i) => this.isEligible(i));
    if (!next) return null;
    this.lastCategory = next.task.category;

    next.status = 'running';
    next.attempts += 1;
    next.lastAttemptAt = new Date();
    this.persist();
    return next;
  }

  complete(
    taskId: string,
    status: QueueStatus,
    failureReason?: string,
  ): void {
    const item = this.items.find((i) => i.task.id === taskId);
    if (!item) return;
    item.status = status;
    if (failureReason) item.lastFailureReason = failureReason;
    this.persist();
  }

  /** Expose the current items (read-only snapshot — do not mutate). */
  snapshot(): readonly QueueItem[] {
    return this.items;
  }

  stats(): {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    byCategory: Record<string, number>;
  } {
    const byCategory: Record<string, number> = {};
    for (const item of this.items) {
      byCategory[item.task.category] =
        (byCategory[item.task.category] ?? 0) + 1;
    }
    return {
      total: this.items.length,
      queued: this.items.filter((i) => i.status === 'queued').length,
      running: this.items.filter((i) => i.status === 'running').length,
      completed: this.items.filter((i) => i.status === 'completed').length,
      failed: this.items.filter((i) => i.status === 'failed').length,
      byCategory,
    };
  }

  prune(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const before = this.items.length;
    this.items = this.items.filter(
      (i) =>
        i.status !== 'completed' ||
        (i.lastAttemptAt !== undefined && i.lastAttemptAt > cutoff),
    );
    this.persist();
    return before - this.items.length;
  }

  private sort(): void {
    this.items.sort((a, b) => a.priority - b.priority);
  }

  private persist(): void {
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const serialized: SerializedQueueItem[] = this.items.map((i) => ({
      task: {
        ...i.task,
        discoveredAt: i.task.discoveredAt.toISOString(),
      },
      priority: i.priority,
      attempts: i.attempts,
      maxAttempts: i.maxAttempts,
      ...(i.lastAttemptAt
        ? { lastAttemptAt: i.lastAttemptAt.toISOString() }
        : {}),
      ...(i.lastFailureReason
        ? { lastFailureReason: i.lastFailureReason }
        : {}),
      status: i.status,
    }));
    writeFileSync(this.persistPath, JSON.stringify(serialized, null, 2), 'utf8');
  }

  private load(): void {
    if (!existsSync(this.persistPath)) {
      this.items = [];
      return;
    }
    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as SerializedQueueItem[];
      this.items = data.map((s) => ({
        task: {
          ...s.task,
          discoveredAt: new Date(s.task.discoveredAt),
        },
        priority: s.priority,
        attempts: s.attempts,
        maxAttempts: s.maxAttempts,
        ...(s.lastAttemptAt
          ? { lastAttemptAt: new Date(s.lastAttemptAt) }
          : {}),
        ...(s.lastFailureReason
          ? { lastFailureReason: s.lastFailureReason }
          : {}),
        status: s.status,
      }));
      this.sort();
    } catch {
      // Corrupted queue file — start fresh rather than crash the loop.
      this.items = [];
    }
  }
}

function computePriority(task: ImprovementTask): number {
  const base = CATEGORY_PRIORITY[task.category];
  const severityMod =
    task.severity === 'critical'
      ? -2
      : task.severity === 'high'
        ? -1
        : task.severity === 'medium'
          ? 0
          : 1;
  return base + severityMod;
}

export function priorityFor(
  category: TaskCategory,
  severity: ImprovementTask['severity'],
): number {
  return computePriority({
    id: '',
    category,
    title: '',
    description: '',
    filePaths: [],
    severity,
    discoveredAt: new Date(),
    estimatedTokens: 0,
  });
}
