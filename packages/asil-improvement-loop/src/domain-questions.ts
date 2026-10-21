/**
 * Domain-question detection, persistence, and context injection.
 *
 * `// DOMAIN_QUESTION:` markers are explicitly "ask Dušan" — per the
 * the project CLAUDE.md domain rule, these are gaps in domain knowledge that
 * the autonomous loop must NOT guess at. The loop's job here is:
 *
 *   1. Find them all (scan).
 *   2. Block files containing unresolved questions from any autonomous
 *      task — touching code with pending questions risks decisions in
 *      the wrong design direction.
 *   3. Surface them to the human at grind start with proposed answers
 *      so triage takes seconds, not minutes.
 *   4. Persist answers (hash-keyed, so re-wording the comment forces a
 *      fresh decision) and inject them as context into future LLM
 *      calls in the same file — the model gets Dušan's verdicts and
 *      stays consistent with them.
 *
 * Persistence intentionally lives in `autonomous/domain-answers.json`,
 * NOT `autonomous/.usage-data/` — answers are shared across machines
 * (committed to git), unlike the per-developer usage logs.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { resolveGrindStatePath } from './paths.js';
import type { CommandRunner } from './scanner.js';
import { normalizePath } from './scanner.js';

export interface DomainQuestion {
  /** sha256 of (repo-relative file path + normalized question text).
   *  Survives minor whitespace/case edits; breaks if the question is
   *  reworded OR moved to a different file (a different file's identical
   *  wording is a distinct question). (Codex review #7.) */
  hash: string;
  /** Repo-relative path to the file containing the marker. */
  filePath: string;
  /** 1-based line number of the marker in the file. */
  line: number;
  /** The question itself (the text after `DOMAIN_QUESTION:`). */
  text: string;
  /** The full original comment line (with leading slashes/whitespace). */
  rawLine: string;
}

export interface StoredAnswer {
  hash: string;
  filePath: string;
  line: number;
  question: string;
  answer: string;
  /** ISO timestamp of when the answer was recorded. */
  answeredAt: string;
}

export interface ProposedAnswer {
  /** The proposal itself — short, concrete, ready to paste. */
  answer: string;
  /** One-sentence reasoning so the operator can compare options at a glance. */
  reasoning: string;
}

export interface QuestionProposals {
  hash: string;
  proposals: ProposedAnswer[];
  generatedAt: string;
  model: string;
}

/** sha256 of the question text after normalization. Whitespace and case
 *  changes don't invalidate the answer; reordering words DOES (different
 *  sentence = different question, ask again). */
export function hashQuestion(filePath: string, text: string): string {
  // Composite key: file path + normalized question text. Without the
  // path, two different files asking the same question (e.g. "What is
  // the grace period?") collapsed to one answer — answering it in file A
  // silently unblocked file B with A's answer. (Codex review #7.)
  // Whitespace/case-insensitive on the text so trivial edits don't
  // re-prompt; rewording or a different file DOES re-prompt.
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256')
    .update(`${normalizePath(filePath)}\0${normalized}`)
    .digest('hex');
}

/**
 * Find every `// DOMAIN_QUESTION:` marker under repoRoot via grep.
 *
 * The regex requires THREE things to count as a marker:
 *   1. Line begins with optional whitespace.
 *   2. Then a comment opener — `//`, `*` (jsdoc/block comment line), or `#`.
 *   3. Then `DOMAIN_QUESTION:` with the colon.
 *
 * This excludes false positives that previously polluted the scan:
 *   - String literals containing the word DOMAIN_QUESTION (the proposer
 *     system prompt, this module's own docstrings, etc.)
 *   - Help text like `List unresolved DOMAIN_QUESTION markers` in the CLI
 *   - Anything that mentions the marker in passing
 *
 * Same exclusion list as the rest of the scanner so node_modules and
 * dist don't pollute results.
 */
