/**
 * Generates proposed answers for `// DOMAIN_QUESTION:` markers using a
 * high-quality LLM call (Opus, with rich context). The whole feature's
 * value rides on the proposals being good enough that the operator
 * actually *uses* the menu instead of typing free-text every time —
 * "lazy + cheap" is the wrong design here. This module is intentionally
 * thorough: it pulls in the file containing the question, all
 * previously-answered domain questions (so new proposals stay
 * consistent with established decisions), and CLAUDE.md as the project
 * constitution.
 */
import type {
  DomainQuestion,
  ProposedAnswer,
  QuestionProposals,
  StoredAnswer,
} from './domain-questions.js';
import type { LLMCaller } from './types.js';

export interface ProposalContext {
  /** Full content of the file the question lives in. */
  fileContent: string;
  /** Every prior `DOMAIN_QUESTION` answer — keeps new proposals consistent. */
  priorAnswers: readonly StoredAnswer[];
  /** Project constitution (CLAUDE.md) — domain rules, tech stack, etc. */
  claudeMd?: string;
}

export interface ProposerOptions {
  /** Model id to use. Default: 'opus' — highest reasoning quality. */
  model?: string;
  /** Number of proposals to generate. Default: 3. */
  proposalCount?: number;
}

const DEFAULT_MODEL = 'opus';
const DEFAULT_PROPOSAL_COUNT = 3;

const SYSTEM_PROMPT = `You are the domain-knowledge assistant. The codebase author left a
\`// DOMAIN_QUESTION:\` marker — an explicit acknowledgement that domain
input is required. The project CLAUDE.md rule is unambiguous: the
autonomous loop must NOT fabricate domain answers. Your job here is
DIFFERENT — you are not answering autonomously, you are PROPOSING
candidate answers for Dušan (the human source of truth) to choose
between or override.

The proposals must be:

1. **Concrete and specific.** No "it depends" or "consider the trade-offs".
   Each proposal commits to a position so Dušan can recognize the right one.
2. **Distinct from each other.** Three flavors of the same answer wastes
   the menu. Each proposal should represent a meaningfully different
   position or approach.
3. **Grounded in the actual code.** Use the surrounding file's structure,
   imports, and existing patterns to ensure the proposal is implementable
   in this codebase, not abstract advice.
4. **Consistent with prior domain decisions.** Established answers (in the
   "Prior decisions" context) define how the project actually works. Don't
   propose anything that contradicts them — extend them instead.
5. **Honest about uncertainty.** If the question genuinely has no good
   answer based on the context provided, say so explicitly in one proposal
   ("Cannot be answered without external clarification: <what's missing>").
   Don't invent confidence.

**LENGTH LIMITS — STRICT.** The whole feature only works if Dušan can
read the menu in 5 seconds and recognize the right answer. Long
proposals defeat the purpose.

- \`answer\`: ≤30 words, ≤200 characters. ONE sentence. No paragraphs,
  no bullet lists, no embedded code blocks. Write the answer plainly.
- \`reasoning\`: ≤15 words, ≤100 characters. ONE short clause.

If you cannot fit the answer in 30 words, the answer is too vague —
make it more specific until it fits. If it genuinely needs more
nuance, write the headline answer and trust Dušan to amend with
free-text.

Output format (strict JSON, no prose, no fences):

{
  "proposals": [
    { "answer": "...", "reasoning": "..." },
    { "answer": "...", "reasoning": "..." },
    { "answer": "...", "reasoning": "..." }
  ]
}`;

function buildUserPrompt(
  question: DomainQuestion,
  ctx: ProposalContext,
  proposalCount: number,
): string {
  const lines: string[] = [];
  lines.push(`## The question`);
  lines.push('');
  lines.push(`File: \`${question.filePath}:${question.line}\``);
  lines.push(`Marker: \`${question.rawLine}\``);
  lines.push(`Question: ${question.text}`);
  lines.push('');

  if (ctx.claudeMd && ctx.claudeMd.trim()) {
    lines.push('## CLAUDE.md (project constitution — domain rules, tech stack)');
    lines.push('');
    lines.push(ctx.claudeMd.trim());
    lines.push('');
  }

  if (ctx.priorAnswers.length > 0) {
    lines.push('## Prior decisions (from Dušan, do not contradict)');
    lines.push('');
    for (const a of ctx.priorAnswers) {
      lines.push(`- \`${a.filePath}:${a.line}\``);
      lines.push(`  Q: ${a.question}`);
      lines.push(`  A: ${a.answer}`);
      lines.push('');
    }
  }

  lines.push('## File containing the question');
  lines.push('');
  lines.push('```typescript');
  lines.push(ctx.fileContent);
  lines.push('```');
  lines.push('');

  lines.push(
    `Generate exactly ${proposalCount} proposed answers in the JSON format specified.`,
  );
  return lines.join('\n');
}

export interface ProposalResult {
  proposals: QuestionProposals;
  /** Tokens spent generating these proposals — surfaced for cost reporting. */
  tokenUsage: { inputTokens: number; outputTokens: number };
}

export async function generateProposals(args: {
  question: DomainQuestion;
  context: ProposalContext;
  llm: LLMCaller;
  options?: ProposerOptions;
}): Promise<ProposalResult> {
  const model = args.options?.model ?? DEFAULT_MODEL;
  const proposalCount = args.options?.proposalCount ?? DEFAULT_PROPOSAL_COUNT;

  const userPrompt = buildUserPrompt(args.question, args.context, proposalCount);
  const response = await args.llm.call(SYSTEM_PROMPT, userPrompt, model);

  const proposals = parseProposals(response.content);
  return {
    proposals: {
      hash: args.question.hash,
      proposals: proposals.slice(0, proposalCount),
      generatedAt: new Date().toISOString(),
      model,
    },
    tokenUsage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };
}

/** Parse the LLM's JSON output into ProposedAnswer[]. Tolerates a
 *  ```json fence wrapper (some models add it despite the prompt) and
 *  rejects anything that doesn't have answer + reasoning strings. */
export function parseProposals(content: string): ProposedAnswer[] {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  const arr = obj.proposals;
  if (!Array.isArray(arr)) return [];

  const proposals: ProposedAnswer[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const p = raw as Record<string, unknown>;
    const answer = typeof p.answer === 'string' ? p.answer.trim() : '';
    const reasoning =
      typeof p.reasoning === 'string' ? p.reasoning.trim() : '';
    if (!answer) continue;
    proposals.push({ answer, reasoning });
  }
  return proposals;
}
