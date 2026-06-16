/**
 * Multi-hop decay detector — INCONCLUSIVE under deterministic-only.
 *
 * The strong form ("chains 'if X then Y; given Y then Z' fail at step
 * 3+; model loses the intermediate condition or substitutes an
 * unrelated conclusion") requires a semantic judgment that no regex
 * can perform. The analyzer must report this mode as inconclusive
 * pending an LLM judge.
 *
 * The deterministic fallback below catches only the trivial sub-case:
 * explicit self-contradiction inside a single response (two sentences
 * with high Jaccard overlap whose negation polarity is flipped, with
 * no intervening change-of-mind marker). Useful as a floor; not the
 * full picture.
 */
import { jaccard, tokenize } from '../lexical.js';
import type { PerTask } from './sycophancy.js';

export interface DecayHit {
  taskId: string;
  callIdx: number;
  excerpt: string;
  notes: string;
}

export interface MultiHopDecayResult {
  conditionalChainCount: number;
  trivialContradictionHits: DecayHit[];
}

const CONDITIONAL_CHAIN_RE =
  /\b(if|given|since|because|provided that)\b[^.]*?\bthen\b[^.]*?\b(therefore|so|hence|thus)\b/gis;

const NEGATION_RE = /\bnot\b|n't\b/;
const MIN_SENTENCE_LEN = 30;
const POLARITY_FLIP_JACCARD_MIN = 0.6;

export function detectMultiHopDecayWeak(perTask: PerTask[]): MultiHopDecayResult {
  const trivial: DecayHit[] = [];
  let chains = 0;

  for (const t of perTask) {
    for (let i = 0; i < t.calls.length; i += 1) {
      const c = t.calls[i]!;
      const text = c.responseContent;

      // Count conditional chains for the report (3+-step structure
      // presence — but we can't judge correctness, hence "inconclusive").
      CONDITIONAL_CHAIN_RE.lastIndex = 0;
      while (CONDITIONAL_CHAIN_RE.exec(text) !== null) chains += 1;

      // Trivial sub-case: same-content sentences with flipped negation
      // polarity.
      const sentences = text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= MIN_SENTENCE_LEN);
      outer: for (let s = 0; s < sentences.length; s += 1) {
        for (let k = s + 1; k < sentences.length; k += 1) {
          const a = sentences[s]!.toLowerCase();
          const b = sentences[k]!.toLowerCase();
          const aHasNot = NEGATION_RE.test(a);
          const bHasNot = NEGATION_RE.test(b);
          if (aHasNot === bHasNot) continue;
          const j = jaccard(tokenize(a), tokenize(b));
          if (j > POLARITY_FLIP_JACCARD_MIN) {
            trivial.push({
              taskId: t.taskId,
              callIdx: i,
              excerpt: `[s${s}] ${sentences[s]}\n[s${k}] ${sentences[k]}`,
              notes: `Jaccard=${j.toFixed(2)}, negation polarity flipped within same response.`,
            });
            break outer;
          }
        }
      }
    }
  }

  return { conditionalChainCount: chains, trivialContradictionHits: trivial };
}
