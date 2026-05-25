import { isBlockedByDomainGuard } from '../loop.js';
import type { Canary, CanaryResult } from '../types.js';

export const domainQuestionCanary: Canary = {
  name: 'domain-question',
  description: 'Verifies domain guard blocks tasks whose files carry unresolved DOMAIN_QUESTION markers',
  async run(): Promise<CanaryResult> {
    const start = Date.now();
    try {
      const blockedFiles = new Set(['canary/blocked.ts']);

      const shouldBlock = isBlockedByDomainGuard(
        ['canary/blocked.ts', 'canary/safe.ts'],
        blockedFiles,
      );

      const shouldPass = !isBlockedByDomainGuard(
        ['canary/safe.ts', 'canary/other.ts'],
        blockedFiles,
      );

      const passed = shouldBlock && shouldPass;

      return {
        name: 'domain-question',
        passed,
        reason: passed
          ? 'Domain guard correctly blocks tasks touching DOMAIN_QUESTION files and passes safe tasks'
          : `Domain guard misbehaved — shouldBlock=${shouldBlock}, shouldPass=${shouldPass}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: 'domain-question',
        passed: false,
        reason: `Canary threw: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
  },
};
