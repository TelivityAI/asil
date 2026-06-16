/**
 * Analyzer orchestrator — reads per-task transcripts (and an optional
 * index.json summary), runs every deterministic detector, and writes a
 * findings.md report.
 *
 * Zero LLM calls. Zero external network. The whole point is to be
 * cheap and re-runnable on every grind.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  detectBeliefActionGap,
  type BeliefActionHit,
} from './detectors/belief-action-gap.js';
import { detectDrift, type DriftHit } from './detectors/drift.js';
import {
  detectFirstItemBias,
  type FirstItemBiasResult,
} from './detectors/first-item-bias.js';
import {
  detectMultiHopDecayWeak,
  type MultiHopDecayResult,
} from './detectors/multi-hop-decay.js';
import { detectSycophancy, type SycophancyHit, type PerTask } from './detectors/sycophancy.js';
import type { Event, LLMCallEvent } from './transcript-writer.js';

export interface AnalyzerIndex {
  timestamp?: string;
  tasksAttempted?: number;
  tasksCompleted?: number;
  tasksRejected?: number;
  totalCostUSD?: string;
  stoppedReason?: string;
  durationMs?: number;
  tasks?: Array<{ id: string; transcriptFile: string }>;
  /** Anything else the caller wants to include. */
  [extra: string]: unknown;
}

export interface AnalyzerInput {
  transcriptsDir: string;
}

export interface AnalyzerOutput {
  index: AnalyzerIndex | null;
  perTask: PerTask[];
  sycophancy: SycophancyHit[];
  firstItemBias: FirstItemBiasResult;
  beliefActionGap: BeliefActionHit[];
  drift: DriftHit[];
  multiHopDecay: MultiHopDecayResult;
}

/** Load every per-task transcript file in the directory. */
export function loadPerTask(transcriptsDir: string): PerTask[] {
  const out: PerTask[] = [];
  const indexPath = join(transcriptsDir, 'index.json');
  if (existsSync(indexPath)) {
    const idx = JSON.parse(readFileSync(indexPath, 'utf8')) as AnalyzerIndex;
    for (const t of idx.tasks ?? []) {
      const fpath = join(transcriptsDir, t.transcriptFile);
      if (!existsSync(fpath)) continue;
      const data = JSON.parse(readFileSync(fpath, 'utf8')) as { events: Event[] };
      const calls = data.events.filter(
        (e) => e.kind === 'llm-call' || e.kind === 'codex-call',
      ) as LLMCallEvent[];
      out.push({ taskId: t.id, calls });
    }
    return out;
  }
  // Fallback: discover task-*.json files directly.
  for (const f of readdirSync(transcriptsDir)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try {
      const data = JSON.parse(readFileSync(join(transcriptsDir, f), 'utf8')) as {
        taskId: string;
        events: Event[];
      };
      const calls = data.events.filter(
        (e) => e.kind === 'llm-call' || e.kind === 'codex-call',
      ) as LLMCallEvent[];
      out.push({ taskId: data.taskId ?? f.replace('.json', ''), calls });
    } catch {
      // Skip unreadable / wrong-shape files quietly.
    }
  }
  return out;
}

/** Run every detector against the loaded transcripts. */
export function runAllDetectors(perTask: PerTask[]): {
  sycophancy: SycophancyHit[];
  firstItemBias: FirstItemBiasResult;
  beliefActionGap: BeliefActionHit[];
  drift: DriftHit[];
  multiHopDecay: MultiHopDecayResult;
} {
  return {
    sycophancy: detectSycophancy(perTask),
    firstItemBias: detectFirstItemBias(perTask),
    beliefActionGap: detectBeliefActionGap(perTask),
    drift: detectDrift(perTask),
    multiHopDecay: detectMultiHopDecayWeak(perTask),
  };
}

export function analyze(input: AnalyzerInput): AnalyzerOutput {
  const indexPath = join(input.transcriptsDir, 'index.json');
  const index: AnalyzerIndex | null = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, 'utf8')) as AnalyzerIndex)
    : null;
  const perTask = loadPerTask(input.transcriptsDir);
  return { index, perTask, ...runAllDetectors(perTask) };
}

function quoteForMd(text: string, maxLen = 600): string {
  const truncated = text.length > maxLen ? text.slice(0, maxLen) + '…[truncated]' : text;
  return truncated.split('\n').map((l) => '> ' + l).join('\n');
}

function pickTwoIllustrative<T>(items: T[]): T[] {
  if (items.length <= 2) return items;
  return [items[0]!, items[Math.floor(items.length / 2)]!];
}

export interface WriteFindingsOptions {
  output: AnalyzerOutput;
  outFile: string;
  /** Relative path printed in citations. Defaults to `transcripts/`. */
  transcriptsLabel?: string;
}

