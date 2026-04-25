/**
 * Interactive triage of `// DOMAIN_QUESTION:` markers at the start of
 * `pnpm auto grind`. Blocks the run on any unresolved question and
 * presents Opus-generated proposed answers so the operator can pick a
 * number, type their own answer, or skip.
 *
 * Pure-ish: file IO + LLM calls injected via deps so tests can drive
 * the full flow without hitting disk or the API.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findDomainQuestions,
  generateProposals,
  type DomainAnswerStore,
  type DomainQuestion,
  type LLMCaller,
  type ProposalContext,
  type ProposedAnswer,
  type QuestionProposals,
  type StoredAnswer,
} from 'asil-improvement-loop';
import type { CommandRunner } from 'asil-improvement-loop';

export interface TriagePromptIO {
  /** Print a line to the operator. */
  print: (msg: string) => void;
  /** Read a line from the operator (returns the trimmed input). */
  ask: (prompt: string) => Promise<string>;
}

export interface TriageDeps {
  repoRoot: string;
  runner: CommandRunner;
  llm: LLMCaller;
  store: DomainAnswerStore;
  io: TriagePromptIO;
  /** Model to use for proposal generation. Default: 'opus'. */
  proposalModel?: string;
  /** Read CLAUDE.md content (injected for tests). Default: read from disk. */
  readClaudeMd?: () => string;
  /** Read a repo file (injected for tests). Default: readFileSync utf8. */
  readFile?: (absPath: string) => string;
}

export interface TriageResult {
  /** Files the loop must NOT process this run. */
  blockedFiles: Set<string>;
  /** New answers accepted during this triage session. */
  newAnswers: StoredAnswer[];
  /** True iff the operator picked `[a]bort` at any point. */
  aborted: boolean;
  /** Total tokens spent generating proposals during this triage. */
  proposalTokenUsage: { inputTokens: number; outputTokens: number };
  /** Total `// DOMAIN_QUESTION:` markers in the codebase right now. */
  totalQuestions: number;
  /** How many were already resolved (answered) before this run. */
  alreadyAnswered: number;
}

const ABORT_TOKENS = new Set(['a', 'abort', 'q', 'quit']);
const SKIP_TOKENS = new Set(['s', 'skip']);
// `sa` is the dedicated skip-all token (case-insensitive). `s` alone
// only skips the current question — keeps the single-skip path cheap
// and prevents accidental skip-all from a stray capital.
const SKIP_ALL_TOKENS = new Set(['sa', 'skip-all', 'skipall']);

