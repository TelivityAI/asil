/**
 * Secret redaction for captured transcripts (Codex review #9).
 *
 * Transcripts capture full prompts + responses, which can include
 * source pulled from the target repo, stack traces, and — the real
 * risk — secrets that happen to appear in that material. Redaction
 * masks well-known secret token shapes before anything is written to
 * disk. It is deliberately conservative (mask known shapes, don't try
 * to be a general-purpose DLP) and runs by default; callers can opt out
 * with `{ redact: false }` on the instrumented callers.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
}

/** Known secret token shapes. Ordered roughly by specificity. */
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  // Anthropic keys: sk-ant-… (long).
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI keys: sk-…, sk-proj-…, sk-svcacct-… .
  { name: 'openai-key', pattern: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ + 36+ chars.
  { name: 'github-token', pattern: /gh[posur]_[A-Za-z0-9]{36,}/g },
  // GitHub fine-grained PAT.
  { name: 'github-pat', pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  // AWS access key id.
  { name: 'aws-akid', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Google API key.
  { name: 'google-key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  // Slack token.
  { name: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  // Bearer header values.
  { name: 'bearer', pattern: /[Bb]earer\s+[A-Za-z0-9._-]{20,}/g },
  // Generic `<SECRETY_NAME>=<value>` / `: <value>` assignments for
  // env vars whose NAME looks secret-y. Masks only the value.
  {
    name: 'assigned-secret',
    pattern:
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?)\b(\s*[:=]\s*)(['"]?)([^\s'"]{6,})\3/gi,
  },
];

const MASK = '«REDACTED»';

/**
 * Redact secret-shaped substrings from `text`. Returns the masked text
 * and a count of redactions made (useful for a "N secrets masked"
 * note). Idempotent-ish: re-running over masked text is a no-op for the
 * token rules.
 */
export function redactSecrets(
  text: string,
  rules: RedactionRule[] = DEFAULT_REDACTION_RULES,
): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const rule of rules) {
    if (rule.name === 'assigned-secret') {
      out = out.replace(rule.pattern, (_m, name, sep, quote, _val) => {
        redactions += 1;
        return `${name}${sep}${quote}${MASK}${quote}`;
      });
    } else {
      out = out.replace(rule.pattern, () => {
        redactions += 1;
        return MASK;
      });
    }
  }
  return { text: out, redactions };
}
