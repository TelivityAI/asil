/**
 * System A: Autonomous Improvement Loop — types.
 */
import type { ModelTier } from 'asil-cost-controller';

export type TaskCategory =
  | 'test-failure'
  | 'type-error'
  | 'vulnerability'
  | 'todo-resolution'
  | 'coverage-gap'
  | 'complexity'
  | 'dead-code'
  | 'dependency-update'
  | 'documentation';

export const CATEGORY_PRIORITY: Record<TaskCategory, number> = {
  'test-failure': 0,
  'type-error': 1,
  vulnerability: 2,
  'todo-resolution': 3,
  'coverage-gap': 4,
  complexity: 5,
  'dead-code': 6,
  'dependency-update': 7,
  documentation: 8,
};

export const CATEGORY_SKILL_MAP: Record<TaskCategory, string> = {
  'test-failure': 'test-coverage-improvement',
  'type-error': 'code-simplification',
  vulnerability: 'security-review',
  'todo-resolution': 'todo-resolution',
  'coverage-gap': 'test-coverage-improvement',
  complexity: 'code-simplification',
  'dead-code': 'dead-code-removal',
  'dependency-update': 'dependency-update',
  documentation: 'documentation-generation',
};

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface ImprovementTask {
  id: string;
  category: TaskCategory;
  title: string;
  description: string;
  filePaths: string[];
  severity: Severity;
  discoveredAt: Date;
  estimatedTokens: number;
}

export type QueueStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface QueueItem {
  task: ImprovementTask;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt?: Date;
  lastFailureReason?: string;
  status: QueueStatus;
}

/** Which pipeline step aborted an execution. */
export type FailedStep =
  | 'safety-guard'
  | 'llm-no-diff'
  | 'diff-apply'
  | 'typecheck'
  | 'tests';

export interface ExecutionResult {
  taskId: string;
  success: boolean;
  diff: string;
  filesChanged: string[];
  testsRun: boolean;
  testsPassed: boolean;
  typeCheckPassed: boolean;
  executionLog: string;
  tokenUsage: { inputTokens: number; outputTokens: number };
  /** Populated when applying the diff failed, so callers can skip reviews. */
  applyError?: string;
  /** Which step aborted this execution. Set iff success=false. */
  failedStep?: FailedStep;
  /** Captured stdout/stderr from a failing typecheck/test run, so the
   *  loop caller can surface them without re-running the command. */
  stepOutput?: { stdout: string; stderr: string };
}

export type PersonaName =
  | 'code-reviewer'
  | 'security-auditor'
  | 'test-engineer';

export interface PersonaReview {
  persona: PersonaName;
  approved: boolean;
  concerns: string[];
  suggestions: string[];
  tokenUsage: { inputTokens: number; outputTokens: number };
}

export interface SelfReviewResult {
  taskId: string;
  reviews: PersonaReview[];
  allApproved: boolean;
  aggregatedConcerns: string[];
  recommendation: 'proceed' | 'revise' | 'reject';
}

export type AdversarialSeverity =
  | 'pass'
  | 'minor-issues'
  | 'major-issues'
  | 'reject';

export interface AdversarialReviewResult {
  taskId: string;
  approved: boolean;
  reasoning: string;
  issuesFound: string[];
  severity: AdversarialSeverity;
}

export type TaskOutcomeStatus =
  | 'pr-opened'
  | 'rejected-self-review'
  | 'rejected-adversarial'
  | 'execution-failed'
  | 'budget-exceeded'
  | 'cycle-skipped';

export interface TaskOutcome {
  taskId: string;
  status: TaskOutcomeStatus;
  prUrl?: string;
  prBranch?: string;
  selfReview?: SelfReviewResult;
  adversarialReview?: AdversarialReviewResult;
  totalTokenUsage: { inputTokens: number; outputTokens: number };
  completedAt: Date;
  /** Populated when status !== 'pr-opened'. The actual git/gh error
   *  (or other failure reason) so the runner's summary can surface it
   *  instead of a generic "PR build failed" string. */
  failureReason?: string;
}

export interface ImprovementLoopConfig {
  executionModel: ModelTier;
  reviewModel: ModelTier;
  maxTasksPerRun: number;
  maxAttempts: number;
  taskCooldownMs: number;
  markdownSkillsPath: string;
  repoRoot: string;
  queuePath: string;
  skipCategories: TaskCategory[];
  codexConfig: {
    apiKey: string;
    model: string;
  };
}

/** Shared LLM caller contract — same shape as System B uses. */
export interface LLMCaller {
  call(
    systemPrompt: string,
    userPrompt: string,
    model: string,
  ): Promise<LLMResponse>;
}

export interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/** Separate call interface for Codex — different provider, distinct mock surface. */
export interface CodexCaller {
  call(prompt: string, model: string): Promise<{ content: string }>;
}
