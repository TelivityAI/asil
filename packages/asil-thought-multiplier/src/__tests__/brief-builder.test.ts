import { describe, expect, it } from 'vitest';
import {
  buildBrief,
  extractTitle,
  generateAcceptanceCriteria,
  generateDoNotChange,
} from '../brief-builder.js';
import type {
  SynthesisResult,
  ThoughtMultiplierConfig,
} from '../types.js';

const CONFIG: ThoughtMultiplierConfig = {
  papaModel: 'opus',
  thinkerModel: 'sonnet',
  maxThinkers: 4,
  autoEscalate: true,
  osmaniSkillsPath: '/nonexistent',
  securityWeight: 0.7,
};

function emptySynthesis(overrides: Partial<SynthesisResult> = {}): SynthesisResult {
  return {
    requestId: 'r1',
    mergedRecommendations: [],
    resolvedConflicts: [],
    unresolvedConcerns: [],
    escalateToHuman: false,
    buildSteps: [],
    thinkerContributions: {},
    ...overrides,
  };
}

describe('brief-builder', () => {
  it('extractTitle returns first 8 words, capitalized', () => {
    expect(extractTitle('add a new expense adapter package with oauth support today now')).toBe(
      'Add a new expense adapter package with oauth',
    );
  });

  it('extractTitle handles empty input', () => {
    expect(extractTitle('')).toBe('Untitled Build');
  });

  it('generateAcceptanceCriteria always includes standard checks', () => {
    const ac = generateAcceptanceCriteria(emptySynthesis());
    expect(ac).toContain('`pnpm test` passes');
    expect(ac).toContain('`pnpm typecheck` clean');
  });

  it('generateAcceptanceCriteria includes must-priority recommendations', () => {
    const ac = generateAcceptanceCriteria(
      emptySynthesis({
        mergedRecommendations: [
          {
            category: 'implementation',
            priority: 'must',
            description: 'All money math uses decimal.js',
            rationale: 'currency safety',
          },
          {
            category: 'implementation',
            priority: 'should',
            description: 'Log timings',
            rationale: 'ops',
          },
        ],
      }),
    );
    expect(ac).toContain('All money math uses decimal.js');
    expect(ac).not.toContain('Log timings');
  });

  it('generateDoNotChange always lists the cost controller and appends caller-supplied extras', () => {
    const dnc = generateDoNotChange();
    expect(dnc.some((l) => l.includes('cost-controller'))).toBe(true);

    const dncWithExtras = generateDoNotChange([
      'House style guide (@acme/style)',
      'Database schema unless the brief adds new tables',
    ]);
    expect(dncWithExtras.some((l) => l.includes('cost-controller'))).toBe(true);
    expect(dncWithExtras.some((l) => l.includes('House style guide'))).toBe(true);
    expect(dncWithExtras.some((l) => l.includes('Database schema'))).toBe(true);
  });

  it('buildBrief produces markdown with all standard sections', () => {
    const brief = buildBrief(
      emptySynthesis({
        buildSteps: [
          {
            order: 1,
            title: 'Architecture',
            description: '- [must] Define the interface — because',
            files: ['src/types.ts'],
            testRequirements: [],
            securityConsiderations: [],
          },
        ],
      }),
      'Build a new expense adapter',
      CONFIG,
    );
    expect(brief.markdown).toContain('# CLAUDE CODE BUILD BRIEF');
    expect(brief.markdown).toContain('## OBJECTIVE');
    expect(brief.markdown).toContain('## STEP 1: Architecture');
    expect(brief.markdown).toContain('## ACCEPTANCE CRITERIA');
    expect(brief.markdown).toContain('## DO NOT CHANGE');
    expect(brief.markdown).toContain('## DOMAIN QUESTIONS');
  });

  it('buildBrief includes a CONFLICT RESOLUTIONS section when conflicts exist', () => {
    const brief = buildBrief(
      emptySynthesis({
        resolvedConflicts: [
          {
            thinkerA: 'security',
            thinkerB: 'spec-writer',
            issue: 'security: contradictory recommendations',
            positionA: 'Do not store secrets in env',
            positionB: 'Store secrets in env',
            resolution: {
              chosen: 'A',
              reasoning: 'Security wins.',
              resolvedBy: 'papa',
            },
          },
        ],
      }),
      'Encrypt bot tokens',
      CONFIG,
    );
    expect(brief.markdown).toContain('## CONFLICT RESOLUTIONS');
    expect(brief.markdown).toContain('security vs spec-writer');
    expect(brief.markdown).toContain('Security wins.');
  });

  it('buildBrief domainQuestions populated from unresolved concerns', () => {
    const brief = buildBrief(
      emptySynthesis({
        unresolvedConcerns: [
          {
            severity: 'blocker',
            source: 'security',
            description: 'Unknown rotation policy',
            suggestedResolution: 'Ask Dušan',
          },
        ],
      }),
      'Add token rotation',
      CONFIG,
    );
    expect(brief.domainQuestions[0]).toMatch(/Unknown rotation policy/);
    expect(brief.domainQuestions[0]).toMatch(/security/);
    expect(brief.markdown).toContain('## DOMAIN QUESTIONS');
    expect(brief.markdown).toContain('Unknown rotation policy');
  });

  it('buildBrief reports the thinker model in estimatedTokenCost', () => {
    const brief = buildBrief(emptySynthesis(), 'x', CONFIG);
    expect(brief.estimatedTokenCost.model).toBe('sonnet');
  });
});
