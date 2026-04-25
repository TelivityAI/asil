import type { LLMCaller, ThinkerOutput, UserRequest } from '../types.js';
import { runThinker } from './shared.js';

const FALLBACK = `
You apply Security Review: scan the request for auth, access control,
data handling, injection, credential exposure, PII leakage, and
supply-chain risks. Default severity for real risks is 'blocker'.
Every output MUST contain at least one security recommendation, even
if it's a note about what to verify.
`.trim();

export async function runSecurity(
  request: UserRequest,
  llm: LLMCaller,
  osmaniSkillsPath: string,
  model: string,
): Promise<ThinkerOutput> {
  const result = await runThinker(
    'security',
    {
      label: 'Security Review',
      osmaniSkillFile: 'security-review.md',
      fallbackInstructions: FALLBACK,
    },
    request,
    llm,
    osmaniSkillsPath,
    model,
  );

  // Security thinker invariant: always output at least one recommendation.
  if (result.recommendations.length === 0) {
    result.recommendations.push({
      category: 'security',
      priority: 'should',
      description:
        'Run a targeted security review on the produced code paths before merge.',
      rationale:
        'Security thinker returned no explicit findings — add a gate so this is verified rather than assumed.',
      source: 'security',
    });
  }

  return result;
}
