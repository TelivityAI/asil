import type {
  AdversarialReviewResult,
  AdversarialSeverity,
  CodexCaller,
  ExecutionResult,
  SelfReviewResult,
} from './types.js';

const VALID_SEVERITIES: readonly AdversarialSeverity[] = [
  'pass',
  'minor-issues',
  'major-issues',
  'reject',
];

export async function adversarialReview(
  execution: ExecutionResult,
  selfReviewResult: SelfReviewResult,
  codex: CodexCaller,
  codexModel: string,
): Promise<AdversarialReviewResult> {
  const prompt = buildAdversarialPrompt(execution, selfReviewResult);
  const response = await codex.call(prompt, codexModel);
  return parseAdversarialResponse(execution.taskId, response.content);
}

export function buildAdversarialPrompt(
  execution: ExecutionResult,
  review: SelfReviewResult,
): string {
  return [
    '# Adversarial Code Review',
    '',
    'You are an adversarial reviewer. Your job is to find problems in the DIFF that the original reviewers MISSED.',
    '',
    '## CRITICAL SCOPING RULE',
    'You are reviewing a DIFF — a set of specific changes to existing files.',
    'Your job is to find issues INTRODUCED BY THE DIFF, not pre-existing issues.',
    '',
    '- If the diff removes an unused export (changes `export interface` to `interface`),',
    '  that is a dead-code cleanup. The scanner already verified nothing imports it.',
    '  Do NOT reject because "dependent code might rely on it" — there is no dependent code.',
    '- Pre-existing bugs, security issues, or style problems in unchanged lines are OUT OF SCOPE.',
    '- Minor style issues (trailing newline) are not rejection-worthy.',
    '- Calibrate your scrutiny to the actual risk of the change. A one-line visibility',
    '  change is not the same risk as a new auth flow.',
    '',
    'Be skeptical of substantive changes:',
    '- "Happy path only" implementations',
    '- Tests that test the mock, not the behavior',
    "- Security assumptions that aren't validated",
    '- Edge cases that are hand-waved away',
    '- Changes that subtly break existing contracts',
    '',
    'But do NOT reject trivial, safe refactors (dead code removal, unused export cleanup,',
    'comment updates) unless they introduce an actual regression.',
    '',
    '## Diff',
    '```diff',
    execution.diff || '(no diff produced)',
    '```',
    '',
    '## Self-Review Results',
    `All approved: ${review.allApproved}`,
    `Recommendation: ${review.recommendation}`,
    `Concerns raised: ${review.aggregatedConcerns.join('; ') || 'none'}`,
    '',
    '## Your Task',
    'Find issues IN THE DIFF that the self-reviewers missed. Respond with a single JSON object:',
    '{ "approved": boolean, "reasoning": string, "issuesFound": string[], "severity": "pass" | "minor-issues" | "major-issues" | "reject" }',
    '',
    'If the change is safe and correct, approve with severity "pass".',
    'If you find minor style/clarity issues IN THE CHANGED LINES, approve with severity "minor-issues".',
    'If you find correctness, security, or regression issues INTRODUCED BY THE DIFF, reject with severity "major-issues" or "reject".',
  ].join('\n');
}

export function parseAdversarialResponse(
  taskId: string,
  content: string,
): AdversarialReviewResult {
  const parsed = tryParseJson(content);
  if (!parsed) {
    // Fail closed.
    return {
      taskId,
      approved: false,
      reasoning:
        'Adversarial reviewer returned unparseable response — failing closed',
      issuesFound: ['Unparseable response'],
      severity: 'reject',
    };
  }

  const severity: AdversarialSeverity = (
    VALID_SEVERITIES as readonly string[]
  ).includes(parsed.severity as string)
    ? (parsed.severity as AdversarialSeverity)
    : 'reject';

  return {
    taskId,
    approved:
      typeof parsed.approved === 'boolean' ? parsed.approved : false,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    issuesFound: Array.isArray(parsed.issuesFound)
      ? parsed.issuesFound.filter((s): s is string => typeof s === 'string')
      : [],
    severity,
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
