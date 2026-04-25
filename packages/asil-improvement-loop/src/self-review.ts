import type {
  ExecutionResult,
  LLMCaller,
  PersonaName,
  PersonaReview,
  SelfReviewResult,
} from './types.js';

/** Shared scoping preamble injected into every persona prompt so reviewers
 *  focus on what the diff CHANGED, not pre-existing issues in the file. */
const SCOPE_PREAMBLE = `CRITICAL SCOPING RULE — read this before anything else:
You are reviewing a DIFF, not auditing the entire file. Your job is to evaluate
whether the CHANGES INTRODUCED BY THIS DIFF are correct, safe, and adequate.

- Pre-existing issues in unchanged lines are OUT OF SCOPE. Do not flag them.
- If the diff does not introduce a bug, do not reject it for bugs that were
  already there before the diff.
- "This file also has X problem" is NOT a valid concern unless the diff made
  it worse or interacts with it.
- A diff that simply removes an unused export keyword is low-risk. Calibrate
  your scrutiny to the scope and complexity of the actual change.
- Minor style issues (e.g., missing trailing newline) are suggestions, not
  rejection-worthy concerns.

Only flag concerns that are DIRECTLY CAUSED OR WORSENED by the lines this diff
adds, removes, or modifies. Approve if the change is correct and not harmful.

`;

const PERSONA_PROMPTS: Record<PersonaName, string> = {
  'code-reviewer': SCOPE_PREAMBLE + `You are a senior code reviewer. Review this diff for:
- Correctness: Does the change do what it claims?
- Style: Do the CHANGED lines follow TypeScript strict conventions?
- Edge cases: Does the change introduce unhandled edge cases?
- Regression risk: Could this specific change break existing behavior?
- Anti-patterns: Any code smells introduced BY THIS DIFF?

Respond with a single JSON object:
{ "approved": boolean, "concerns": string[], "suggestions": string[] }`,

  'security-auditor': SCOPE_PREAMBLE + `You are a security auditor. Review this diff for security issues INTRODUCED by the change:
- Does the diff introduce new injection risks?
- Does the diff weaken auth / authz?
- Does the diff expose sensitive data that wasn't exposed before?
- Does the diff introduce crypto misuse?
- Does the diff remove input validation?

If the diff is a simple refactor (e.g., removing an export keyword, deleting dead code),
and introduces no new attack surface, approve it.

Respond with a single JSON object:
{ "approved": boolean, "concerns": string[], "suggestions": string[] }`,

  'test-engineer': SCOPE_PREAMBLE + `You are a test engineer. Review this diff for:
- Test coverage: Do the CHANGES require new tests?
- If the diff only removes dead code or changes visibility, no new tests are needed.
- If the diff modifies runtime behavior, tests should cover the new behavior.

A diff that removes an unused export or deletes dead code does NOT require new tests
if the existing test suite passes. The bar is: does this change alter observable behavior?
If not, no new tests are needed.

Respond with a single JSON object:
{ "approved": boolean, "concerns": string[], "suggestions": string[] }`,
};

const PERSONAS: readonly PersonaName[] = [
  'code-reviewer',
  'security-auditor',
  'test-engineer',
];

export async function selfReview(
  execution: ExecutionResult,
  llm: LLMCaller,
  model: string,
): Promise<SelfReviewResult> {
  const reviews = await Promise.all(
    PERSONAS.map((p) => runPersonaReview(p, execution, llm, model)),
  );

  const allApproved = reviews.every((r) => r.approved);
  const rejections = reviews.filter((r) => !r.approved).length;
  const aggregatedConcerns = reviews.flatMap((r) => r.concerns);

  const recommendation: SelfReviewResult['recommendation'] = allApproved
    ? 'proceed'
    : rejections === 1
      ? 'revise'
      : 'reject';

  return {
    taskId: execution.taskId,
    reviews,
    allApproved,
    aggregatedConcerns,
    recommendation,
  };
}

async function runPersonaReview(
  persona: PersonaName,
  execution: ExecutionResult,
  llm: LLMCaller,
  model: string,
): Promise<PersonaReview> {
  const systemPrompt = PERSONA_PROMPTS[persona];
  const userPrompt = [
    '## Diff to review',
    '```diff',
    execution.diff || '(no diff produced)',
    '```',
    '',
    '## Execution log',
    execution.executionLog,
    '',
    `Tests passed: ${execution.testsPassed}`,
    `Typecheck passed: ${execution.typeCheckPassed}`,
  ].join('\n');

  const response = await llm.call(systemPrompt, userPrompt, model);
  const parsed = tryParseJson(response.content);

  if (!parsed) {
    // Fail closed — unparseable = rejection.
    return {
      persona,
      approved: false,
      concerns: [
        'Persona returned an unparseable response — treating as rejection.',
      ],
      suggestions: [],
      tokenUsage: {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      },
    };
  }

  return {
    persona,
    approved: typeof parsed.approved === 'boolean' ? parsed.approved : false,
    concerns: Array.isArray(parsed.concerns)
      ? parsed.concerns.filter((c): c is string => typeof c === 'string')
      : [],
    suggestions: Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((s): s is string => typeof s === 'string')
      : [],
    tokenUsage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };
}

function tryParseJson(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1]?.trim() ?? trimmed;
  try {
    const obj = JSON.parse(candidate) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
