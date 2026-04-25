import type { CostCheckpoint } from 'asil-cost-controller';
import type {
  HandoffBrief,
  LLMCaller,
  RoutingDecision,
  SynthesisResult,
  ThinkerOutput,
  ThinkerRole,
  ThoughtMultiplierConfig,
  UserRequest,
} from './types.js';
import { routeRequest } from './router.js';
import { synthesize } from './synthesizer.js';
import { buildBrief } from './brief-builder.js';
import { runSpecWriter } from './thinkers/spec-writer.js';
import { runSecurity } from './thinkers/security.js';
import { runTestStrategist } from './thinkers/test-strategist.js';
import { runApiDesigner } from './thinkers/api-designer.js';
import { runPlanner } from './thinkers/planner.js';

type ThinkerRunner = (
  request: UserRequest,
  llm: LLMCaller,
  osmaniSkillsPath: string,
  model: string,
) => Promise<ThinkerOutput>;

const THINKER_RUNNERS: Record<ThinkerRole, ThinkerRunner> = {
  'spec-writer': runSpecWriter,
  security: runSecurity,
  'test-strategist': runTestStrategist,
  'api-designer': runApiDesigner,
  planner: runPlanner,
};

export const DEFAULT_CONFIG: ThoughtMultiplierConfig = {
  papaModel: 'opus',
  thinkerModel: 'sonnet',
  maxThinkers: 4,
  autoEscalate: true,
  osmaniSkillsPath: '../agent-skills',
  securityWeight: 0.7,
};

export interface PapaResult {
  routing: RoutingDecision;
  thinkerOutputs: ThinkerOutput[];
  synthesis: SynthesisResult;
  brief: HandoffBrief | null;
  escalated: boolean;
  escalationReason?: string;
  totalCost: { inputTokens: number; outputTokens: number };
}

export async function runPapa(
  request: UserRequest,
  llm: LLMCaller,
  checkpoint: CostCheckpoint,
  config: ThoughtMultiplierConfig = DEFAULT_CONFIG,
): Promise<PapaResult> {
  // 1. Route.
  const routing = routeRequest(request, config.maxThinkers);

  // 2. Fan out in parallel. Each thinker is independent.
  const outputs = await Promise.all(
    routing.activatedThinkers.map((role) =>
      THINKER_RUNNERS[role](
        request,
        llm,
        config.osmaniSkillsPath,
        config.thinkerModel,
      ),
    ),
  );

  // 3. Record combined token usage with the cost controller.
  let totalInput = 0;
  let totalOutput = 0;
  for (const o of outputs) {
    totalInput += o.costUsed.inputTokens;
    totalOutput += o.costUsed.outputTokens;
  }
  const budgetCheck = checkpoint.recordAndCheck(
    totalInput,
    totalOutput,
    config.thinkerModel,
  );

  if (budgetCheck.recommendation === 'kill') {
    checkpoint.kill('Budget exceeded during thinker fan-out');
    const reason = 'Budget exceeded during thinker fan-out';
    return {
      routing,
      thinkerOutputs: outputs,
      synthesis: {
        requestId: request.id,
        mergedRecommendations: [],
        resolvedConflicts: [],
        unresolvedConcerns: [],
        escalateToHuman: true,
        escalationReason: reason,
        buildSteps: [],
        thinkerContributions: {},
      },
      brief: null,
      escalated: true,
      escalationReason: reason,
      totalCost: { inputTokens: totalInput, outputTokens: totalOutput },
    };
  }

  // 4. Synthesize.
  const synthesis = synthesize(request.id, outputs, {
    securityWeight: config.securityWeight,
    businessWeight: 1 - config.securityWeight,
  });

  // 5. Escalate OR build the brief.
  if (synthesis.escalateToHuman && config.autoEscalate) {
    checkpoint.complete();
    return {
      routing,
      thinkerOutputs: outputs,
      synthesis,
      brief: null,
      escalated: true,
      escalationReason: synthesis.escalationReason,
      totalCost: { inputTokens: totalInput, outputTokens: totalOutput },
    };
  }

  const brief = buildBrief(synthesis, request.input, config);
  checkpoint.complete();

  return {
    routing,
    thinkerOutputs: outputs,
    synthesis,
    brief,
    escalated: false,
    totalCost: { inputTokens: totalInput, outputTokens: totalOutput },
  };
}
