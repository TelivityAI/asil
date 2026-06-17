import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../redact.js';

describe('redactSecrets (Codex #9)', () => {
  it('masks an Anthropic key', () => {
    const { text, redactions } = redactSecrets(
      'key is sk-ant-api03-AbCdEf0123456789_xyz-more and done',
    );
    expect(text).not.toContain('sk-ant-api03');
    expect(text).toContain('«REDACTED»');
    expect(redactions).toBeGreaterThan(0);
  });

  it('masks an OpenAI key (incl. sk-proj-)', () => {
    expect(redactSecrets('sk-proj-abcdefghijklmnopqrstuvwxyz0123').text).toContain(
      '«REDACTED»',
    );
    expect(redactSecrets('sk-abcdefghijklmnopqrstuvwxyz0123').text).not.toContain(
      'sk-abcdefghij',
    );
  });

  it('masks GitHub tokens', () => {
    const t = redactSecrets('ghp_' + 'A'.repeat(36)).text;
    expect(t).toContain('«REDACTED»');
    expect(t).not.toContain('ghp_AAAA');
  });

  it('masks AWS access key ids', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE').text).toContain('«REDACTED»');
  });

  it('masks a Bearer header value', () => {
    const t = redactSecrets('Authorization: Bearer abcdef0123456789ghijklmnop').text;
    expect(t).toContain('«REDACTED»');
    expect(t).not.toContain('abcdef0123456789ghij');
  });

  it('masks the VALUE of a secret-named assignment but keeps the name', () => {
    const { text } = redactSecrets('ANTHROPIC_API_KEY=sk-ant-supersecretvalue123');
    expect(text).toContain('ANTHROPIC_API_KEY=');
    expect(text).not.toContain('supersecretvalue123');
    expect(text).toContain('«REDACTED»');
  });

  it('leaves non-secret text untouched', () => {
    const input = 'The function refactors the parser. No secrets here.';
    expect(redactSecrets(input).text).toBe(input);
    expect(redactSecrets(input).redactions).toBe(0);
  });

  it('handles multiple secrets in one blob', () => {
    const blob = [
      'sk-ant-api03-' + 'x'.repeat(20),
      'ghp_' + 'y'.repeat(36),
      'just some code',
    ].join('\n');
    const { text, redactions } = redactSecrets(blob);
    expect(redactions).toBeGreaterThanOrEqual(2);
    expect(text).toContain('just some code');
  });
});