export async function findDomainQuestions(args: {
  repoRoot: string;
  runner: CommandRunner;
}): Promise<DomainQuestion[]> {
  const { stdout } = await args.runner.run(
    'grep',
    [
      '-rn',
      '--exclude-dir=node_modules',
      '--exclude-dir=dist',
      '--exclude-dir=.git',
      '--exclude-dir=.next',
      '--exclude-dir=coverage',
      '--exclude-dir=design',
      '--include=*.ts',
      '--include=*.tsx',
      '-E',
      // Regex parts (described abstractly to avoid self-matching the
      // literal marker inside this very file — see prior bug):
      //   ^[ \t]*       optional leading whitespace
      //   (//|\*|#)     comment opener (line, jsdoc, hash)
      //   [ \t]*        optional space after opener
      //   <MARKER>:     literal marker token followed by a colon
      '^[ \\t]*(//|\\*|#)[ \\t]*DOMAIN_QUESTION:',
      '.',
    ],
    { cwd: args.repoRoot },
  );
  if (!stdout.trim()) return [];

  const questions: DomainQuestion[] = [];
  // grep line: ./path/file.ts:42:    // DOMAIN_QUESTION: how does X work?
  const lineRe = /^(.+?):(\d+):(.*)$/;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (!m) continue;
    const [, rawFile, lnStr, raw] = m;
    if (!rawFile || !lnStr || raw === undefined) continue;
    const filePath = normalizePath(rawFile);
    const lineNum = Number.parseInt(lnStr, 10);
    if (Number.isNaN(lineNum)) continue;

    // Extract the question text after the colon. Colon is now required
    // — `DOMAIN_QUESTION` followed by a space alone is not a marker.
    const qMatch = raw.match(/DOMAIN_QUESTION:\s*(.*?)\s*$/);
    if (!qMatch) continue;
    const text = qMatch[1] ?? '';
    if (!text) continue;

    questions.push({
      hash: hashQuestion(filePath, text),
      filePath,
      line: lineNum,
      text,
      rawLine: raw.trim(),
    });
  }
  return questions;
}

interface PersistedState {
  version: 1;
  answers: StoredAnswer[];
  proposals: QuestionProposals[];
}

/**
 * JSON-file-backed store for resolved answers and cached proposals.
 *
 * Defaults under the grind state root (temp unless `ASIL_STATE_DIR` is
 * set). Operators who want shared answers can point
 * `ASIL_DOMAIN_ANSWERS_PATH` at a tracked file.
 */
export class DomainAnswerStore {
  private state: PersistedState;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  /** Path to the persisted ledger (for tooling that wants to display it). */
  get filePath(): string {
    return this.path;
  }

  listAnswers(): readonly StoredAnswer[] {
    return this.state.answers;
  }

  getAnswer(hash: string): StoredAnswer | undefined {
    return this.state.answers.find((a) => a.hash === hash);
  }

  saveAnswer(answer: StoredAnswer): void {
    // Replace any existing answer for the same hash — last write wins.
    this.state.answers = this.state.answers.filter((a) => a.hash !== answer.hash);
    this.state.answers.push(answer);
    this.persist();
  }

  getProposals(hash: string): QuestionProposals | undefined {
    return this.state.proposals.find((p) => p.hash === hash);
  }

  saveProposals(p: QuestionProposals): void {
    this.state.proposals = this.state.proposals.filter((x) => x.hash !== p.hash);
    this.state.proposals.push(p);
    this.persist();
  }

  /** Returns answers whose `filePath` matches one of the supplied paths. */
  answersForFiles(filePaths: readonly string[]): StoredAnswer[] {
    const set = new Set(filePaths);
    return this.state.answers.filter((a) => set.has(a.filePath));
  }

  private load(): PersistedState {
    if (!existsSync(this.path)) {
      return { version: 1, answers: [], proposals: [] };
    }
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        version: 1,
        answers: Array.isArray(parsed.answers) ? parsed.answers : [],
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      };
    } catch {
      // Corrupted ledger → fresh state. Don't crash the loop because
      // the JSON file got malformed by hand-editing.
      return { version: 1, answers: [], proposals: [] };
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2), 'utf8');
  }
}

/**
 * Format the "Domain context from Dušan" block that gets injected into
 * the executor's user prompt. Only includes answers for files this task
 * actually touches — keeps the prompt tight and relevant.
 */
export function buildDomainAnswerContext(
  filePaths: readonly string[],
  store: Pick<DomainAnswerStore, 'answersForFiles'>,
): string {
  const relevant = store.answersForFiles(filePaths);
  if (relevant.length === 0) return '';

  const lines = ['## Domain context (from Dušan, the human source of truth)', ''];
  for (const a of relevant) {
    lines.push(`- \`${a.filePath}:${a.line}\``);
    lines.push(`  Q: ${a.question}`);
    lines.push(`  A: ${a.answer}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Convenience factory used by the runner. Defaults under the grind
 *  state root (`tmpdir()/asil-state-<hash>` unless `ASIL_STATE_DIR` is
 *  set). Overridable via `ASIL_DOMAIN_ANSWERS_PATH`. */
export function createDomainAnswerStore(repoRoot: string): DomainAnswerStore {
  const path = resolveGrindStatePath(
    repoRoot,
    process.env.ASIL_DOMAIN_ANSWERS_PATH,
    '.asil/domain-answers.json',
  );
  return new DomainAnswerStore(path);
}
