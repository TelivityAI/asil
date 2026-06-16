/**
 * Shared lexical helpers used by every detector.
 *
 * Deterministic only — no LLM call, no semantic similarity API. Just
 * tokenization, Jaccard overlap, and sentence segmentation. The whole
 * analyzer's "deterministic" guarantee rests on these helpers staying
 * that way; do not introduce model-backed similarity here.
 */

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have if in into is it its no not of on or such that the their then there these this to was were will with you your we'.split(
    ' ',
  ),
);

/**
 * Tokenize for Jaccard overlap. Lowercase, strip punctuation, drop
 * stopwords + tokens ≤ 2 chars (noise). The token set is identity-
 * insensitive — "Foo" and "foo" hash the same.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Jaccard overlap on token sets. Returns 0 if either side is empty. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Split text into sentences. Conservative — splits on `[.!?]` followed
 *  by whitespace. Won't handle decimal points perfectly but good enough
 *  for detector use. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** First N sentences of a response, joined. Used by sycophancy detector
 *  to bound where we look for disagreement markers vs proposer-echo. */
export function firstNSentences(text: string, n: number): string {
  return splitSentences(text).slice(0, n).join(' ');
}

/** Disagreement markers — if any appear in the opening of a reviewer
 *  response, sycophancy is NOT flagged. Lexical only. */
export const DISAGREEMENT_MARKERS = [
  'however',
  'but ',
  'disagree',
  'i contest',
  'actually',
  'pushback',
  'not quite',
  'concern',
  'block',
  'reject',
  'object',
  'risk',
  'flaw',
  'wrong',
  'incorrect',
];

export function hasDisagreementMarker(text: string): boolean {
  const t = text.toLowerCase();
  return DISAGREEMENT_MARKERS.some((m) => t.includes(m));
}

/** Hedge markers — soften a definitive valence. Belief-action-gap
 *  detector treats a low-confidence response WITHOUT hedges as the
 *  failure shape. */
export const HEDGE_MARKERS = [
  'unsure',
  'tentatively',
  'leaning',
  'maybe',
  'might',
  'perhaps',
  'possibly',
];

export function hasHedgeMarker(text: string): boolean {
  const t = text.toLowerCase();
  return HEDGE_MARKERS.some((m) => t.includes(m));
}

/** Valence detection — accept / reject keywords. */
export const ACCEPT_TOKENS = ['accept', 'approve', 'merge', 'pass ', 'ship', 'lgtm'];
export const REJECT_TOKENS = ['reject', 'block', 'fail', 'do not merge', 'request changes'];

export type Valence = 'accept' | 'reject' | 'mixed' | 'unknown';

export function valenceOf(text: string): Valence {
  const t = text.toLowerCase();
  const accept = ACCEPT_TOKENS.some((m) => t.includes(m));
  const reject = REJECT_TOKENS.some((m) => t.includes(m));
  if (accept && reject) return 'mixed';
  if (accept) return 'accept';
  if (reject) return 'reject';
  return 'unknown';
}
