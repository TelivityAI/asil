import { DEFAULT_CANARIES } from './canaries/index.js';
import type { CanaryGateConfig, CanaryGateResult, CanaryResult } from './types.js';

export async function runCanaryGate(
  config?: CanaryGateConfig,
): Promise<CanaryGateResult> {
  const start = Date.now();
  const canaries = config?.canaries ?? DEFAULT_CANARIES;
  const results: CanaryResult[] = [];

  for (const canary of canaries) {
    let result: CanaryResult;
    try {
      result = await canary.run();
    } catch (err) {
      result = {
        name: canary.name,
        passed: false,
        reason: `Canary threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
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
