/**
 * Runtime wiring — turns the mock boundaries in Systems A / B / C into
 * real API-backed implementations. Pure glue: no domain logic here.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import {
  RemoteBranchExistsError,
  resolveConfiguredPath,
  type CodexCaller,
  type CommandRunner,
  type DiffApplier,
  type FileFetcher,
  type FileReader,
  type GitOperations,
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
    async call(prompt: string, model: string) {
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
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      // Surface token usage so the adversarial gate's spend is
      // budget-accounted (Codex review #2).
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
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
  /** Max output tokens per call. Default 8192 — matches the Anthropic
   *  caller. The executor rewrites WHOLE files, so a low cap truncates
   *  large-file rewrites mid-output (the closing `<<<END FILE>>>`
   *  sentinel gets cut), and the patch is rejected. 4096 was too low. */
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
      max_tokens: opts.maxTokens ?? 8192,
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
 * CodexCaller variant for the adversarial gate against a local model.
 * Reports token usage from the server's `usage` block when present,
 * else estimates via chars/4 — so adversarial spend is budget-accounted
 * even on local servers that omit usage (Codex review #2).
 */
export function createOpenAICompatibleCodexCaller(
  opts: OpenAICompatibleOptions,
): CodexCaller {
  const estimate = opts.estimateTokens ?? defaultEstimator;
  return {
    async call(prompt, model) {
      const data = await postOpenAICompatible(opts, {
        model,
        messages: [{ role: 'user', content: prompt }],
      });
      const content = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage ?? {};
      return {
        content,
        inputTokens:
          typeof usage.prompt_tokens === 'number'
            ? usage.prompt_tokens
            : estimate(prompt),
        outputTokens:
          typeof usage.completion_tokens === 'number'
            ? usage.completion_tokens
            : estimate(content),
      };
    },
  };
}

export interface CommandRunnerOptions {
  /** Complete environment for spawned commands. When set, replaces the
   *  inherited process env entirely. Untrusted target-repo commands pass
   *  a scrubbed environment. Git and gh pass an allowlisted environment.
   *  Leave undefined only when the caller intentionally inherits the
   *  parent process environment. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Environment-variable names whose VALUES are secrets and must never
 * reach a spawned target-repo command (where a malicious postinstall,
 * build, or test script could exfiltrate them). Used by `scrubbedEnv`.
 */
const SECRET_ENV_PATTERNS: RegExp[] = [
  // Secret-shaped SUFFIXES catch the common cases (NPM_TOKEN, DB_PASSWORD,
  // *_API_KEY, *_SECRET, etc.) without touching pnpm's npm_config_* vars.
  /_(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/i,
  // Provider prefixes for vars that DON'T end in a secret-shaped suffix.
  // Deliberately excludes a blanket `NPM_` (would strip npm_config_*).
  /^(ANTHROPIC|OPENAI|GH|GITHUB|AWS|GCP|GOOGLE|AZURE|SLACK|STRIPE|HF|HUGGINGFACE)_/i,
  /^(API_KEY|ACCESS_KEY|SESSION_TOKEN|PRIVATE_KEY)$/i,
];

/**
 * Build an environment for untrusted commands by removing secret-shaped
 * variables from the inherited env. Default-allow (keeps PATH, HOME,
 * npm/pnpm config, etc. so pnpm/tsc/vitest still run) but strips
 * anything matching a secret pattern. This is the Level-1 sandbox
 * boundary: the credentials ASIL injects (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GH/GITHUB tokens) are no longer in scope when the
 * loop runs `pnpm install`/build/test inside a worktree of the target
 * repo. (Codex review #1.)
 */
export function scrubbedEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_ENV_PATTERNS.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Environment for git and gh. Target-repo hooks must not see model API
 * keys. Only identity, temp, path, and the tokens those tools need to
 * authenticate are copied.
 */
const GITOPS_ENV_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_EXEC_PATH',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
]);

export function gitOpsEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      GITOPS_ENV_EXACT.has(key) ||
      key.startsWith('GIT_') ||
      key.startsWith('LC_')
    ) {
      out[key] = value;
    }
  }
  return out;
}

