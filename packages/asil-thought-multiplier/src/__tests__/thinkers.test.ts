import { describe, expect, it } from 'vitest';
import { runSpecWriter } from '../thinkers/spec-writer.js';
import { runSecurity } from '../thinkers/security.js';
import { runTestStrategist } from '../thinkers/test-strategist.js';
import { runApiDesigner } from '../thinkers/api-designer.js';
import { runPlanner } from '../thinkers/planner.js';
import type { LLMCaller, LLMResponse, UserRequest } from '../types.js';
import { envelope } from './helpers.js';

function mkLLM(script: () => LLMResponse): LLMCaller & {
  calls: Array<{ system: string; user: string; model: string }>;
} {
  const calls: Array<{ system: string; user: string; model: string }> = [];
  return {
    calls,
    async call(system, user, model) {
      calls.push({ system, user, model });
      return script();
    },
  };
}

function req(input: string): UserRequest {
  return { id: 'r1', input, timestamp: new Date() };
}

const OSMANI = '/nonexistent';

describe('thinkers', () => {
  describe('spec-writer', () => {
    it('calls LLM with a system prompt that identifies the role', async () => {
      const llm = mkLLM(() => ({
        content: envelope({
          analysis: 'spec analysis',
          recommendations: [
            {
              category: 'architecture',
              priority: 'must',
              description: 'Define the interface',
              rationale: 'contracts first',
            },
          ],
        }),
        inputTokens: 100,
        outputTokens: 50,
      }));

      const out = await runSpecWriter(req('Build X'), llm, OSMANI, 'sonnet');

      expect(out.role).toBe('spec-writer');
      expect(llm.calls[0]?.system).toMatch(/role: spec-writer/);
      expect(llm.calls[0]?.model).toBe('sonnet');
    });

    it('parses LLM JSON envelope into ThinkerOutput', async () => {
      const llm = mkLLM(() => ({
        content: envelope({
          analysis: 'x',
          recommendations: [
            {
              category: 'implementation',
              priority: 'must',
              description: 'Do the thing',
              rationale: 'reason',
            },
          ],
          concerns: [
            {
              severity: 'note',
              description: 'watch out',
              suggestedResolution: 'be careful',
            },
          ],
        }),
        inputTokens: 10,
        outputTokens: 5,
      }));
      const out = await runSpecWriter(req('x'), llm, OSMANI, 'sonnet');
      expect(out.recommendations.length).toBe(1);
      expect(out.recommendations[0]?.source).toBe('spec-writer');
      expect(out.concerns.length).toBe(1);
      expect(out.concerns[0]?.source).toBe('spec-writer');
      expect(out.costUsed.inputTokens).toBe(10);
      expect(out.costUsed.outputTokens).toBe(5);
    });

    it('malformed JSON → empty recs + warning concern', async () => {
      const llm = mkLLM(() => ({
        content: 'definitely not JSON',
        inputTokens: 10,
        outputTokens: 5,
      }));
      const out = await runSpecWriter(req('x'), llm, OSMANI, 'sonnet');
      expect(out.recommendations).toEqual([]);
      expect(out.concerns.length).toBe(1);
      expect(out.concerns[0]?.severity).toBe('warning');
    });

    it('accepts JSON wrapped in a ```json fence', async () => {
      const llm = mkLLM(() => ({
        content:
          '```json\n' +
          envelope({
            recommendations: [
              {
                category: 'implementation',
                priority: 'should',
                description: 'Fenced',
                rationale: 'x',
              },
            ],
          }) +
          '\n```',
        inputTokens: 10,
        outputTokens: 5,
      }));
      const out = await runSpecWriter(req('x'), llm, OSMANI, 'sonnet');
      expect(out.recommendations.length).toBe(1);
      expect(out.recommendations[0]?.description).toBe('Fenced');
    });

    it('coerces invalid category/priority to safe defaults', async () => {
      const llm = mkLLM(() => ({
        content: envelope({
          recommendations: [
            {
              category: 'nonsense',
              priority: 'later',
              description: 'A thing',
              rationale: 'y',
            },
          ],
        }),
        inputTokens: 10,
        outputTokens: 5,
      }));
      const out = await runSpecWriter(req('x'), llm, OSMANI, 'sonnet');
      expect(out.recommendations[0]?.category).toBe('implementation');
      expect(out.recommendations[0]?.priority).toBe('should');
    });
  });

  describe('security', () => {
    it('role is security', async () => {
      const llm = mkLLM(() => ({
        content: envelope({
          recommendations: [
            {
              category: 'security',
              priority: 'must',
              description: 'Validate all inputs',
              rationale: 'injection',
            },
          ],
        }),
        inputTokens: 1,
        outputTokens: 1,
      }));
      const out = await runSecurity(req('add auth'), llm, OSMANI, 'sonnet');
      expect(out.role).toBe('security');
    });

    it('always outputs at least one recommendation even if LLM returns none', async () => {
      const llm = mkLLM(() => ({
        content: envelope({ recommendations: [] }),
        inputTokens: 1,
        outputTokens: 1,
      }));
      const out = await runSecurity(req('add auth'), llm, OSMANI, 'sonnet');
      expect(out.recommendations.length).toBeGreaterThanOrEqual(1);
      expect(out.recommendations[0]?.category).toBe('security');
    });
  });

  describe('test-strategist', () => {
    it('role is test-strategist', async () => {
      const llm = mkLLM(() => ({
        content: envelope({}),
        inputTokens: 1,
        outputTokens: 1,
      }));
      const out = await runTestStrategist(req('test x'), llm, OSMANI, 'sonnet');
      expect(out.role).toBe('test-strategist');
    });
  });

  describe('api-designer', () => {
    it('role is api-designer', async () => {
      const llm = mkLLM(() => ({
        content: envelope({}),
        inputTokens: 1,
        outputTokens: 1,
      }));
      const out = await runApiDesigner(req('design api'), llm, OSMANI, 'sonnet');
      expect(out.role).toBe('api-designer');
    });
  });

  describe('planner', () => {
    it('role is planner', async () => {
      const llm = mkLLM(() => ({
        content: envelope({}),
        inputTokens: 1,
        outputTokens: 1,
      }));
      const out = await runPlanner(req('plan x'), llm, OSMANI, 'sonnet');
      expect(out.role).toBe('planner');
    });
  });
});
