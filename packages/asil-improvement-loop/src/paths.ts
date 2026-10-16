/**
 * Resolve operator-configured paths without letting a relative value
 * escape the repository root. Absolute paths are kept: the operator
 * named that location explicitly.
 */
import { isAbsolute, relative, resolve } from 'node:path';

export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function resolveConfiguredPath(repoRoot: string, configured: string): string {
  if (isAbsolute(configured)) return resolve(configured);
  const abs = resolve(repoRoot, configured);
  if (!isInsideRoot(repoRoot, abs)) {
    throw new Error(
      `Refusing path "${configured}": it resolves outside the repository root.`,
    );
  }
  return abs;
}
