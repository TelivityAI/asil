import { describe, expect, it } from 'vitest';
import { routeRequest } from '../router.js';
import type { UserRequest } from '../types.js';

function req(input: string, id = 'r1'): UserRequest {
  return { id, input, timestamp: new Date() };
}

describe('routeRequest', () => {
  it('activates spec-writer + test-strategist for "build a new expense adapter"', () => {
    const decision = routeRequest(req('Build a new expense adapter package'));
    expect(decision.activatedThinkers).toContain('spec-writer');
    expect(decision.activatedThinkers).toContain('test-strategist');
  });

  it('activates planner when the input names explicit planning/phasing work', () => {
    const decision = routeRequest(
      req('Build this in three phases with clear milestone dependencies'),
    );
    expect(decision.activatedThinkers).toContain('planner');
  });

  it('activates api-designer + security for "add API key auth to connect routes"', () => {
    const decision = routeRequest(req('Add API key auth to the connect routes'));
    expect(decision.activatedThinkers).toContain('api-designer');
    expect(decision.activatedThinkers).toContain('security');
  });

  it('activates test-strategist for "fix the test for pricing module"', () => {
    const decision = routeRequest(req('Fix the test for pricing module'));
    expect(decision.activatedThinkers).toContain('test-strategist');
  });

  it('forces security when a SECURITY_ALWAYS_DOMAINS term is present', () => {
    const decision = routeRequest(req('Encrypt bot tokens in Slack connections'));
    expect(decision.activatedThinkers).toContain('security');
  });

  it('activates planner + spec-writer for "refactor the orchestrator"', () => {
    const decision = routeRequest(
      req('Refactor the orchestrator into smaller modules'),
    );
    expect(decision.activatedThinkers).toContain('planner');
    expect(decision.activatedThinkers).toContain('spec-writer');
  });

  it('defaults to spec-writer + planner when input has no signal keywords', () => {
    const decision = routeRequest(req('zzzz'));
    expect(decision.activatedThinkers).toEqual(
      expect.arrayContaining(['spec-writer', 'planner']),
    );
  });

  it('respects maxThinkers and returns only the top-N', () => {
    const decision = routeRequest(
      req(
        'Build a new API endpoint with tests, security auth, and a migration plan',
      ),
      2,
    );
    expect(decision.activatedThinkers.length).toBeLessThanOrEqual(2);
  });

  it('alwaysActivateWith: spec-writer pulls in test-strategist', () => {
    const decision = routeRequest(req('Build a new module'));
    expect(decision.activatedThinkers).toContain('spec-writer');
    expect(decision.activatedThinkers).toContain('test-strategist');
  });

  it('always sets estimatedModel=sonnet and papaModel=opus', () => {
    const decision = routeRequest(req('Build something'));
    expect(decision.estimatedModel).toBe('sonnet');
    expect(decision.papaModel).toBe('opus');
  });

  it('reasoning string names activated and skipped thinkers', () => {
    const decision = routeRequest(req('Add API auth endpoint'));
    expect(decision.reasoning).toMatch(/Activated:/);
    expect(decision.reasoning).toMatch(/Skipped:/);
  });
});
