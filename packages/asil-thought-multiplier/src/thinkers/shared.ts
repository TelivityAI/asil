/**
 * Shared helpers for thinker agents.
 *
 * Each thinker loads its Osmani skill markdown (if available), injects
 * project rules, and asks the LLM to respond in a structured JSON
 * envelope we can parse back into ThinkerOutput.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Concern,
  LLMCaller,
  LLMResponse,
  Recommendation,
  RecommendationCategory,
  ThinkerOutput,
  ThinkerRole,
  UserRequest,
  Priority,
  Severity,
} from '../types.js';

/** Default engineering rules injected into every thinker's system prompt. */
const PROJECT_RULES = `
PROJECT RULES (always apply):
- TypeScript strict. No 'any', no undocumented 'as' casts.
- decimal.js for all money math. No 'number' type for currency.
- No secrets in code, no PII in logs.
- If domain logic is unknown, emit a DOMAIN_QUESTION concern — do not guess.
`.trim();

/** The structured JSON envelope we ask thinkers to return. */
const OUTPUT_ENVELOPE_SPEC = `
Respond with a single JSON object of shape:
{
  "analysis": "<1-3 paragraph narrative analysis>",
  "recommendations": [
    {
      "category": "architecture|implementation|testing|security|performance|api-design|planning",
      "priority": "must|should|could",
      "description": "<1 sentence>",
      "rationale": "<1 sentence>"
    }
  ],
  "concerns": [
    {
      "severity": "blocker|warning|note",
      "description": "<1 sentence>",
      "suggestedResolution": "<1 sentence>"
    }
  ]
}
Do not include any prose outside the JSON object.
`.trim();

const VALID_CATEGORIES: readonly RecommendationCategory[] = [
  'architecture',
  'implementation',
  'testing',
  'security',
  'performance',
  'api-design',
  'planning',
];

const VALID_PRIORITIES: readonly Priority[] = ['must', 'should', 'could'];
const VALID_SEVERITIES: readonly Severity[] = ['blocker', 'warning', 'note'];

export interface ThinkerPromptParts {
  /** Content-type heading used in the system prompt ("Spec Writer", etc.) */
  label: string;
  /** Filename of the Osmani skill (relative to osmaniSkillsPath/skills). */
  osmaniSkillFile?: string;
  /** Fallback instructions if the Osmani skill file can't be read. */
  fallbackInstructions: string;
}

export function loadOsmaniSkill(
  osmaniSkillsPath: string,
  skillFile: string | undefined,
  fallback: string,
): string {
  if (!skillFile) return fallback;
  try {
    return readFileSync(join(osmaniSkillsPath, 'skills', skillFile), 'utf8');
  } catch {
    return fallback;
  }
}

export function buildSystemPrompt(
  role: ThinkerRole,
  parts: ThinkerPromptParts,
  osmaniSkillsPath: string,
): string {
  const skill = loadOsmaniSkill(
    osmaniSkillsPath,
    parts.osmaniSkillFile,
    parts.fallbackInstructions,
  );

  return `You are the ${parts.label} thinker (role: ${role}) for the autonomous build system.

${skill}

${PROJECT_RULES}

${OUTPUT_ENVELOPE_SPEC}`;
}

export function buildUserPrompt(request: UserRequest): string {
  const ctx = request.context
    ? `\n\nAdditional context:\n${request.context}`
    : '';
  return `Build request:\n${request.input}${ctx}`;
}

export async function runThinker(
  role: ThinkerRole,
  parts: ThinkerPromptParts,
  request: UserRequest,
  llm: LLMCaller,
  osmaniSkillsPath: string,
  model: string,
): Promise<ThinkerOutput> {
  const systemPrompt = buildSystemPrompt(role, parts, osmaniSkillsPath);
  const userPrompt = buildUserPrompt(request);

  const response = await llm.call(systemPrompt, userPrompt, model);
  return parseThinkerOutput(role, request.id, response);
}

export function parseThinkerOutput(
  role: ThinkerRole,
  requestId: string,
  response: LLMResponse,
): ThinkerOutput {
  const base: ThinkerOutput = {
    role,
    requestId,
    analysis: '',
    recommendations: [],
    concerns: [],
    costUsed: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };

  const parsed = tryParseJson(response.content);
  if (!parsed) {
    return {
      ...base,
      analysis: response.content,
      concerns: [
        {
          severity: 'warning',
          source: role,
          description: `${role} returned malformed JSON — output parsed as raw text.`,
          suggestedResolution: 'Retry the thinker, or inspect the raw LLM response.',
        },
      ],
    };
  }

  const analysis = typeof parsed.analysis === 'string' ? parsed.analysis : '';
  const recommendations = Array.isArray(parsed.recommendations)
    ? parsed.recommendations
        .map((r) => sanitizeRecommendation(role, r))
        .filter((r): r is Recommendation => r !== null)
    : [];
  const concerns = Array.isArray(parsed.concerns)
    ? parsed.concerns
        .map((c) => sanitizeConcern(role, c))
        .filter((c): c is Concern => c !== null)
    : [];

  return {
    ...base,
    analysis,
    recommendations,
    concerns,
  };
}

function tryParseJson(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  // Accept raw JSON or a fenced ```json block.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    const obj = JSON.parse(candidate) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizeRecommendation(
  role: ThinkerRole,
  raw: unknown,
): Recommendation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const category = typeof r.category === 'string' ? r.category : '';
  const priority = typeof r.priority === 'string' ? r.priority : '';
  const description = typeof r.description === 'string' ? r.description : '';
  const rationale = typeof r.rationale === 'string' ? r.rationale : '';
  if (!description) return null;

  return {
    category: (VALID_CATEGORIES as readonly string[]).includes(category)
      ? (category as RecommendationCategory)
      : 'implementation',
    priority: (VALID_PRIORITIES as readonly string[]).includes(priority)
      ? (priority as Priority)
      : 'should',
    description,
    rationale,
    source: role,
  };
}

function sanitizeConcern(role: ThinkerRole, raw: unknown): Concern | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const severity = typeof c.severity === 'string' ? c.severity : '';
  const description = typeof c.description === 'string' ? c.description : '';
  const suggestedResolution =
    typeof c.suggestedResolution === 'string' ? c.suggestedResolution : '';
  if (!description) return null;

  return {
    severity: (VALID_SEVERITIES as readonly string[]).includes(severity)
      ? (severity as Severity)
      : 'note',
    source: role,
    description,
    suggestedResolution,
  };
}
