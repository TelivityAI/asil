import { describe, expect, it } from 'vitest';
import { detectMultiHopDecayWeak } from '../detectors/multi-hop-decay.js';
import { mkCall, mkTask } from './helpers.js';

describe('detectMultiHopDecayWeak', () => {
  it('counts conditional chains via regex (3+ marker structure)', () => {
    const call = mkCall({
      roleGuess: 'thinker',
      responseContent:
        'If the cache is warm then we save 200ms; since memory is plentiful, therefore we should cache aggressively.',
    });
    const r = detectMultiHopDecayWeak([mkTask('t1', [call])]);
    expect(r.conditionalChainCount).toBeGreaterThanOrEqual(1);
  });

  it('catches trivial self-contradiction (negation polarity flip within same response)', () => {
    const call = mkCall({
      roleGuess: 'thinker',
      responseContent:
        'The transaction must commit before the audit log is written. ' +
        'The transaction must not commit before the audit log is written. ' +
        'Therefore the implementation requires verifying.',
    });
    const r = detectMultiHopDecayWeak([mkTask('t1', [call])]);
    expect(r.trivialContradictionHits.length).toBe(1);
    expect(r.trivialContradictionHits[0]?.notes).toMatch(/polarity flipped/);
  });

  it('does NOT flag when two sentences differ in topic (low Jaccard)', () => {
    const call = mkCall({
      roleGuess: 'thinker',
      responseContent:
        'The cache should be warmed at startup. Database migrations must not run inside a serverless invocation. The two concerns are unrelated.',
    });
    const r = detectMultiHopDecayWeak([mkTask('t1', [call])]);
    expect(r.trivialContradictionHits.length).toBe(0);
  });

  it('does NOT flag short sentences (under MIN_SENTENCE_LEN floor)', () => {
    const call = mkCall({
      roleGuess: 'thinker',
      responseContent: 'It is fine. It is not fine. Decide.',
    });
    const r = detectMultiHopDecayWeak([mkTask('t1', [call])]);
    expect(r.trivialContradictionHits.length).toBe(0);
  });
});
