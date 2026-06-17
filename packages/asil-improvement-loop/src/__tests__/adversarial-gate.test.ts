import { describe, expect, it } from 'vitest';
import {
  adversarialReview,
  buildAdversarialPrompt,
  parseAdversarialResponse,
} from '../adversarial-gate.js';
import type { ExecutionResult, SelfReviewResult } from '../types.js';
import { mockCodex, SAMPLE_DIFF } from './helpers.js';

function mkExecution(): ExecutionResult {
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
  };
}

function mkSelfReview(allApproved = true): SelfReviewResult {
  return {
    taskId: 't1',
    reviews: [],
    allApproved,
    aggregatedConcerns: allApproved ? [] : ['something'],
    recommendation: allApproved ? 'proceed' : 'revise',
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe('adversarial-gate', () => {
  it('buildAdversarialPrompt embeds the diff and the self-review summary', () => {
    const prompt = buildAdversarialPrompt(mkExecution(), mkSelfReview(false));
    expect(prompt).toContain('diff --git');
    expect(prompt).toMatch(/All approved: false/);
    expect(prompt).toMatch(/Concerns raised: something/);
  });

  it('parseAdversarialResponse handles a clean pass', () => {
    const out = parseAdversarialResponse(
      't1',
      JSON.stringify({
        approved: true,
        reasoning: 'nothing wrong',
        issuesFound: [],
        severity: 'pass',
      }),
    );
    expect(out.approved).toBe(true);
    expect(out.severity).toBe('pass');
  });

  it('parseAdversarialResponse rejects invalid severity values', () => {
    const out = parseAdversarialResponse(
      't1',
      JSON.stringify({ approved: true, severity: 'unknown' }),
    );
    expect(out.severity).toBe('reject');
  });

  it('parseAdversarialResponse fails closed on unparseable content', () => {
    const out = parseAdversarialResponse('t1', 'not json');
    expect(out.approved).toBe(false);
    expect(out.severity).toBe('reject');
    expect(out.reasoning).toMatch(/unparseable/i);
  });

  it('adversarialReview approves a clean diff with severity=pass', async () => {
    const codex = mockCodex(
      JSON.stringify({
        approved: true,
        reasoning: 'clean',
        issuesFound: [],
        severity: 'pass',
      }),
    );
    const result = await adversarialReview(
      mkExecution(),
      mkSelfReview(),
      codex,
      'codex-mini',
    );
    expect(result.approved).toBe(true);
    expect(result.severity).toBe('pass');
  });

  it('adversarialReview rejects when codex flags major issues', async () => {
    const codex = mockCodex(
      JSON.stringify({
        approved: false,
        reasoning: 'secret logged',
        issuesFound: ['PII in logs'],
        severity: 'major-issues',
      }),
    );
    const result = await adversarialReview(
      mkExecution(),
      mkSelfReview(),
      codex,
      'codex-mini',
    );
    expect(result.approved).toBe(false);
    expect(result.severity).toBe('major-issues');
    expect(result.issuesFound).toContain('PII in logs');
  });

  it('unparseable codex response rejects the change (fail closed)', async () => {
    const codex = mockCodex('not even close to json');
    const result = await adversarialReview(
      mkExecution(),
      mkSelfReview(),
      codex,
      'codex-mini',
    );
    expect(result.approved).toBe(false);
    expect(result.severity).toBe('reject');
  });

  it('the adversarial prompt scopes review to the diff and includes skepticism cues', async () => {
    const codex = mockCodex(JSON.stringify({ approved: true, severity: 'pass' }));
    await adversarialReview(mkExecution(), mkSelfReview(), codex, 'codex-mini');
    expect(codex.calls[0]?.prompt).toMatch(/adversarial/i);
    expect(codex.calls[0]?.prompt).toMatch(/INTRODUCED BY THE DIFF/i);
    expect(codex.calls[0]?.prompt).toMatch(/Be skeptical/i);
  });
});
