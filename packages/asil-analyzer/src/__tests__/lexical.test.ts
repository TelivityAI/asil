import { describe, expect, it } from 'vitest';
import {
  firstNSentences,
  hasDisagreementMarker,
  hasHedgeMarker,
  jaccard,
  splitSentences,
  tokenize,
  valenceOf,
} from '../lexical.js';

describe('lexical helpers', () => {
  describe('tokenize', () => {
    it('lowercases and strips punctuation', () => {
      expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
    });

    it('drops stopwords', () => {
      expect(tokenize('the quick fox')).toEqual(['quick', 'fox']);
    });

    it('drops tokens of length ≤ 2', () => {
      expect(tokenize('go to it home')).toEqual(['home']);
    });
  });

  describe('jaccard', () => {
    it('returns 0 when either side is empty', () => {
      expect(jaccard([], ['foo'])).toBe(0);
      expect(jaccard(['foo'], [])).toBe(0);
    });

    it('returns 1 for identical sets', () => {
      expect(jaccard(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    });

    it('returns 0 for disjoint sets', () => {
      expect(jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
    });

    it('computes overlap correctly for partial intersection', () => {
      // {a,b,c} ∩ {b,c,d} = {b,c}; union = {a,b,c,d}; 2/4 = 0.5
      expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
    });

    it('treats inputs as sets (dedupes)', () => {
      expect(jaccard(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(1);
    });
  });

  describe('splitSentences + firstNSentences', () => {
    it('splits on .!? followed by whitespace', () => {
      const r = splitSentences('First sentence. Second one! Third? Fourth.');
      expect(r).toEqual(['First sentence.', 'Second one!', 'Third?', 'Fourth.']);
    });

    it('returns first N joined', () => {
      const r = firstNSentences('A. B. C. D.', 2);
      expect(r).toBe('A. B.');
    });
  });

  describe('marker detection', () => {
    it('hasDisagreementMarker detects "however"', () => {
      expect(hasDisagreementMarker('However, I disagree')).toBe(true);
    });
    it('hasDisagreementMarker false on agreement-only text', () => {
      expect(hasDisagreementMarker('I fully agree with everything')).toBe(false);
    });
    it('hasHedgeMarker detects "might"', () => {
      expect(hasHedgeMarker('it might work')).toBe(true);
    });
  });

  describe('valenceOf', () => {
    it('detects accept', () => {
      expect(valenceOf('I approve this change')).toBe('accept');
    });
    it('detects reject', () => {
      expect(valenceOf('I block this for security reasons')).toBe('reject');
    });
    it('detects mixed when both present', () => {
      expect(valenceOf('approve some parts; reject the rest')).toBe('mixed');
    });
    it('returns unknown when no signal', () => {
      expect(valenceOf('interesting work')).toBe('unknown');
    });
  });
});
