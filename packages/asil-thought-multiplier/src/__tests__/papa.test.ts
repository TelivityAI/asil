import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BudgetManager,
  CostCheckpoint,
  TokenTracker,
} from 'asil-cost-controller';
import { runPapa, DEFAULT_CONFIG } from '../papa.js';
import type { UserRequest } from '../types.js';
import { envelope, mockLLM } from './helpers.js';

function req(input: string, id = 'r1'): UserRequest {
  return { id, input, timestamp: new Date() };
}

describe('runPapa — integration', () => {
  let dir: string;
  let tracker: TokenTracker;
  let bm: BudgetManager;
  let cp: CostCheckpoint;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'papa-'));
    tracker = new TokenTracker(join(dir, 'usage.json'), { autoPersist: false });
    bm = new BudgetManager(tracker);
    bm.allocate('t1', 'B', 'thought-multiplier', 'sonnet');
    cp = new CostCheckpoint({
      taskId: 't1',
      systemId: 'B',
      agentId: 'papa',
      tracker,
      budgetManager: bm,
      checkpointInterval: 1,
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('full flow: input → routing → fan-out → synthesis → brief', async () => {
    const llm = mockLLM({
      'spec-writer': {
        content: envelope({
          recommendations: [
            {
              category: 'architecture',
              priority: 'must',
              description: 'Define the interface first',
              rationale: 'contracts precede impl',
            },
          ],
        }),
      },
      'test-strategist': {
        content: envelope({
          recommendations: [
            {
              category: 'testing',
              priority: 'must',
              description: 'Cover the happy path and two failure modes',
              rationale: 'business logic',
            },
          ],
        }),
      },
    });

    const result = await runPapa(req('Build a new expense adapter'), llm, cp, {
      ...DEFAULT_CONFIG,
      markdownSkillsPath: '/nonexistent',
    });

    expect(result.escalated).toBe(false);
    expect(result.brief).not.toBeNull();
    expect(result.brief?.markdown).toContain('# CLAUDE CODE BUILD BRIEF');
    expect(result.routing.activatedThinkers).toContain('spec-writer');
    expect(result.routing.activatedThinkers).toContain('test-strategist');
    expect(result.totalCost.inputTokens).toBeGreaterThan(0);
    expect(result.totalCost.outputTokens).toBeGreaterThan(0);
  });

  it('blocker concern escalates, returns brief=null', async () => {
    const llm = mockLLM({
      'spec-writer': {
        content: envelope({
          concerns: [
            {
              severity: 'blocker',
              description: 'Unknown fare rule for ticket refunds',
              suggestedResolution: 'Ask Dušan',
            },
          ],
        }),
      },
    });

    const result = await runPapa(req('Add a new refund feature'), llm, cp, {
      ...DEFAULT_CONFIG,
      markdownSkillsPath: '/nonexistent',
    });

    expect(result.escalated).toBe(true);
    expect(result.brief).toBeNull();
    expect(result.escalationReason).toMatch(/blocker/i);
  });

  it('budget exceeded during fan-out returns escalated=true with kill', async () => {
    // The default thought-multiplier task has 2× multiplier on the
    // estimate (80k→160k input, 60k→120k output) and a $2 cost cap.
    // Blow past the cost cap with one enormous Sonnet response.
    const llm = mockLLM({
      'spec-writer': {
        content: envelope({ recommendations: [] }),
        inputTokens: 5_000_000,
        outputTokens: 5_000_000,
      },
      'test-strategist': {
        content: envelope({ recommendations: [] }),
        inputTokens: 1,
        outputTokens: 1,
      },
    });

    const result = await runPapa(req('Build something'), llm, cp, {
      ...DEFAULT_CONFIG,
      markdownSkillsPath: '/nonexistent',
    });

    expect(result.escalated).toBe(true);
    expect(result.brief).toBeNull();
    expect(result.escalationReason).toMatch(/budget/i);
  });

  it('security-vs-spec-writer conflict: security wins at default securityWeight', async () => {
    const llm = mockLLM({
      security: {
        content: envelope({
          recommendations: [
            {
              category: 'security',
              priority: 'must',
              description: 'Do not store API keys in plaintext',
              rationale: 'leak risk',
            },
          ],
        }),
      },
      'spec-writer': {
        content: envelope({
          recommendations: [
            {
              category: 'security',
              priority: 'should',
              description: 'Store API keys in plaintext for simplicity',
              rationale: 'fewer moving parts',
            },
          ],
        }),
      },
    });

    const result = await runPapa(
      req('Add API key auth to the admin endpoint'),
      llm,
      cp,
      { ...DEFAULT_CONFIG, markdownSkillsPath: '/nonexistent' },
    );

    expect(result.synthesis.resolvedConflicts.length).toBeGreaterThanOrEqual(1);
    const firstResolution = result.synthesis.resolvedConflicts[0]?.resolution;
    expect(firstResolution?.reasoning).toMatch(/security/i);
  });

  it('records thinker token usage via the checkpoint', async () => {
    const llm = mockLLM({
      'spec-writer': { content: envelope({}), inputTokens: 200, outputTokens: 100 },
      'test-strategist': {
        content: envelope({}),
        inputTokens: 150,
        outputTokens: 80,
      },
    });

    await runPapa(req('Build a new thing'), llm, cp, {
      ...DEFAULT_CONFIG,
      markdownSkillsPath: '/nonexistent',
    });

    const usage = tracker.getTaskUsage('t1');
    expect(usage?.callCount).toBeGreaterThanOrEqual(1);
    expect(usage?.totalInputTokens).toBeGreaterThan(0);
    expect(usage?.totalOutputTokens).toBeGreaterThan(0);
  });

  it('routing reflects the user input semantics', async () => {
    const llm = mockLLM({});
    const result = await runPapa(
      req('Fix the test for the pricing module'),
      llm,
      cp,
      { ...DEFAULT_CONFIG, markdownSkillsPath: '/nonexistent' },
    );
    expect(result.routing.activatedThinkers).toContain('test-strategist');
  });
});
