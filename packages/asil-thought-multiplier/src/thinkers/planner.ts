import type { LLMCaller, ThinkerOutput, UserRequest } from '../types.js';
import { runThinker } from './shared.js';

const FALLBACK = `
You apply Planning and Task Breakdown: turn the request into an
ordered list of build steps with dependencies. Identify what can be
parallelised. Flag blockers on other packages or external systems.
Prefer thin vertical slices over wide horizontal layers. Every step
should be individually verifiable.
`.trim();

export function runPlanner(
  request: UserRequest,
  llm: LLMCaller,
  markdownSkillsPath: string,
  model: string,
): Promise<ThinkerOutput> {
  return runThinker(
    'planner',
    {
      label: 'Planner',
      skillFile: 'planning-and-task-breakdown.md',
      fallbackInstructions: FALLBACK,
    },
    request,
    llm,
    markdownSkillsPath,
    model,
  );
}
