import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DomainAnswerStore,
  type LLMCaller,
} from 'asil-improvement-loop';
import { triageDomainQuestions } from '../triage.js';

interface MockRunner {
  run: (
    cmd: string,
    args: string[],
    opts: { cwd: string },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function mkRunner(grepStdout: string): MockRunner {
  return {
    async run() {
      return { stdout: grepStdout, stderr: '', exitCode: 0 };
    },
  };
}

function mkLLM(content: string): LLMCaller & {
  calls: Array<{ system: string; user: string; model: string }>;
} {
  const calls: Array<{ system: string; user: string; model: string }> = [];
  return {
    calls,
    async call(system, user, model) {
      calls.push({ system, user, model });
      return { content, inputTokens: 100, outputTokens: 50 };
    },
  };
}

function mkIO(): {
  print: (msg: string) => void;
  ask: (prompt: string) => Promise<string>;
  output: string[];
  feed: (replies: string[]) => void;
} {
  const output: string[] = [];
  const queue: string[] = [];
  return {
    output,
    feed: (replies) => queue.push(...replies),
    print: (msg) => output.push(msg),
    ask: async () => queue.shift() ?? '',
  };
}

const proposalsContent = JSON.stringify({
  proposals: [
    { answer: 'option A', reasoning: 'because A' },
    { answer: 'option B', reasoning: 'because B' },
    { answer: 'option C', reasoning: 'because C' },
  ],
});

describe('triageDomainQuestions', () => {
  let dir: string;
  let storePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-'));
    storePath = join(dir, 'domain-answers.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns no blockers and no prompts when no domain questions exist', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner(''),
      llm: mkLLM(proposalsContent),
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(result.totalQuestions).toBe(0);
    expect(result.blockedFiles.size).toBe(0);
    expect(result.aborted).toBe(false);
    // Nothing was printed — no prompt was needed.
    expect(io.output.length).toBe(0);
  });

  it('skips proposal generation entirely when every question is already answered', async () => {
    const store = new DomainAnswerStore(storePath);
    // Pre-seed the answer for the question we'll surface from grep.
    const grepOut = './a.ts:1:// DOMAIN_QUESTION: How to do X?';
    const llm = mkLLM(proposalsContent);
    // Compute what the hash will be by issuing the same call.
    const { hashQuestion } = await import('asil-improvement-loop');
    store.saveAnswer({
      hash: hashQuestion('How to do X?'),
      filePath: 'a.ts',
      line: 1,
      question: 'How to do X?',
      answer: 'do it like Y',
      answeredAt: 't',
    });
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner(grepOut),
      llm,
      store,
      io: mkIO(),
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(result.totalQuestions).toBe(1);
    expect(result.alreadyAnswered).toBe(1);
    expect(result.blockedFiles.size).toBe(0);
    // No LLM call — proposals are only generated for unanswered questions.
    expect(llm.calls.length).toBe(0);
  });

  it('numeric pick saves the corresponding proposal as the answer', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    io.feed(['2']);
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner('./a.ts:1:// DOMAIN_QUESTION: How to do X?'),
      llm: mkLLM(proposalsContent),
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(result.aborted).toBe(false);
    expect(result.blockedFiles.size).toBe(0);
    expect(result.newAnswers.length).toBe(1);
    expect(result.newAnswers[0]?.answer).toBe('option B');
    // Persisted to the store (next run picks it up).
    expect(store.listAnswers().length).toBe(1);
  });

  it('free-text reply saves the verbatim text as the answer', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    io.feed(['my custom answer that is none of the above']);
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner('./a.ts:1:// DOMAIN_QUESTION: How to do X?'),
      llm: mkLLM(proposalsContent),
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(result.newAnswers[0]?.answer).toBe(
      'my custom answer that is none of the above',
    );
  });

