/**
 * System B: Thought Multiplier — public types.
 *
 * Papa is the orchestrator that routes a user's request to a subset of
 * thinker agents (spec-writer, security, test-strategist, api-designer,
 * planner), synthesises their outputs, resolves conflicts, and produces
 * a production-ready Claude Code handoff brief.
 */
import type { ModelTier } from 'asil-cost-controller';

export interface UserRequest {
  id: string;
  input: string;
  timestamp: Date;
  context?: string;
}

export type ThinkerRole =
  | 'spec-writer'
  | 'security'
  | 'test-strategist'
  | 'api-designer'
  | 'planner';

export interface RoutingDecision {
  requestId: string;
  activatedThinkers: ThinkerRole[];
  reasoning: string;
  estimatedModel: ModelTier;
  papaModel: ModelTier;
}

export type RecommendationCategory =
  | 'architecture'
  | 'implementation'
  | 'testing'
  | 'security'
  | 'performance'
  | 'api-design'
  | 'planning';

export type Priority = 'must' | 'should' | 'could';
export type Severity = 'blocker' | 'warning' | 'note';

export interface Recommendation {
  category: RecommendationCategory;
  priority: Priority;
  description: string;
  rationale: string;
  /** Which thinker contributed this. Populated when synthesizing. */
  source?: ThinkerRole;
}

export interface Concern {
  severity: Severity;
  source: ThinkerRole;
  description: string;
  suggestedResolution: string;
}

export interface ThinkerOutput {
  role: ThinkerRole;
  requestId: string;
  analysis: string;
  recommendations: Recommendation[];
  concerns: Concern[];
  costUsed: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface Conflict {
  thinkerA: ThinkerRole;
  thinkerB: ThinkerRole;
  issue: string;
  positionA: string;
  positionB: string;
  resolution?: ConflictResolution;
}

export interface ConflictResolution {
  chosen: 'A' | 'B' | 'compromise';
  reasoning: string;
  resolvedBy: 'papa';
}

export interface BuildStep {
  order: number;
  title: string;
  description: string;
  files: string[];
  testRequirements: string[];
  securityConsiderations: string[];
}

export interface SynthesisResult {
  requestId: string;
  mergedRecommendations: Recommendation[];
  resolvedConflicts: Conflict[];
  unresolvedConcerns: Concern[];
  escalateToHuman: boolean;
  escalationReason?: string;
  buildSteps: BuildStep[];
  thinkerContributions: Partial<Record<ThinkerRole, string>>;
}

export interface HandoffBrief {
  requestId: string;
  title: string;
  objective: string;
  steps: BuildStep[];
  acceptanceCriteria: string[];
  doNotChange: string[];
  domainQuestions: string[];
  estimatedTokenCost: {
    model: ModelTier;
    estimatedInput: number;
    estimatedOutput: number;
  };
  generatedAt: Date;
  thinkerContributions: Partial<Record<ThinkerRole, string>>;
  markdown: string;
}

export interface ThoughtMultiplierConfig {
  papaModel: ModelTier;
  thinkerModel: ModelTier;
  maxThinkers: number;
  autoEscalate: boolean;
  osmaniSkillsPath: string;
  /** 0..1 — higher = more weight to security in conflict resolution. */
  securityWeight: number;
  /** Display name for the host project. Appears in the brief header. Defaults to "Project". */
  projectName?: string;
  /** Project-specific entries appended to the brief's "DO NOT CHANGE" list. */
  projectDoNotChange?: readonly string[];
}

/** Mock boundary for LLM calls. Real impl wraps the Anthropic SDK. */
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
