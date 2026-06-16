import { describe, expect, it } from 'vitest';
import { detectFirstItemBias } from '../detectors/first-item-bias.js';
import { mkCall, mkTask } from './helpers.js';

describe('detectFirstItemBias', () => {
  it('records index 0 selection from "Option A" enumeration + selection phrase', () => {
    const call = mkCall({
      roleGuess: 'papa',
      responseContent: [
        'Option A: Reject the diff entirely.',
        'Option B: Accept with reservations.',
        'Option C: Request follow-up tests.',
        '',
        'I recommend Option A — the diff lacks coverage for the edge case.',
      ].join('\n'),
    });
    const r = detectFirstItemBias([mkTask('t1', [call])]);
    expect(r.totalEnumerations).toBe(1);
    expect(r.selectedDistribution[0]).toBe(1);
    expect(r.hits.length).toBe(1);
    expect(r.hits[0]?.selectedIndex).toBe(0);
  });

  it('records non-zero index without adding to hits', () => {
    const call = mkCall({
      roleGuess: 'papa',
      responseContent: [
        'Option A: Reject the diff entirely.',
        'Option B: Accept with reservations.',
        'Option C: Request follow-up tests.',
        '',
        'I choose Option C — additional tests pin down the contract.',
      ].join('\n'),
    });
    const r = detectFirstItemBias([mkTask('t1', [call])]);
    expect(r.selectedDistribution[2]).toBe(1);
    expect(r.hits.length).toBe(0);
  });

  it('handles numbered enumerations', () => {
    const call = mkCall({
      roleGuess: 'thinker',
      responseContent: [
        '1. Approve.',
        '2. Request changes.',
        '3. Reject.',
        '',
        'My recommendation is 1.',
      ].join('\n'),
    });
    const r = detectFirstItemBias([mkTask('t1', [call])]);
    expect(r.selectedDistribution[0]).toBe(1);
    expect(r.hits[0]?.selectedIndex).toBe(0);
  });

  it('skips responses with no enumeration', () => {
    const call = mkCall({
      roleGuess: 'thinker',
      responseContent: 'Approve. Looks fine.',
    });
    const r = detectFirstItemBias([mkTask('t1', [call])]);
    expect(r.totalEnumerations).toBe(0);
    expect(r.hits.length).toBe(0);
  });

  it('skips responses that enumerate but never signal a selection', () => {
    const call = mkCall({
      roleGuess: 'thinker',
      responseContent: 'Option A: foo\nOption B: bar\nThese are the trade-offs.',
    });
    const r = detectFirstItemBias([mkTask('t1', [call])]);
    expect(r.totalEnumerations).toBe(0);
    expect(r.hits.length).toBe(0);
  });
});
