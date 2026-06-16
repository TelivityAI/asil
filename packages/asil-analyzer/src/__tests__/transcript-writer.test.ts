import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyRole,
  EventSink,
  readEvents,
  splitByTask,
  writePerTaskTranscripts,
  type Event,
} from '../transcript-writer.js';

describe('EventSink', () => {
  it('truncates on construct and appends events as JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analyzer-test-'));
    try {
      const path = join(dir, 'events.jsonl');
      const sink = new EventSink(path);
      sink.append({
        kind: 'run-start',
        ts: '2026-05-05T19:00:00Z',
        extra: { foo: 'bar' },
      });
      sink.append({
        kind: 'task-start',
        ts: '2026-05-05T19:00:01Z',
        taskId: 't1',
        systemId: 'A',
        taskType: 'type-error',
        model: 'sonnet',
      });
      const events = readEvents(path);
      expect(events.length).toBe(2);
      expect(events[0]?.kind).toBe('run-start');
      expect(events[1]?.kind).toBe('task-start');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('setCurrentTask / getCurrentTask round-trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analyzer-test-'));
    try {
      const sink = new EventSink(join(dir, 'events.jsonl'));
      expect(sink.getCurrentTask()).toBeNull();
      sink.setCurrentTask('t-42');
      expect(sink.getCurrentTask()).toBe('t-42');
      sink.setCurrentTask(null);
      expect(sink.getCurrentTask()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('splitByTask', () => {
  it('partitions events by task-start markers', () => {
    const events: Event[] = [
      { kind: 'run-start', ts: '0', extra: {} },
      {
        kind: 'task-start',
        ts: '1',
        taskId: 't1',
        systemId: 'A',
        taskType: 'x',
        model: 'sonnet',
      },
      {
        kind: 'llm-call',
        ts: '2',
        model: 'sonnet',
        systemPrompt: '',
        userPrompt: 'a',
        responseContent: 'b',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      },
      {
        kind: 'task-start',
        ts: '3',
        taskId: 't2',
        systemId: 'A',
        taskType: 'x',
        model: 'sonnet',
      },
      {
        kind: 'llm-call',
        ts: '4',
        model: 'sonnet',
        systemPrompt: '',
        userPrompt: 'c',
        responseContent: 'd',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      },
    ];
    const { preTask, tasks } = splitByTask(events);
    expect(preTask.length).toBe(1);
    expect(preTask[0]?.kind).toBe('run-start');
    expect(Object.keys(tasks)).toEqual(['t1', 't2']);
    expect(tasks['t1']?.events.length).toBe(2); // task-start + 1 llm-call
    expect(tasks['t2']?.events.length).toBe(2);
  });
});

describe('writePerTaskTranscripts', () => {
  it('writes one JSON file per task with totals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analyzer-test-'));
    try {
      const events: Event[] = [
        {
          kind: 'task-start',
          ts: '1',
          taskId: 't1',
          systemId: 'A',
          taskType: 'x',
          model: 'sonnet',
        },
        {
          kind: 'llm-call',
          ts: '2',
          model: 'sonnet',
          systemPrompt: '',
          userPrompt: 'a',
          responseContent: 'b',
          inputTokens: 10,
          outputTokens: 20,
          latencyMs: 100,
        },
      ];
      const r = writePerTaskTranscripts(events, dir);
      expect(r.tasksWritten).toBe(1);
      expect(r.taskIds).toEqual(['t1']);
      const written = JSON.parse(readFileSync(join(dir, 't1.json'), 'utf8'));
      expect(written.taskId).toBe('t1');
      expect(written.totalTokens).toEqual({ input: 10, output: 20 });
      expect(written.llmCallCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('classifyRole', () => {
  it('detects adversarial via "try to break"', () => {
    expect(classifyRole('You are an adversarial reviewer. Try to break this diff.')).toBe(
      'adversarial',
    );
  });
  it('detects reviewer-code', () => {
    expect(classifyRole('You are a code reviewer.')).toBe('reviewer-code');
  });
  it('detects reviewer-security', () => {
    expect(classifyRole('You are a security auditor.')).toBe('reviewer-security');
  });
  it('detects reviewer-test', () => {
    expect(classifyRole('You are a test engineer reviewing test coverage.')).toBe(
      'reviewer-test',
    );
  });
  it('detects executor via "end file"', () => {
    expect(
      classifyRole(
        'Produce a patch using <<<FILE: path>>> ... <<<END FILE>>> sentinels.',
      ),
    ).toBe('executor');
  });
  it('returns unknown when no signal', () => {
    expect(classifyRole('hello')).toBe('unknown');
  });
});
