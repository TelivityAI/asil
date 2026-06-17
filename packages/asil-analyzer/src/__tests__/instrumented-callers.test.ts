import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentLLMCaller, instrumentCodexCaller } from '../instrumented-callers.js';
import { EventSink, readEvents, type LLMCallEvent } from '../transcript-writer.js';

function withSink<T>(fn: (sink: EventSink, file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'instr-'));
  const file = join(dir, 'events.jsonl');
  const sink = new EventSink(file);
  return fn(sink, file).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('instrumented callers — redaction (Codex #9)', () => {
  it('masks secrets in the captured LLM transcript by default', async () => {
    await withSink(async (sink, file) => {
      const real = {
        async call() {
          return {
            content: 'sure, your key sk-ant-api03-' + 'z'.repeat(24) + ' works',
            inputTokens: 1,
            outputTokens: 1,
          };
        },
      };
      const llm = instrumentLLMCaller(real, sink);
      await llm.call('system has GITHUB_TOKEN=ghp_' + 'a'.repeat(36), 'user prompt', 'sonnet');
      const events = readEvents(file);
      const call = events.find((e) => e.kind === 'llm-call') as LLMCallEvent;
      expect(call.responseContent).toContain('«REDACTED»');
      expect(call.responseContent).not.toContain('sk-ant-api03');
      expect(call.systemPrompt).toContain('«REDACTED»');
      expect(call.systemPrompt).not.toContain('ghp_aaaa');
    });
  });

  it('honors { redact: false } (raw capture for trusted/debug runs)', async () => {
    await withSink(async (sink, file) => {
      const secret = 'sk-ant-api03-' + 'z'.repeat(24);
      const real = {
        async call() {
          return { content: secret, inputTokens: 1, outputTokens: 1 };
        },
      };
      const llm = instrumentLLMCaller(real, sink, { redact: false });
      await llm.call('s', 'u', 'sonnet');
      const events = readEvents(file);
      const call = events.find((e) => e.kind === 'llm-call') as LLMCallEvent;
      expect(call.responseContent).toBe(secret);
    });
  });

  it('redacts codex-call prompts too', async () => {
    await withSink(async (sink, file) => {
      const real = {
        async call() {
          return { content: 'ok', inputTokens: 0, outputTokens: 0 };
        },
      };
      const codex = instrumentCodexCaller(real, sink);
      await codex.call('please use ghp_' + 'b'.repeat(36), 'gpt-4o');
      const events = readEvents(file);
      const call = events.find((e) => e.kind === 'codex-call') as LLMCallEvent;
      expect(call.userPrompt).toContain('«REDACTED»');
      expect(call.userPrompt).not.toContain('ghp_bbbb');
    });
  });
});
