import { describe, expect, it } from 'vitest';
import { selfReview } from '../self-review.js';
import type { ExecutionResult } from '../types.js';
import { allPersonas, mockLLM, personaResponse, SAMPLE_DIFF } from './helpers.js';

function mkExecution(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    taskId: 't1',
    success: true,
    diff: SAMPLE_DIFF,
    filesChanged: ['a.ts'],
    testsRun: true,
    testsPassed: true,
    typeCheckPassed: true,
    executionLog: 'ok',
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  };
}

describe('selfReview', () => {
  it('all personas approve → recommendation=proceed', async () => {
    const llm = mockLLM(
      allPersonas({
        'code-reviewer': personaResponse({ approved: true }),
        'security-auditor': personaResponse({ approved: true }),
        'test-engineer': personaResponse({ approved: true }),
      }),
    );
    const result = await selfReview(mkExecution(), llm, 'sonnet');
    expect(result.allApproved).toBe(true);
    expect(result.recommendation).toBe('proceed');
    expect(result.reviews.length).toBe(3);
  });

  it('one rejection → recommendation=revise', async () => {
    const llm = mockLLM(
      allPersonas({
        'code-reviewer': personaResponse({ approved: true }),
        'security-auditor': personaResponse({
          approved: false,
          concerns: ['secret in log'],
        }),
        'test-engineer': personaResponse({ approved: true }),
      }),
    );
    const result = await selfReview(mkExecution(), llm, 'sonnet');
    expect(result.allApproved).toBe(false);
    expect(result.recommendation).toBe('revise');
    expect(result.aggregatedConcerns).toContain('secret in log');
  });

  it('two or more rejections → recommendation=reject', async () => {
    const llm = mockLLM(
      allPersonas({
        'code-reviewer': personaResponse({
          approved: false,
          concerns: ['bad naming'],
        }),
        'security-auditor': personaResponse({
          approved: false,
          concerns: ['missing validation'],
        }),
        'test-engineer': personaResponse({ approved: true }),
      }),
    );
    const result = await selfReview(mkExecution(), llm, 'sonnet');
    expect(result.recommendation).toBe('reject');
  });

  it('unparseable response fails closed (persona rejects)', async () => {
    const llm = mockLLM(
      allPersonas({
        'code-reviewer': 'not json at all',
        'security-auditor': personaResponse({ approved: true }),
        'test-engineer': personaResponse({ approved: true }),
      }),
    );
    const result = await selfReview(mkExecution(), llm, 'sonnet');
    const cr = result.reviews.find((r) => r.persona === 'code-reviewer');
    expect(cr?.approved).toBe(false);
    expect(cr?.concerns[0]).toMatch(/unparseable/i);
  });

  it('token usage recorded per persona', async () => {
    const llm = mockLLM(
      allPersonas({
        'code-reviewer': personaResponse({ approved: true }),
        'security-auditor': personaResponse({ approved: true }),
        'test-engineer': personaResponse({ approved: true }),
      }),
      { inputTokens: 123, outputTokens: 45 },
    );
    const result = await selfReview(mkExecution(), llm, 'sonnet');
    for (const r of result.reviews) {
      expect(r.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(r.tokenUsage.outputTokens).toBeGreaterThan(0);
    }
  });

  it('all three personas are called', async () => {
    const llm = mockLLM(
      allPersonas({
        'code-reviewer': personaResponse({ approved: true }),
        'security-auditor': personaResponse({ approved: true }),
        'test-engineer': personaResponse({ approved: true }),
      }),
    );
    await selfReview(mkExecution(), llm, 'sonnet');
    expect(llm.calls.length).toBe(3);
  });
});
