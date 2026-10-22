/**
 * Resolve operator-configured paths without letting a relative value
 * escape the repository root. An absolute path is kept when the operator
 * named that location explicitly. A `..` segment that still lands outside
 * the repository is rejected.
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
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

/** Short stable id so state directories for different repositories cannot collide. */
export function repoPathSlug(repoRoot: string): string {
  return createHash('sha256').update(resolve(repoRoot)).digest('hex').slice(0, 12);
}

/** Default grind state root under the system temp directory. */
export function defaultGrindStateRoot(repoRoot: string): string {
  return resolve(tmpdir(), `asil-state-${repoPathSlug(repoRoot)}`);
}

/**
 * Directory for queue, usage, and domain-answer files.
 * `ASIL_STATE_DIR` when set; otherwise `tmpdir()/asil-state-<hash>`.
 */
export function resolveGrindStateRoot(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.ASIL_STATE_DIR;
  if (configured === undefined || configured === '') {
    return defaultGrindStateRoot(repoRoot);
  }
  return resolveConfiguredPath(repoRoot, configured);
}

/**
 * Resolve a grind state file or directory.
 *
 * - Unset → under the grind state root (temp by default).
 * - Absolute → kept under today's absolute-path rules.
 * - Relative → against `ASIL_STATE_DIR` when that env is set, otherwise
 *   against `REPO_ROOT` (preserves prior explicit relative overrides).
 */
export function resolveGrindStatePath(
  repoRoot: string,
  configured: string | undefined,
  defaultRelative: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateRoot = resolveGrindStateRoot(repoRoot, env);
  if (configured === undefined || configured === '') {
    return resolveConfiguredPath(stateRoot, defaultRelative);
  }
  if (isAbsolute(configured)) {
    return resolveConfiguredPath(repoRoot, configured);
  }
  const stateDirSet =
    env.ASIL_STATE_DIR !== undefined && env.ASIL_STATE_DIR !== '';
  const base = stateDirSet ? stateRoot : repoRoot;
  return resolveConfiguredPath(base, configured);
}
