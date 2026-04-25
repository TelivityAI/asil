import type {
  BuildStep,
  Concern,
  Conflict,
  ConflictResolution,
  Priority,
  Recommendation,
  RecommendationCategory,
  SynthesisResult,
  ThinkerOutput,
  ThinkerRole,
} from './types.js';

export interface SynthesizerConfig {
  /** 0..1 — weight applied when resolving conflicts that involve security. */
  securityWeight: number;
  /** 0..1 — weight applied to the non-security side. */
  businessWeight: number;
}

export const DEFAULT_SYNTH_CONFIG: SynthesizerConfig = {
  securityWeight: 0.7,
  businessWeight: 0.3,
};

/** Terms that reliably negate a matching positive statement. */
const NEGATION_TERMS = [
  'do not',
  "don't",
  'avoid',
  'never',
  'should not',
  "shouldn't",
  'must not',
  "mustn't",
  'no ',
];

export function synthesize(
  requestId: string,
  outputs: ThinkerOutput[],
  config: SynthesizerConfig = DEFAULT_SYNTH_CONFIG,
): SynthesisResult {
  const allRecs = outputs.flatMap((o) => o.recommendations);
  const allConcerns = outputs.flatMap((o) => o.concerns);

  const conflicts = detectConflicts(outputs);
  const resolvedConflicts = conflicts.map((c) => ({
    ...c,
    resolution: resolveConflict(c, config),
  }));

  const mergedRecs = applyResolutions(
    deduplicateRecommendations(allRecs),
    resolvedConflicts,
  );

  const blockers = allConcerns.filter((c) => c.severity === 'blocker');
  const escalate = blockers.length > 0;

  const buildSteps = buildOrderedSteps(mergedRecs, allConcerns);

  const thinkerContributions: Partial<Record<ThinkerRole, string>> = {};
  for (const o of outputs) {
    thinkerContributions[o.role] = o.analysis;
  }

  return {
    requestId,
    mergedRecommendations: mergedRecs,
    resolvedConflicts,
    unresolvedConcerns: blockers,
    escalateToHuman: escalate,
    escalationReason: escalate
      ? `${blockers.length} blocker(s) need human decision: ${blockers
          .map((c) => c.description)
          .join('; ')}`
      : undefined,
    buildSteps,
    thinkerContributions,
  };
}

function deduplicateRecommendations(recs: Recommendation[]): Recommendation[] {
  const seen = new Map<string, Recommendation>();
  for (const rec of recs) {
    const key = `${rec.category}:${normalize(rec.description).slice(0, 60)}`;
    const existing = seen.get(key);
    if (!existing || priorityRank(rec.priority) > priorityRank(existing.priority)) {
      seen.set(key, rec);
    }
  }
  return Array.from(seen.values());
}

