/**
 * CLI dispatch tests. We don't exercise the actual think/grind/report
 * flows here — those are covered by each runner's own test file. The
 * point of this test is the routing and error-handling at the CLI
 * layer: unknown commands, missing args, help, and the `status` view.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli, workspaceEnvPath } from '../cli.js';

function mkIO(): {
  log: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  out(): string;
  err(): string;
} {
  const log = vi.fn();
  const error = vi.fn();
  return {
    log,
    error,
    out: () => log.mock.calls.map((c) => String(c[0] ?? '')).join('\n'),
    err: () => error.mock.calls.map((c) => String(c[0] ?? '')).join('\n'),
  };
}

describe('workspaceEnvPath', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads the .env next to pnpm-workspace.yaml, not a nested package .env', () => {
    dir = mkdtempSync(join(tmpdir(), 'asil-env-'));
    const nested = join(dir, 'packages', 'asil-runners', 'src');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=from-root\n');
    writeFileSync(join(dir, 'packages', '.env'), 'ANTHROPIC_API_KEY=from-packages\n');
    expect(workspaceEnvPath(nested)).toBe(join(dir, '.env'));
  });
});

describe('runCli', () => {
  it('no args → prints help and exits 0', async () => {
    const io = mkIO();
    const code = await runCli([], io);
    expect(code).toBe(0);
    expect(io.out()).toContain('ASIL — Autonomous Improvement Loop');
    expect(io.out()).toContain('think');
    expect(io.out()).toContain('grind');
    expect(io.out()).toContain('report');
    expect(io.out()).toContain('status');
  });

  it('`help` → prints help', async () => {
    const io = mkIO();
    expect(await runCli(['help'], io)).toBe(0);
    expect(io.out()).toContain('Usage: pnpm auto');
  });

  it('`--help` → prints help', async () => {
    const io = mkIO();
    expect(await runCli(['--help'], io)).toBe(0);
    expect(io.out()).toContain('Usage: pnpm auto');
  });

  it('`-h` → prints help', async () => {
    const io = mkIO();
    expect(await runCli(['-h'], io)).toBe(0);
    expect(io.out()).toContain('Usage: pnpm auto');
  });

  it('unknown command → prints error + help, exits 1', async () => {
    const io = mkIO();
    const code = await runCli(['wrangle'], io);
    expect(code).toBe(1);
    expect(io.err()).toContain('Unknown command: wrangle');
    expect(io.out()).toContain('Usage: pnpm auto');
  });

  it('`think` with no input → usage error, exits 1', async () => {
    const io = mkIO();
    const code = await runCli(['think'], io);
    expect(code).toBe(1);
    expect(io.err()).toMatch(/Usage: pnpm auto think/);
  });

  it('`status` prints daily budget, spend, active tasks, and remaining', async () => {
    // Minimal env for loadEnv() — status uses createCostInfra which needs
    // a REPO_ROOT but no network calls.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const io = mkIO();
      const code = await runCli(['status'], io);
      expect(code).toBe(0);
      const out = io.out();
      expect(out).toContain('Autonomous System Status');
      expect(out).toMatch(/Daily budget:\s+\$\d/);
      expect(out).toMatch(/Spent today:\s+\$\d/);
      expect(out).toMatch(/Active tasks:/);
      expect(out).toMatch(/Remaining:\s+\$\d/);
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
