import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RemoteBranchExistsError } from 'asil-improvement-loop';
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
  scrubbedEnv,
  createDiffApplier,
  createFileFetcher,
  createFileReader,
  createGitOps,
  gitOpsEnv,
  isScratchClone,
  prepareScratchClone,
  removeScratchClone,
  scratchClonePath,
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

    it('surfaces token usage from the OpenAI usage block (Codex review #2)', async () => {
      const fakeFetch: typeof fetch = (async () =>
        ({
          ok: true,
          async json() {
            return {
              choices: [{ message: { content: 'reply' } }],
              usage: { prompt_tokens: 30, completion_tokens: 8 },
            };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any) as any;
      const caller = createCodexCaller('k', { fetchImpl: fakeFetch });
      const res = await caller.call('p', 'gpt-4o');
      expect(res.inputTokens).toBe(30);
      expect(res.outputTokens).toBe(8);
    });

    it('reports zero tokens when usage is absent (does not throw)', async () => {
      const fakeFetch: typeof fetch = (async () =>
        ({
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'reply' } }] };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any) as any;
      const caller = createCodexCaller('k', { fetchImpl: fakeFetch });
      const res = await caller.call('p', 'gpt-4o');
      expect(res.inputTokens).toBe(0);
      expect(res.outputTokens).toBe(0);
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
      // Default max_tokens must be high enough for whole-file rewrites —
      // 4096 truncated large files mid-output and the patch was rejected.
      // A live gpt-4o grind surfaced this. (Matches the Anthropic caller.)
      expect(body.max_tokens).toBe(8192);
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
    it('uses a single user message and reports token usage from the server', async () => {
      let capturedInit: RequestInit | undefined;
      const fakeFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return {
          ok: true,
          async json() {
            return {
              choices: [{ message: { content: 'adversarial reply' } }],
              usage: { prompt_tokens: 12, completion_tokens: 4 },
            };
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
      // CodexCaller now surfaces tokens so the adversarial gate is
      // budget-accounted (Codex review #2).
      expect(res.inputTokens).toBe(12);
      expect(res.outputTokens).toBe(4);
    });

    it('estimates tokens via chars/4 when the server omits usage', async () => {
      const fakeFetch: typeof fetch = (async () =>
        ({
          ok: true,
          async json() {
            return { choices: [{ message: { content: 'abcdefgh' } }] };
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any) as any;
      const caller = createOpenAICompatibleCodexCaller({
        baseUrl: 'http://x/v1',
        fetchImpl: fakeFetch,
      });
      const res = await caller.call('abcd', 'm'); // prompt 4 chars → 1
      expect(res.inputTokens).toBe(1);
      expect(res.outputTokens).toBe(2); // content 8 chars → 2
    });
  });

  describe('scrubbedEnv (Codex #1 — Level 1 sandbox)', () => {
    it('strips secret-shaped vars but keeps PATH/HOME/pnpm config', () => {
      const src = {
        PATH: '/usr/bin',
        HOME: '/home/x',
        npm_config_registry: 'https://registry.npmjs.org',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-oai-secret',
        GITHUB_TOKEN: 'ghp_secret',
        GH_TOKEN: 'gho_secret',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        MY_DB_PASSWORD: 'hunter2',
        SOME_SESSION_TOKEN: 'abc',
        REGULAR_VAR: 'fine',
      };
      const out = scrubbedEnv(src);
      // Kept — needed for pnpm/tsc/vitest to run.
      expect(out.PATH).toBe('/usr/bin');
      expect(out.HOME).toBe('/home/x');
      expect(out.npm_config_registry).toBe('https://registry.npmjs.org');
      expect(out.REGULAR_VAR).toBe('fine');
      // Stripped — secrets must never reach untrusted target-repo code.
      expect(out.ANTHROPIC_API_KEY).toBeUndefined();
      expect(out.OPENAI_API_KEY).toBeUndefined();
      expect(out.GITHUB_TOKEN).toBeUndefined();
      expect(out.GH_TOKEN).toBeUndefined();
      expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(out.MY_DB_PASSWORD).toBeUndefined();
      expect(out.SOME_SESSION_TOKEN).toBeUndefined();
    });
  });

  describe('gitOpsEnv', () => {
    it('keeps git and GitHub credentials and drops model API keys', () => {
      const out = gitOpsEnv({
        PATH: '/usr/bin',
        HOME: '/home/x',
        LANG: 'C',
        GIT_AUTHOR_NAME: 'A',
        GH_TOKEN: 'gho_token',
        GITHUB_TOKEN: 'ghp_token',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-oai-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
      });
      expect(out.PATH).toBe('/usr/bin');
      expect(out.HOME).toBe('/home/x');
      expect(out.GIT_AUTHOR_NAME).toBe('A');
      expect(out.GH_TOKEN).toBe('gho_token');
      expect(out.GITHUB_TOKEN).toBe('ghp_token');
      expect(out.ANTHROPIC_API_KEY).toBeUndefined();
      expect(out.OPENAI_API_KEY).toBeUndefined();
      expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
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

    it('with { env } replaces the child environment — secrets are not visible to spawned commands (Codex #1)', async () => {
      // A spawned process should NOT see a secret that the parent has,
      // when the runner is built with a scrubbed env.
      process.env.ASIL_TEST_SECRET = 'leak-me';
      try {
        const scrubbed = scrubbedEnv({ PATH: process.env.PATH, ASIL_TEST_SECRET: 'leak-me-too' });
        // (ASIL_TEST_SECRET doesn't match a secret pattern, so prove the
        //  env-REPLACEMENT itself isolates: build a runner with an env
        //  that simply omits it.)
        const runner = createCommandRunner({ env: { PATH: process.env.PATH ?? '' } });
        const res = await runner.run(
          'node',
          ['-e', 'process.stdout.write(String(process.env.ASIL_TEST_SECRET))'],
          { cwd: process.cwd() },
        );
        expect(res.stdout.trim()).toBe('undefined');
        // sanity: the inherited runner WOULD see it
        const inherit = createCommandRunner();
        const res2 = await inherit.run(
          'node',
          ['-e', 'process.stdout.write(String(process.env.ASIL_TEST_SECRET))'],
          { cwd: process.cwd() },
        );
        expect(res2.stdout.trim()).toBe('leak-me');
        void scrubbed;
      } finally {
        delete process.env.ASIL_TEST_SECRET;
      }
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

    it('refuses absolute paths and paths that leave the repository', async () => {
      const fetcher = createFileFetcher();
      const root = resolve(__dirname, '..', '..');
      await expect(fetcher.read('/etc/passwd', root)).rejects.toThrow(/outside the repository/);
      await expect(fetcher.read('../../etc/passwd', root)).rejects.toThrow(
        /outside the repository/,
      );
    });
  });

  describe('createDiffApplier', () => {
    it('returns an object with apply() and revert()', () => {
      const diff = createDiffApplier();
      expect(typeof diff.apply).toBe('function');
      expect(typeof diff.revert).toBe('function');
    });

    it('does not write the patch file into the working tree', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'asil-diff-'));
      try {
        const diff = createDiffApplier();
        await diff.apply('not a diff', dir);
        expect(existsSync(join(dir, '.tmp-auto-diff.patch'))).toBe(false);
        expect(existsSync(join(dir, '.tmp-pr-diff.patch'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('scratch clone', () => {
    const source = '/repo/example';

    it('clones with --no-hardlinks and points origin at the real remote', async () => {
      const dest = scratchClonePath(source);
      const calls: Array<{ args: string[]; cwd?: string }> = [];
      const runner = {
        async run(_cmd: string, args: string[], opts: { cwd: string }) {
          calls.push({ args, cwd: opts.cwd });
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            return { stdout: `${source}\n`, stderr: '', exitCode: 0 };
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'config' && args.includes('remote.origin.url')) {
            return {
              stdout: 'https://github.com/acme/example.git\n',
              stderr: '',
              exitCode: 0,
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      rmSync(dest, { recursive: true, force: true });
      const path = await prepareScratchClone(source, runner);
      expect(path).toBe(dest);
      expect(isScratchClone(path)).toBe(true);
      const clone = calls.find((c) => c.args[0] === 'clone');
      expect(clone?.args).toEqual(['clone', '--no-hardlinks', source, dest]);
      expect(clone?.args).not.toContain('fetch');
      const setUrl = calls.find((c) => c.args[0] === 'remote' && c.args[1] === 'set-url');
      expect(setUrl?.args).toContain('https://github.com/acme/example.git');
      expect(setUrl?.cwd).toBe(dest);
      expect(calls.some((c) => c.args[0] === 'fetch')).toBe(false);
    });

    it('reuses an existing clone and refreshes from the local source without cloning again', async () => {
      const dest = scratchClonePath(source);
      mkdirSync(dest, { recursive: true });
      const calls: Array<{ args: string[]; cwd?: string }> = [];
      const runner = {
        async run(_cmd: string, args: string[], opts: { cwd: string }) {
          calls.push({ args, cwd: opts.cwd });
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            const top = opts.cwd === dest ? dest : source;
            return { stdout: `${top}\n`, stderr: '', exitCode: 0 };
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return { stdout: 'def456\n', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'config' && args.includes('asil.scratchSource')) {
            return { stdout: `${source}\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      try {
        const path = await prepareScratchClone(source, runner);
        expect(path).toBe(dest);
        expect(calls.some((c) => c.args[0] === 'clone')).toBe(false);
        const fetch = calls.find((c) => c.args[0] === 'fetch');
        expect(fetch?.args).toEqual([
          'fetch',
          '--no-tags',
          source,
          '+HEAD:refs/asil/source-head',
        ]);
        expect(fetch?.cwd).toBe(dest);
        expect(
          calls.some(
            (c) =>
              c.args[0] === 'reset' &&
              c.args[1] === '--hard' &&
              c.args[2] === 'refs/asil/source-head',
          ),
        ).toBe(true);
        expect(
          calls.some(
            (c) =>
              c.args[0] === 'config' &&
              c.args.includes('asil.scratchBase') &&
              c.args.includes('def456'),
          ),
        ).toBe(true);
        expect(calls.some((c) => c.args.includes('worktree'))).toBe(false);
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    });

    it('--fresh deletes the warm scratch before cloning', async () => {
      const dest = scratchClonePath(source);
      mkdirSync(dest, { recursive: true });
      const calls: Array<{ args: string[] }> = [];
      const runner = {
        async run(_cmd: string, args: string[]) {
          calls.push({ args });
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            return { stdout: `${source}\n`, stderr: '', exitCode: 0 };
          }
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      try {
        expect(existsSync(dest)).toBe(true);
        const path = await prepareScratchClone(source, runner, { fresh: true });
        expect(path).toBe(dest);
        // fresh deletes the warm directory before clone; the mock runner
        // does not recreate it on disk.
        expect(existsSync(dest)).toBe(false);
        expect(calls.some((c) => c.args[0] === 'clone')).toBe(true);
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    });

    it('removeScratchClone deletes only the scratch directory', async () => {
      const dest = scratchClonePath(source);
      mkdirSync(dest, { recursive: true });
      await removeScratchClone(source);
      expect(existsSync(dest)).toBe(false);
      await removeScratchClone('/etc');
      expect(existsSync('/etc')).toBe(true);
    });
  });

  describe('createGitOps', () => {
    const source = '/repo/example';
    const scratch = scratchClonePath(source);

    function scratchRunner(
      extra?: (
        args: string[],
        cwd: string,
      ) => { stdout: string; stderr: string; exitCode: number } | undefined,
    ) {
      const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
      const runner = {
        async run(cmd: string, args: string[], opts: { cwd: string }) {
          calls.push({ cmd, args, cwd: opts.cwd });
          const overridden = extra?.(args, opts.cwd);
          if (overridden) return overridden;
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            return { stdout: `${scratch}\n`, stderr: '', exitCode: 0 };
          }
          if (args[0] === 'config' && args.includes('asil.scratchBase')) {
            return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      return { calls, runner };
    }

    it('returns the git operations surface', () => {
      const git = createGitOps(scratch);
      expect(typeof git.createBranch).toBe('function');
      expect(typeof git.applyDiff).toBe('function');
      expect(typeof git.commit).toBe('function');
      expect(typeof git.push).toBe('function');
      expect(typeof git.createPR).toBe('function');
      expect(typeof git.cleanup).toBe('function');
    });

    it('createBranch checks out inside the scratch clone and does not touch the source repo', async () => {
      const { calls, runner } = scratchRunner();
      const git = createGitOps(scratch, runner);
      const path = await git.createBranch('auto/test-failure/abc12345');
      expect(path).toBe(scratch);
      const checkout = calls.find((c) => c.args[0] === 'checkout');
      expect(checkout?.args).toEqual([
        'checkout',
        '-B',
        'auto/test-failure/abc12345',
        'abc123',
      ]);
      expect(checkout?.cwd).toBe(scratch);
      expect(calls.some((c) => c.args.includes('worktree'))).toBe(false);
      expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(
        false,
      );
      expect(calls.some((c) => c.cwd === source)).toBe(false);
    });

    it('refuses to create a branch when the git root is the open checkout', async () => {
      const runner = {
        async run(_cmd: string, args: string[]) {
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
            return { stdout: `${source}\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps(source, runner);
      await expect(git.createBranch('auto/x/y')).rejects.toThrow(/scratch clone/);
    });

    it('commits with hooks disabled', async () => {
      const calls: string[][] = [];
      const runner = {
        async run(_cmd: string, args: string[]) {
          calls.push(args);
          if (args[0] === 'rev-parse') {
            return { stdout: '/repo\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps('/repo', runner);
      await git.commit('auto(type-error): fix', '/tmp/work');
      const commit = calls.find((args) => args.includes('commit'));
      expect(commit).toEqual([
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--no-verify',
        '-m',
        'auto(type-error): fix',
      ]);
    });

    it('writes the pull request body under the temp directory', async () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const runner = {
        async run(cmd: string, args: string[]) {
          calls.push({ cmd, args });
          if (args[0] === 'rev-parse') {
            return { stdout: '/repo\n', stderr: '', exitCode: 0 };
          }
          return { stdout: 'https://example.com/pull/1\n', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps('/repo', runner);
      await git.createPR({
        title: 't',
        body: 'hello',
        branch: 'auto/x/y',
        base: 'main',
      });
      const gh = calls.find((c) => c.cmd === 'gh');
      expect(gh?.args).toContain('--draft');
      const bodyFile = gh?.args[gh.args.indexOf('--body-file') + 1] ?? '';
      expect(bodyFile.startsWith(tmpdir())).toBe(true);
      expect(bodyFile.includes(`${join('repo', '.tmp-pr-body.md')}`)).toBe(false);
      expect(existsSync(resolve('/repo', '.tmp-pr-body.md'))).toBe(false);
    });

    it('pushes without force and skips a branch that already exists on origin', async () => {
      const branch = 'auto/type-error/abc12345';
      const fresh = scratchRunner();
      const git = createGitOps(scratch, fresh.runner);
      await git.push(branch, scratch);
      const push = fresh.calls.find((c) => c.args[0] === 'push');
      expect(push?.args).toEqual(['push', '-u', 'origin', branch]);
      expect(push?.args).not.toContain('--force-with-lease');

      const taken = scratchRunner((args) => {
        if (args[0] === 'ls-remote') {
          return {
            stdout: `deadbeef\trefs/heads/${branch}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        return undefined;
      });
      const blocked = createGitOps(scratch, taken.runner);
      await expect(blocked.push(branch, scratch)).rejects.toBeInstanceOf(
        RemoteBranchExistsError,
      );
      expect(taken.calls.some((c) => c.args[0] === 'push')).toBe(false);
      expect(taken.calls.some((c) => c.args.includes('--force-with-lease'))).toBe(
        false,
      );
    });

    it('resets the scratch clone without deleting it or its dependencies', async () => {
      const { calls, runner } = scratchRunner();
      const git = createGitOps(scratch, runner);
      await git.cleanup(scratch);
      expect(calls.some((c) => c.args[0] === 'reset' && c.args[1] === '--hard')).toBe(
        true,
      );
      const clean = calls.find((c) => c.args[0] === 'clean');
      expect(clean?.args).toContain('node_modules');
      expect(clean?.cwd).toBe(scratch);
      expect(calls.some((c) => c.cmd === 'rm')).toBe(false);
      expect(calls.some((c) => c.args.includes('worktree'))).toBe(false);
    });

    it('refuses to delete a path that is not this repository worktree', async () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const runner = {
        async run(cmd: string, args: string[]) {
          calls.push({ cmd, args });
          if (args[0] === 'rev-parse') {
            return { stdout: '/repo\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      };
      const git = createGitOps('/repo', runner);
      await git.cleanup('/etc');
      expect(calls.some((c) => c.cmd === 'rm')).toBe(false);
      expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(
        false,
      );
    });
  });

  describe('createCostInfra', () => {
    let dir: string;
    let savedUsage: string | undefined;
    let savedState: string | undefined;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'wiring-'));
      savedUsage = process.env.ASIL_USAGE_DATA_DIR;
      savedState = process.env.ASIL_STATE_DIR;
      delete process.env.ASIL_USAGE_DATA_DIR;
      delete process.env.ASIL_STATE_DIR;
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      if (savedUsage === undefined) {
        delete process.env.ASIL_USAGE_DATA_DIR;
      } else {
        process.env.ASIL_USAGE_DATA_DIR = savedUsage;
      }
      if (savedState === undefined) {
        delete process.env.ASIL_STATE_DIR;
      } else {
        process.env.ASIL_STATE_DIR = savedState;
      }
    });

    it('creates the default usage-data dir under the temp state root', () => {
      const infra = createCostInfra(dir);
      expect(infra.tracker).toBeInstanceOf(TokenTracker);
      expect(infra.budgetManager).toBeInstanceOf(BudgetManager);
      expect(infra.reporter).toBeInstanceOf(UsageReporter);
      expect(infra.dataDir.startsWith(join(tmpdir(), 'asil-state-'))).toBe(true);
      expect(infra.dataDir.endsWith(join('.asil', 'usage-data'))).toBe(true);
      expect(existsSync(infra.dataDir)).toBe(true);
      expect(existsSync(join(dir, '.asil', 'usage-data'))).toBe(false);
    });

    it('honours ASIL_STATE_DIR for the default usage-data location', () => {
      const state = mkdtempSync(join(tmpdir(), 'asil-state-override-'));
      process.env.ASIL_STATE_DIR = state;
      try {
        const infra = createCostInfra(dir);
        expect(infra.dataDir).toBe(join(state, '.asil', 'usage-data'));
        expect(existsSync(infra.dataDir)).toBe(true);
      } finally {
        rmSync(state, { recursive: true, force: true });
      }
    });

    it('honours ASIL_USAGE_DATA_DIR when set (relative path resolved against repoRoot)', () => {
      process.env.ASIL_USAGE_DATA_DIR = 'custom/spend';
      const infra = createCostInfra(dir);
      expect(existsSync(join(dir, 'custom', 'spend'))).toBe(true);
      expect(infra.dataDir).toBe(join(dir, 'custom', 'spend'));
    });

    it('resolves a relative ASIL_USAGE_DATA_DIR against ASIL_STATE_DIR when set', () => {
      const state = mkdtempSync(join(tmpdir(), 'asil-state-rel-'));
      process.env.ASIL_STATE_DIR = state;
      process.env.ASIL_USAGE_DATA_DIR = 'custom/spend';
      try {
        const infra = createCostInfra(dir);
        expect(infra.dataDir).toBe(join(state, 'custom', 'spend'));
        expect(existsSync(infra.dataDir)).toBe(true);
      } finally {
        rmSync(state, { recursive: true, force: true });
      }
    });

    it('rejects a relative ASIL_USAGE_DATA_DIR that leaves the repository', () => {
      process.env.ASIL_USAGE_DATA_DIR = '../outside-repo';
      expect(() => createCostInfra(dir)).toThrow(/outside the repository/);
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
