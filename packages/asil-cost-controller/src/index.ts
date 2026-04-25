/**
 * asil-cost-controller — public surface.
 *
 * The token budget governor for ASIL's autonomous agent systems
 * (System A, System B). Systems import:
 *   - CostCheckpoint (call from every agent to record + gate usage)
 *   - TokenTracker   (persistence + historical queries)
 *   - BudgetManager  (allocate + check task budgets)
 *   - KillSwitch     (sweep / panic stop)
 *   - UsageReporter  (daily / weekly digests)
 */
export * from './types.js';
export {
  DEFAULT_PRICING,
  TASK_ESTIMATES,
  calculateCallCost,
  estimateTaskCost,
  type ModelPricing,
  type TaskEstimate,
} from './cost-estimator.js';
export { TokenTracker } from './token-tracker.js';
export {
  BudgetManager,
  DEFAULT_GLOBAL_BUDGET,
  type AllocationOptions,
} from './budget-manager.js';
export {
  CostCheckpoint,
  type CostCheckpointOptions,
} from './checkpoint.js';
export {
  KillSwitch,
  type KillEvent,
} from './kill-switch.js';
export { UsageReporter } from './reporter.js';