function priorityRank(p: Priority): number {
  return p === 'must' ? 3 : p === 'should' ? 2 : 1;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripNegation(s: string): { negated: boolean; core: string } {
  const lower = ` ${normalize(s)} `;
  for (const term of NEGATION_TERMS) {
    const needle = ` ${term}`;
    const idx = lower.indexOf(needle);
    if (idx !== -1) {
      return { negated: true, core: lower.replace(needle, ' ').trim() };
    }
  }
  return { negated: false, core: lower.trim() };
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter((w) => w.length > 3));
  const tb = new Set(b.split(/\s+/).filter((w) => w.length > 3));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

function detectConflicts(outputs: ThinkerOutput[]): Conflict[] {
  const conflicts: Conflict[] = [];

  for (let i = 0; i < outputs.length; i += 1) {
    for (let j = i + 1; j < outputs.length; j += 1) {
      const a = outputs[i];
      const b = outputs[j];
      if (!a || !b || a.role === b.role) continue;

      for (const recA of a.recommendations) {
        for (const recB of b.recommendations) {
          if (recA.category !== recB.category) continue;

          const na = stripNegation(recA.description);
          const nb = stripNegation(recB.description);
          // A conflict requires high topical overlap AND opposite polarity.
          const overlap = tokenOverlap(na.core, nb.core);
          if (overlap >= 0.5 && na.negated !== nb.negated) {
            conflicts.push({
              thinkerA: a.role,
              thinkerB: b.role,
              issue: `${recA.category}: contradictory recommendations`,
              positionA: recA.description,
              positionB: recB.description,
            });
          }
        }
      }
    }
  }

  return conflicts;
}

function resolveConflict(
  conflict: Conflict,
  config: SynthesizerConfig,
): ConflictResolution {
  const aIsSecurity = conflict.thinkerA === 'security';
  const bIsSecurity = conflict.thinkerB === 'security';

  if (aIsSecurity || bIsSecurity) {
    const chosen: 'A' | 'B' = aIsSecurity ? 'A' : 'B';
    const winningPosition =
      chosen === 'A' ? conflict.positionA : conflict.positionB;
    return {
      chosen,
      reasoning: `Security concern takes precedence (weight: ${config.securityWeight}). Chose: "${winningPosition}"`,
      resolvedBy: 'papa',
    };
  }

  // Non-security conflicts: default to the more conservative (negated) side.
  const na = stripNegation(conflict.positionA);
  const nb = stripNegation(conflict.positionB);
  if (na.negated !== nb.negated) {
    const chosen: 'A' | 'B' = na.negated ? 'A' : 'B';
    return {
      chosen,
      reasoning: `Non-security conflict — defaulted to the more conservative (restrictive) position (business weight: ${config.businessWeight}).`,
      resolvedBy: 'papa',
    };
  }

  return {
    chosen: 'compromise',
    reasoning: `Non-security conflict with symmetric polarity — flagged for human review during handoff (business weight: ${config.businessWeight}).`,
    resolvedBy: 'papa',
  };
}

function applyResolutions(
  recs: Recommendation[],
  resolvedConflicts: Conflict[],
): Recommendation[] {
  const losers = new Set<string>();
  for (const c of resolvedConflicts) {
    if (!c.resolution) continue;
    const loserDesc =
      c.resolution.chosen === 'A'
        ? c.positionB
        : c.resolution.chosen === 'B'
          ? c.positionA
          : null; // compromise: keep both
    if (loserDesc) losers.add(normalize(loserDesc));
  }
  return recs.filter((r) => !losers.has(normalize(r.description)));
}

function buildOrderedSteps(
  recs: Recommendation[],
  concerns: Concern[],
): BuildStep[] {
  const stepOrder: RecommendationCategory[] = [
    'architecture',
    'api-design',
    'implementation',
    'testing',
    'security',
    'performance',
    'planning',
  ];

  const steps: BuildStep[] = [];
  let order = 1;

  const securityConcerns = concerns
    .filter((c) => c.source === 'security' && c.severity !== 'blocker')
    .map((c) => c.description);

  for (const category of stepOrder) {
    const catRecs = recs
      .filter((r) => r.category === category)
      .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority));
    if (catRecs.length === 0) continue;

    const description = catRecs
      .map((r) => `- [${r.priority}] ${r.description} — ${r.rationale}`)
      .join('\n');

    const testRequirements =
      category === 'testing'
        ? catRecs.filter((r) => r.priority === 'must').map((r) => r.description)
        : [];

    const securityConsiderations =
      category === 'security'
        ? [...catRecs.map((r) => r.description), ...securityConcerns]
        : [];

    steps.push({
      order: order++,
      title: titleize(category),
      description,
      files: [],
      testRequirements,
      securityConsiderations,
    });
  }

  return steps;
}

function titleize(category: RecommendationCategory): string {
  switch (category) {
    case 'api-design':
      return 'API Design';
    default:
      return category.charAt(0).toUpperCase() + category.slice(1);
  }
}
