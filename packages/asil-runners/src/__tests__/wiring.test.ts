import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BudgetManager,
  CostCheckpoint,
  TokenTracker,
  UsageReporter,
} from 'asil-cost-controller';
import {
  MODEL_ID_BY_TIER,
  createAnthropicCaller,
  createCodexCaller,
  createCommandRunner,
  createCostInfra,
  createDiffApplier,
  createFileFetcher,
  createFileReader,
  createGitOps,
  createOpenAICompatibleCaller,
  createOpenAICompatibleCodexCaller,
  loadEnv,
} from '../wiring.js';

describe('wiring', () => {
  describe('loadEnv', () => {
    it('throws when ANTHROPIC_API_KEY is missing', () => {
      expect(() => loadEnv({})).toThrow(/ANTHROPIC_API_KEY/);
    });

    it('defaults REPO_ROOT to process.cwd() when not set', () => {
      const env = loadEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' });
      expect(env.REPO_ROOT).toBe(process.cwd());
    });

    it('allows OPENAI_API_KEY to be empty (System B does not need it)', () => {
      const env = loadEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' });
      expect(env.OPENAI_API_KEY).toBe('');
    });

    it('passes through all three env vars when present', () => {
      const env = loadEnv({
        ANTHROPIC_API_KEY: 'sk-ant-x',
        OPENAI_API_KEY: 'sk-oai-y',
        REPO_ROOT: '/tmp/repo',
      });
      expect(env).toEqual({
        ANTHROPIC_API_KEY: 'sk-ant-x',
        OPENAI_API_KEY: 'sk-oai-y',
        REPO_ROOT: '/tmp/repo',
      });
    });

    it('skips the ANTHROPIC_API_KEY requirement when ASIL_LLM_BASE_URL is set (local-mode)', () => {
      const env = loadEnv({
        ASIL_LLM_BASE_URL: 'http://localhost:11434/v1',
        REPO_ROOT: '/tmp/repo',
      });
      // The Anthropic key field stays empty — caller wires the local
      // adapter instead. No throw.
      expect(env.ANTHROPIC_API_KEY).toBe('');
      expect(env.REPO_ROOT).toBe('/tmp/repo');
    });
  });

  describe('MODEL_ID_BY_TIER', () => {
    it('maps opus, sonnet, and haiku tiers to current model IDs', () => {
      expect(MODEL_ID_BY_TIER.opus).toBe('claude-opus-4-7');
      expect(MODEL_ID_BY_TIER.sonnet).toBe('claude-sonnet-4-6');
      expect(MODEL_ID_BY_TIER.haiku).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('createAnthropicCaller', () => {
    it('returns an object with a call() method', () => {
      const caller = createAnthropicCaller('sk-ant-test');
      expect(typeof caller.call).toBe('function');
    });

    it('maps the model tier before invoking the client, and returns SDK tokens verbatim', async () => {
      let capturedModel = '';
      const fakeClient = {
        messages: {
          create: async ({ model }: { model: string }) => {
            capturedModel = model;
            return {
              content: [{ type: 'text', text: 'hello' }],
              usage: { input_tokens: 42, output_tokens: 17 },
            };
          },
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caller = createAnthropicCaller('key', { client: fakeClient as any });
      const res = await caller.call('sys', 'user', 'sonnet');
      expect(capturedModel).toBe('claude-sonnet-4-6');
      expect(res.content).toBe('hello');
      expect(res.inputTokens).toBe(42);
      expect(res.outputTokens).toBe(17);
    });

    it('concatenates multiple text blocks and ignores non-text blocks', async () => {
      const fakeClient = {
        messages: {
          create: async () => ({
            content: [
              { type: 'text', text: 'part1 ' },
              { type: 'tool_use', id: 'x' },
              { type: 'text', text: 'part2' },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caller = createAnthropicCaller('key', { client: fakeClient as any });
      const res = await caller.call('s', 'u', 'opus');
      expect(res.content).toBe('part1 part2');
    });

    it('passes unknown model strings through verbatim', async () => {
      let seen = '';
      const fakeClient = {
        messages: {
          create: async ({ model }: { model: string }) => {
            seen = model;
            return {
              content: [{ type: 'text', text: '' }],
              usage: { input_tokens: 0, output_tokens: 0 },
            };
          },
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const caller = createAnthropicCaller('key', { client: fakeClient as any });
      await caller.call('s', 'u', 'some-future-model');
      expect(seen).toBe('some-future-model');
    });
  });

  describe('createCodexCaller', () => {
    it('returns an object with a call() method', () => {
      const caller = createCodexCaller('sk-oai-test');
      expect(typeof caller.call).toBe('function');
    });

    it('POSTs to chat completions with Bearer auth and returns the choice content', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      const fakeFetch: typeof fetch = (async (
        url: string,
        init?: RequestInit,
      ) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          async json() {
            return {
              choices: [{ message: { content: 'codex reply' } }],
            };
          },
        } as Response;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      const caller = createCodexCaller('sk-oai-abc', { fetchImpl: fakeFetch });
      const res = await caller.call('prompt here', 'gpt-4o');

      expect(res.content).toBe('codex reply');
      expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-oai-abc');
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(String(capturedInit?.body ?? '{}'));
      expect(body.model).toBe('gpt-4o');
      expect(body.messages[0]).toEqual({ role: 'user', content: 'prompt here' });
    });

    it('throws a clear error when the OpenAI API returns non-OK', async () => {
      const fakeFetch: typeof fetch = (async () =>
        ({
          ok: false,
          status: 429,
          async text() {
            return 'rate limited';
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any) as any;
      const caller = createCodexCaller('k', { fetchImpl: fakeFetch });
      await expect(caller.call('p', 'gpt-4o')).rejects.toThrow(/429/);
    });

    it('falls back to empty content if the response shape is malformed', async () => {
      const fakeFetch: typeof fetch = (async () =>
        ({
          ok: true,
          async json() {
            return { choices: [] };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any) as any;
      const caller = createCodexCaller('k', { fetchImpl: fakeFetch });
      const res = await caller.call('p', 'gpt-4o');
      expect(res.content).toBe('');
    });
  });

  describe('createOpenAICompatibleCaller', () => {
    it('POSTs system+user messages to <baseUrl>/chat/completions; parses content + usage', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      const fakeFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          async json() {
            return {
              choices: [{ message: { content: 'llm reply' } }],
              usage: { prompt_tokens: 17, completion_tokens: 9 },
            };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;

      const caller = createOpenAICompatibleCaller({
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'optional-token',
        fetchImpl: fakeFetch,
      });
      const res = await caller.call('sys', 'user', 'llama3.1');

      expect(res.content).toBe('llm reply');
      expect(res.inputTokens).toBe(17);
      expect(res.outputTokens).toBe(9);
      expect(capturedUrl).toBe('http://localhost:11434/v1/chat/completions');

      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer optional-token');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(String(capturedInit?.body ?? '{}'));
      expect(body.model).toBe('llama3.1');
      expect(body.messages).toEqual([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' },
      ]);
    });

    it('omits Authorization header when apiKey is unset (many local servers ignore auth)', async () => {
      let capturedInit: RequestInit | undefined;
      const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'r' } }] };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
      const caller = createOpenAICompatibleCaller({
        baseUrl: 'http://localhost:11434/v1',
        fetchImpl: fakeFetch,
      });
      await caller.call('s', 'u', 'm');
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('estimates tokens via chars/4 when the server omits usage', async () => {
      const fakeFetch: typeof fetch = (async () =>
        ({
          ok: true,
          async json() {
            // No `usage` field — common with Ollama on /v1 and llama.cpp.
            return { choices: [{ message: { content: 'abcdefghij' } }] };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any) as any;
      const caller = createOpenAICompatibleCaller({
        baseUrl: 'http://localhost:11434/v1',
        fetchImpl: fakeFetch,
      });
      const res = await caller.call('sysprompt', 'userp', 'm');
      // system+user chars = 9 + 1 + 5 = 15; ceil(15/4) = 4
      expect(res.inputTokens).toBe(4);
      // content chars = 10; ceil(10/4) = 3
      expect(res.outputTokens).toBe(3);
    });

    it('honours a custom estimateTokens', async () => {
      const fakeFetch: typeof fetch = (async () =>
        ({
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'xyz' } }] };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any) as any;
      const caller = createOpenAICompatibleCaller({
        baseUrl: 'http://x/v1',
        fetchImpl: fakeFetch,
        estimateTokens: (t) => t.length, // 1 char = 1 token
      });
      const res = await caller.call('ab', 'c', 'm');
      // estimateTokens('ab\nc') = 4
      expect(res.inputTokens).toBe(4);
      expect(res.outputTokens).toBe(3);
    });

    it('strips trailing slash from baseUrl before appending /chat/completions', async () => {
      let capturedUrl = '';
      const fakeFetch: typeof fetch = (async (url: string) => {
        capturedUrl = url;
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'r' } }] };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
      const caller = createOpenAICompatibleCaller({
        baseUrl: 'http://localhost:1234/v1/',
        fetchImpl: fakeFetch,
      });
      await caller.call('s', 'u', 'm');
      expect(capturedUrl).toBe('http://localhost:1234/v1/chat/completions');
    });

    it('throws a clear error when the server returns non-OK', async () => {
      const fakeFetch: typeof fetch = (async () =>
        ({
          ok: false,
          status: 500,
          async text() {
            return 'broken';
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any) as any;
      const caller = createOpenAICompatibleCaller({
        baseUrl: 'http://x/v1',
        fetchImpl: fakeFetch,
      });
      await expect(caller.call('s', 'u', 'm')).rejects.toThrow(/500/);
    });
  });

  describe('createOpenAICompatibleCodexCaller', () => {
    it('uses a single user message and returns just { content }', async () => {
      let capturedInit: RequestInit | undefined;
      const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return {
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'adversarial reply' } }] };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any;
      const caller = createOpenAICompatibleCodexCaller({
        baseUrl: 'http://localhost:11434/v1',
        fetchImpl: fakeFetch,
      });
      const res = await caller.call('challenge this diff', 'mistral');
      expect(res.content).toBe('adversarial reply');
      const body = JSON.parse(String(capturedInit?.body ?? '{}'));
      expect(body.messages).toEqual([
        { role: 'user', content: 'challenge this diff' },
      ]);
      // The result shape matches CodexCaller — no token fields.
      expect('inputTokens' in res).toBe(false);
    });
  });

  describe('createCommandRunner', () => {
    it('captures stdout and exitCode=0 for a successful command', async () => {
      const runner = createCommandRunner();
      const result = await runner.run('node', ['-e', 'console.log("ok")'], {
        cwd: process.cwd(),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/ok/);
    });

    it('captures non-zero exitCode without throwing', async () => {
      const runner = createCommandRunner();
      const result = await runner.run('node', ['-e', 'process.exit(3)'], {
        cwd: process.cwd(),
      });
      expect(result.exitCode).toBe(3);
    });

    it('surfaces a clear stderr for missing binaries (ENOENT) with exit code 127 — regression: empty `??` fallback used to swallow it', async () => {
      const runner = createCommandRunner();
      const result = await runner.run(
        'a-binary-that-does-not-exist-test',
        [],
        { cwd: process.cwd() },
      );
      // POSIX "command not found" exit code so callers can distinguish.
      expect(result.exitCode).toBe(127);
      // The actual error message must be in stderr — not empty,
      // not the cryptic "(no output)" placeholder.
      expect(result.stderr).toMatch(/ENOENT|not found|spawn/i);
      expect(result.stderr.trim()).not.toBe('');
    });
  });

  describe('createFileReader', () => {
    it('returns null for missing files', async () => {
      const fs = createFileReader();
      expect(await fs.read('/nonexistent/missing.json')).toBeNull();
    });

    it('reads existing files', async () => {
      const fs = createFileReader();
      expect(await fs.read(__filename)).toMatch(/createFileReader/);
    });
  });

  describe('createFileFetcher', () => {
    it('resolves relative paths under repoRoot', async () => {
      const fetcher = createFileFetcher();
      const content = await fetcher.read(
        'src/wiring.ts',
        resolve(__dirname, '..', '..'),
      );
      expect(content).toMatch(/createAnthropicCaller/);
    });
  });

  describe('createDiffApplier', () => {
    it('returns an object with apply() and revert()', () => {
      const diff = createDiffApplier();
      expect(typeof diff.apply).toBe('function');
      expect(typeof diff.revert).toBe('function');
    });
  });

  describe('createGitOps', () => {
    it('returns the full worktree-aware GitOperations surface', () => {
      const git = createGitOps('/tmp');
      expect(typeof git.createBranch).toBe('function');
      expect(typeof git.applyDiff).toBe('function');
      expect(typeof git.commit).toBe('function');
      expect(typeof git.push).toBe('function');
      expect(typeof git.createPR).toBe('function');
      // cleanup() is the non-negotiable worktree teardown hook.
      expect(typeof git.cleanup).toBe('function');
    });

    it('createBranch succeeds when `git worktree add` works', async () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const runner = {
        async run(cmd: string, args: string[]) {
          calls.push({ cmd, args });
          // rev-parse --show-toplevel needs to return a usable path
          // so subsequent git ops target the right root.
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            return { stdout: '/repo\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps('/repo', runner);
      const path = await git.createBranch('auto/test-failure/abc12345');
      expect(path).toMatch(/asil-auto-auto-test-failure-abc12345/);
      expect(calls.some((c) => c.args.includes('clone'))).toBe(false);
    });

    it('createBranch deletes a stale local branch before creating a new one (fixes "a branch named X already exists" on retry)', async () => {
      const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
      const runner = {
        async run(cmd: string, args: string[], opts: { cwd: string }) {
          calls.push({ cmd, args, cwd: opts.cwd });
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            return { stdout: '/repo\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps('/repo', runner);
      await git.createBranch('auto/test-failure/abc12345');

      // The fix: `git branch -D <name>` must run in repoRoot before
      // `git worktree add -b <name>`. Otherwise the add fails with
      // "a branch named '<name>' already exists" on retry after a
      // previous run that left the branch ref behind.
      const branchDeleteIdx = calls.findIndex(
        (c) =>
          c.args[0] === 'branch' &&
          c.args[1] === '-D' &&
          c.args[2] === 'auto/test-failure/abc12345' &&
          c.cwd === '/repo',
      );
      const worktreeAddIdx = calls.findIndex(
        (c) => c.args[0] === 'worktree' && c.args[1] === 'add',
      );
      expect(branchDeleteIdx).toBeGreaterThanOrEqual(0);
      expect(worktreeAddIdx).toBeGreaterThanOrEqual(0);
      expect(branchDeleteIdx).toBeLessThan(worktreeAddIdx);
    });

    it('createBranch also prunes stale worktree admin records before adding', async () => {
      const calls: Array<{ args: string[] }> = [];
      const runner = {
        async run(_cmd: string, args: string[]) {
          calls.push({ args });
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            return { stdout: '/repo\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps('/repo', runner);
      await git.createBranch('auto/x/y');
      const pruneIdx = calls.findIndex(
        (c) => c.args[0] === 'worktree' && c.args[1] === 'prune',
      );
      const addIdx = calls.findIndex(
        (c) => c.args[0] === 'worktree' && c.args[1] === 'add',
      );
      expect(pruneIdx).toBeGreaterThanOrEqual(0);
      expect(pruneIdx).toBeLessThan(addIdx);
    });

    it('createGitOps resolves the true git root via `git rev-parse --show-toplevel` (fixes seedPath-is-a-subdir bug)', async () => {
      const calls: Array<{ args: string[]; cwd?: string }> = [];
      const runner = {
        async run(_cmd: string, args: string[], opts: { cwd: string }) {
          calls.push({ args, cwd: opts.cwd });
          // Seed was the runners package dir; rev-parse walks up to
          // the true repo root.
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            return {
              stdout: '/tmp/example-repo\n',
              stderr: '',
              exitCode: 0,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps(
        '/tmp/example-repo/autonomous/runners',
        runner,
      );
      await git.createBranch('auto/x/y');

      // rev-parse runs with cwd = seed path (starting point).
      const revParse = calls.find(
        (c) => c.args[0] === 'rev-parse' && c.args.includes('--show-toplevel'),
      );
      expect(revParse?.cwd).toBe('/tmp/example-repo/autonomous/runners');

      // Every subsequent git command uses the RESOLVED root, not the seed.
      const worktreeAdd = calls.find(
        (c) => c.args[0] === 'worktree' && c.args[1] === 'add',
      );
      expect(worktreeAdd?.cwd).toBe('/tmp/example-repo');
    });

    it('clone fallback sources from the RESOLVED root, not the (possibly wrong) seed path', async () => {
      const calls: Array<{ args: string[]; cwd?: string }> = [];
      const runner = {
        async run(_cmd: string, args: string[], opts: { cwd: string }) {
          calls.push({ args, cwd: opts.cwd });
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            return { stdout: '/true/repo\n', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'worktree' && args[1] === 'add') {
            // Force fallback.
            return { stdout: '', stderr: 'drive error', exitCode: 128 };
          }
          if (args[0] === 'config' && args.includes('remote.origin.url')) {
            return {
              stdout: 'https://github.com/acme/example.git',
              stderr: '',
              exitCode: 0,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps('/some/subdir', runner);
      await git.createBranch('auto/x/y');

      const clone = calls.find((c) => c.args[0] === 'clone');
      // The clone source (second positional arg after flags) must be
      // the resolved root, not the seed.
      expect(clone?.args).toContain('/true/repo');
      expect(clone?.args).not.toContain('/some/subdir');
    });

    it('createBranch falls back to `git clone` when `git worktree add` fails (Google Drive / FUSE mount case)', async () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const runner = {
        async run(cmd: string, args: string[]) {
          calls.push({ cmd, args });
          // Simulate the Drive failure for `worktree add`.
          if (args[0] === 'worktree' && args[1] === 'add') {
            return {
              stdout: '',
              stderr: 'fatal: cannot create directory',
              exitCode: 128,
            };
          }
          // Surface the origin URL so remote set-url gets called.
          if (args[0] === 'config' && args.includes('remote.origin.url')) {
            return {
              stdout: 'https://github.com/acme/example.git',
              stderr: '',
              exitCode: 0,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps('/repo', runner);
      const path = await git.createBranch('auto/test-failure/abc12345');
      expect(path).toMatch(/asil-auto-auto-test-failure-abc12345/);
      // Clone fallback actually ran.
      const cloneCall = calls.find((c) => c.args[0] === 'clone');
      expect(cloneCall).toBeDefined();
      expect(cloneCall?.args).toContain('--no-hardlinks');
      expect(cloneCall?.args).toContain('/repo');
      // Origin rewired to the real GitHub URL so `push` doesn't target
      // the Drive repo.
      const setUrl = calls.find(
        (c) => c.args[0] === 'remote' && c.args[1] === 'set-url',
      );
      expect(setUrl?.args).toContain('https://github.com/acme/example.git');
      // Branch created off the clone's HEAD.
      const checkout = calls.find((c) => c.args[0] === 'checkout');
      expect(checkout?.args).toEqual(['checkout', '-b', 'auto/test-failure/abc12345']);
    });

    it('createBranch throws with a clear error when BOTH worktree and clone fail', async () => {
      const runner = {
        async run(_cmd: string, args: string[]) {
          if (args[0] === 'worktree' && args[1] === 'add') {
            return {
              stdout: '',
              stderr: 'drive mount error',
              exitCode: 128,
            };
          }
          if (args[0] === 'clone') {
            return {
              stdout: '',
              stderr: 'fatal: could not read from remote',
              exitCode: 128,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps('/repo', runner);
      await expect(git.createBranch('auto/x/y')).rejects.toThrow(
        /both 'git worktree add' and 'git clone' failed/,
      );
    });
  });

  describe('createCostInfra', () => {
    let dir: string;
    let savedEnv: string | undefined;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'wiring-'));
      savedEnv = process.env.ASIL_USAGE_DATA_DIR;
      delete process.env.ASIL_USAGE_DATA_DIR;
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      if (savedEnv === undefined) {
        delete process.env.ASIL_USAGE_DATA_DIR;
      } else {
        process.env.ASIL_USAGE_DATA_DIR = savedEnv;
      }
    });

    it('creates the default .asil/usage-data dir if missing and wires tracker + budget + reporter', () => {
      const infra = createCostInfra(dir);
      expect(infra.tracker).toBeInstanceOf(TokenTracker);
      expect(infra.budgetManager).toBeInstanceOf(BudgetManager);
      expect(infra.reporter).toBeInstanceOf(UsageReporter);
      expect(existsSync(join(dir, '.asil', 'usage-data'))).toBe(true);
    });

    it('honours ASIL_USAGE_DATA_DIR when set (relative path resolved against repoRoot)', () => {
      process.env.ASIL_USAGE_DATA_DIR = 'custom/spend';
      const infra = createCostInfra(dir);
      expect(existsSync(join(dir, 'custom', 'spend'))).toBe(true);
      expect(infra.dataDir).toBe(join(dir, 'custom', 'spend'));
    });

    it('honours ASIL_USAGE_DATA_DIR when set to an absolute path', () => {
      const abs = mkdtempSync(join(tmpdir(), 'asil-abs-'));
      process.env.ASIL_USAGE_DATA_DIR = abs;
      try {
        const infra = createCostInfra(dir);
        expect(infra.dataDir).toBe(abs);
        expect(existsSync(abs)).toBe(true);
      } finally {
        rmSync(abs, { recursive: true, force: true });
      }
    });

    it('createCheckpoint returns a CostCheckpoint bound to the shared tracker/budget', () => {
      const infra = createCostInfra(dir);
      infra.budgetManager.allocate('t1', 'B', 'test-coverage', 'sonnet');
      const cp = infra.createCheckpoint('t1', 'B', 'runner-test');
      expect(cp).toBeInstanceOf(CostCheckpoint);
      const check = cp.recordAndCheck(100, 50, 'sonnet');
      expect(check.allowed).toBe(true);
    });
  });
});
