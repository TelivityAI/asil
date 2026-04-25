import { describe, expect, it } from 'vitest';
import { synthesize, DEFAULT_SYNTH_CONFIG } from '../synthesizer.js';
import type {
  Concern,
  Recommendation,
  ThinkerOutput,
  ThinkerRole,
} from '../types.js';

function mkOutput(
  role: ThinkerRole,
  recs: Recommendation[] = [],
  concerns: Concern[] = [],
): ThinkerOutput {
  return {
    role,
    requestId: 'r1',
    analysis: `${role} analysis`,
    recommendations: recs.map((r) => ({ ...r, source: role })),
    concerns,
    costUsed: { inputTokens: 100, outputTokens: 50 },
  };
}

function rec(
  category: Recommendation['category'],
  description: string,
  priority: Recommendation['priority'] = 'should',
): Recommendation {
  return { category, priority, description, rationale: 'because' };
}

describe('synthesize', () => {
  it('deduplicates identical recommendations from two thinkers, keeps highest priority', () => {
    const outputs = [
      mkOutput('spec-writer', [rec('implementation', 'Use Zod for config validation', 'should')]),
      mkOutput('api-designer', [rec('implementation', 'Use Zod for config validation', 'must')]),
    ];
    const result = synthesize('r1', outputs);
    const impl = result.mergedRecommendations.filter((r) => r.category === 'implementation');
    expect(impl.length).toBe(1);
    expect(impl[0]?.priority).toBe('must');
  });

  it('merges distinct recommendations cleanly with no conflicts', () => {
    const outputs = [
      mkOutput('spec-writer', [rec('architecture', 'Split into three modules')]),
      mkOutput('planner', [rec('planning', 'Build in three phases')]),
    ];
    const result = synthesize('r1', outputs);
    expect(result.resolvedConflicts.length).toBe(0);
    expect(result.mergedRecommendations.length).toBe(2);
  });

  it('security wins in conflict with spec-writer (securityWeight=0.7)', () => {
    const outputs = [
      mkOutput('security', [rec('security', 'Do not store API keys in database', 'must')]),
      mkOutput('spec-writer', [rec('security', 'Store API keys in database', 'should')]),
    ];
    const result = synthesize('r1', outputs, { ...DEFAULT_SYNTH_CONFIG });
    expect(result.resolvedConflicts.length).toBe(1);
    expect(result.resolvedConflicts[0]?.resolution?.chosen).toBe('A');
    expect(result.resolvedConflicts[0]?.resolution?.reasoning).toMatch(/security/i);
  });

  it('blocker concern triggers escalateToHuman with a reason', () => {
    const outputs = [
      mkOutput('security', [], [
        {
          severity: 'blocker',
          source: 'security',
          description: 'Unknown how tokens are rotated',
          suggestedResolution: 'Ask Dušan',
        },
      ]),
    ];
    const result = synthesize('r1', outputs);
    expect(result.escalateToHuman).toBe(true);
    expect(result.escalationReason).toMatch(/blocker/i);
    expect(result.unresolvedConcerns.length).toBe(1);
  });

  it('orders build steps: architecture → api-design → implementation → testing → security', () => {
    const outputs = [
      mkOutput('spec-writer', [
        rec('testing', 'Test the happy path'),
        rec('architecture', 'Define the interface'),
        rec('security', 'Validate all inputs'),
        rec('implementation', 'Write the adapter'),
        rec('api-design', 'Expose GET /things'),
      ]),
    ];
    const result = synthesize('r1', outputs);
    const titles = result.buildSteps.map((s) => s.title);
    expect(titles).toEqual(['Architecture', 'API Design', 'Implementation', 'Testing', 'Security']);
  });

  it('sorts recommendations within a step by priority (must > should > could)', () => {
    const outputs = [
      mkOutput('spec-writer', [
        rec('implementation', 'Could-level work', 'could'),
        rec('implementation', 'Must-level work', 'must'),
        rec('implementation', 'Should-level work', 'should'),
      ]),
    ];
    const result = synthesize('r1', outputs);
    const implStep = result.buildSteps.find((s) => s.title === 'Implementation');
    expect(implStep?.description.indexOf('Must-level')).toBeLessThan(
      implStep?.description.indexOf('Should-level') ?? -1,
    );
    expect(implStep?.description.indexOf('Should-level')).toBeLessThan(
      implStep?.description.indexOf('Could-level') ?? -1,
    );
  });

  it('empty thinker outputs produce a minimal valid synthesis', () => {
    const result = synthesize('r1', []);
    expect(result.mergedRecommendations).toEqual([]);
    expect(result.buildSteps).toEqual([]);
    expect(result.escalateToHuman).toBe(false);
  });

  it('thinkerContributions records analysis text from each thinker', () => {
    const outputs = [
      mkOutput('spec-writer', [rec('architecture', 'X')]),
      mkOutput('security', [rec('security', 'Y')]),
    ];
    const result = synthesize('r1', outputs);
    expect(result.thinkerContributions['spec-writer']).toBe('spec-writer analysis');
    expect(result.thinkerContributions.security).toBe('security analysis');
  });

  it('non-security conflict with asymmetric polarity picks the conservative side', () => {
    const outputs = [
      mkOutput('spec-writer', [rec('implementation', 'Do not cache pricing responses', 'must')]),
      mkOutput('api-designer', [rec('implementation', 'Cache pricing responses aggressively', 'should')]),
    ];
    const result = synthesize('r1', outputs);
    expect(result.resolvedConflicts.length).toBe(1);
    expect(result.resolvedConflicts[0]?.resolution?.chosen).toBe('A');
  });
});
