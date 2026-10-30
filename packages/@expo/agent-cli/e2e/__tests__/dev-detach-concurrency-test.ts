import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { stopOwnedDevServerAsync } from '../../src/smoke/cleanupDevServer';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import {
  collectOutput,
  executeAgentCliAsync,
  expoHomeOf,
  fixturesDir,
  holdDevLockAsync,
  killAsync,
  installStubBinAsync,
  pathEnvVars,
  readDevLockAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  spawnAgentCli,
  waitForAsync,
  waitForDevLockAsync,
  waitForExitAsync,
} from '../utils';
import {
  bindingFixture,
  installStubXcrunAsync,
  installStubAdbAsync,
  installStubEmulatorAsync,
  killBoundEmulatorsAsync,
} from './installedAppStubs';

async function fixture() {
  const root = await setupFixtureAsync('go-app');
  const barrier = path.join(root, '.barrier');
  fs.mkdirSync(barrier);
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const env = {
    NODE_OPTIONS: `--require "${path.join(fixturesDir, 'detach-barrier.cjs').replaceAll('\\', '/')}"`,
    DETACH_TEST_BARRIER: barrier,
    STUB_EXPO_LISTEN: '1',
    STUB_EXPO_DELAY_MS: '60000',
    STUB_EXPO_DEV_SERVER_PORT: String(port),
  };
  const parents: ReturnType<typeof spawnAgentCli>[] = [];
  const marks = (name: string) =>
    fs.readdirSync(barrier).filter((file) => file.startsWith(`${name}-`));
  function start(extraEnv: Record<string, string> = {}, extraArgs: string[] = [], cwd = root) {
    const child = spawnAgentCli(
      cwd,
      [
        'dev',
        '--ios',
        '--go',
        '--local',
        '--no-open',
        '--detach',
        '--wait-ready',
        '--json',
        ...extraArgs,
      ],
      { env: { ...env, ...extraEnv } }
    );
    parents.push(child);
    return { child, result: waitForExitAsync(child, collectOutput(child)) };
  }
  const release = () => fs.writeFileSync(path.join(barrier, 'release'), '');
  async function cleanup() {
    release();
    await executeAgentCliAsync(root, ['dev:stop', '--json'], { reject: false });
    await Promise.all(parents.map((child) => killAsync(child, 'SIGKILL')));
    for (const file of marks('child')) {
      const pid = Number(file.slice('child-'.length));
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
      } catch {}
    }
  }
  return { root, env, port, start, marks, release, cleanup, barrier };
}

it.each([
  { name: 'same options', argv: [], alias: false },
  { name: 'different port', argv: ['--port', '8396'], alias: false },
  { name: 'worktree alias', argv: [], alias: true },
])(
  'a concurrent detached start refuses without replacing the owner: $name',
  async ({ argv, alias }) => {
    const f = await fixture();
    try {
      const first = f.start();
      expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
      const ownerPid = Number(f.marks('blocked')[0]!.slice('blocked-'.length));
      const cwd = alias ? path.join(f.root, '.alias') : f.root;
      if (alias) fs.symlinkSync(f.root, cwd, 'junction');
      const second = await f.start({}, argv, cwd).result;
      expect(second.exitCode, second.all).toBe(20);
      const refusal = JSON.parse(second.stdout).error;
      expect(refusal).toMatchObject({ code: 'DEV_START_BUSY', data: { pid: ownerPid } });
      expect(fs.existsSync(refusal.data.logFile)).toBe(true);
      expect(f.marks('blocked')).toHaveLength(1);
      expect(readStubExpoInvocations(f.root)).toHaveLength(0);
      f.release();
      const started = await first.result;
      expect(started.exitCode, started.all).toBe(0);
      const a = JSON.parse(started.stdout);
      expect(a).toMatchObject({ pid: ownerPid, logFile: refusal.data.logFile });
      expect(
        readStubExpoInvocations(f.root).filter((call) => call.args[0] === 'start')
      ).toHaveLength(1);
      const logs = await executeAgentCliAsync(f.root, ['dev:logs', '--json']);
      expect(JSON.parse(logs.stdout)).toMatchObject({ logFile: a.logFile });
      expect(JSON.parse(logs.stdout).lines.join('\n')).toContain(`pid ${a.pid}`);
      const status = await executeAgentCliAsync(f.root, ['status', '--json']);
      expect(JSON.parse(status.stdout).devServer).toMatchObject({ running: true, url: a.url });
      const stopped = await executeAgentCliAsync(f.root, ['dev:stop', '--json']);
      expect(JSON.parse(stopped.stdout)).toMatchObject({ stopped: true, pid: a.pid });
    } finally {
      await f.cleanup();
    }
  }
);

