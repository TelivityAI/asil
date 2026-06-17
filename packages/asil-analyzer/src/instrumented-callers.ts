/**
 * Instrumented LLMCaller / CodexCaller wrappers.
 *
 * Wraps the real caller and writes every prompt+response tuple to the
 * EventSink. Does not modify the response itself — the wrapper is
 * transparent to the runner.
 *
 * Usage:
 *   const sink = new EventSink(path);
 *   const llm = instrumentLLMCaller(createAnthropicCaller(key), sink);
 *   // ...pass llm into LoopDeps as usual...
 */
import type { CodexCaller, LLMCaller } from 'asil-improvement-loop';
import { classifyRole, type EventSink } from './transcript-writer.js';
import { redactSecrets } from './redact.js';

export interface InstrumentOptions {
  /** Mask secret-shaped tokens before writing to disk. Default true.
   *  (Codex review #9 — transcripts can contain pulled-in source/secrets.) */
  redact?: boolean;
}

function maybeRedact(text: string, redact: boolean): string {
  return redact ? redactSecrets(text).text : text;
}

export function instrumentLLMCaller(
  real: LLMCaller,
  sink: EventSink,
  opts: InstrumentOptions = {},
): LLMCaller {
  const redact = opts.redact !== false;
  return {
    async call(systemPrompt: string, userPrompt: string, model: string) {
      const startedAt = Date.now();
      const ts = new Date(startedAt).toISOString();
      try {
        const response = await real.call(systemPrompt, userPrompt, model);
        sink.append({
          kind: 'llm-call',
          ts,
          model,
          systemPrompt: maybeRedact(systemPrompt, redact),
          userPrompt: maybeRedact(userPrompt, redact),
          responseContent: maybeRedact(response.content, redact),
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          latencyMs: Date.now() - startedAt,
          taskIdGuess: sink.getCurrentTask() ?? undefined,
          roleGuess: classifyRole(systemPrompt),
        });
        return response;
      } catch (err) {
        sink.append({
          kind: 'note',
          ts,
          text: 'llm-call-error',
          details: {
            model,
            taskId: sink.getCurrentTask(),
            error: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - startedAt,
          },
        });
        throw err;
      }
    },
  };
}

export function instrumentCodexCaller(
  real: CodexCaller,
  sink: EventSink,
  opts: InstrumentOptions = {},
): CodexCaller {
  const redact = opts.redact !== false;
  return {
    async call(prompt: string, model: string) {
      const startedAt = Date.now();
      const ts = new Date(startedAt).toISOString();
      try {
        const response = await real.call(prompt, model);
        sink.append({
          kind: 'codex-call',
          ts,
          model,
          // CodexCaller takes a single combined prompt — store as userPrompt
          // and leave systemPrompt empty so analyzer text scans work
          // uniformly across both call types.
          systemPrompt: '',
          userPrompt: maybeRedact(prompt, redact),
          responseContent: maybeRedact(response.content, redact),
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startedAt,
          taskIdGuess: sink.getCurrentTask() ?? undefined,
          roleGuess: 'adversarial',
        });
        return response;
      } catch (err) {
        sink.append({
          kind: 'note',
          ts,
          text: 'codex-call-error',
          details: {
            model,
            taskId: sink.getCurrentTask(),
            error: err instanceof Error ? err.message : String(err),
            latencyMs: Date.now() - startedAt,
          },
        });
        throw err;
      }
    },
  };
}
