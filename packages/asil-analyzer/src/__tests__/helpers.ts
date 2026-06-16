import type { LLMCallEvent, RoleGuess } from '../transcript-writer.js';
import type { PerTask } from '../detectors/sycophancy.js';

/** Build a minimal LLMCallEvent for tests. */
export function mkCall(
  overrides: Partial<LLMCallEvent> & { responseContent: string; roleGuess: RoleGuess },
): LLMCallEvent {
  return {
    kind: 'llm-call',
    ts: '2026-05-05T19:34:33Z',
    model: 'sonnet',
    systemPrompt: '',
    userPrompt: '',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 1234,
    ...overrides,
  };
}

export function mkTask(taskId: string, calls: LLMCallEvent[]): PerTask {
  return { taskId, calls };
}
