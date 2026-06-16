/**
 * First-item bias detector — deterministic.
 *
 * Definition: when an LLM response enumerates ≥2 options AND signals a
 * selection, record which index was selected. Aggregate selected-index
 * distribution across all such calls. The failure shape: index 0
 * selected disproportionately when other indices were equally supported.
 *
 * Regex on enumeration shape, regex on selection phrase. No LLM judge.
 */
import type { LLMCallEvent } from '../transcript-writer.js';
import type { PerTask } from './sycophancy.js';

export interface EnumerationHit {
  taskId: string;
  callIdx: number;
  totalOptions: number;
  selectedIndex: number;
  responseExcerpt: string;
}

export interface FirstItemBiasResult {
  hits: EnumerationHit[];
  selectedDistribution: Record<number, number>;
  totalEnumerations: number;
}

const NUMBERED_RE = /(?:^|\n)\s*(\d+)[.)]\s+(.+?)(?=\n\s*\d+[.)]|\n\n|$)/gs;
const LETTERED_RE = /(?:^|\n)\s*\(?([a-d])\)?[.)]\s+(.+?)(?=\n\s*\(?[a-d]\)?[.)]|\n\n|$)/gs;
const OPTION_RE =
  /(?:^|\n)\s*\*?\*?Option ([A-D]|\d+)\*?\*?\s*[:.\-]\s*(.+?)(?=\n\s*\*?\*?Option |\n\n|$)/gis;

const SELECTION_PHRASES = [
  /(?:choose|select|recommend|go with|pick|prefer|going with|chosen)[^.\n]*?\bOption ([A-D]|\d+)\b/gi,
  /(?:choose|select|recommend|go with|pick|prefer|going with|chosen)[^.\n]*?\b([1-9])\b/gi,
  /\bOption ([A-D]|\d+)\b[^.\n]*?\b(?:is best|wins|is the right choice|is the answer)\b/gi,
];

function findEnumeration(
  text: string,
): { count: number; matches: RegExpExecArray[] } | null {
  const candidates: Array<{ count: number; matches: RegExpExecArray[] }> = [];
  for (const re of [NUMBERED_RE, LETTERED_RE, OPTION_RE]) {
    re.lastIndex = 0;
    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) matches.push(m);
    if (matches.length >= 2) candidates.push({ count: matches.length, matches });
  }
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.count - a.count)[0]!;
}

function findSelectedIndex(text: string): number {
  for (const re of SELECTION_PHRASES) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m && m[1]) {
      const raw = m[1];
      if (/^[A-Da-d]$/.test(raw)) {
        return raw.toUpperCase().charCodeAt(0) - 65;
      }
      if (/^\d+$/.test(raw)) {
        return Number.parseInt(raw, 10) - 1;
      }
    }
  }
  return -1;
}

export function detectFirstItemBias(perTask: PerTask[]): FirstItemBiasResult {
  const hits: EnumerationHit[] = [];
  const dist: Record<number, number> = {};

  for (const t of perTask) {
    for (let i = 0; i < t.calls.length; i += 1) {
      const c: LLMCallEvent = t.calls[i]!;
      const enumeration = findEnumeration(c.responseContent);
      if (!enumeration) continue;
      const selectedIndex = findSelectedIndex(c.responseContent);
      if (selectedIndex < 0) continue;

      dist[selectedIndex] = (dist[selectedIndex] ?? 0) + 1;
      if (selectedIndex === 0) {
        hits.push({
          taskId: t.taskId,
          callIdx: i,
          totalOptions: enumeration.count,
          selectedIndex,
          responseExcerpt: c.responseContent.slice(0, 600),
        });
      }
    }
  }

  const totalEnumerations = Object.values(dist).reduce((s, n) => s + n, 0);
  return { hits, selectedDistribution: dist, totalEnumerations };
}