/** Short stable id so worktrees from different repositories cannot collide. */
export function worktreeSlug(repoRoot: string): string {
  return createHash('sha256').update(resolve(repoRoot)).digest('hex').slice(0, 12);
}

export function worktreePathFor(repoRoot: string, branchName: string): string {
  const safeName = branchName.replace(/[/\\]/g, '-');
  return resolve(tmpdir(), `asil-auto-${worktreeSlug(repoRoot)}-${safeName}`);
}

/** Scratch clone for one grind run. Distinct from any editor checkout. */
export function scratchClonePath(repoRoot: string): string {
  return resolve(tmpdir(), `asil-scratch-${worktreeSlug(repoRoot)}`);
}

/** True when `dir` is an ASIL scratch clone under the system temp directory. */
export function isScratchClone(dir: string): boolean {
  const abs = resolve(dir);
  return (
    dirname(abs) === resolve(tmpdir()) &&
    /^asil-scratch-[0-9a-f]{12}$/.test(basename(abs))
  );
}

/** True when `candidate` is the temp worktree directory for `repoRoot`. */
export function isDeletableWorktree(workDir: string, repoRoot: string): boolean {
  const abs = resolve(workDir);
  const tmp = resolve(tmpdir());
  const prefix = resolve(tmpdir(), `asil-auto-${worktreeSlug(repoRoot)}-`);
  const underTmp = abs === tmp || abs.startsWith(tmp + sep);
  return underTmp && abs.startsWith(prefix);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Real CommandRunner via execFile. Captures stdout, stderr, and exit code
 *  without throwing — callers inspect exitCode to decide.
 *  Pass `{ env: scrubbedEnv() }` for the untrusted target-repo runner so
 *  secrets never enter the spawned command's environment. */
export function createCommandRunner(
  opts: CommandRunnerOptions = {},
): CommandRunner {
  return {
    async run(command, args, { cwd }) {
      try {
        const { stdout, stderr } = await execFileAsync(command, args, {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 10 * 60_000,
          ...(opts.env ? { env: opts.env } : {}),
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
      if (isAbsolute(filePath) || filePath.split(/[/\\]/).includes('..')) {
        throw new Error(`Refusing to read a path outside the repository: ${filePath}`);
      }
      const root = resolve(repoRoot);
      const abs = resolve(root, filePath);
      if (!isInsideRoot(root, abs)) {
        throw new Error(`Refusing to read a path outside the repository: ${filePath}`);
      }
      return readFileSync(abs, 'utf8');
    },
  };
}

/** Real DiffApplier used by the executor to apply-then-verify the LLM's
 *  unified diff. On success the tree stays dirty — the PR builder is
 *  responsible for checking out a fresh branch and re-applying cleanly. */
export function createDiffApplier(): DiffApplier {
  const runner = createCommandRunner({ env: scrubbedEnv() });
  const patchFile = (): string =>
    join(tmpdir(), `asil-diff-${randomUUID()}.patch`);
  return {
    async apply(diff, repoRoot) {
      const tmpFile = patchFile();
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
      const tmpFile = patchFile();
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

async function gitTopLevel(
  runner: CommandRunner,
  cwd: string,
): Promise<string> {
  const res = await runner.run('git', ['rev-parse', '--show-toplevel'], { cwd });
  const out = res.stdout.trim();
  if (res.exitCode !== 0 || !out) return resolve(cwd);
  return out;
}

export interface PrepareScratchCloneOptions {
  /** Delete any existing scratch for this repo and clone from scratch. */
  fresh?: boolean;
}

/**
 * Clone `repoRoot` into `tmpdir()/asil-scratch-<hash>`, or reuse and
 * refresh that directory when it is already a clone of this repository.
 * Refresh copies objects from the local source path (not `origin`) and
 * does not create worktrees on the open checkout. `origin` stays pointed
 * at the source repository's real remote.
 */
export async function prepareScratchClone(
  repoRoot: string,
  injectedRunner?: CommandRunner,
  opts: PrepareScratchCloneOptions = {},
): Promise<string> {
  const runner = injectedRunner ?? createCommandRunner({ env: gitOpsEnv() });
  const source = await gitTopLevel(runner, repoRoot);
  const dest = scratchClonePath(source);

  if (opts.fresh) {
    await removeScratchClone(source);
  }

  if (existsSync(dest)) {
    const marker = await runner.run(
      'git',
      ['config', '--get', 'asil.scratchSource'],
      { cwd: dest },
    );
    const top = await runner.run('git', ['rev-parse', '--show-toplevel'], {
      cwd: dest,
    });
    const sameSource = marker.exitCode === 0 && marker.stdout.trim() === source;
    const sameTop = top.exitCode === 0 && resolve(top.stdout.trim()) === dest;
    if (sameSource && sameTop) {
      await refreshScratchFromSource(runner, source, dest);
      return dest;
    }
    if (!isScratchClone(dest)) {
      throw new Error(`Refusing to replace ${dest}: not an ASIL scratch clone.`);
    }
    rmSync(dest, { recursive: true, force: true });
  }

  const cloneRes = await runner.run(
    'git',
    ['clone', '--no-hardlinks', source, dest],
    { cwd: tmpdir() },
  );
  if (cloneRes.exitCode !== 0) {
    throw new Error(
      `git clone failed: ${cloneRes.stderr.trim() || cloneRes.stdout.trim()}`,
    );
  }

  const originRes = await runner.run(
    'git',
    ['config', '--get', 'remote.origin.url'],
    { cwd: source },
  );
  const realOriginUrl = originRes.stdout.trim();
  if (originRes.exitCode === 0 && realOriginUrl) {
    const remoteRes = await runner.run(
      'git',
      ['remote', 'set-url', 'origin', realOriginUrl],
      { cwd: dest },
    );
    if (remoteRes.exitCode !== 0) {
      throw new Error(`failed to set origin URL: ${remoteRes.stderr}`);
    }
  }

  for (const key of ['user.name', 'user.email'] as const) {
    const got = await runner.run('git', ['config', '--get', key], { cwd: source });
    const value = got.stdout.trim();
    if (got.exitCode === 0 && value) {
      await runner.run('git', ['config', key, value], { cwd: dest });
    }
  }

  const head = await runner.run('git', ['rev-parse', 'HEAD'], { cwd: dest });
  const base = head.stdout.trim();
  if (head.exitCode !== 0 || !base) {
    throw new Error('scratch clone has no HEAD');
  }
  await runner.run('git', ['config', 'asil.scratchSource', source], { cwd: dest });
  await runner.run('git', ['config', 'asil.scratchBase', base], { cwd: dest });
  return dest;
}

/** Pull the open checkout's current HEAD into the scratch without worktrees. */
async function refreshScratchFromSource(
  runner: CommandRunner,
  source: string,
  dest: string,
): Promise<void> {
  const head = await runner.run('git', ['rev-parse', 'HEAD'], { cwd: source });
  const sha = head.stdout.trim();
  if (head.exitCode !== 0 || !sha) {
    throw new Error(`failed to read HEAD from ${source}: ${head.stderr}`);
  }

  // Fetch objects from the local source path into a private ref. This
  // does not create a worktree and does not rewrite origin.
  const fetchRes = await runner.run(
    'git',
    ['fetch', '--no-tags', source, `+HEAD:refs/asil/source-head`],
    { cwd: dest },
  );
  if (fetchRes.exitCode !== 0) {
    throw new Error(
      `failed to refresh scratch from ${source}: ${fetchRes.stderr.trim() || fetchRes.stdout.trim()}`,
    );
  }

  const reset = await runner.run(
    'git',
    ['reset', '--hard', 'refs/asil/source-head'],
    { cwd: dest },
  );
  if (reset.exitCode !== 0) {
    throw new Error(
      `failed to reset scratch to source HEAD: ${reset.stderr.trim() || reset.stdout.trim()}`,
    );
  }

  await runner.run(
    'git',
    [
      'clean',
      '-fd',
      '-e',
      'node_modules',
      '-e',
      '.pnpm-store',
      '-e',
      'dist',
      '-e',
      '.asil-scratch',
    ],
    { cwd: dest },
  );
  await runner.run('git', ['config', 'asil.scratchBase', sha], { cwd: dest });
}

/** Delete the scratch clone for `repoRoot`, or `dir` when it is already that path. */
export async function removeScratchClone(repoRootOrDest: string): Promise<void> {
  const dest = isScratchClone(repoRootOrDest)
    ? resolve(repoRootOrDest)
    : scratchClonePath(repoRootOrDest);
  if (!isScratchClone(dest)) return;
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
}

/**
 * Git operations for a grind run. `seedPath` is the scratch clone from
 * `prepareScratchClone`. Branch creation checks out inside that clone
 * only. It does not call `git worktree` or `git branch -D` on the
 * repository the operator has open.
 */
export function createGitOps(
  seedPath: string,
  injectedRunner?: CommandRunner,
): GitOperations {
  const runner = injectedRunner ?? createCommandRunner({ env: gitOpsEnv() });

  // `seedPath` is wherever the CLI was invoked from. It may be a
  // subdirectory rather than the repository root. Resolve the true git
  // top-level via `git rev-parse` so worktree and clone operations
  // always target the real repository. Lazy and cached — the first
  // method call pays the lookup cost.
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
      if (!isScratchClone(repoRoot)) {
        throw new Error(
          `Refusing to create ${name} in ${repoRoot}. Grind creates branches only inside its scratch clone.`,
        );
      }
      const baseRes = await runner.run(
        'git',
        ['config', '--get', 'asil.scratchBase'],
        { cwd: repoRoot },
      );
      const base = baseRes.stdout.trim();
      if (baseRes.exitCode !== 0 || !base) {
        throw new Error(
          `scratch clone ${repoRoot} has no asil.scratchBase; refusing to check out ${name}`,
        );
      }
      // -B resets the branch to the cloned revision. Every task shares
      // this directory so node_modules survives from task to task.
      const branchRes = await runner.run(
        'git',
        ['checkout', '-B', name, base],
        { cwd: repoRoot },
      );
      if (branchRes.exitCode !== 0) {
        throw new Error(
          `failed to create branch ${name}: ${branchRes.stderr.trim() || branchRes.stdout.trim()}`,
        );
      }
      return repoRoot;
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
      // Disable the target repository's hooks. They run with this
      // process's environment and can touch other checkouts.
      await mustRunIn(workDir, [
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--no-verify',
        '-m',
        message,
      ]);
    },

    async push(branch, workDir) {
      // A normal push. If origin already has this auto/* branch, skip
      // the push. Do not force-update a branch the remote already has.
      const listed = await runner.run(
        'git',
        ['ls-remote', '--heads', 'origin', branch],
        { cwd: workDir },
      );
      if (listed.exitCode === 0 && listed.stdout.trim()) {
        throw new RemoteBranchExistsError(branch);
      }
      await mustRunIn(workDir, ['push', '-u', 'origin', branch]);
    },

    async createPR({ title, body, branch, base }) {
      // `gh pr create` talks to GitHub's API; cwd just needs to be a
      // checkout of the same repo.
      const repoRoot = await gitRoot();
      const bodyDir = mkdtempSync(join(tmpdir(), 'asil-pr-'));
      const bodyFile = join(bodyDir, 'body.md');
      try {
        writeFileSync(bodyFile, body, 'utf8');
        const { stdout, stderr, exitCode } = await runner.run(
          'gh',
          [
            'pr',
            'create',
            '--title',
            title,
            '--body-file',
            bodyFile,
            '--draft',
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
        rmSync(bodyDir, { recursive: true, force: true });
      }
    },

    async cleanup(workDir) {
      // Best-effort — never throw from cleanup. Reset the scratch clone
      // only. node_modules and dist stay so the next task does not
      // reinstall. The process deletes the clone on exit.
      const repoRoot = await gitRoot();
      if (resolve(workDir) !== resolve(repoRoot) || !isScratchClone(repoRoot)) {
        console.error(
          `[git] Refusing to reset ${workDir}: not this run's scratch clone.`,
        );
        return;
      }
      await runner.run('git', ['reset', '--hard'], { cwd: repoRoot });
      await runner.run(
        'git',
        [
          'clean',
          '-fd',
          '-e',
          'node_modules',
          '-e',
          '.pnpm-store',
          '-e',
          'dist',
          '-e',
          '.asil-scratch',
        ],
        { cwd: repoRoot },
      );
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
  const dataDir = resolveConfiguredPath(repoRoot, configured);
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