it('the starter times out without stopping its child, and another start refuses', async () => {
  const f = await fixture();
  try {
    const expire = path.join(f.barrier, 'expire');
    const first = f.start({ DETACH_TEST_EXPIRE: expire });
    expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
    fs.writeFileSync(expire, '');
    const timedOut = await first.result;
    expect(timedOut.exitCode, timedOut.all).toBe(22);
    const owner = JSON.parse(timedOut.stdout).error.data;
    expect(JSON.parse(timedOut.stdout).error.code).toBe('DEV_START_IN_PROGRESS');
    const retry = await f.start().result;
    expect(retry.exitCode, retry.all).toBe(20);
    expect(JSON.parse(retry.stdout).error).toMatchObject({ code: 'DEV_START_BUSY', data: owner });
    f.release();
    expect(await waitForDevLockAsync(f.root, 15_000)).toMatchObject({ pid: owner.pid });
    expect(
      await waitForAsync(
        () => readStubExpoInvocations(f.root).some((call) => call.args[0] === 'start'),
        15_000
      )
    ).toBe(true);
    const status = await executeAgentCliAsync(f.root, ['status', '--json']);
    expect(JSON.parse(status.stdout).devServer.running).toBe(true);
    expect(readStubExpoInvocations(f.root).filter((call) => call.args[0] === 'start')).toHaveLength(
      1
    );
  } finally {
    await f.cleanup();
  }
});

it('two retries recover a dead child that never began work without removing the new owner', async () => {
  const f = await fixture();
  try {
    const first = f.start({ DETACH_TEST_CLAIM_BARRIER: '1' });
    expect(await waitForAsync(() => f.marks('claimed').length === 1, 15_000)).toBe(true);
    process.kill(Number(f.marks('claimed')[0]!.slice('claimed-'.length)), 'SIGKILL');
    await first.result;
    const second = f.start({ DETACH_TEST_RECLAIM_BARRIER: '1' });
    const third = f.start({ DETACH_TEST_RECLAIM_BARRIER: '1' });
    expect(await waitForAsync(() => f.marks('reclaim').length === 2, 15_000)).toBe(true);
    // Both inspected the old owner. Let one replace it before the other removes its old marker.
    const [one, two] = f.marks('reclaim');
    fs.writeFileSync(path.join(f.barrier, `release-${one}`), '');
    expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
    fs.writeFileSync(path.join(f.barrier, `release-${two}`), '');
    expect(
      await waitForAsync(
        () => f.marks('blocked').length === 1 && f.marks('exited').length === 1,
        15_000
      )
    ).toBe(true);
    f.release();
    const results = await Promise.all([second.result, third.result]);
    expect(results.map((result) => result.exitCode).sort()).toEqual([0, 20]);
    const winner = JSON.parse(results.find((result) => result.exitCode === 0)!.stdout);
    const loser = JSON.parse(results.find((result) => result.exitCode === 20)!.stdout).error;
    expect(loser).toMatchObject({ code: 'DEV_START_BUSY', data: { pid: winner.pid } });
    expect(readStubExpoInvocations(f.root).filter((call) => call.args[0] === 'start')).toHaveLength(
      1
    );
  } finally {
    await f.cleanup();
  }
});

