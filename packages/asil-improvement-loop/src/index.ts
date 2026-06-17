/**
 * asil-improvement-loop — System A public surface.
 *
 * The autonomous improvement grinder: scan the codebase for improvable
 * items, pick the highest-priority task, execute the matching Markdown
 * skill, run a three-persona self-review, gate through Codex, and open
 * a PR if everything passes. Budget enforced via asil-cost-controller.
 */
export * from './types.js';
export { TaskQueue, priorityFor } from './task-queue.js';
export {
  CycleDetector,
  type CycleCheck,
  type CycleEvent,
} from './cycle-detector.js';
export {
  scanCodebase,
  scanTestFailures,
  scanTypeErrors,
  scanTodos,
  scanCoverageGaps,
  scanDeadCode,
  normalizePath,
  stableTaskId,
  toRepoRelative,
  type ScanResult,
  type ScannerDeps,
  type CommandRunner,
  type FileReader,
} from './scanner.js';
export {
  executeTask,
  extractDiff,
  extractFileBlocks,
  buildPatchFromFiles,
  extractAntiRationalization,
  buildExecutionPrompt,
  buildTaskPrompt,
  type DiffApplier,
  type ExecutorDeps,
  type ExecuteOptions,
  type ExecutorLogger,
  type ExecutorFailureEvent,
  type FileBlock,
  type FileFetcher,
} from './executor.js';
export { selfReview } from './self-review.js';
export {
  adversarialReview,
  buildAdversarialPrompt,
  parseAdversarialResponse,
} from './adversarial-gate.js';
export {
  buildAndOpenPR,
  buildPRBody,
  branchNameFor,
  type GitOperations,
} from './pr-builder.js';
export { runLoop, isBlockedByDomainGuard, type LoopDeps, type LoopResult } from './loop.js';
export { runCanaryGate } from './canary-gate.js';
export {
  DEFAULT_CANARIES,
  destructiveDiffCanary,
  emptyContentCanary,
  domainQuestionCanary,
} from './canaries/index.js';
export {
  DomainAnswerStore,
  buildDomainAnswerContext,
  createDomainAnswerStore,
  findDomainQuestions,
  hashQuestion,
  type DomainQuestion,
  type ProposedAnswer,
  type QuestionProposals,
  type StoredAnswer,
} from './domain-questions.js';
export {
  generateProposals,
  parseProposals,
  type ProposalContext,
  type ProposalResult,
  type ProposerOptions,
} from './domain-question-proposer.js';
export type {
  CommandSpec,
  CoverageEntry,
  CoverageProfile,
  DeadCodeProfile,
  LanguageProfile,
  TestFailure,
  TypeError as ScannerTypeError,
} from './language-profile.js';
export { typescriptProfile } from './profiles/typescript.js';
export { pythonProfile } from './profiles/python.js';
