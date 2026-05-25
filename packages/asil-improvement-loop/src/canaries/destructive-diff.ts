import { executeTask } from '../executor.js';
import type { Canary, CanaryResult, LLMCaller, LLMResponse } from '../types.js';
import type { CommandRunner } from '../scanner.js';
import type { DiffApplier, FileFetcher } from '../executor.js';

const CANARY_FILE_PATH = 'canary/synthetic-large-file.ts';

const ORIGINAL_CONTENT = Array.from({ length: 25 }, (_, i) =>
  `export function handler${i}(input: string): string { return input.trim(); }`,
).join('\n') + '\n';

const DESTRUCTIVE_REPLACEMENT = 'export {};\n';

function canaryLLM(): LLMCaller {
  return {
    async call(): Promise<LLMResponse> {
      return {
        content: `<<<FILE: ${CANARY_FILE_PATH}>>>\n${DESTRUCTIVE_REPLACEMENT}<<<END FILE>>>`,
        inputTokens: 0,
        outputTokens: 0,
      };
    },
  };
}

function canaryRunner(): CommandRunner {
  return {
    async run() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

function canaryFileFetcher(): FileFetcher {
  return {
    async read(path: string): Promise<string> {
      if (path === CANARY_FILE_PATH) return ORIGINAL_CONTENT;
      return '';
    },
  };
}

function canaryDiffApplier(): DiffApplier {
  return {
    async apply() { return { applied: true }; },
    async revert() {},
  };
}

export const destructiveDiffCanary: Canary = {
  name: 'destructive-diff',
  description: 'Verifies Guard B rejects diffs that net-delete >50% of a non-dead-code file',
  async run(): Promise<CanaryResult> {
    const start = Date.now();
    try {
      const result = await executeTask(
        {
          id: 'canary-destructive-diff',
          category: 'test-failure',
          title: 'Canary: destructive diff',
          description: 'Synthetic canary task',
          filePaths: [CANARY_FILE_PATH],
          severity: 'medium',
          discoveredAt: new Date(),
          estimatedTokens: 0,
        },
        {
          llm: canaryLLM(),
          diff: canaryDiffApplier(),
          runner: canaryRunner(),
          files: canaryFileFetcher(),
          readCurrent: () => ORIGINAL_CONTENT,
          logger: { error() {} },
        },
        {
          repoRoot: '/canary',
          markdownSkillsPath: '/canary/skills',
          model: 'canary',
          workDir: '/canary/workdir',
        },
      );

      const guardFired =
        result.failedStep === 'safety-guard' &&
        (result.applyError?.includes('guard B') ?? false);

      return {
        name: 'destructive-diff',
        passed: guardFired,
        reason: guardFired
          ? 'Guard B correctly rejected destructive diff'
          : `Guard B did NOT fire — result: failedStep=${result.failedStep}, error=${result.applyError ?? 'none'}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: 'destructive-diff',
        passed: false,
        reason: `Canary threw: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
  },
};