it('refuses automatic takeover when the dead child had already begun work', async () => {
  const f = await fixture();
  try {
    const first = f.start();
    expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
    process.kill(Number(f.marks('blocked')[0]!.slice('blocked-'.length)), 'SIGKILL');
    await first.result;
    const result = await f.start().result;
    expect(result.exitCode, result.all).toBe(20);
    expect(JSON.parse(result.stdout).error.code).toBe('DEV_START_UNCERTAIN');
    expect(readStubExpoInvocations(f.root).filter((call) => call.args[0] === 'start')).toHaveLength(
      0
    );
  } finally {
    await f.cleanup();
  }
});

it('a retry refuses while the surviving child owns startup after its parent dies', async () => {
  const f = await fixture();
  try {
    const first = f.start();
    expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
    const ownerPid = Number(f.marks('blocked')[0]!.slice('blocked-'.length));
    first.child.kill('SIGKILL'); // Only the parent, never the detached child's process group.
    await first.result;
    const result = await f.start().result;
    expect(result.exitCode, result.all).toBe(20);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'DEV_START_BUSY',
      data: { pid: ownerPid },
    });
    expect(f.marks('blocked')).toHaveLength(1);
    f.release();
    expect(await waitForDevLockAsync(f.root, 15_000)).toMatchObject({ pid: ownerPid });
    expect(
      await waitForAsync(
        () => readStubExpoInvocations(f.root).some((call) => call.args[0] === 'start'),
        15_000
      )
    ).toBe(true);
    expect(readStubExpoInvocations(f.root).filter((call) => call.args[0] === 'start')).toHaveLength(
      1
    );
  } finally {
    await f.cleanup();
  }
});

