/**
 * Runtime wiring — turns the mock boundaries in Systems A / B / C into
 * real API-backed implementations. Pure glue: no domain logic here.
 */
import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  BudgetManager,
  CostCheckpoint,
  TokenTracker,
  UsageReporter,
} from 'asil-cost-controller';
import type { ModelTier, SystemId } from 'asil-cost-controller';
import type {
  LLMCaller,
  LLMResponse,
} from 'asil-thought-multiplier';
import type {
  CodexCaller,
  CommandRunner,
  DiffApplier,
  FileFetcher,
  FileReader,
  GitOperations,
} from 'asil-improvement-loop';

const execFileAsync = promisify(execFile);

/** Maps our ModelTier names to the current Anthropic model IDs.
 *  Kept here so upgrades are a one-line change (per CLAUDE.md:
 *  "default to the latest and most capable Claude models"). */
export const MODEL_ID_BY_TIER: Record<ModelTier, string> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

export interface EnvConfig {
  ANTHROPIC_API_KEY: string;
  /** Optional — only needed for System A's adversarial gate. */
  OPENAI_API_KEY: string;
  REPO_ROOT: string;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY ?? '';
  const OPENAI_API_KEY = env.OPENAI_API_KEY ?? '';
  const REPO_ROOT = env.REPO_ROOT ?? process.cwd();

  // ANTHROPIC_API_KEY is the historical default for the primary LLM.
  // When the caller has configured a local-model adapter via
  // ASIL_LLM_BASE_URL, the Anthropic key is not needed — skip the
  // requirement so users on air-gapped / regulated deployments aren't
  // forced to set a dummy value.
  const localModeEnabled = (env.ASIL_LLM_BASE_URL ?? '').length > 0;
  if (!ANTHROPIC_API_KEY && !localModeEnabled) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required (or set ASIL_LLM_BASE_URL for local-mode)',
    );
  }

  return { ANTHROPIC_API_KEY, OPENAI_API_KEY, REPO_ROOT };
}

export interface AnthropicCallerOptions {
  /** Max output tokens per call. Default 8192. */
  maxTokens?: number;
  /** Injectable client for tests. */
  client?: Anthropic;
}

