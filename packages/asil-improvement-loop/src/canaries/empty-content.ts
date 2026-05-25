import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeTask } from '../executor.js';
import type { Canary, CanaryResult, LLMCaller, LLMResponse } from '../types.js';
import type { CommandRunner } from '../scanner.js';
import type { DiffApplier, FileFetcher } from '../executor.js';

const CANARY_FILE_PATH = 'canary/real-file.ts';
const ON_DISK_CONTENT = 'export const realValue = 42;\nexport const another = "hello";\n';

function canaryLLM(): LLMCaller {
  return {
    async call(): Promise<LLMResponse> {
      return { content: '', inputTokens: 0, outputTokens: 0 };
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
    async read(): Promise<string> {
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

export const emptyContentCanary: Canary = {
  name: 'empty-content',
  description: 'Verifies Guard A rejects tasks where prompt file content is empty but on-disk file exists',
  async run(): Promise<CanaryResult> {
    const start = Date.now();
    let scratchDir: string | undefined;
    try {
      scratchDir = mkdtempSync(join(tmpdir(), 'asil-canary-empty-'));
      const fileDir = join(scratchDir, 'canary');
      mkdirSync(fileDir, { recursive: true });
      writeFileSync(join(fileDir, 'real-file.ts'), ON_DISK_CONTENT, 'utf8');

      const result = await executeTask(
        {
          id: 'canary-empty-content',
          category: 'test-failure',
          title: 'Canary: empty content',
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
          logger: { error() {} },
        },
        {
          repoRoot: scratchDir,
          markdownSkillsPath: '/canary/skills',
          model: 'canary',
          workDir: scratchDir,
        },
      );

      const guardFired =
        result.failedStep === 'safety-guard' &&
        (result.applyError?.includes('guard A') ?? false);

      return {
        name: 'empty-content',
        passed: guardFired,
        reason: guardFired
          ? 'Guard A correctly rejected empty-content task'
          : `Guard A did NOT fire — result: failedStep=${result.failedStep}, error=${result.applyError ?? 'none'}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: 'empty-content',
        passed: false,
        reason: `Canary threw: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    } finally {
      if (scratchDir) {
        try { rmSync(scratchDir, { recursive: true, force: true }); } catch {}
      }
    }
  },
};
