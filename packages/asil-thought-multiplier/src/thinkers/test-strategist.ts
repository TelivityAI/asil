import type { LLMCaller, ThinkerOutput, UserRequest } from '../types.js';
import { runThinker } from './shared.js';

const FALLBACK = `
You apply Testing Strategy: define what to test, test types
(unit/integration/e2e), the mock boundary, fixtures, and edge cases.
Business-logic tests must be marked priority 'must'. Prefer vitest.
Tests should encode business rules, not just assert that a function
returns a value.
`.trim();

export function runTestStrategist(
  request: UserRequest,
  llm: LLMCaller,
  osmaniSkillsPath: string,
  model: string,
): Promise<ThinkerOutput> {
  return runThinker(
    'test-strategist',
    {
      label: 'Test Strategist',
      osmaniSkillFile: 'testing-strategy.md',
      fallbackInstructions: FALLBACK,
    },
    request,
    llm,
    osmaniSkillsPath,
    model,
  );
}