/** Real LLMCaller backed by the Anthropic SDK. */
export function createAnthropicCaller(
  apiKey: string,
  opts: AnthropicCallerOptions = {},
): LLMCaller {
  const client = opts.client ?? new Anthropic({ apiKey });
  const maxTokens = opts.maxTokens ?? 8192;

  return {
    async call(
      systemPrompt: string,
      userPrompt: string,
      model: string,
    ): Promise<LLMResponse> {
      const modelId =
        MODEL_ID_BY_TIER[model as ModelTier] ?? model;

      const response = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const textContent = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        content: textContent,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}

export interface CodexCallerOptions {
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Default max output tokens. Default 4096. */
  maxTokens?: number;
}

/** Real CodexCaller hitting OpenAI's chat completions endpoint via fetch. */
export function createCodexCaller(
  apiKey: string,
  opts: CodexCallerOptions = {},
): CodexCaller {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxTokens = opts.maxTokens ?? 4096;

  return {
    async call(prompt: string, model: string): Promise<{ content: string }> {
      const response = await fetchImpl(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model || 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `OpenAI API error: ${response.status} ${await response.text()}`,
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      return { content: data.choices?.[0]?.message?.content ?? '' };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible local-model adapter
//
// Targets any HTTP server that implements the `/v1/chat/completions`
// OpenAI-compatible API: Ollama (via /v1 endpoint), LM Studio, vLLM,
// llama.cpp server, OpenRouter, Azure OpenAI, etc. One adapter, many
// backends. The cost-controller's checkpoint expects non-zero tokens
// to gate spend — local servers often omit `usage`, so this adapter
// falls back to a chars/4 estimate (overridable).
// ---------------------------------------------------------------------------

export interface OpenAICompatibleOptions {
  /** Base URL, e.g. 'http://localhost:11434/v1' (Ollama),
   *  'http://localhost:1234/v1' (LM Studio), or an OpenRouter URL. */
  baseUrl: string;
  /** Optional bearer token; many local servers don't require auth. */
  apiKey?: string;
  /** Path appended to baseUrl. Default `/chat/completions`. */
  endpoint?: string;
  /** Max output tokens per call. Default 4096. */
  maxTokens?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Estimator used when the server omits `usage`. Default chars/4. */
  estimateTokens?: (text: string) => number;
}

interface OpenAICompatibleResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function defaultEstimator(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build the LLMCaller / CodexCaller variants over an OpenAI-compatible
 * endpoint. The bodies are nearly identical to `createCodexCaller`'s —
 * the differences: configurable baseUrl, optional Authorization
 * header, token estimation when `usage` is absent. The two factories
 * share a single internal POST helper.
 */
function postOpenAICompatible(
  opts: OpenAICompatibleOptions,
  body: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  },
): Promise<OpenAICompatibleResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? '/chat/completions';
  const url = opts.baseUrl.replace(/\/+$/, '') + endpoint;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  return fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...body,
      max_tokens: opts.maxTokens ?? 4096,
    }),
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible API error (${url}): ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as OpenAICompatibleResponse;
  });
}

/**
 * LLMCaller backed by an OpenAI-compatible endpoint. The `model`
 * argument is passed through unchanged — local model ids (e.g.
 * `llama3.1:8b-instruct-q4_K_M`) don't fit the opus/sonnet/haiku
 * tier system, so MODEL_ID_BY_TIER is intentionally NOT consulted.
 * Callers should pass the local model id verbatim (typically wired
 * through config or the ASIL_LLM_MODEL env var).
 */
export function createOpenAICompatibleCaller(
  opts: OpenAICompatibleOptions,
): LLMCaller {
  const estimate = opts.estimateTokens ?? defaultEstimator;
  return {
    async call(systemPrompt, userPrompt, model) {
      const data = await postOpenAICompatible(opts, {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      const content = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage ?? {};
      const inputTokens =
        typeof usage.prompt_tokens === 'number'
          ? usage.prompt_tokens
          : estimate(systemPrompt + '\n' + userPrompt);
      const outputTokens =
        typeof usage.completion_tokens === 'number'
          ? usage.completion_tokens
          : estimate(content);
      return { content, inputTokens, outputTokens };
    },
  };
}

/**
 * CodexCaller variant (no token surface). Useful when the adversarial
 * gate should also run against a local model rather than OpenAI cloud.
 * Wraps `createOpenAICompatibleCaller` and drops the token fields.
 */
export function createOpenAICompatibleCodexCaller(
  opts: OpenAICompatibleOptions,
): CodexCaller {
  return {
    async call(prompt, model) {
      const data = await postOpenAICompatible(opts, {
        model,
        messages: [{ role: 'user', content: prompt }],
      });
      return { content: data.choices?.[0]?.message?.content ?? '' };
    },
  };
}

/** Real CommandRunner via execFile. Captures stdout, stderr, and exit code
 *  without throwing — callers inspect exitCode to decide. */
export function createCommandRunner(): CommandRunner {
  return {
    async run(command, args, { cwd }) {
      try {
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 10 * 60_000,
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (err) {
        const anyErr = err as {
          stdout?: string;
          stderr?: string;
          code?: number | string;
        };

        // execFile sets stdout/stderr to '' (empty STRING, not undefined)
        // even on spawn errors like ENOENT — using `??` to fall back loses
        // the underlying error message. Use the actual error message when
        // the captured streams are empty, otherwise we get cryptic
        // "(no output, exit code 1)" surfaces for missing binaries.
        const errMessage =
          err instanceof Error ? err.message : String(err);
        const stdoutFromExec = anyErr.stdout ?? '';
        const stderrFromExec = anyErr.stderr ?? '';
        const stderr = stderrFromExec.trim() ? stderrFromExec : errMessage;

        // ENOENT → use the conventional "command not found" exit code
        // (127, POSIX convention) so callers can distinguish missing
        // binary from a real exit-1 failure.
        const code = anyErr.code;
        const exitCode =
          typeof code === 'number'
            ? code
            : code === 'ENOENT'
              ? 127
              : 1;

        return { stdout: stdoutFromExec, stderr, exitCode };
      }
    },
  };
}

/** Real FileReader rooted on disk. */
export function createFileReader(): FileReader {
  return {
    async read(path) {
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf8');
    },
    async glob() {
      // Scanner callers currently don't rely on glob — keep a no-op so we
      // don't pull in fast-glob for one callsite. Wire a real impl later
      // if the scanner starts depending on it.
      return [];
    },
  };
}

/** Real FileFetcher that resolves relative paths under repoRoot. */
export function createFileFetcher(): FileFetcher {
  return {
    async read(filePath, repoRoot) {
      const abs = resolve(repoRoot, filePath);
      return readFileSync(abs, 'utf8');
    },
  };
}

/** Real DiffApplier used by the executor to apply-then-verify the LLM's
 *  unified diff. On success the tree stays dirty — the PR builder is
 *  responsible for checking out a fresh branch and re-applying cleanly. */
export function createDiffApplier(): DiffApplier {
  const runner = createCommandRunner();
  return {
    async apply(diff, repoRoot) {
      const tmpFile = resolve(repoRoot, '.tmp-auto-diff.patch');
      writeFileSync(tmpFile, diff, 'utf8');
      try {
        const check = await runner.run('git', ['apply', '--check', tmpFile], {
          cwd: repoRoot,
        });
        if (check.exitCode !== 0) {
          return { applied: false, error: check.stderr || 'git apply --check failed' };
        }
        const apply = await runner.run('git', ['apply', tmpFile], {
          cwd: repoRoot,
        });
        if (apply.exitCode !== 0) {
          return { applied: false, error: apply.stderr || 'git apply failed' };
        }
        return { applied: true };
      } finally {
        if (existsSync(tmpFile)) unlinkSync(tmpFile);
      }
    },
    async revert(diff, repoRoot) {
      const tmpFile = resolve(repoRoot, '.tmp-auto-revert.patch');
      writeFileSync(tmpFile, diff, 'utf8');
      try {
        await runner.run('git', ['apply', '--reverse', tmpFile], {
          cwd: repoRoot,
        });
      } finally {
        if (existsSync(tmpFile)) unlinkSync(tmpFile);
      }
    },
  };
}

/**
 * Real GitOperations for the autonomous loop.
 *
 * Worktree isolation — this implementation NEVER runs a destructive
 * `git reset --hard` on the user's main working tree. Each task gets
 * its own `git worktree` under `os.tmpdir()`; diff application,
 * typecheck, tests, commit, and push all target that worktree. The
 * loop's `finally` block calls `cleanup()` on every exit path to
 * remove the worktree.
 *
 * Why: the user's live checkout may hold uncommitted work, in-progress
 * branches, etc. A destructive reset would wipe those. Worktrees share
 * the underlying `.git` directory (no clone, no copy), so creation and
 * removal are sub-second and nothing on the main tree is touched.
 */
export function createGitOps(
  seedPath: string,
  injectedRunner?: CommandRunner,
): GitOperations {
  const runner = injectedRunner ?? createCommandRunner();

  // `seedPath` is wherever the CLI was invoked from — it may be a
  // subdirectory (e.g. `autonomous/runners/`) rather than the repo
  // root. Resolve the true git top-level via `git rev-parse` so
  // worktree/clone operations always target the real repo. Lazy +
  // cached — first method call pays the lookup cost.
  let resolvedRoot: string | null = null;
  const gitRoot = async (): Promise<string> => {
    if (resolvedRoot) return resolvedRoot;
    const res = await runner.run(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: seedPath },
    );
    const out = res.stdout.trim();
    if (res.exitCode !== 0 || !out) {
      // Not a git repo (or rev-parse failed) — fall back to the
      // provided seed path so the caller still sees a usable error
      // downstream (instead of a cryptic path/empty string failure).
      resolvedRoot = seedPath;
    } else {
      resolvedRoot = out;
    }
    return resolvedRoot;
  };

  const mustRunIn = async (cwd: string, args: string[]): Promise<string> => {
    const { stdout, stderr, exitCode } = await runner.run('git', args, {
      cwd,
    });
    if (exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
    }
    return stdout.trim();
  };

  return {
    async createBranch(name) {
      const repoRoot = await gitRoot();

      // Each branch name maps 1:1 to a worktree path so concurrent
      // tasks don't collide. Slashes in the branch name (auto/<cat>/<id>)
      // can't appear in a directory name — swap for dashes.
      const safeName = name.replace(/\//g, '-');
      const worktreePath = resolve(tmpdir(), `asil-auto-${safeName}`);

      // Clear the four possible leftover states from a prior crashed run:
      //   1. Worktree admin record still registered in .git/worktrees/.
      //   2. Worktree directory on disk (may be from worktree OR clone).
      //   3. Local branch ref in the main repo (blocks `worktree add -b`).
      //   4. None of the above (clean — all these no-op harmlessly).
      // Order matters: prune admin records BEFORE rm -rf so prune sees
      // the disk entries it's supposed to match. Delete the branch
      // ref LAST so nothing still references it.
      await runner.run('git', ['worktree', 'remove', worktreePath, '--force'], {
        cwd: repoRoot,
      });
      await runner.run('git', ['worktree', 'prune'], { cwd: repoRoot });
      if (existsSync(worktreePath)) {
        await runner.run('rm', ['-rf', worktreePath], { cwd: tmpdir() });
      }
      // `git branch -D` is the fix for "fatal: a branch named '<name>'
      // already exists" on retry after a previous worktree was cleaned
      // up without its branch ref. Ignore errors — nothing to delete is
      // the normal case.
      await runner.run('git', ['branch', '-D', name], { cwd: repoRoot });

      // Prefer `git worktree add` — fast (shared .git dir), clean.
      const wtResult = await runner.run(
        'git',
        ['worktree', 'add', worktreePath, '-b', name],
        { cwd: repoRoot },
      );
      if (wtResult.exitCode === 0) return worktreePath;

      // Fallback: the repo lives on Google Drive / iCloud / a FUSE mount
      // that can't host worktree admin files. Clone to local tmp
      // instead. Slower than a worktree but always works.
      const wtErr = wtResult.stderr.trim() || wtResult.stdout.trim();
      console.error(
        `[git] 'git worktree add' failed; falling back to local clone. reason: ${wtErr}`,
      );

      // Grab the real remote URL from the main repo so push still
      // targets GitHub (a plain `git clone <repoRoot>` would point
      // origin at the Drive repo instead).
      const originRes = await runner.run(
        'git',
        ['config', '--get', 'remote.origin.url'],
        { cwd: repoRoot },
      );
      const realOriginUrl = originRes.stdout.trim();

      const cloneRes = await runner.run(
        'git',
        ['clone', '--no-hardlinks', repoRoot, worktreePath],
        { cwd: tmpdir() },
      );
      if (cloneRes.exitCode !== 0) {
        throw new Error(
          `both 'git worktree add' and 'git clone' failed. worktree: ${wtErr}. clone: ${cloneRes.stderr.trim() || cloneRes.stdout.trim()}`,
        );
      }

      if (realOriginUrl) {
        const remoteRes = await runner.run(
          'git',
          ['remote', 'set-url', 'origin', realOriginUrl],
          { cwd: worktreePath },
        );
        if (remoteRes.exitCode !== 0) {
          throw new Error(
            `clone fallback: failed to set origin URL: ${remoteRes.stderr}`,
          );
        }
      }

      // Propagate git identity from the source repo so `git commit` in
      // the clone doesn't fail with "Please tell me who you are".
      // `git clone` inherits the global `~/.gitconfig` only — if the
      // source repo overrides user.name/user.email per-repo (or the
      // global is empty), commits in the clone fail. Copy whatever the
      // source has; ignore failures (commit will surface the real error).
      for (const key of ['user.name', 'user.email'] as const) {
        const got = await runner.run('git', ['config', '--get', key], {
          cwd: repoRoot,
        });
        const value = got.stdout.trim();
        if (got.exitCode === 0 && value) {
          await runner.run('git', ['config', key, value], { cwd: worktreePath });
        }
      }

      // The clone inherits every local branch from the source repo as
      // an `origin/*` remote-tracking ref. A local branch with the
      // task name would block `checkout -b` — delete it first
      // (ignore errors; normal case is nothing to delete).
      await runner.run('git', ['branch', '-D', name], { cwd: worktreePath });
      const branchRes = await runner.run(
        'git',
        ['checkout', '-b', name],
        { cwd: worktreePath },
      );
      if (branchRes.exitCode !== 0) {
        throw new Error(
          `clone fallback: failed to create branch ${name}: ${branchRes.stderr}`,
        );
      }
      return worktreePath;
    },

    async applyDiff(diff, workDir) {
      const tmpFile = resolve(workDir, '.tmp-pr-diff.patch');
      writeFileSync(tmpFile, diff, 'utf8');
      try {
        const check = await runner.run('git', ['apply', '--check', tmpFile], {
          cwd: workDir,
        });
        if (check.exitCode !== 0) return false;
        const apply = await runner.run('git', ['apply', tmpFile], {
          cwd: workDir,
        });
        return apply.exitCode === 0;
      } finally {
        if (existsSync(tmpFile)) unlinkSync(tmpFile);
      }
    },

    async commit(message, workDir) {
      await mustRunIn(workDir, ['add', '-A']);
      await mustRunIn(workDir, ['commit', '-m', message]);
    },

    async push(branch, workDir) {
      // Auto/* branches are owned by the loop. If a previous run pushed
      // a now-stale version of this branch (e.g. crashed before
      // `gh pr create`), a plain push fails with non-fast-forward. We
      // need to overwrite — but safely, so a divergent branch from
      // some other source wouldn't get blasted.
      //
      // Strategy: fetch the remote's view first to populate the
      // tracking ref, then use `--force-with-lease`. The lease passes
      // when the remote matches what we just fetched (i.e. it's still
      // a stale auto/* branch, not something modified between fetch
      // and push). On a brand-new branch with no remote ref, fetch is
      // a no-op and the push behaves normally.
      await runner.run('git', ['fetch', 'origin', branch], { cwd: workDir });
      await mustRunIn(workDir, [
        'push',
        '-u',
        '--force-with-lease',
        'origin',
        branch,
      ]);
    },

    async createPR({ title, body, branch, base }) {
      // `gh pr create` talks to GitHub's API; cwd just needs to be a
      // checkout of the same repo.
      const repoRoot = await gitRoot();
      const bodyFile = resolve(repoRoot, '.tmp-pr-body.md');
      writeFileSync(bodyFile, body, 'utf8');
      try {
        const { stdout, stderr, exitCode } = await runner.run(
          'gh',
          [
            'pr',
            'create',
            '--title',
            title,
            '--body-file',
            bodyFile,
            '--head',
            branch,
            '--base',
            base,
          ],
          { cwd: repoRoot },
        );
        if (exitCode !== 0) {
          // gh sometimes writes the failure reason to stdout (e.g. when
          // a PR already exists for the branch it prints the URL there
          // and exits non-zero). Falling back to stdout + exit code
          // avoids the empty `gh pr create failed:` we saw in the wild.
          const stderrTrim = stderr.trim();
          const stdoutTrim = stdout.trim();
          const detail =
            stderrTrim ||
            stdoutTrim ||
            `(no output, exit code ${exitCode})`;
          throw new Error(
            `gh pr create failed (exit ${exitCode}): ${detail}`,
          );
        }
        return stdout.trim().split(/\r?\n/).pop() ?? '';
      } finally {
        if (existsSync(bodyFile)) unlinkSync(bodyFile);
      }
    },

    async cleanup(workDir) {
      // Best-effort — never throw from cleanup. First try the worktree
      // teardown (works when we used `git worktree add`, harmlessly
      // errors when we used the clone fallback). Then nuke the dir to
      // catch the clone case OR any worktree residue.
      const repoRoot = await gitRoot();
      await runner.run('git', ['worktree', 'remove', workDir, '--force'], {
        cwd: repoRoot,
      });
      if (existsSync(workDir)) {
        await runner.run('rm', ['-rf', workDir], { cwd: tmpdir() });
      }
    },
  };
}

export interface CostInfra {
  tracker: TokenTracker;
  budgetManager: BudgetManager;
  reporter: UsageReporter;
  dataDir: string;
  createCheckpoint: (
    taskId: string,
    systemId: SystemId,
    agentId: string,
  ) => CostCheckpoint;
}

/** Default usage-data location, relative to repoRoot. Overridable via the
 *  `ASIL_USAGE_DATA_DIR` env var (absolute or repoRoot-relative). */
const DEFAULT_USAGE_DATA_SUBPATH = '.asil/usage-data';

/** Shared System C infrastructure — tracker + budget + reporter + a
 *  factory for CostCheckpoints. Creates the usage-data dir if missing. */
export function createCostInfra(repoRoot: string): CostInfra {
  const configured = process.env.ASIL_USAGE_DATA_DIR ?? DEFAULT_USAGE_DATA_SUBPATH;
  const dataDir = isAbsolute(configured) ? configured : resolve(repoRoot, configured);
  mkdirSync(dataDir, { recursive: true });

  const tracker = new TokenTracker(resolve(dataDir, 'usage.json'));
  const budgetManager = new BudgetManager(tracker);
  const reporter = new UsageReporter(tracker, budgetManager);

  return {
    tracker,
    budgetManager,
    reporter,
    dataDir,
    createCheckpoint: (taskId, systemId, agentId) =>
      new CostCheckpoint({
        taskId,
        systemId,
        agentId,
        tracker,
        budgetManager,
      }),
  };
}
