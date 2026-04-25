import type { LLMCaller, LLMResponse, ThinkerRole } from '../types.js';

/** Builds a mock LLMCaller that returns a pre-scripted response per thinker role. */
export function mockLLM(
  scripts: Partial<Record<ThinkerRole, Partial<LLMResponse>>>,
): LLMCaller & { calls: Array<{ system: string; user: string; model: string }> } {
  const calls: Array<{ system: string; user: string; model: string }> = [];

  function fallback(content: string): LLMResponse {
    return { content, inputTokens: 100, outputTokens: 50 };
  }

  return {
    calls,
    async call(systemPrompt: string, userPrompt: string, model: string) {
      calls.push({ system: systemPrompt, user: userPrompt, model });
      for (const role of Object.keys(scripts) as ThinkerRole[]) {
        if (systemPrompt.includes(`role: ${role}`)) {
          const s = scripts[role];
          if (!s) break;
          return {
            content: s.content ?? defaultEnvelope(role),
            inputTokens: s.inputTokens ?? 100,
            outputTokens: s.outputTokens ?? 50,
          };
        }
      }
      return fallback(defaultEnvelope('spec-writer'));
    },
  };
}

export function envelope(payload: {
  analysis?: string;
  recommendations?: Array<Record<string, unknown>>;
  concerns?: Array<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    analysis: payload.analysis ?? 'default analysis',
    recommendations: payload.recommendations ?? [],
    concerns: payload.concerns ?? [],
  });
}

function defaultEnvelope(role: ThinkerRole): string {
  return envelope({
    analysis: `${role} default analysis`,
    recommendations: [
      {
        category: 'implementation',
        priority: 'should',
        description: `${role} default recommendation`,
        rationale: 'default',
      },
    ],
  });
}
