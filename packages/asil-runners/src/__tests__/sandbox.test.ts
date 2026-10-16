import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bubblewrapAvailable,
  buildBwrapArgs,
  commandAllowsNetwork,
  createSandboxedCommandRunner,
  toolchainRoot,
} from '../sandbox.js';

const noFs = {
  exists: () => false,
  resolveCommand: () => null,
  pathEnv: '',
};

describe('commandAllowsNetwork', () => {
  it('allows network only for pnpm and npm install', () => {
    expect(commandAllowsNetwork('pnpm', ['install', '--frozen-lockfile'])).toBe(true);
    expect(commandAllowsNetwork('npm', ['install'])).toBe(true);
    expect(commandAllowsNetwork('pnpm', ['test'])).toBe(false);
    expect(commandAllowsNetwork('pnpm', ['run', '-r', 'build'])).toBe(false);
    expect(commandAllowsNetwork('grep', ['-n', 'TODO'])).toBe(false);
  });
});

describe('buildBwrapArgs', () => {
  it('drops the network and binds only the working directory for a test command', () => {
    const args = buildBwrapArgs('pnpm', ['test'], '/work/repo', noFs);
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--clearenv');
    const bindAt = args.indexOf('--bind');
    expect(args.slice(bindAt, bindAt + 3)).toEqual(['--bind', '/work/repo', '/work/repo']);
    expect(args).toContain('--setenv');
    expect(args).toContain('HOME');
    expect(args).toContain('/tmp/home');
    if (process.env.HOME && process.env.HOME !== '/tmp/home') {
      expect(args).not.toContain(process.env.HOME);
    }
  });

  it('keeps the network for pnpm install', () => {
    const args = buildBwrapArgs('pnpm', ['install', '--ignore-scripts'], '/work/repo', noFs);
    expect(args).not.toContain('--unshare-net');
  });

  it('read-only binds a toolchain that lives outside the system directories', () => {
    const args = buildBwrapArgs('pnpm', ['test'], '/work/repo', {
      exists: (path) => path === '/usr',
      resolveCommand: (command) =>
        command === 'pnpm' ? '/opt/node/bin/pnpm' : null,
      pathEnv: '/opt/node/bin',
    });
    expect(args).toContain('/usr');
    expect(args).toContain('/opt/node');
    expect(args.filter((part) => part === '--ro-bind').length).toBe(2);
  });

  it('refuses to bind the filesystem root', () => {
    expect(() => buildBwrapArgs('true', [], '/', noFs)).toThrow(/working directory is \//);
  });
});

describe('toolchainRoot', () => {
  it('uses the parent of a bin directory', () => {
    expect(toolchainRoot('/opt/node/bin/node')).toBe('/opt/node');
    expect(toolchainRoot('/usr/bin/grep')).toBe('/usr');
  });
});

describe('createSandboxedCommandRunner', () => {
  const prev = process.env.ASIL_SANDBOX;
  afterEach(() => {
    if (prev === undefined) delete process.env.ASIL_SANDBOX;
    else process.env.ASIL_SANDBOX = prev;
  });

  it('reports a missing bubblewrap binary instead of running the command unsandboxed', async () => {
    const runner = createSandboxedCommandRunner({
      ...process.env,
      ASIL_SANDBOX: 'on',
      PATH: '',
    });
    const result = await runner.run('true', [], { cwd: tmpdir() });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/bwrap|bubblewrap|ENOENT/i);
  });
});

describe('bubblewrap jail', () => {
  const available = bubblewrapAvailable();
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!available)(
    'cannot read a sibling directory or open an outbound socket',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'asil-jail-'));
      const work = join(dir, 'work');
      const outside = join(dir, 'secret.txt');
      mkdirSync(work);
      writeFileSync(outside, 'secret');
      writeFileSync(
        join(work, 'probe.js'),
        `
          const fs = require('fs');
          const net = require('net');
          let readOk = false;
          try { fs.readFileSync(process.argv[2]); readOk = true; } catch {}
          const sock = net.connect({ host: '1.1.1.1', port: 443 });
          const finish = (netOpen) => {
            console.log(readOk ? 'READ_OK' : 'READ_BLOCKED');
            console.log(netOpen ? 'NET_OPEN' : 'NET_BLOCKED');
            process.exit(readOk || netOpen ? 2 : 0);
          };
          sock.setTimeout(1500);
          sock.on('connect', () => finish(true));
          sock.on('timeout', () => finish(true));
          sock.on('error', () => finish(false));
        `,
      );
      const runner = createSandboxedCommandRunner();
      const result = await runner.run(
        'node',
        [join(work, 'probe.js'), outside],
        { cwd: work },
      );
      expect(result.stdout).toContain('READ_BLOCKED');
      expect(result.stdout).toContain('NET_BLOCKED');
      expect(result.exitCode).toBe(0);
    },
  );
});
