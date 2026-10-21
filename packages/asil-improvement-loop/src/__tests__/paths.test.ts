import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  defaultGrindStateRoot,
  repoPathSlug,
  resolveConfiguredPath,
  resolveGrindStatePath,
  resolveGrindStateRoot,
} from '../paths.js';

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

describe('grind state paths', () => {
  const root = '/repo/project';

  it('hashes the absolute repository path into a stable slug', () => {
    const expected = createHash('sha256')
      .update(resolve(root))
      .digest('hex')
      .slice(0, 12);
    expect(repoPathSlug(root)).toBe(expected);
  });

  it('defaults the state root under tmpdir()/asil-state-<hash>', () => {
    expect(defaultGrindStateRoot(root)).toBe(
      resolve(tmpdir(), `asil-state-${repoPathSlug(root)}`),
    );
    expect(resolveGrindStateRoot(root, {})).toBe(defaultGrindStateRoot(root));
  });

  it('honours ASIL_STATE_DIR when set', () => {
    expect(
      resolveGrindStateRoot(root, { ASIL_STATE_DIR: '/var/asil-state' }),
    ).toBe('/var/asil-state');
    expect(
      resolveGrindStateRoot(root, { ASIL_STATE_DIR: '.asil-state' }),
    ).toBe('/repo/project/.asil-state');
  });

  it('places unset state files under the grind state root', () => {
    const env = {};
    const expected = resolve(
      defaultGrindStateRoot(root),
      '.asil/usage-data/queue.json',
    );
    expect(
      resolveGrindStatePath(root, undefined, '.asil/usage-data/queue.json', env),
    ).toBe(expected);
  });

  it('resolves relative overrides against REPO_ROOT when ASIL_STATE_DIR is unset', () => {
    expect(
      resolveGrindStatePath(root, 'custom/queue.json', '.asil/usage-data/queue.json', {}),
    ).toBe('/repo/project/custom/queue.json');
  });

  it('resolves relative overrides against ASIL_STATE_DIR when that env is set', () => {
    const env = { ASIL_STATE_DIR: '/var/asil-state' };
    expect(
      resolveGrindStatePath(root, 'custom/queue.json', '.asil/usage-data/queue.json', env),
    ).toBe('/var/asil-state/custom/queue.json');
  });

  it('keeps absolute overrides under the absolute-path rules', () => {
    expect(
      resolveGrindStatePath(
        root,
        '/tmp/explicit-queue.json',
        '.asil/usage-data/queue.json',
        {},
      ),
    ).toBe('/tmp/explicit-queue.json');
  });
});
