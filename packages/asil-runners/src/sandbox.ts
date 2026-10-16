/**
 * Run a target-repository command inside bubblewrap.
 *
 * The child can write only its working directory. It gets a private
 * home and tmp. Network is off except for package-manager installs.
 * Git and gh do not use this runner.
 */
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { CommandRunner } from 'asil-improvement-loop';
import { createCommandRunner, scrubbedEnv } from './wiring.js';

const SYSTEM_DIRS = ['/usr', '/lib', '/lib64', '/bin', '/sbin'] as const;

const NETWORK_FILES = [
  '/etc/ssl',
  '/etc/resolv.conf',
  '/etc/hosts',
  '/etc/nsswitch.conf',
  '/etc/ca-certificates',
] as const;

export interface SandboxDeps {
  exists?: (path: string) => boolean;
  resolveCommand?: (command: string, pathEnv: string) => string | null;
  pathEnv?: string;
}

export function commandAllowsNetwork(
  command: string,
  args: readonly string[],
): boolean {
  const base = basename(command);
  return (base === 'pnpm' || base === 'npm') && args.includes('install');
}

function inside(root: string, candidate: string): boolean {
  const absRoot = resolve(root);
  const abs = resolve(candidate);
  return abs === absRoot || abs.startsWith(absRoot + sep);
}

/** Directory that contains a toolchain `bin/` plus its libraries. */
export function toolchainRoot(realBinary: string): string {
  const dir = dirname(realBinary);
  return basename(dir) === 'bin' ? dirname(dir) : dir;
}

function readShebang(realBinary: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(realBinary, 'r');
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    if (!text.startsWith('#!')) return null;
    const line = text.split('\n', 1)[0]?.slice(2).trim() ?? '';
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts[0] === '/usr/bin/env' && parts[1]) return parts[1];
    return parts[0] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function resolveCommandOnPath(
  command: string,
  pathEnv: string,
): string | null {
  const candidates = command.includes('/')
    ? [command]
    : pathEnv.split(sep === '\\' ? ';' : ':').filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      return realpathSync(candidate);
    } catch {
      // try the next PATH entry
    }
  }
  return null;
}

function collectBinaries(
  command: string,
  pathEnv: string,
  resolveCommand: (command: string, pathEnv: string) => string | null,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    const real = resolveCommand(name, pathEnv);
    if (!real || seen.has(real)) return;
    seen.add(real);
    found.push(real);
    const shebang = readShebang(real);
    if (shebang) visit(shebang);
  };
  visit(command);
  return found;
}

export function buildBwrapArgs(
  command: string,
  args: readonly string[],
  cwd: string,
  deps: SandboxDeps = {},
): string[] {
  const exists = deps.exists ?? existsSync;
  const resolveCommand = deps.resolveCommand ?? resolveCommandOnPath;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? '';
  const workDir = resolve(cwd);
  if (workDir === resolve('/')) {
    throw new Error('Refusing to jail a command whose working directory is /.');
  }

  const network = commandAllowsNetwork(command, args);
  const roBinds: string[] = [];
  for (const dir of SYSTEM_DIRS) {
    if (exists(dir)) roBinds.push(dir);
  }

  const binaries = collectBinaries(command, pathEnv, resolveCommand);
  const extraPath: string[] = [];
  for (const real of binaries) {
    const root = toolchainRoot(real);
    if (roBinds.some((bound) => inside(bound, root))) {
      const binDir = dirname(real);
      if (!['/usr/bin', '/usr/local/bin', '/bin', '/sbin'].includes(binDir)) {
        extraPath.push(binDir);
      }
      continue;
    }
    if (!roBinds.includes(root)) roBinds.push(root);
    extraPath.push(dirname(real));
  }

  if (network) {
    for (const file of NETWORK_FILES) {
      if (exists(file) && !roBinds.some((bound) => inside(bound, file))) {
        roBinds.push(file);
      }
    }
  }

  const pathValue = [
    ...extraPath,
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');

  const bwrapArgs = [
    '--die-with-parent',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-uts',
    '--hostname',
    'asil',
    '--unshare-ipc',
    ...(network ? [] : ['--unshare-net']),
    '--clearenv',
    '--setenv',
    'PATH',
    pathValue,
    '--setenv',
    'HOME',
    '/tmp/home',
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--setenv',
    'LC_ALL',
    'C.UTF-8',
    '--setenv',
    'CI',
    '1',
    '--setenv',
    'npm_config_store_dir',
    join(workDir, '.pnpm-store'),
  ];

  for (const dir of roBinds) {
    bwrapArgs.push('--ro-bind', dir, dir);
  }
  bwrapArgs.push(
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/tmp/home',
    '--bind',
    workDir,
    workDir,
    '--chdir',
    workDir,
    '--',
    command,
    ...args,
  );
  return bwrapArgs;
}

let warnedSandboxOff = false;

/** Target-repo command runner. Jailed unless `ASIL_SANDBOX=off`. */
export function createSandboxedCommandRunner(
  env: NodeJS.ProcessEnv = process.env,
): CommandRunner {
  if (env.ASIL_SANDBOX === 'off') {
    if (!warnedSandboxOff) {
      warnedSandboxOff = true;
      console.error(
        'ASIL_SANDBOX=off: target-repository commands are not jailed.',
      );
    }
    return createCommandRunner({ env: scrubbedEnv(env) });
  }

  const inner = createCommandRunner({ env: scrubbedEnv(env) });
  return {
    async run(command, args, opts) {
      let bwrapArgs: string[];
      try {
        bwrapArgs = buildBwrapArgs(command, args, opts.cwd, {
          pathEnv: env.PATH,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { stdout: '', stderr: message, exitCode: 1 };
      }
      const result = await inner.run('bwrap', bwrapArgs, { cwd: opts.cwd });
      if (result.exitCode === 127) {
        return {
          stdout: result.stdout,
          stderr:
            'bubblewrap (bwrap) is required to run target-repository commands. ' +
            'Install bubblewrap, or set ASIL_SANDBOX=off to run them without a jail. ' +
            result.stderr,
          exitCode: 127,
        };
      }
      return result;
    },
  };
}

/** True when a trivial jailed command can start. */
export function bubblewrapAvailable(): boolean {
  try {
    const cwd = existsSync('/tmp') ? '/tmp' : '.';
    execFileSync('bwrap', buildBwrapArgs('/usr/bin/true', [], cwd), {
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
