import { describe, expect, it } from 'vitest';
import { resolveConfiguredPath } from '../paths.js';

describe('resolveConfiguredPath', () => {
  const root = '/repo';

  it('resolves a relative path under the repository', () => {
    expect(resolveConfiguredPath(root, '.asil/skills')).toBe('/repo/.asil/skills');
  });

  it('rejects a relative path that leaves the repository', () => {
    expect(() => resolveConfiguredPath(root, '../other')).toThrow(/outside the repository/);
  });

  it('keeps an absolute path the operator named explicitly', () => {
    expect(resolveConfiguredPath(root, '/var/asil-data')).toBe('/var/asil-data');
  });

  it('rejects an absolute path whose .. segment leaves the repository', () => {
    expect(() => resolveConfiguredPath(root, '/repo/../other')).toThrow(
      /outside the repository/,
    );
  });
});
