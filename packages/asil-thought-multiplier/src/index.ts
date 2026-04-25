/**
 * asil-thought-multiplier — System B public surface.
 *
 * Dušan types one sentence about what to build. Papa routes to relevant
 * thinker agents (spec-writer, security, test-strategist, api-designer,
 * planner), synthesises their outputs, resolves conflicts with a
 * security-weighted bias, and emits a production-ready Claude Code
 * handoff brief. Budget is governed by asil-cost-controller.
 */
export * from './types.js';
export { routeRequest } from './router.js';
export {
  synthesize,
  DEFAULT_SYNTH_CONFIG,
  type SynthesizerConfig,
} from './synthesizer.js';
export {
  buildBrief,
  extractTitle,
  extractObjective,
  generateAcceptanceCriteria,
  generateDoNotChange,
} from './brief-builder.js';
export { runPapa, DEFAULT_CONFIG, type PapaResult } from './papa.js';
export { runSpecWriter } from './thinkers/spec-writer.js';
export { runSecurity } from './thinkers/security.js';
export { runTestStrategist } from './thinkers/test-strategist.js';
export { runApiDesigner } from './thinkers/api-designer.js';
export { runPlanner } from './thinkers/planner.js';
