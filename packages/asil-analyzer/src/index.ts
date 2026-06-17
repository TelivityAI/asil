/**
 * asil-analyzer — public surface.
 *
 * Two layers:
 *   1. Transcript capture: EventSink + instrumented LLMCaller / CodexCaller
 *      / BudgetManager wrappers. Drop in at the runner's dep-construction
 *      site to record every conversational turn as structured JSON.
 *   2. Deterministic analyzer: per-task transcripts → 5 detectors
 *      (sycophancy, first-item bias, belief-action gap, drift,
 *      multi-hop decay) → findings.md. Zero LLM calls.
 */
export {
  classifyRole,
  EventSink,
  readEvents,
  splitByTask,
  writePerTaskTranscripts,
} from './transcript-writer.js';
export type {
  BaseEvent,
  BudgetAllocateEvent,
  Event,
  EventKind,
  GitPushRejectedEvent,
  LLMCallEvent,
  NoteEvent,
  PRStubbedEvent,
  RoleGuess,
  RunStartEvent,
  TaskEndEvent,
  TaskStartEvent,
  TaskTranscript,
} from './transcript-writer.js';

export { instrumentLLMCaller, instrumentCodexCaller } from './instrumented-callers.js';
export type { InstrumentOptions } from './instrumented-callers.js';
export { wrapBudgetManager } from './budget-instrument.js';
export { redactSecrets, DEFAULT_REDACTION_RULES } from './redact.js';
export type { RedactionRule } from './redact.js';

export {
  analyze,
  loadPerTask,
  runAllDetectors,
  runAnalyzer,
  writeFindings,
} from './analyzer.js';
export type {
  AnalyzerIndex,
  AnalyzerInput,
  AnalyzerOutput,
  WriteFindingsOptions,
} from './analyzer.js';

export { detectSycophancy } from './detectors/sycophancy.js';
export type { PerTask, SycophancyHit } from './detectors/sycophancy.js';

export { detectFirstItemBias } from './detectors/first-item-bias.js';
export type { EnumerationHit, FirstItemBiasResult } from './detectors/first-item-bias.js';

export { detectBeliefActionGap, extractConfidences } from './detectors/belief-action-gap.js';
export type { BeliefActionHit } from './detectors/belief-action-gap.js';

export { detectDrift } from './detectors/drift.js';
export type { DriftHit } from './detectors/drift.js';

export { detectMultiHopDecayWeak } from './detectors/multi-hop-decay.js';
export type { DecayHit, MultiHopDecayResult } from './detectors/multi-hop-decay.js';

// Lexical helpers — exported so callers can write their own custom
// detectors that share the same token/jaccard/valence definitions.
export {
  tokenize,
  jaccard,
  splitSentences,
  firstNSentences,
  hasDisagreementMarker,
  hasHedgeMarker,
  valenceOf,
  DISAGREEMENT_MARKERS,
  HEDGE_MARKERS,
  ACCEPT_TOKENS,
  REJECT_TOKENS,
} from './lexical.js';
export type { Valence } from './lexical.js';
