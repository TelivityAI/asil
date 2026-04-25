import { describe, expect, it } from 'vitest';
import {
  generateProposals,
  parseProposals,
} from '../domain-question-proposer.js';
import type { DomainQuestion, StoredAnswer } from '../domain-questions.js';

function mkQuestion(overrides: Partial<DomainQuestion> = {}): DomainQuestion {
  return {
    hash: 'h1',
    filePath: 'packages/foo/src/bar.ts',
    line: 42,
    text: 'How does BSP settlement timing affect refund eligibility?',
    rawLine: '// DOMAIN_QUESTION: How does BSP settlement timing affect refund eligibility?',
    ...overrides,
  };
}

describe('parseProposals', () => {
  it('parses a clean JSON envelope', () => {
    const out = parseProposals(
      JSON.stringify({
        proposals: [
          { answer: 'a1', reasoning: 'r1' },
          { answer: 'a2', reasoning: 'r2' },
        ],
      }),
    );
    expect(out).toEqual([
      { answer: 'a1', reasoning: 'r1' },
      { answer: 'a2', reasoning: 'r2' },
    ]);
  });

  it('strips a ```json fence wrapper', () => {
    const out = parseProposals(
      '```json\n' +
        JSON.stringify({ proposals: [{ answer: 'a', reasoning: 'r' }] }) +
        '\n```',
    );
    expect(out.length).toBe(1);
    expect(out[0]?.answer).toBe('a');
  });

  it('returns [] on unparseable JSON', () => {
    expect(parseProposals('I am sorry, I cannot help.')).toEqual([]);
  });

  it('drops entries without an answer string', () => {
    const out = parseProposals(
      JSON.stringify({
        proposals: [
          { answer: 'good', reasoning: 'r' },
          { reasoning: 'orphan' },
          { answer: '', reasoning: 'empty' },
          { answer: 42 }, // wrong type
        ],
      }),
    );
    expect(out.length).toBe(1);
    expect(out[0]?.answer).toBe('good');
  });

  it('tolerates a missing reasoning field', () => {
    const out = parseProposals(
      JSON.stringify({ proposals: [{ answer: 'a' }] }),
    );
    expect(out).toEqual([{ answer: 'a', reasoning: '' }]);
  });
});

describe('generateProposals', () => {
  it('uses Opus by default and feeds the question + file content + prior answers + CLAUDE.md to the LLM', async () => {
    const calls: Array<{ system: string; user: string; model: string }> = [];
    const llm = {
      async call(system: string, user: string, model: string) {
        calls.push({ system, user, model });
        return {
          content: JSON.stringify({
            proposals: [
              { answer: 'one', reasoning: 'why one' },
              { answer: 'two', reasoning: 'why two' },
              { answer: 'three', reasoning: 'why three' },
            ],
          }),
          inputTokens: 1000,
          outputTokens: 200,
        };
      },
    };
    const result = await generateProposals({
      question: mkQuestion(),
      context: {
        fileContent: 'export const refund = () => {};',
        priorAnswers: [
          {
            hash: 'h-prior',
            filePath: 'a.ts',
            line: 1,
            question: 'prior q',
            answer: 'prior a',
            answeredAt: 't',
          } satisfies StoredAnswer,
        ],
        claudeMd: '# CLAUDE.md\nDomain rule: BSP-led refunds.',
      },
      llm,
    });
    expect(result.proposals.proposals.length).toBe(3);
    expect(result.proposals.model).toBe('opus');
    expect(result.tokenUsage).toEqual({ inputTokens: 1000, outputTokens: 200 });
    expect(calls.length).toBe(1);
    // Prompt must contain ALL the context the proposer is supposed to ground in.
    expect(calls[0]?.user).toContain('BSP settlement');
    expect(calls[0]?.user).toContain('export const refund');
    expect(calls[0]?.user).toContain('prior q');
    expect(calls[0]?.user).toContain('Domain rule: BSP-led refunds');
    // System prompt enforces the JSON format and domain-question rules.
    expect(calls[0]?.system).toMatch(/domain-knowledge assistant/);
    expect(calls[0]?.system).toMatch(/JSON/);
    expect(calls[0]?.system).toMatch(/CLAUDE\.md/);
  });

  it('honours an explicit model option', async () => {
    let capturedModel = '';
    const llm = {
      async call(_s: string, _u: string, model: string) {
        capturedModel = model;
        return {
          content: JSON.stringify({ proposals: [{ answer: 'a', reasoning: 'r' }] }),
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    };
    await generateProposals({
      question: mkQuestion(),
      context: { fileContent: '', priorAnswers: [] },
      llm,
      options: { model: 'sonnet' },
    });
    expect(capturedModel).toBe('sonnet');
  });

  it('caps the proposal count to the requested limit', async () => {
    const llm = {
      async call() {
        return {
          content: JSON.stringify({
            proposals: [
              { answer: '1', reasoning: '' },
              { answer: '2', reasoning: '' },
              { answer: '3', reasoning: '' },
              { answer: '4', reasoning: '' },
            ],
          }),
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    };
    const result = await generateProposals({
      question: mkQuestion(),
      context: { fileContent: '', priorAnswers: [] },
      llm,
      options: { proposalCount: 2 },
    });
    expect(result.proposals.proposals.length).toBe(2);
  });

  it('returns zero proposals when the LLM produces unparseable output', async () => {
    const llm = {
      async call() {
        return { content: 'sorry, no idea', inputTokens: 0, outputTokens: 0 };
      },
    };
    const result = await generateProposals({
      question: mkQuestion(),
      context: { fileContent: '', priorAnswers: [] },
      llm,
    });
    expect(result.proposals.proposals).toEqual([]);
  });
});
