import { describe, expect, it } from 'vitest';
import { detectDrift } from '../detectors/drift.js';
import { mkCall, mkTask } from './helpers.js';

describe('detectDrift', () => {
  it('flags when persona accepts and adversarial rejects within the same task', () => {
    const persona = mkCall({
      roleGuess: 'reviewer-code',
      responseContent: 'Approve — code is clean and tested.',
    });
    const adversarial = mkCall({
      roleGuess: 'adversarial',
      responseContent: 'Reject — there is a missing null check on the input path.',
    });
    const hits = detectDrift([mkTask('t1', [persona, adversarial])]);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const flip = hits.find(
      (h) => h.fromValence === 'accept' && h.toValence === 'reject',
    );
    expect(flip).toBeDefined();
  });

  it('does NOT flag when all definitive verdicts agree', () => {
    const a = mkCall({
      roleGuess: 'reviewer-code',
      responseContent: 'Approve.',
    });
    const b = mkCall({ roleGuess: 'reviewer-security', responseContent: 'Approve.' });
    const c = mkCall({ roleGuess: 'adversarial', responseContent: 'Approve.' });
    const hits = detectDrift([mkTask('t1', [a, b, c])]);
    expect(hits.length).toBe(0);
  });

  it('does NOT flag valence flips across different tasks', () => {
    const accept = mkCall({ roleGuess: 'reviewer-code', responseContent: 'Approve.' });
    const reject = mkCall({ roleGuess: 'reviewer-code', responseContent: 'Reject.' });
    const hits = detectDrift([
      mkTask('t1', [accept]),
      mkTask('t2', [reject]),
    ]);
    expect(hits.length).toBe(0);
  });

  it('ignores calls with unknown valence', () => {
    const exec = mkCall({
      roleGuess: 'executor',
      responseContent: 'Here is a diff: <<<FILE: foo.ts>>>x<<<END FILE>>>',
    });
    const reject = mkCall({ roleGuess: 'reviewer-code', responseContent: 'Reject.' });
    const hits = detectDrift([mkTask('t1', [exec, reject])]);
    expect(hits.length).toBe(0); // only one definitive verdict
  });
});
