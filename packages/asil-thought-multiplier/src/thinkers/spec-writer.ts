import type { LLMCaller, ThinkerOutput, UserRequest } from '../types.js';
import { runThinker } from './shared.js';

const FALLBACK = `
You apply Spec-Driven Development: turn the request into a precise
specification before anyone writes code. Cover objectives, interfaces,
data models, edge cases, error paths, and acceptance criteria. Flag
ambiguity as a concern rather than guessing. Pair every 'must' rec
with a crisp acceptance criterion.
`.trim();

export function runSpecWriter(
  request: UserRequest,
  llm: LLMCaller,
  osmaniSkillsPath: string,
  model: string,
): Promise<ThinkerOutput> {
  return runThinker(
    'spec-writer',
    {
      label: 'Spec Writer',
      osmaniSkillFile: 'spec-driven-development.md',
      fallbackInstructions: FALLBACK,
    },
    request,
    llm,
    osmaniSkillsPath,
    model,
  );
}
