/**
 * Drift detector — deterministic.
 *
 * Definition: within a single task, two LLM calls produce opposite
 * structured valences (accept vs reject) on the same diff. The
 * structured-verdict flip is the deterministic catch. Narrative
 * position changes without a definitive valence keyword would not
 * flag — that requires an LLM judge.
 */
import { valenceOf } from '../lexical.js';
import type { PerTask } from './sycophancy.js';

export interface DriftHit {
  taskId: string;
  fromCallIdx: number;
  fromValence: 'accept' | 'reject';
  fromRole: string;
  toCallIdx: number;
  toValence: 'accept' | 'reject';
  toRole: string;
  fromExcerpt: string;
  toExcerpt: string;
}

export function detectDrift(perTask: PerTask[]): DriftHit[] {
  const hits: DriftHit[] = [];
  for (const t of perTask) {
    const verdicts = t.calls.map((c, idx) => ({
      idx,
      role: c.roleGuess ?? 'unknown',
      valence: valenceOf(c.responseContent),
      excerpt: c.responseContent.slice(0, 400),
    }));
    const definitive = verdicts.filter(
      (v) => v.valence === 'accept' || v.valence === 'reject',
    );
    for (let i = 0; i < definitive.length; i += 1) {
      for (let j = i + 1; j < definitive.length; j += 1) {
        const a = definitive[i]!;
        const b = definitive[j]!;
        if (a.valence !== b.valence) {
          hits.push({
            taskId: t.taskId,
            fromCallIdx: a.idx,
            fromValence: a.valence as 'accept' | 'reject',
            fromRole: a.role,
            toCallIdx: b.idx,
            toValence: b.valence as 'accept' | 'reject',
            toRole: b.role,
            fromExcerpt: a.excerpt,
            toExcerpt: b.excerpt,
          });
        }
      }
    }
  }
  return hits;
}
