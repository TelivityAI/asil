import { describe, expect, it } from 'vitest';
import { parseFlags } from '../run-a.js';

describe('parseFlags', () => {
  it('does not publish unless --apply is set', () => {
    const flags = parseFlags(['--max-tasks', '1']);
    expect(flags?.apply).toBe(false);
    expect(flags?.dryRun).toBe(false);
  });

  it('sets apply when --apply is passed', () => {
    const flags = parseFlags(['--apply', '--max-tasks', '2']);
    expect(flags?.apply).toBe(true);
    expect(flags?.maxTasks).toBe(2);
  });

  it('keeps --dry-run from executing even if --apply is also passed', () => {
    const flags = parseFlags(['--dry-run', '--apply']);
    expect(flags?.dryRun).toBe(true);
    expect(flags?.apply).toBe(true);
  });
});