export async function triageDomainQuestions(
  deps: TriageDeps,
): Promise<TriageResult> {
  const allQuestions = await findDomainQuestions({
    repoRoot: deps.repoRoot,
    runner: deps.runner,
  });

  const totalTokens = { inputTokens: 0, outputTokens: 0 };
  const newAnswers: StoredAnswer[] = [];
  const blockedFiles = new Set<string>();

  // Partition questions by whether we already have a stored answer.
  const unanswered: DomainQuestion[] = [];
  let alreadyAnswered = 0;
  for (const q of allQuestions) {
    if (deps.store.getAnswer(q.hash)) {
      alreadyAnswered += 1;
    } else {
      unanswered.push(q);
    }
  }

  if (unanswered.length === 0) {
    // Nothing to triage → no blocker. Loop runs immediately.
    return {
      blockedFiles,
      newAnswers,
      aborted: false,
      proposalTokenUsage: totalTokens,
      totalQuestions: allQuestions.length,
      alreadyAnswered,
    };
  }

  deps.io.print('');
  deps.io.print(
    `📋 ${unanswered.length} unresolved domain question${unanswered.length === 1 ? '' : 's'} — answer or skip before grind starts:`,
  );
  deps.io.print('');

  for (let idx = 0; idx < unanswered.length; idx += 1) {
    const q = unanswered[idx]!;

    // Generate (or fetch cached) proposals for this question.
    let proposals: ProposedAnswer[];
    const cached = deps.store.getProposals(q.hash);
    if (cached) {
      proposals = cached.proposals;
    } else {
      try {
        const result = await generateProposals({
          question: q,
          context: buildProposalContext(q, deps),
          llm: deps.llm,
          options: {
            ...(deps.proposalModel ? { model: deps.proposalModel } : {}),
          },
        });
        proposals = result.proposals.proposals;
        totalTokens.inputTokens += result.tokenUsage.inputTokens;
        totalTokens.outputTokens += result.tokenUsage.outputTokens;
        // Cache so subsequent runs don't pay the LLM cost for the same
        // wording — re-wording forces a new hash and fresh proposals.
        deps.store.saveProposals({
          hash: q.hash,
          proposals,
          generatedAt: result.proposals.generatedAt,
          model: result.proposals.model,
        } satisfies QuestionProposals);
      } catch (err) {
        deps.io.print(
          `   ⚠️  proposal generation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        deps.io.print('       falling back to free-text answer.');
        proposals = [];
      }
    }

    // Render the question + proposals.
    deps.io.print('');
    deps.io.print(
      `[${idx + 1}/${unanswered.length}] ${q.filePath}:${q.line}`,
    );
    deps.io.print(`   Q: ${q.text}`);
    deps.io.print('');
    if (proposals.length > 0) {
      deps.io.print('   Proposed answers:');
      for (let i = 0; i < proposals.length; i += 1) {
        const p = proposals[i]!;
        deps.io.print(`     ${i + 1}. ${p.answer}`);
        if (p.reasoning) {
          deps.io.print(`        ↳ ${p.reasoning}`);
        }
      }
      deps.io.print('');
      deps.io.print(
        `   Pick 1–${proposals.length}, type your own answer, 's' skip / 'sa' skip all remaining / 'a' abort:`,
      );
    } else {
      deps.io.print(
        "   Type your answer, 's' skip / 'sa' skip all remaining / 'a' abort:",
      );
    }

    const reply = (await deps.io.ask('   > ')).trim();
    const lower = reply.toLowerCase();

    if (ABORT_TOKENS.has(lower)) {
      deps.io.print('   ⏹  aborted by operator');
      // Files for ALL remaining unresolved questions stay blocked.
      for (let j = idx; j < unanswered.length; j += 1) {
        blockedFiles.add(unanswered[j]!.filePath);
      }
      return {
        blockedFiles,
        newAnswers,
        aborted: true,
        proposalTokenUsage: totalTokens,
        totalQuestions: allQuestions.length,
        alreadyAnswered,
      };
    }

    if (SKIP_ALL_TOKENS.has(lower)) {
      // Skip THIS question and every remaining question for this run.
      // Different from abort: the grind still proceeds for unblocked
      // files. Different from `s`: doesn't ask 35 more times.
      for (let j = idx; j < unanswered.length; j += 1) {
        blockedFiles.add(unanswered[j]!.filePath);
      }
      const remaining = unanswered.length - idx;
      deps.io.print(
        `   ⏭⏭  skipped this and ${remaining - 1} remaining question(s) — grind continues on unblocked files`,
      );
      break;
    }

    if (!reply || SKIP_TOKENS.has(lower)) {
      blockedFiles.add(q.filePath);
      deps.io.print('   ⏭  skipped this run');
      continue;
    }

    // Numeric pick → use the corresponding proposal verbatim.
    const numeric = Number.parseInt(reply, 10);
    let chosenAnswer: string;
    if (
      !Number.isNaN(numeric) &&
      reply === String(numeric) &&
      numeric >= 1 &&
      numeric <= proposals.length
    ) {
      chosenAnswer = proposals[numeric - 1]!.answer;
      deps.io.print(`   ✓ accepted proposal #${numeric}`);
    } else {
      // Anything else is treated as a free-text answer.
      chosenAnswer = reply;
      deps.io.print('   ✓ saved your answer');
    }

    const stored: StoredAnswer = {
      hash: q.hash,
      filePath: q.filePath,
      line: q.line,
      question: q.text,
      answer: chosenAnswer,
      answeredAt: new Date().toISOString(),
    };
    deps.store.saveAnswer(stored);
    newAnswers.push(stored);
  }

  deps.io.print('');
  return {
    blockedFiles,
    newAnswers,
    aborted: false,
    proposalTokenUsage: totalTokens,
    totalQuestions: allQuestions.length,
    alreadyAnswered,
  };
}

function buildProposalContext(
  q: DomainQuestion,
  deps: TriageDeps,
): ProposalContext {
  const readFile =
    deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const readClaudeMd =
    deps.readClaudeMd ??
    (() => {
      try {
        return readFileSync(resolve(deps.repoRoot, 'CLAUDE.md'), 'utf8');
      } catch {
        return '';
      }
    });

  let fileContent = '';
  try {
    fileContent = readFile(resolve(deps.repoRoot, q.filePath));
  } catch {
    // File missing or unreadable — proposer can still emit useful
    // candidates from the question text alone. Empty string is safe.
  }

  return {
    fileContent,
    priorAnswers: deps.store.listAnswers(),
    claudeMd: readClaudeMd(),
  };
}