it.each([false, true])(
  'a delayed child loses to a published owner (parent killed: %s)',
  async (killParent) => {
    const f = await fixture();
    try {
      const first = f.start({ DETACH_TEST_BOOT_BARRIER: '1' });
      expect(await waitForAsync(() => f.marks('child').length === 1, 15_000)).toBe(true);
      if (killParent) {
        first.child.kill('SIGKILL');
        await first.result;
      }
      const second = f.start();
      expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
      const ownerPid = Number(f.marks('blocked')[0]!.slice('blocked-'.length));
      f.release();
      const result = await second.result;
      fs.writeFileSync(path.join(f.barrier, 'release-boot'), '');
      expect(await waitForAsync(() => f.marks('exited').length === 1, 15_000)).toBe(true);
      if (!killParent) {
        const refused = await first.result;
        expect(refused.exitCode, refused.all).toBe(20);
        expect(JSON.parse(refused.stdout).error).toMatchObject({
          code: 'DEV_START_BUSY',
          data: { pid: ownerPid },
        });
      }
      expect(result.exitCode, result.all).toBe(0);
      expect(JSON.parse(result.stdout).pid).toBe(ownerPid);
      expect(
        readStubExpoInvocations(f.root).filter((call) => call.args[0] === 'start')
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  }
);

it('does not replace a live owner whose claim cannot be read', async () => {
  const f = await fixture();
  try {
    f.start();
    expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
    const claim = path.join(f.root, '.expo', 'dev', 'detached-run');
    const marker = fs.readdirSync(claim).find((name) => name.startsWith('owner-'))!;
    fs.writeFileSync(path.join(claim, marker), '{');
    const result = await f.start().result;
    expect(result.exitCode, result.all).toBe(20);
    expect(JSON.parse(result.stdout).error.code).toBe('DEV_START_UNCERTAIN');
    expect(f.marks('blocked')).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

it('a blocked startup in one worktree does not prevent a second worktree from starting', async () => {
  const a = await fixture();
  const b = await fixture();
  try {
    const first = a.start();
    expect(await waitForAsync(() => a.marks('blocked').length === 1, 15_000)).toBe(true);
    b.release();
    const second = await b.start().result;
    expect(second.exitCode, second.all).toBe(0);
    expect(readStubExpoInvocations(a.root).filter((call) => call.args[0] === 'start')).toHaveLength(
      0
    );
    a.release();
    const result = await first.result;
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout).pid).not.toBe(JSON.parse(second.stdout).pid);
  } finally {
    await Promise.all([a.cleanup(), b.cleanup()]);
  }
});

it('releases ownership after a normal startup failure so another attempt can succeed', async () => {
  const f = await fixture();
  try {
    f.release();
    const failed = await f.start({ STUB_EXPO_EXIT_CODE: '1', STUB_EXPO_DELAY_MS: '0' }).result;
    expect(failed.exitCode, failed.all).not.toBe(0);
    const retry = await f.start().result;
    expect(retry.exitCode, retry.all).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it.each(['pid', 'url'] as const)(
  'refuses success when the published %s changes during the final readiness probe',
  async (changed) => {
    const f = await fixture();
    let release: (() => void) | undefined;
    const info = {
      pid: 0,
      url: '',
      port: 0,
      projectRoot: f.root,
      startedAt: new Date(0).toISOString(),
    };
    let probes = 0;
    const server = http.createServer((request, response) => {
      if (request.url !== '/status') return void response.writeHead(404).end();
      if (++probes === 2) {
        if (changed === 'pid') info.pid = process.pid;
        else info.url += '/replacement';
      }
      response.writeHead(200, { 'X-React-Native-Project-Root': encodeURI(f.root) });
      response.end('packager-status:running');
    });
    try {
      const started = f.start();
      expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
      info.pid = Number(f.marks('blocked')[0]!.slice('blocked-'.length));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      info.port = (server.address() as net.AddressInfo).port;
      info.url = `http://127.0.0.1:${info.port}`;
      release = await holdDevLockAsync(f.root, info);
      const result = await started.result;
      expect(probes).toBe(2);
      expect(result.exitCode, result.all).toBe(20);
      expect(JSON.parse(result.stdout).error.code).toBe('DEV_DETACH_OWNER_CHANGED');
    } finally {
      // Never let cleanup signal the test runner through its replacement socket.
      release?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.cleanup();
    }
  }
);

it.skipIf(process.platform !== 'darwin')(
  'a missing-device suggestion leads to state-aware recovery beside a running server',
  async () => {
    const f = await fixture();
    const { binDir } = await installStubXcrunAsync(f.root);
    const env = { ...f.env, ...pathEnvVars(binDir), AGENT_CLI_NO_DEVICE: '0' };
    try {
      f.release();
      const started = await f.start().result;
      expect(started.exitCode, started.all).toBe(0);
      const refused = await executeAgentCliAsync(f.root, ['navigate', '/', '--ios', '--json'], {
        reject: false,
        env,
      });
      expect(JSON.parse(refused.stdout).error.code).toBe('NO_BOUND_DEVICE');
      const command = JSON.parse(refused.stdout).error.suggestedCommand;
      expect(command).toBe('npx @expo/agent-cli status');
      const recovery = await executeAgentCliAsync(
        f.root,
        [...command.split(' ').slice(2), '--json'],
        { env }
      );
      expect(JSON.parse(recovery.stdout).next.command).toMatch(
        /^npx @expo\/agent-cli dev:stop && npx @expo\/agent-cli dev --ios /
      );
      expect(await readDevLockAsync(f.root)).toMatchObject({ pid: JSON.parse(started.stdout).pid });
    } finally {
      await f.cleanup();
    }
  }
);

it.each(['live', 'dead-executing', 'unreadable', 'dead-claimed'])(
  'status respects pre-publication ownership: %s',
  async (state) => {
    const f = await fixture();
    try {
      const recoverable = state === 'dead-claimed';
      const first = f.start(recoverable ? { DETACH_TEST_CLAIM_BARRIER: '1' } : {});
      const mark = recoverable ? 'claimed' : 'blocked';
      expect(await waitForAsync(() => f.marks(mark).length === 1, 15_000)).toBe(true);
      const pid = Number(f.marks(mark)[0]!.slice(mark.length + 1));
      if (state.startsWith('dead-')) {
        process.kill(pid, 'SIGKILL');
        await first.result;
      } else if (state === 'unreadable') {
        const claim = path.join(f.root, '.expo', 'dev', 'detached-run');
        const marker = fs.readdirSync(claim).find((name) => name.startsWith('owner-'))!;
        fs.writeFileSync(path.join(claim, marker), '{');
      }
      const status = await executeAgentCliAsync(f.root, ['status', '--json']);
      const next = JSON.parse(status.stdout).next;
      if (recoverable) {
        expect(next.command).toContain(' dev --');
        f.release();
        expect((await f.start().result).exitCode).toBe(0);
      } else {
        expect(next).toMatchObject({ command: 'npx @expo/agent-cli dev:logs', steps: [] });
        expect(next.why).toContain('ownership');
      }
    } finally {
      await f.cleanup();
    }
  }
);

it.skipIf(process.platform !== 'darwin')(
  'startup observation takes priority over unreadable-binding cleanup',
  async () => {
    const f = await fixture();
    const { binDir } = await installStubXcrunAsync(f.root);
    const binding = await bindingFixture(f.root, 'E2E-STARTUP-BINDING');
    fs.writeFileSync(binding, '{');
    const env = { ...pathEnvVars(binDir), AGENT_CLI_NO_DEVICE: '0' };
    try {
      f.start();
      expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
      const status = await executeAgentCliAsync(f.root, ['status', '--json'], { env });
      const next = JSON.parse(status.stdout).next;
      expect(next).toMatchObject({ command: 'npx @expo/agent-cli dev:logs', steps: [] });
      await executeAgentCliAsync(f.root, [...next.command.split(' ').slice(2), '--json'], { env });
      expect(fs.readFileSync(binding, 'utf8')).toBe('{');
      expect(f.marks('blocked')).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  }
);

it('stopping and starting again selects a new log without changing the previous run', async () => {
  const f = await fixture();
  try {
    f.release();
    const first = await f.start().result;
    expect(first.exitCode, first.all).toBe(0);
    const a = JSON.parse(first.stdout);
    await executeAgentCliAsync(f.root, ['dev:stop', '--json']);
    const previous = fs.readFileSync(a.logFile, 'utf8');
    const second = await f.start().result;
    expect(second.exitCode, second.all).toBe(0);
    const b = JSON.parse(second.stdout);
    expect(b.pid).not.toBe(a.pid);
    expect(b.logFile).not.toBe(a.logFile);
    expect(fs.readFileSync(a.logFile, 'utf8')).toBe(previous);
    const logs = await executeAgentCliAsync(f.root, ['dev:logs', '--json']);
    expect(JSON.parse(logs.stdout).logFile).toBe(b.logFile);
  } finally {
    await f.cleanup();
  }
});

it('smoke cannot stop a competing detached owner when its own bootstrap loses', async () => {
  const f = await fixture();
  let smoke: ReturnType<typeof spawnAgentCli> | undefined;
  try {
    const first = f.start();
    expect(await waitForAsync(() => f.marks('blocked').length === 1, 15_000)).toBe(true);
    smoke = spawnAgentCli(
      f.root,
      ['smoke', '--ios', '--json', '--no-screenshot', '--port', String(f.port), '--timeout', '1s'],
      {
        env: { ...f.env, ...pathEnvVars(path.join(f.root, '.no-bin')) },
      }
    );
    const finished = waitForExitAsync(smoke, collectOutput(smoke));
    expect(await waitForAsync(() => f.marks('exited').length === 1, 15_000)).toBe(true);
    f.release();
    const started = await first.result;
    expect(started.exitCode, started.all).toBe(0);
    const owner = JSON.parse(started.stdout);
    const checked = await finished;
    expect(checked.exitCode, checked.all).not.toBe(0);
    expect(await readDevLockAsync(f.root)).toMatchObject({ pid: owner.pid });
    expect(await (await fetch(`${owner.url}/status`)).text()).toBe('packager-status:running');
    expect(readStubExpoInvocations(f.root).filter((call) => call.args[0] === 'start')).toHaveLength(
      1
    );
  } finally {
    if (smoke) await killAsync(smoke, 'SIGKILL');
    await f.cleanup();
  }
});

it.each(
  (['ios', 'android'] as const).filter(
    (platform) => platform === 'android' || process.platform === 'darwin'
  )
)(
  'smoke reports skipped %s device cleanup when its own server has already exited',
  async (platform) => {
    const f = await fixture();
    const device = 'E2E-OWNED-CLEANUP';
    let binding: string | undefined;
    let deviceEnv: Record<string, string> = {};
    let calls: () => string[][];
    if (platform === 'ios') {
      ({ calls } = await installStubXcrunAsync(f.root, {
        simulators: [{ udid: device, name: 'agent-cli deadbeef', state: 'Shutdown' }],
      }));
      binding = await bindingFixture(f.root, device, 'agent-cli deadbeef');
    } else {
      const adb = await installStubAdbAsync(f.root, 'host.exp.exponent', {
        attached: false,
        bound: false,
      });
      deviceEnv = adb.env;
      calls = adb.calls;
      await installStubEmulatorAsync(f.root);
    }
    const script = path.join(f.root, '.stub-bin', 'npx-refuse.js');
    fs.writeFileSync(script, 'process.exit(1);');
    await installStubBinAsync(path.dirname(script), 'npx', script);
    const env = {
      ...f.env,
      ...pathEnvVars(path.dirname(script)),
      ...deviceEnv,
      AGENT_CLI_NO_DEVICE: '0',
    };
    try {
      f.release();
      const result = await executeAgentCliAsync(
        f.root,
        [
          'smoke',
          `--${platform}`,
          '--json',
          '--no-screenshot',
          '--port',
          String(f.port),
          '--timeout',
          '1s',
        ],
        { reject: false, env: { ...env, STUB_EXPO_DIE_AFTER_STATUS_MS: '1' } }
      );
      const report = JSON.parse(result.stdout);
      expect(report.environment.cleanup).toContainEqual(
        expect.objectContaining({
          resource: 'dev-server',
          ok: false,
          reason: expect.stringContaining('device cleanup was skipped'),
        })
      );
      if (platform === 'ios') {
        expect(calls()).toContainEqual(['simctl', 'bootstatus', device, '-b']);
        expect(calls()).not.toContainEqual(['simctl', 'shutdown', device]);
      } else {
        const directory = path.join(expoHomeOf(f.root), 'agent-cli', 'bindings');
        binding = path.join(
          directory,
          fs.readdirSync(directory).find((name) => name.endsWith('-android-local-android.json'))!
        );
        const own = JSON.parse(fs.readFileSync(binding, 'utf8')).device.origin;
        expect(own.kind).toBe('spawned');
        expect(() => process.kill(own.emulatorPid, 0)).not.toThrow();
      }
      expect(Date.parse(JSON.parse(fs.readFileSync(binding!, 'utf8')).expiresAt)).toBeGreaterThan(
        Date.now()
      );
    } finally {
      if (platform === 'android') await killBoundEmulatorsAsync(expoHomeOf(f.root));
      await executeAgentCliAsync(f.root, ['dev:stop', '--release', '--json'], {
        reject: false,
        env,
      });
      await f.cleanup();
    }
  }
);

it.each(['ios', 'android'] as const)(
  'cleanup for a live %s child cannot stop a different live owner',
  async (platform) => {
    const f = await fixture();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    try {
      f.release();
      const started = await f.start().result;
      expect(started.exitCode, started.all).toBe(0);
      const owner = JSON.parse(started.stdout);
      expect(child.pid).not.toBe(owner.pid);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      const cleanup = await stopOwnedDevServerAsync(f.root, platform, false, child);
      expect(cleanup.ok).toBe(false);
      expect(await readDevLockAsync(f.root)).toMatchObject({ pid: owner.pid });
      expect(await (await fetch(`${owner.url}/status`)).text()).toBe('packager-status:running');
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      await killAsync(child, 'SIGKILL');
      await f.cleanup();
    }
  }
);