export function writeFindings(opts: WriteFindingsOptions): void {
  const { output, outFile } = opts;
  const transcriptsLabel = opts.transcriptsLabel ?? 'transcripts';
  const { index, perTask, sycophancy: syc, firstItemBias: fib, beliefActionGap: bag, drift, multiHopDecay: decay } = output;

  const totalCalls = perTask.reduce((s, t) => s + t.calls.length, 0);
  const lines: string[] = [];

  lines.push(`# ASIL Reasoning-Failure-Mode Audit`);
  lines.push('');
  lines.push(`**Run timestamp:** ${index?.timestamp ?? 'n/a'}`);
  lines.push('');
  lines.push('## Run summary');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Tasks attempted | ${index?.tasksAttempted ?? 0} |`);
  lines.push(`| Tasks completed (passed all gates) | ${index?.tasksCompleted ?? 0} |`);
  lines.push(`| Tasks rejected | ${index?.tasksRejected ?? 'n/a'} |`);
  lines.push(`| Total cost | $${index?.totalCostUSD ?? 'n/a'} |`);
  lines.push(`| Stop reason | ${index?.stoppedReason ?? 'n/a'} |`);
  lines.push(`| Total LLM/Codex calls captured | ${totalCalls} |`);
  lines.push(`| Per-task transcripts at | \`${transcriptsLabel}\` |`);
  lines.push('');

  lines.push('## Five-failure-mode summary');
  lines.push('');
  lines.push('| Mode | Observed | Count | Detector |');
  lines.push('|---|---|---|---|');
  lines.push(
    `| Sycophancy | ${syc.length > 0 ? 'yes' : 'no'} | ${syc.length} | deterministic (Jaccard ≥0.40 + no disagreement marker) |`,
  );
  lines.push(
    `| First-item bias | ${fib.hits.length > 0 ? 'yes' : 'no'} | ${fib.hits.length} | deterministic (enumeration regex + selection regex) |`,
  );
  lines.push(
    `| Belief-action gap | ${bag.length > 0 ? 'yes' : 'no'} | ${bag.length} | deterministic (confidence regex + valence keyword) |`,
  );
  lines.push(
    `| Drift | ${drift.length > 0 ? 'yes' : 'no'} | ${drift.length} | deterministic (within-task valence flip) |`,
  );
  lines.push(
    `| Multi-hop decay | Inconclusive | ${decay.trivialContradictionHits.length} (trivial only) | deterministic catches only explicit self-contradiction; strong form requires LLM judge — deferred |`,
  );
  lines.push('');

  // ---- Mode 1: Sycophancy
  lines.push('## 1. Sycophancy');
  lines.push('');
  lines.push(`**Observed:** ${syc.length > 0 ? 'yes' : 'no'}. **Count:** ${syc.length}.`);
  lines.push('');
  lines.push(
    '**Detector definition.** A reviewer LLM call whose first 3 sentences have Jaccard token overlap ≥ 0.40 with the preceding executor call, with no disagreement marker in those 3 sentences.',
  );
  lines.push('');
  if (syc.length === 0) {
    lines.push('_No instances detected._');
  } else {
    for (const hit of pickTwoIllustrative(syc)) {
      lines.push(`### Instance — ${hit.taskId} (call #${hit.reviewerCallIdx}, role \`${hit.reviewerRole}\`)`);
      lines.push(`**Jaccard with proposer:** ${hit.jaccard}.`);
      lines.push('');
      lines.push(quoteForMd(hit.reviewerOpening));
      lines.push('');
      lines.push(`Source: \`${transcriptsLabel}/${hit.reviewerFile}\` (call #${hit.reviewerCallIdx})`);
      lines.push('');
    }
  }

  // ---- Mode 2: First-item bias
  lines.push('## 2. First-item bias');
  lines.push('');
  lines.push(`**Observed:** ${fib.hits.length > 0 ? 'yes' : 'no'}. **Count:** ${fib.hits.length} (where index 0 was selected).`);
  lines.push('');
  lines.push('**Detector definition.** Responses that enumerate ≥2 options AND signal a selection. Distribution of selected indices:');
  lines.push('');
  if (fib.totalEnumerations === 0) {
    lines.push('_No enumerated-selection responses detected._');
  } else {
    lines.push('| Index | Count |');
    lines.push('|---|---|');
    for (const [idx, n] of Object.entries(fib.selectedDistribution).sort(
      (a, b) => Number(a[0]) - Number(b[0]),
    )) {
      lines.push(`| ${idx} | ${n} |`);
    }
    lines.push('');
    for (const hit of pickTwoIllustrative(fib.hits)) {
      lines.push(`### Instance — ${hit.taskId} (call #${hit.callIdx})`);
      lines.push(`**Total options:** ${hit.totalOptions}. **Selected index:** ${hit.selectedIndex}.`);
      lines.push('');
      lines.push(quoteForMd(hit.responseExcerpt));
      lines.push('');
      lines.push(`Source: \`${transcriptsLabel}/${hit.taskId}.json\` (call #${hit.callIdx})`);
      lines.push('');
    }
  }

  // ---- Mode 3: Belief-action gap
  lines.push('## 3. Belief-action gap');
  lines.push('');
  lines.push(`**Observed:** ${bag.length > 0 ? 'yes' : 'no'}. **Count:** ${bag.length}.`);
  lines.push('');
  lines.push(
    '**Detector definition.** Either (a) the same confidence value yields opposite accept/reject valences across calls, OR (b) confidence < 0.5 (or "low") yields a definitive accept/reject without any hedge tokens.',
  );
  lines.push('');
  if (bag.length === 0) {
    lines.push('_No instances detected._');
  } else {
    for (const hit of pickTwoIllustrative(bag)) {
      lines.push(`### Instance — ${hit.taskId} (call #${hit.callIdx})`);
      lines.push(
        `**Rule:** \`${hit.rule}\`. **Confidence:** \`${hit.confidence}\`. **Valence:** \`${hit.valence}\`. **Hedge present:** ${hit.hedge}.`,
      );
      lines.push('');
      lines.push(quoteForMd(hit.excerpt));
      lines.push('');
      lines.push(`Source: \`${transcriptsLabel}/${hit.taskId}.json\` (call #${hit.callIdx})`);
      lines.push('');
    }
  }

  // ---- Mode 4: Drift
  lines.push('## 4. Drift');
  lines.push('');
  lines.push(`**Observed:** ${drift.length > 0 ? 'yes' : 'no'}. **Count:** ${drift.length}.`);
  lines.push('');
  lines.push(
    '**Detector definition.** Within a single task, two LLM calls produce opposite valences (accept vs reject) on the same diff.',
  );
  lines.push('');
  if (drift.length === 0) {
    lines.push('_No instances detected._');
  } else {
    for (const hit of pickTwoIllustrative(drift)) {
      lines.push(`### Instance — ${hit.taskId} (call #${hit.fromCallIdx} → #${hit.toCallIdx})`);
      lines.push(`**Earlier call (${hit.fromRole}):** valence \`${hit.fromValence}\`.`);
      lines.push('');
      lines.push(quoteForMd(hit.fromExcerpt));
      lines.push('');
      lines.push(`**Later call (${hit.toRole}):** valence \`${hit.toValence}\`.`);
      lines.push('');
      lines.push(quoteForMd(hit.toExcerpt));
      lines.push('');
      lines.push(`Source: \`${transcriptsLabel}/${hit.taskId}.json\``);
      lines.push('');
    }
  }

  // ---- Mode 5: Multi-hop decay
  lines.push('## 5. Multi-hop decay');
  lines.push('');
  lines.push(
    `**Observed:** Inconclusive. **Trivial-case count:** ${decay.trivialContradictionHits.length}. **Conditional chains scanned:** ${decay.conditionalChainCount}.`,
  );
  lines.push('');
  lines.push(
    "**Detector definition.** Strong form requires checking whether a 3+-step conditional chain's conclusion is logically consistent with its premise — outside deterministic regex. Reported as **Inconclusive — requires LLM judge, deferred**. The deterministic fallback catches only the trivial case (explicit self-contradiction).",
  );
  lines.push('');
  if (decay.trivialContradictionHits.length === 0) {
    lines.push('_No trivial-case contradictions detected._');
  } else {
    for (const hit of pickTwoIllustrative(decay.trivialContradictionHits)) {
      lines.push(`### Trivial-case instance — ${hit.taskId} (call #${hit.callIdx})`);
      lines.push(`Notes: ${hit.notes}`);
      lines.push('');
      lines.push(quoteForMd(hit.excerpt));
      lines.push('');
      lines.push(`Source: \`${transcriptsLabel}/${hit.taskId}.json\` (call #${hit.callIdx})`);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('_Analyzer ran on captured transcripts only. No LLM calls. Deterministic detectors only._');

  writeFileSync(outFile, lines.join('\n'));
}

/** Convenience: load + run all detectors + write findings.md in one call. */
export function runAnalyzer(opts: {
  transcriptsDir: string;
  outFile: string;
}): AnalyzerOutput {
  const output = analyze({ transcriptsDir: opts.transcriptsDir });
  writeFindings({
    output,
    outFile: opts.outFile,
    transcriptsLabel: relative(resolve(opts.outFile, '..'), opts.transcriptsDir),
  });
  return output;
}
