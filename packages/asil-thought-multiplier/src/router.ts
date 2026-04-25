import type { ThinkerRole, UserRequest, RoutingDecision } from './types.js';

interface ThinkerSignals {
  keywords: string[];
  patterns: RegExp[];
  alwaysActivateWith?: ThinkerRole[];
}

const THINKER_SIGNALS: Record<ThinkerRole, ThinkerSignals> = {
  'spec-writer': {
    keywords: [
      'build', 'create', 'add', 'implement', 'feature', 'agent',
      'new', 'component', 'module', 'package', 'screen',
    ],
    patterns: [/\bbuild\s+\w+/i, /\badd\s+\w+/i, /\bcreate\s+\w+/i, /\bnew\s+\w+/i],
    alwaysActivateWith: ['test-strategist'],
  },
  security: {
    keywords: [
      'auth', 'encrypt', 'token', 'secret', 'credential', 'permission',
      'api key', 'oauth', 'session', 'cors', 'csrf', 'injection',
      'sanitize', 'validate', 'password', 'role', 'rls',
    ],
    patterns: [/api\s*key/i, /user\s*data/i, /personal\s*info/i, /\bpii\b/i],
  },
  'test-strategist': {
    keywords: ['test', 'coverage', 'mock', 'fixture', 'assert', 'vitest', 'spec', 'validate', 'verify'],
    patterns: [/\btest\s+\w+/i, /\badd\s+tests?\b/i, /\bfix\s+test/i],
  },
  'api-designer': {
    keywords: [
      'api', 'endpoint', 'route', 'rest', 'graphql', 'schema',
      'contract', 'interface', 'openapi', 'mcp', 'webhook',
      'request', 'response',
    ],
    patterns: [/\bapi\s+\w+/i, /\bendpoint\b/i, /\broute\b/i, /\/api\//i],
  },
  planner: {
    keywords: [
      'plan', 'phase', 'order', 'sequence', 'dependency',
      'milestone', 'roadmap', 'refactor', 'migrate', 'restructure', 'reorganize',
    ],
    patterns: [/\bphase\s*\d/i, /\bstep\s*\d/i, /\bbreak\s*(down|up)\b/i],
  },
};

/** Security is ALWAYS activated if the request touches these domains. */
const SECURITY_ALWAYS_DOMAINS = [
  'auth', 'payment', 'stripe', 'card', 'billing', 'user',
  'admin', 'credential', 'key', 'token', 'encrypt',
];

export function routeRequest(
  request: UserRequest,
  maxThinkers = 4,
): RoutingDecision {
  const input = request.input.toLowerCase();
  const scores: Record<ThinkerRole, number> = {
    'spec-writer': 0,
    security: 0,
    'test-strategist': 0,
    'api-designer': 0,
    planner: 0,
  };

  for (const [role, signals] of Object.entries(THINKER_SIGNALS) as [
    ThinkerRole,
    ThinkerSignals,
  ][]) {
    for (const kw of signals.keywords) {
      if (input.includes(kw)) scores[role] += 1;
    }
    for (const pat of signals.patterns) {
      if (pat.test(input)) scores[role] += 2;
    }
  }

  // Force security if any always-domain is present.
  if (SECURITY_ALWAYS_DOMAINS.some((d) => input.includes(d))) {
    scores.security = Math.max(scores.security, 5);
  }

  let activated = (Object.entries(scores) as [ThinkerRole, number][])
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxThinkers)
    .map(([role]) => role);

  // alwaysActivateWith dependencies.
  const toAdd: ThinkerRole[] = [];
  for (const role of activated) {
    const deps = THINKER_SIGNALS[role].alwaysActivateWith ?? [];
    for (const dep of deps) {
      if (!activated.includes(dep) && !toAdd.includes(dep)) toAdd.push(dep);
    }
  }
  activated = [...activated, ...toAdd].slice(0, maxThinkers);

  if (activated.length === 0) {
    activated = ['spec-writer', 'planner'].slice(0, maxThinkers) as ThinkerRole[];
  }

  return {
    requestId: request.id,
    activatedThinkers: activated,
    reasoning: buildReasoning(activated, scores),
    estimatedModel: 'sonnet',
    papaModel: 'opus',
  };
}

function buildReasoning(
  activated: ThinkerRole[],
  scores: Record<ThinkerRole, number>,
): string {
  const active = activated.map((r) => `${r} (score: ${scores[r]})`).join(', ');
  const skipped = (Object.keys(scores) as ThinkerRole[])
    .filter((r) => !activated.includes(r))
    .map((r) => `${r} (score: ${scores[r]})`)
    .join(', ');
  return `Activated: ${active}. Skipped: ${skipped || 'none'}.`;
}
