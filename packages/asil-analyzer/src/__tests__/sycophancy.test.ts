import { describe, expect, it } from 'vitest';
import { detectSycophancy } from '../detectors/sycophancy.js';
import { mkCall, mkTask } from './helpers.js';

describe('detectSycophancy', () => {
  it('flags a reviewer whose opening echoes the proposer with no disagreement marker', () => {
    const proposer = mkCall({
      roleGuess: 'executor',
      responseContent:
        'The function refactors the parser to handle deeply nested expressions correctly. ' +
        'We introduce a new visitor pattern walking the AST. The handler tracks scope ' +
        'depth and accumulates errors without aborting at the first failure.',
    });
    const reviewer = mkCall({
      roleGuess: 'reviewer-code',
      responseContent:
        'The function refactors the parser to handle deeply nested expressions correctly. ' +
        'The visitor pattern walks the AST appropriately. Scope depth tracking and error accumulation are reasonable. ' +
        'LGTM, approve.',
    });
    const hits = detectSycophancy([mkTask('t1', [proposer, reviewer])]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.reviewerRole).toBe('reviewer-code');
    expect(hits[0]?.jaccard).toBeGreaterThanOrEqual(0.4);
  });

  it('does NOT flag when the reviewer opening contains a disagreement marker', () => {
    const proposer = mkCall({
      roleGuess: 'executor',
      responseContent:
        'The function refactors the parser to handle deeply nested expressions correctly.',
    });
    const reviewer = mkCall({
      roleGuess: 'reviewer-code',
      responseContent:
        'The function refactors the parser to handle deeply nested expressions correctly. ' +
        'However, the visitor lacks bounds checking — this could stack-overflow.',
    });
    const hits = detectSycophancy([mkTask('t1', [proposer, reviewer])]);
    expect(hits.length).toBe(0);
  });

  it('does NOT flag when there is no preceding executor call', () => {
    const reviewer = mkCall({
      roleGuess: 'reviewer-code',
      responseContent: 'Looks great, ship it.',
    });
    const hits = detectSycophancy([mkTask('t1', [reviewer])]);
    expect(hits.length).toBe(0);
  });

  it('considers adversarial gate calls as reviewers', () => {
    const proposer = mkCall({
      roleGuess: 'executor',
      responseContent: 'Adds rate limiting via a fixed-window counter with redis storage.',
    });
    const adversarial = mkCall({
      roleGuess: 'adversarial',
      responseContent:
        'Adds rate limiting via a fixed-window counter with redis storage. ' +
        'The redis storage and fixed window approach are sound. Approve.',
    });
    const hits = detectSycophancy([mkTask('t1', [proposer, adversarial])]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.reviewerRole).toBe('adversarial');
  });
});
