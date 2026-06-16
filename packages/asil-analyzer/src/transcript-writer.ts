/**
 * Transcript writer / event sink.
 *
 * Captures LLM/Codex calls and pipeline events into a flat JSONL stream,
 * then splits the stream into per-task transcript files for the
 * deterministic analyzer to scan.
 *
 * Task boundaries are inferred from `task-start` events emitted by an
 * instrumented BudgetManager.allocate wrapper. Every event after a
 * task-start (up to the next task-start) belongs to that task.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type EventKind =
  | 'run-start'
  | 'task-start'
  | 'task-end'
  | 'llm-call'
  | 'codex-call'
  | 'budget-allocate'
  | 'budget-allocate-rejected'
  | 'pr-stubbed'
  | 'git-push-rejected'
  | 'note';

export interface BaseEvent {
  ts: string;
  kind: EventKind;
}

export type RoleGuess =
  | 'executor'
  | 'reviewer-code'
  | 'reviewer-security'
  | 'reviewer-test'
  | 'adversarial'
  | 'thinker'
  | 'papa'
  | 'unknown';

export interface LLMCallEvent extends BaseEvent {
  kind: 'llm-call' | 'codex-call';
  model: string;
  systemPrompt: string;
  userPrompt: string;
  responseContent: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Best-effort attribution. Filled by the wrapper from EventSink state. */
  taskIdGuess?: string;
  /** Best-effort role hint based on the system prompt content. */
  roleGuess?: RoleGuess;
}

export interface TaskStartEvent extends BaseEvent {
  kind: 'task-start';
  taskId: string;
  systemId: string;
  taskType: string;
  model: string;
}

export interface TaskEndEvent extends BaseEvent {
  kind: 'task-end';
  taskId: string;
  outcome: string;
  totalCostUsd?: string;
}

export interface BudgetAllocateEvent extends BaseEvent {
  kind: 'budget-allocate' | 'budget-allocate-rejected';
  taskId: string;
  systemId: string;
  taskType: string;
  model: string;
  estimatedUsd?: string;
}

export interface PRStubbedEvent extends BaseEvent {
  kind: 'pr-stubbed';
  taskId: string;
  branch: string;
  prBody: string;
}

export interface GitPushRejectedEvent extends BaseEvent {
  kind: 'git-push-rejected';
  branch?: string;
}

export interface NoteEvent extends BaseEvent {
  kind: 'note';
  text: string;
  details?: Record<string, unknown>;
}

export interface RunStartEvent extends BaseEvent {
  kind: 'run-start';
  /** Caller-supplied attributes (repo SHA, config snapshot, etc.). */
  extra: Record<string, unknown>;
}

export type Event =
  | RunStartEvent
  | TaskStartEvent
  | TaskEndEvent
  | LLMCallEvent
  | BudgetAllocateEvent
  | PRStubbedEvent
  | GitPushRejectedEvent
  | NoteEvent;

/**
 * Per-task transcript shape written to <taskId>.json. The analyzer reads
 * these and the index.json to compute its detectors.
 */
export interface TaskTranscript {
  taskId: string;
  taskStart?: TaskStartEvent;
  eventCount: number;
  llmCallCount: number;
  totalTokens: { input: number; output: number };
  events: Event[];
}

export class EventSink {
  private currentTaskId: string | null = null;

  constructor(private readonly eventsFile: string) {
    mkdirSync(dirname(eventsFile), { recursive: true });
    // Truncate any prior content so re-runs start clean.
    writeFileSync(eventsFile, '');
  }

  setCurrentTask(taskId: string | null): void {
    this.currentTaskId = taskId;
  }

  getCurrentTask(): string | null {
    return this.currentTaskId;
  }

  append(event: Event): void {
    appendFileSync(this.eventsFile, JSON.stringify(event) + '\n');
  }
}

/** Read events.jsonl back as a typed array. */
export function readEvents(eventsFile: string): Event[] {
  const text = readFileSync(eventsFile, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Event);
}

/**
 * Group events into per-task buckets. Boundary rule: the first
 * `task-start` event begins task A; every subsequent event up to the
 * next `task-start` belongs to A. Events before the first `task-start`
 * land in a `_pre` bucket.
 */
export function splitByTask(events: Event[]): {
  preTask: Event[];
  tasks: Record<string, { taskStart?: TaskStartEvent; events: Event[] }>;
} {
  const preTask: Event[] = [];
  const tasks: Record<string, { taskStart?: TaskStartEvent; events: Event[] }> = {};
  let currentId: string | null = null;

  for (const event of events) {
    if (event.kind === 'task-start') {
      currentId = event.taskId;
      tasks[currentId] = { taskStart: event, events: [event] };
      continue;
    }
    if (currentId === null) {
      preTask.push(event);
    } else {
      tasks[currentId]!.events.push(event);
    }
  }

  return { preTask, tasks };
}

/** Write per-task JSON files. */
export function writePerTaskTranscripts(
  events: Event[],
  outDir: string,
): { tasksWritten: number; taskIds: string[] } {
  mkdirSync(outDir, { recursive: true });
  const { tasks } = splitByTask(events);
  const taskIds: string[] = [];

  for (const [taskId, data] of Object.entries(tasks)) {
    const outFile = join(outDir, `${taskId}.json`);
    const llmCalls = data.events.filter(
      (e) => e.kind === 'llm-call' || e.kind === 'codex-call',
    ) as LLMCallEvent[];
    const totalInput = llmCalls.reduce((s, e) => s + (e.inputTokens || 0), 0);
    const totalOutput = llmCalls.reduce((s, e) => s + (e.outputTokens || 0), 0);

    const transcript: TaskTranscript = {
      taskId,
      taskStart: data.taskStart,
      eventCount: data.events.length,
      llmCallCount: llmCalls.length,
      totalTokens: { input: totalInput, output: totalOutput },
      events: data.events,
    };

    writeFileSync(outFile, JSON.stringify(transcript, null, 2));
    taskIds.push(taskId);
  }

  return { tasksWritten: taskIds.length, taskIds };
}

/**
 * Heuristic role classifier — looks at distinctive phrases in the
 * system prompt to label which agent role made the call. Used by the
 * analyzer to bucket calls (proposer vs reviewer, etc.). The exact
 * thresholds and phrases are deterministic — no LLM call.
 */
export function classifyRole(systemPrompt: string): RoleGuess {
  const sp = systemPrompt.toLowerCase();
  if (sp.includes('adversar') || sp.includes('try to break') || sp.includes('challenge')) {
    return 'adversarial';
  }
  if (sp.includes('code reviewer') || sp.includes('code-reviewer')) {
    return 'reviewer-code';
  }
  if (sp.includes('security') && (sp.includes('auditor') || sp.includes('audit'))) {
    return 'reviewer-security';
  }
  if (sp.includes('test engineer') || sp.includes('test-engineer')) {
    return 'reviewer-test';
  }
  if (sp.includes('papa')) return 'papa';
  if (sp.includes('thinker')) return 'thinker';
  if (
    sp.includes('autonomous improvement') ||
    sp.includes('improvement task') ||
    sp.includes('produce a patch') ||
    sp.includes('end file')
  ) {
    return 'executor';
  }
  return 'unknown';
}
