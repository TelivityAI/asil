import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DomainAnswerStore,
  buildDomainAnswerContext,
  findDomainQuestions,
  hashQuestion,
} from '../domain-questions.js';
import { mockRunner } from './helpers.js';

describe('hashQuestion', () => {
  it('is deterministic for the same input', () => {
    expect(hashQuestion('How does X work?')).toBe(hashQuestion('How does X work?'));
  });

  it('normalizes whitespace and case (re-formatting does not invalidate the answer)', () => {
    expect(hashQuestion('How does X work?')).toBe(
      hashQuestion('  HOW DOES   X work?  '),
    );
  });

  it('returns a different hash when the question is reworded', () => {
    expect(hashQuestion('How does X work?')).not.toBe(
      hashQuestion('How does Y work?'),
    );
  });

  it('returns a 64-char hex sha256', () => {
    expect(hashQuestion('test')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('findDomainQuestions', () => {
  it('returns [] when grep finds nothing', async () => {
    const runner = mockRunner([{ match: () => true, stdout: '' }]);
    expect(await findDomainQuestions({ repoRoot: '/repo', runner })).toEqual([]);
  });

  it('parses grep output into structured questions, normalizing ./ prefix', async () => {
    const grepOut = [
      './packages/orchestrator/src/foo.ts:142:    // DOMAIN_QUESTION: How does BSP settlement timing affect refund eligibility?',
      './packages/policy-engine/src/rules/approval.ts:58:// DOMAIN_QUESTION: What is the escalation chain for over-policy CFO travel?',
    ].join('\n');
    const runner = mockRunner([{ match: () => true, stdout: grepOut }]);
    const questions = await findDomainQuestions({ repoRoot: '/repo', runner });
    expect(questions.length).toBe(2);
    expect(questions[0]?.filePath).toBe(
      'packages/orchestrator/src/foo.ts',
    );
    expect(questions[0]?.line).toBe(142);
    expect(questions[0]?.text).toBe(
      'How does BSP settlement timing affect refund eligibility?',
    );
    expect(questions[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(questions[1]?.filePath).toBe(
      'packages/policy-engine/src/rules/approval.ts',
    );
  });

  it('skips lines without a colon delimiter or invalid line numbers', async () => {
    const runner = mockRunner([
      {
        match: () => true,
        stdout: 'malformed line without colons\n./foo.ts:abc:nope\n',
      },
    ]);
    expect(await findDomainQuestions({ repoRoot: '/repo', runner })).toEqual([]);
  });

  it('skips a marker with no question text after the colon', async () => {
    const runner = mockRunner([
      {
        match: () => true,
        stdout: './foo.ts:5:// DOMAIN_QUESTION: \n',
      },
    ]);
    expect(await findDomainQuestions({ repoRoot: '/repo', runner })).toEqual([]);
  });

  it('passes the standard exclude-dir flags so node_modules/dist do not pollute results', async () => {
    const calls: Array<{ args: string[] }> = [];
    const runner = {
      async run(cmd: string, args: string[]) {
        calls.push({ args });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    await findDomainQuestions({ repoRoot: '/repo', runner });
    const grepArgs = calls[0]?.args ?? [];
    expect(grepArgs).toContain('--exclude-dir=node_modules');
    expect(grepArgs).toContain('--exclude-dir=dist');
    // Searches BOTH .ts and .tsx — same lesson learned from scanDeadCode.
    expect(grepArgs).toContain('--include=*.ts');
    expect(grepArgs).toContain('--include=*.tsx');
  });

  it('grep regex requires comment context (//, *, #) AND a colon (regression: 41 false-positives from docstrings + help text)', async () => {
    const calls: Array<{ args: string[] }> = [];
    const runner = {
      async run(_cmd: string, args: string[]) {
        calls.push({ args });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    await findDomainQuestions({ repoRoot: '/repo', runner });
    // The regex must require BOTH a comment opener AND the colon.
    const regexArg = calls[0]?.args.find((a) => a.includes('DOMAIN_QUESTION'));
    expect(regexArg).toBeDefined();
    // Comment opener required (matches // OR * OR #, not arbitrary whitespace).
    expect(regexArg).toMatch(/\(\/\/\|.*\\\*\|#\)/);
    // Colon required after the marker (no `[: ]` lax alternative).
    expect(regexArg).toContain('DOMAIN_QUESTION:');
    expect(regexArg).not.toContain('DOMAIN_QUESTION[: ]');
  });

  it('rejects parser input that lacks a colon after the marker', async () => {
    // Even if grep somehow surfaces a non-colon line, the parser must
    // still reject it. This is the second line of defense.
    const grepOut = './x.ts:1:    // DOMAIN_QUESTION markers (no colon)';
    const runner = mockRunner([{ match: () => true, stdout: grepOut }]);
    expect(await findDomainQuestions({ repoRoot: '/repo', runner })).toEqual([]);
  });
});

describe('DomainAnswerStore', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'das-'));
    path = join(dir, 'domain-answers.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts empty when the ledger does not exist', () => {
    const store = new DomainAnswerStore(path);
    expect(store.listAnswers()).toEqual([]);
  });

  it('saves an answer and returns it via getAnswer(hash)', () => {
    const store = new DomainAnswerStore(path);
    const ans = {
      hash: 'h1',
      filePath: 'foo.ts',
      line: 1,
      question: 'q?',
      answer: 'a',
      answeredAt: '2026-04-25T00:00:00.000Z',
    };
    store.saveAnswer(ans);
    expect(store.getAnswer('h1')).toEqual(ans);
    expect(store.listAnswers()).toEqual([ans]);
  });

  it('replaces an existing answer for the same hash (last write wins)', () => {
    const store = new DomainAnswerStore(path);
    store.saveAnswer({
      hash: 'h1',
      filePath: 'a.ts',
      line: 1,
      question: 'q?',
      answer: 'first',
      answeredAt: 't1',
    });
    store.saveAnswer({
      hash: 'h1',
      filePath: 'a.ts',
      line: 1,
      question: 'q?',
      answer: 'second',
      answeredAt: 't2',
    });
    expect(store.listAnswers().length).toBe(1);
    expect(store.getAnswer('h1')?.answer).toBe('second');
  });

  it('persists to disk and reloads', () => {
    const s1 = new DomainAnswerStore(path);
    s1.saveAnswer({
      hash: 'h1',
      filePath: 'foo.ts',
      line: 1,
      question: 'q?',
      answer: 'a',
      answeredAt: 't',
    });
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('h1');
    const s2 = new DomainAnswerStore(path);
    expect(s2.getAnswer('h1')?.answer).toBe('a');
  });

  it('caches and retrieves proposals by hash', () => {
    const store = new DomainAnswerStore(path);
    const proposals = {
      hash: 'h1',
      proposals: [{ answer: 'p1', reasoning: 'r1' }],
      generatedAt: 't',
      model: 'opus',
    };
    store.saveProposals(proposals);
    expect(store.getProposals('h1')).toEqual(proposals);
  });

  it('answersForFiles returns only answers whose filePath matches', () => {
    const store = new DomainAnswerStore(path);
    store.saveAnswer({
      hash: 'h1',
      filePath: 'a.ts',
      line: 1,
      question: 'q1',
      answer: 'A1',
      answeredAt: 't',
    });
    store.saveAnswer({
      hash: 'h2',
      filePath: 'b.ts',
      line: 2,
      question: 'q2',
      answer: 'A2',
      answeredAt: 't',
    });
    const subset = store.answersForFiles(['a.ts']);
    expect(subset.length).toBe(1);
    expect(subset[0]?.answer).toBe('A1');
  });

  it('survives a corrupted ledger file (returns empty state)', () => {
    writeFileSync(path, '{not json', 'utf8');
    const store = new DomainAnswerStore(path);
    expect(store.listAnswers()).toEqual([]);
  });
});

describe('buildDomainAnswerContext', () => {
  it('returns an empty string when no relevant answers exist', () => {
    const store = new DomainAnswerStore(join(tmpdir(), 'empty-store'));
    expect(buildDomainAnswerContext(['a.ts'], store)).toBe('');
  });

  it('formats matched answers as a "Domain context from Dušan" section', () => {
    const store = new DomainAnswerStore(
      join(mkdtempSync(join(tmpdir(), 'ctx-')), 'domain-answers.json'),
    );
    store.saveAnswer({
      hash: 'h1',
      filePath: 'a.ts',
      line: 5,
      question: 'how?',
      answer: 'like this',
      answeredAt: 't',
    });
    const ctx = buildDomainAnswerContext(['a.ts'], store);
    expect(ctx).toContain('Domain context');
    expect(ctx).toContain('a.ts:5');
    expect(ctx).toContain('Q: how?');
    expect(ctx).toContain('A: like this');
  });
});
