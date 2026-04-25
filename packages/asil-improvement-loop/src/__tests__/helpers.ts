import type {
  CodexCaller,
  ImprovementTask,
  LLMCaller,
  LLMResponse,
  PersonaName,
  Severity,
  TaskCategory,
} from '../types.js';
import type { CommandRunner, FileReader } from '../scanner.js';
import type { DiffApplier, FileFetcher } from '../executor.js';
import type { GitOperations } from '../pr-builder.js';

export function mkTask(overrides: Partial<ImprovementTask> = {}): ImprovementTask {
  return {
    id: overrides.id ?? 'task-1',
    category: overrides.category ?? 'test-failure',
    title: overrides.title ?? 'Fix tests',
    description: overrides.description ?? 'desc',
    filePaths: overrides.filePaths ?? ['packages/foo/src/foo.ts'],
    severity: overrides.severity ?? 'high',
    discoveredAt: overrides.discoveredAt ?? new Date(),
    estimatedTokens: overrides.estimatedTokens ?? 10_000,
  };
}

export function mkCategoryTask(
  category: TaskCategory,
  severity: Severity = 'medium',
  id?: string,
): ImprovementTask {
  return mkTask({
    id: id ?? `${category}-task`,
    category,
    severity,
    title: `${category} task`,
  });
}

/** Build an LLMCaller that dispatches replies by persona/heuristic. */
export function mockLLM(
  replies: Array<{ match: RegExp; response: Partial<LLMResponse> }>,
  fallback?: Partial<LLMResponse>,
): LLMCaller & { calls: Array<{ system: string; user: string; model: string }> } {
  const calls: Array<{ system: string; user: string; model: string }> = [];
  return {
    calls,
    async call(system, user, model) {
      calls.push({ system, user, model });
      for (const r of replies) {
        if (r.match.test(system) || r.match.test(user)) {
          return {
            content: r.response.content ?? '',
            inputTokens: r.response.inputTokens ?? 100,
            outputTokens: r.response.outputTokens ?? 50,
          };
        }
      }
      return {
        content: fallback?.content ?? '',
        inputTokens: fallback?.inputTokens ?? 100,
        outputTokens: fallback?.outputTokens ?? 50,
      };
    },
  };
}

export function personaResponse(p: {
  approved: boolean;
  concerns?: string[];
  suggestions?: string[];
}): string {
  return JSON.stringify({
    approved: p.approved,
    concerns: p.concerns ?? [],
    suggestions: p.suggestions ?? [],
  });
}

export function allPersonas(replies: Record<PersonaName, string>): Array<{
  match: RegExp;
  response: Partial<LLMResponse>;
}> {
  return [
    { match: /senior code reviewer/i, response: { content: replies['code-reviewer'] } },
    { match: /security auditor/i, response: { content: replies['security-auditor'] } },
    { match: /test engineer/i, response: { content: replies['test-engineer'] } },
  ];
}

export function mockCodex(content: string): CodexCaller & {
  calls: Array<{ prompt: string; model: string }>;
} {
  const calls: Array<{ prompt: string; model: string }> = [];
  return {
    calls,
    async call(prompt, model) {
      calls.push({ prompt, model });
      return { content };
    },
  };
}

export function mockRunner(
  script: Array<{
    match: (cmd: string, args: string[]) => boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>,
): CommandRunner & {
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args });
      for (const s of script) {
        if (s.match(command, args)) {
          return {
            stdout: s.stdout ?? '',
            stderr: s.stderr ?? '',
            exitCode: s.exitCode ?? 0,
          };
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

export function mockFileReader(
  files: Record<string, string> = {},
): FileReader {
  return {
    async read(path) {
      return files[path] ?? null;
    },
    async glob() {
      return Object.keys(files);
    },
  };
}

export function mockFileFetcher(
  files: Record<string, string> = {},
): FileFetcher {
  return {
    async read(path) {
      return files[path] ?? '';
    },
  };
}

export function mockDiffApplier(
  opts: { appliedValues?: boolean[]; error?: string } = {},
): DiffApplier & { applied: string[]; reverted: string[] } {
  const applied: string[] = [];
  const reverted: string[] = [];
  const sequence = [...(opts.appliedValues ?? [true])];
  return {
    applied,
    reverted,
    async apply(diff) {
      applied.push(diff);
      const result = sequence.length > 0 ? sequence.shift()! : true;
      return result
        ? { applied: true }
        : { applied: false, error: opts.error ?? 'diff rejected' };
    },
    async revert(diff) {
      reverted.push(diff);
    },
  };
}

export interface MockGit extends GitOperations {
  operations: string[];
  /** Track which worktree paths were cleaned up for assertions. */
  cleanedUp: string[];
  lastPR?: { title: string; body: string; branch: string; base: string };
  /** If set, createBranch throws — used to test worktree creation failure. */
  failCreateBranch?: boolean;
  /** If set, commit/push/createPR throws — used to test PR-build failure. */
  failPush?: boolean;
  failCreatePR?: boolean;
}

export function mockGit(prUrl = 'https://example.com/pr/1'): MockGit {
  const operations: string[] = [];
  const cleanedUp: string[] = [];
  const git: MockGit = {
    operations,
    cleanedUp,
    async createBranch(name) {
      if (git.failCreateBranch) throw new Error('createBranch failed');
      operations.push(`createBranch:${name}`);
      return `/tmp/asil-auto-${name.replace(/\//g, '-')}`;
    },
    async applyDiff(diff, workDir) {
      operations.push(`applyDiff:${diff.slice(0, 20)}@${workDir}`);
      return true;
    },
    async commit(msg, workDir) {
      operations.push(`commit:${msg}@${workDir}`);
    },
    async push(branch, workDir) {
      if (git.failPush) throw new Error('push failed');
      operations.push(`push:${branch}@${workDir}`);
    },
    async createPR(opts) {
      if (git.failCreatePR) throw new Error('createPR failed');
      operations.push(`createPR:${opts.branch}`);
      git.lastPR = opts;
      return prUrl;
    },
    async cleanup(workDir) {
      cleanedUp.push(workDir);
      operations.push(`cleanup:${workDir}`);
    },
  };
  return git;
}

export const SAMPLE_DIFF = `diff --git a/packages/foo/src/foo.ts b/packages/foo/src/foo.ts
--- a/packages/foo/src/foo.ts
+++ b/packages/foo/src/foo.ts
@@ -1,3 +1,3 @@
-export const value = 1;
+export const value = 2;
 export const other = 3;
 export const another = 4;
`;

/** Build the sentinel-delimited file block the new executor prompt asks
 *  the LLM to produce (one block per changed file). */
export function fileBlock(path: string, content: string): string {
  return `<<<FILE: ${path}>>>\n${content}\n<<<END FILE>>>`;
}

/** A canned unified diff the `diff` shell mock returns so tests don't
 *  need a real `diff` binary — just needs to look patch-shaped enough
 *  that downstream code treats it as non-empty. */
export const CANNED_UNIFIED_DIFF = `--- a/packages/foo/src/foo.ts
+++ b/packages/foo/src/foo.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;