  it('`s` skip blocks the file for this run without saving an answer', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    io.feed(['s']);
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner('./pkg/foo.ts:7:// DOMAIN_QUESTION: How?'),
      llm: mkLLM(proposalsContent),
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(result.blockedFiles.has('pkg/foo.ts')).toBe(true);
    expect(result.newAnswers.length).toBe(0);
    expect(store.listAnswers().length).toBe(0);
  });

  it('empty reply also counts as skip (no accidental empty-string answer)', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    io.feed(['']);
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner('./pkg/foo.ts:7:// DOMAIN_QUESTION: How?'),
      llm: mkLLM(proposalsContent),
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(result.blockedFiles.has('pkg/foo.ts')).toBe(true);
    expect(result.newAnswers.length).toBe(0);
  });

  it('`sa` skip-all blocks every remaining question but does NOT abort the grind', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    // Answer the first question, then skip-all the rest.
    io.feed(['1', 'sa']);
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner(
        [
          './a.ts:1:// DOMAIN_QUESTION: q1',
          './b.ts:2:// DOMAIN_QUESTION: q2',
          './c.ts:3:// DOMAIN_QUESTION: q3',
          './d.ts:4:// DOMAIN_QUESTION: q4',
        ].join('\n'),
      ),
      llm: mkLLM(proposalsContent),
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    // First answer accepted; b/c/d all blocked by skip-all (b was the
    // current question when sa was typed, so it's in the blocked set too).
    expect(result.aborted).toBe(false);
    expect(result.newAnswers.length).toBe(1);
    expect(result.blockedFiles.has('a.ts')).toBe(false); // answered
    expect(result.blockedFiles.has('b.ts')).toBe(true);
    expect(result.blockedFiles.has('c.ts')).toBe(true);
    expect(result.blockedFiles.has('d.ts')).toBe(true);
  });

  it('skip-all is recognized via `sa`, `SA`, and `skip-all` aliases (NOT a bare `S`)', async () => {
    for (const token of ['sa', 'SA', 'skip-all', 'Skipall']) {
      const store = new DomainAnswerStore(
        join(mkdtempSync(join(tmpdir(), `triage-${token}-`)), 'a.json'),
      );
      const io = mkIO();
      io.feed([token]);
      const result = await triageDomainQuestions({
        repoRoot: '/repo',
        runner: mkRunner(
          [
            './a.ts:1:// DOMAIN_QUESTION: q1',
            './b.ts:2:// DOMAIN_QUESTION: q2',
          ].join('\n'),
        ),
        llm: mkLLM(proposalsContent),
        store,
        io,
        readClaudeMd: () => '',
        readFile: () => '',
      });
      expect(result.aborted).toBe(false);
      expect(result.blockedFiles.size).toBe(2);
    }
  });

  it('a bare uppercase `S` is treated as single-skip (case-insensitive `s`), NOT as skip-all — prevents accidental skip-all from stray capital lock', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    io.feed(['S', 's']);
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner(
        [
          './a.ts:1:// DOMAIN_QUESTION: q1',
          './b.ts:2:// DOMAIN_QUESTION: q2',
        ].join('\n'),
      ),
      llm: mkLLM(proposalsContent),
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    // `S` skipped only the first question (single-skip behavior), then
    // we still got asked about the second. If `S` had triggered skip-all,
    // we'd never have been prompted for `s` (the second feed entry).
    expect(result.aborted).toBe(false);
    expect(result.newAnswers.length).toBe(0);
    expect(result.blockedFiles.has('a.ts')).toBe(true);
    expect(result.blockedFiles.has('b.ts')).toBe(true);
    expect(result.blockedFiles.size).toBe(2);
  });

  it('`a` abort short-circuits and blocks every remaining question', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    io.feed(['a']); // abort on the first question
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner(
        [
          './a.ts:1:// DOMAIN_QUESTION: q1',
          './b.ts:2:// DOMAIN_QUESTION: q2',
          './c.ts:3:// DOMAIN_QUESTION: q3',
        ].join('\n'),
      ),
      llm: mkLLM(proposalsContent),
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(result.aborted).toBe(true);
    expect(result.blockedFiles.size).toBe(3);
    expect(result.blockedFiles.has('a.ts')).toBe(true);
    expect(result.blockedFiles.has('b.ts')).toBe(true);
    expect(result.blockedFiles.has('c.ts')).toBe(true);
  });

  it('proposals are cached after first generation (no LLM call on second run for same hash)', async () => {
    const store = new DomainAnswerStore(storePath);
    const llm = mkLLM(proposalsContent);

    // First run: generate proposals, then skip.
    const ioA = mkIO();
    ioA.feed(['s']);
    await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner('./a.ts:1:// DOMAIN_QUESTION: How?'),
      llm,
      store,
      io: ioA,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(llm.calls.length).toBe(1);

    // Second run: same question, cached proposals — no new LLM call.
    const ioB = mkIO();
    ioB.feed(['1']);
    await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner('./a.ts:1:// DOMAIN_QUESTION: How?'),
      llm,
      store,
      io: ioB,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(llm.calls.length).toBe(1); // unchanged
  });

  it('falls back to free-text-only prompt when proposal generation throws', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    io.feed(['my answer']);
    const llmThatFails: LLMCaller = {
      async call() {
        throw new Error('llm down');
      },
    };
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner('./a.ts:1:// DOMAIN_QUESTION: How?'),
      llm: llmThatFails,
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    // Triage still completed with a free-text answer.
    expect(result.newAnswers[0]?.answer).toBe('my answer');
    // The fallback notice was printed.
    expect(io.output.some((l) => /proposal generation failed/i.test(l))).toBe(
      true,
    );
  });

  it('mixes accepted, free-text, and skipped answers in a single pass', async () => {
    const store = new DomainAnswerStore(storePath);
    const io = mkIO();
    // 3 questions: accept proposal 1, free-text the second, skip the third.
    io.feed(['1', 'custom answer', 's']);
    const result = await triageDomainQuestions({
      repoRoot: '/repo',
      runner: mkRunner(
        [
          './a.ts:1:// DOMAIN_QUESTION: q1',
          './b.ts:2:// DOMAIN_QUESTION: q2',
          './c.ts:3:// DOMAIN_QUESTION: q3',
        ].join('\n'),
      ),
      llm: mkLLM(proposalsContent),
      store,
      io,
      readClaudeMd: () => '',
      readFile: () => '',
    });
    expect(result.aborted).toBe(false);
    expect(result.newAnswers.length).toBe(2);
    expect(result.newAnswers[0]?.answer).toBe('option A');
    expect(result.newAnswers[1]?.answer).toBe('custom answer');
    expect(result.blockedFiles.has('c.ts')).toBe(true);
    expect(result.blockedFiles.size).toBe(1);
  });
});
