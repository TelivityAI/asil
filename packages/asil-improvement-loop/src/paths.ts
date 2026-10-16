/**
 * Resolve operator-configured paths without letting a relative value
 * escape the repository root. An absolute path is kept when the operator
 * named that location explicitly. A `..` segment that still lands outside
 * the repository is rejected.
 */
import { isAbsolute, relative, resolve } from 'node:path';

export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function climbsOut(configured: string): boolean {
  return configured.split(/[/\\]/).includes('..');
}

export function resolveConfiguredPath(repoRoot: string, configured: string): string {
  const abs = isAbsolute(configured)
    ? resolve(configured)
    : resolve(repoRoot, configured);
  if (isInsideRoot(repoRoot, abs)) return abs;
  if (isAbsolute(configured) && !climbsOut(configured)) return abs;
  throw new Error(
    `Refusing path "${configured}": it resolves outside the repository root.`,
  );
}
