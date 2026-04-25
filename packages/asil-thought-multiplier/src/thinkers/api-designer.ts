import type { LLMCaller, ThinkerOutput, UserRequest } from '../types.js';
import { runThinker } from './shared.js';

const FALLBACK = `
You design the API surface: endpoint structure, request/response
shapes, error model, versioning, and authentication. Reuse the project's
existing patterns — Zod for config, existing Next.js App Router
conventions, OpenAPI 3.1 for ChatGPT channel, MCP for Claude channel.
Prefer consistency with existing endpoints over novel designs.
`.trim();

export function runApiDesigner(
  request: UserRequest,
  llm: LLMCaller,
  osmaniSkillsPath: string,
  model: string,
): Promise<ThinkerOutput> {
  return runThinker(
    'api-designer',
    {
      label: 'API Designer',
      // No dedicated Osmani skill — project-native conventions instead.
      osmaniSkillFile: undefined,
      fallbackInstructions: FALLBACK,
    },
    request,
    llm,
    osmaniSkillsPath,
    model,
  );
}
