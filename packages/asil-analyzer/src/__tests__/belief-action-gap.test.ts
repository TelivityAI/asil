import { describe, expect, it } from 'vitest';
import {
  detectBeliefActionGap,
  extractConfidences,
} from '../detectors/belief-action-gap.js';
import { mkCall, mkTask } from './helpers.js';

describe('extractConfidences', () => {
  it('parses "confidence: 30%"', () => {
    expect(extractConfidences('confidence: 30%')).toEqual([
      { kind: 'numeric', value: 0.3 },
    ]);
  });
  it('parses "confidence: 0.3"', () => {
    expect(extractConfidences('confidence: 0.3')).toEqual([
      { kind: 'numeric', value: 0.3 },
    ]);
  });
  it('parses "low confidence"', () => {
    expect(extractConfidences('My low confidence here')).toEqual([
      { kind: 'word', value: 'low' },
    ]);
  });
});

describe('detectBeliefActionGap', () => {
  it('rule (b): flags low numeric confidence with definitive valence, no hedge', () => {
    const call = mkCall({
      roleGuess: 'reviewer-code',
      responseContent:
        'My confidence: 0.3 — but the change is correct. Approve and merge.',
    });
    const hits = detectBeliefActionGap([mkTask('t1', [call])]);
    expect(hits.some((h) => h.rule === 'low-conf-definitive')).toBe(true);
  });

  it('rule (b): flags "low confidence" word form', () => {
    const call = mkCall({
      roleGuess: 'reviewer-code',
      responseContent: 'I have low confidence here, but reject this PR.',
    });
    const hits = detectBeliefActionGap([mkTask('t1', [call])]);
    expect(hits.some((h) => h.rule === 'low-conf-definitive')).toBe(true);
  });

  it('rule (b): does NOT flag when a hedge marker is present alongside low confidence', () => {
    const call = mkCall({
      roleGuess: 'reviewer-code',
      responseContent:
        'My confidence: 0.3 — tentatively leaning approve, but might be wrong.',
    });
    const hits = detectBeliefActionGap([mkTask('t1', [call])]);
    expect(hits.filter((h) => h.rule === 'low-conf-definitive').length).toBe(0);
  });

  it('rule (a): flags same numeric confidence yielding opposite valences WITHIN one task', () => {
    const accept = mkCall({
      roleGuess: 'reviewer-code',
      responseContent: 'My confidence: 0.7. Approve.',
    });
    const reject = mkCall({
      roleGuess: 'reviewer-code',
      responseContent: 'My confidence: 0.7. Reject.',
    });
    const hits = detectBeliefActionGap([mkTask('t1', [accept, reject])]);
    expect(hits.filter((h) => h.rule === 'same-conf-opposite-valence').length).toBeGreaterThan(0);
  });

  it('rule (a): does NOT flag same confidence + opposite valences across DIFFERENT tasks (Codex #8)', () => {
    // A 0.7-accept on task A and a 0.7-reject on task B are verdicts
    // about different diffs — not a contradiction. Buckets are scoped
    // by taskId, so this must not produce a same-conf-opposite-valence hit.
    const acceptA = mkCall({
      roleGuess: 'reviewer-code',
      responseContent: 'My confidence: 0.7. Approve.',
    });
    const rejectB = mkCall({
      roleGuess: 'reviewer-code',
      responseContent: 'My confidence: 0.7. Reject.',
    });
    const hits = detectBeliefActionGap([
      mkTask('task-A', [acceptA]),
      mkTask('task-B', [rejectB]),
    ]);
    expect(hits.filter((h) => h.rule === 'same-conf-opposite-valence').length).toBe(0);
  });

  it('does not flag when confidence is high and valence is definitive', () => {
    const call = mkCall({
      roleGuess: 'reviewer-code',
      responseContent: 'My confidence: 0.9 — definitely approve.',
    });
    const hits = detectBeliefActionGap([mkTask('t1', [call])]);
    expect(hits.length).toBe(0);
  });
});
