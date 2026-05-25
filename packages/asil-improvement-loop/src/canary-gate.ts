import { DEFAULT_CANARIES } from './canaries/index.js';
import type { CanaryGateConfig, CanaryGateResult } from './types.js';

export async function runCanaryGate(
  config?: CanaryGateConfig,
): Promise<CanaryGateResult> {
  const start = Date.now();
  const canaries = config?.canaries ?? DEFAULT_CANARIES;
  const results = [];

  for (const canary of canaries) {
    const result = await canary.run();
    results.push(result);
    if (!result.passed) {
      return {
        passed: false,
        results,
        failedCanary: result.name,
        failureReason: result.reason,
        totalDurationMs: Date.now() - start,
      };
    }
  }

  return {
    passed: true,
    results,
    totalDurationMs: Date.now() - start,
  };
}
