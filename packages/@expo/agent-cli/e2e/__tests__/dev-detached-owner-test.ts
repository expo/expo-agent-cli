import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  withDetachedOwnerAsync,
  readDetachedAttemptAsync,
  cancelDetachedAttemptAsync,
  DETACHED_ATTEMPT_ENV,
} from '../../src/dev/detachedOwner';
import { resolveDevOptions } from '../../src/dev/resolveOptions';
import { resolveDevStopOptions } from '../../src/dev/resolveStopOptions';
import { spawnSubprocessAsync } from '../../src/utils/subprocess';
import { spawnCaptureAsync } from '../../src/utils/spawnCapture';
import { withSubprocessDeadlineAsync } from '../../src/utils/subprocessDeadline';
import { buildSessionStopArgs } from '../../src/device/eas';
import { signalProcessAsync } from '../../src/dev/processStop';

import { isProcessAlive, isProcessRunning } from '../../src/dev/processLiveness';
import { readLastDevRequest } from '../../src/dev/lastRequest';
import { DETACHED_LOG_PATH } from '../detachUtils';
import { setupDetachedFixtureAsync } from '../detachedFixture';
import { stubEasArgs, writeCloudBindingAsync, cloudBindingFile } from '../stubEas';
import { canonicalizeExistingPath } from '../../src/utils/dir';
import {
  collectOutput,
  installStubBinAsync,
  readJsonLines,
  setupFixtureAsync,
  expoHomeOf,
  executeAgentCliAsync,
  freePortAsync,
  killAsync,
  readDevLockAsync,
  readStubExpoInvocations,
  spawnAgentCli,
  waitForAsync,
  waitForExitAsync,
} from '../utils';

const platforms: ('ios' | 'android')[] = ['ios', 'android'];

it.concurrent.for(
  platforms.flatMap((platform) =>
    ['killed', 'expired', 'raced'].map((mode) => ({ platform, mode }))
  )
)('keeps one startup visible and exclusive (%j)', async ({ platform, mode }, { expect }) => {
  const fixture = await setupDetachedFixtureAsync();
  const { root, port, env, heldPids, processes } = fixture;
  const runEnv = {
    ...env,
    HOLD_FINGERPRINT: '1',
    HOLD_CANDIDATE: mode === 'raced' ? '1' : '0',
    AGENT_CLI_DETACH_TIMEOUT_MS: '5000',
  };
  const run = (args: string[], overrides = {}) =>
    executeAgentCliAsync(root, [...args, '--json'], {
      env: { ...env, ...overrides },
      reject: false,
    });
  const start = ['dev', `--${platform}`, '--eas', '--detach', '--port', String(port)];
  const parent = spawnAgentCli(root, [...start, '--wait-ready', '--json'], { env: runEnv });
  const output = collectOutput(parent);
  const exited = waitForExitAsync(parent, output);
  const contender =
    mode === 'raced' ? spawnAgentCli(root, [...start, '--json'], { env: runEnv }) : null;
  const contended = contender && waitForExitAsync(contender, collectOutput(contender));
  try {
    if (contender) {
      expect(
        await waitForAsync(() => processes().filter(({ owner }) => owner).length === 2, 15000)
      ).toBe(true);
      expect(heldPids()).toHaveLength(0);
      fixture.releaseCandidates();
    }
    expect(await waitForAsync(() => heldPids().length > 0, 15_000), output.all).toBe(true);
    const logs = await run(['dev:logs']);
    const logged = JSON.parse(logs.stdout);
    const { logFile, lines } = logged;
    const pid =
      logged.detached?.pid ??
      processes().find(({ owner, pid }) => owner && isProcessAlive(pid))?.pid;
    expect(pid).toBeDefined();
    if (mode !== 'expired') await killAsync(parent, 'SIGKILL');
    else {
      const result = await exited;
      expect(result.exitCode, result.all).toBe(22);
    }
    if (contender) {
      const result = await contended!;
      expect.soft([20, 22], result.all).toContain(result.exitCode);
    }
    expect(pid && isProcessAlive(pid)).toBe(true);
    expect(await readDevLockAsync(root)).toBeNull();
    const saved = readLastDevRequest(root);

    expect.soft(path.basename(logFile)).not.toBe(path.basename(DETACHED_LOG_PATH));
    const observation = { phase: 'starting', pid, port, logFile };
    expect.soft(logged, logs.all).toMatchObject({ detached: observation });

    const changedPort = String(await freePortAsync());
    const [equivalent, changed] = await Promise.all([
      run(['dev', '--detach', '--port', String(port), '--eas', `--${platform}`], runEnv),
      run([...start.slice(0, -1), changedPort, '--wait-ready'], runEnv),
    ]);
    expect.soft(equivalent.exitCode, equivalent.all).toBe(22);
    expect.soft(changed.exitCode, changed.all).toBe(20);
    expect.soft(readLastDevRequest(root)).toEqual(saved);
    expect.soft(heldPids(), 'one elected child reaches fingerprint').toHaveLength(1);
    const smoke = await run(
      [
        'smoke',
        `--${platform}`,
        '--eas',
        '--no-screenshot',
        '--port',
        String(port),
        '--timeout',
        '1s',
      ],
      { ...runEnv, HOLD_FINGERPRINT: '0', HOLD_CANDIDATE: '0' }
    );
    expect(JSON.parse(smoke.stdout), smoke.all).toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({
          id: 'start-dev-server',
          status: 'failed',
          reason: expect.stringContaining('detached startup still owns'),
        }),
      ]),
      environment: {
        cleanup: expect.arrayContaining([
          expect.objectContaining({ resource: 'dev-server', ok: true, target: null }),
        ]),
      },
    });
    expect(isProcessAlive(pid)).toBe(true);
    expect.soft(await readDevLockAsync(root)).toBeNull();
    const tmpdir = fs.mkdtempSync(path.join(root, 'observer-tmp-'));
    const status = await run(['status'], { TMPDIR: tmpdir, TEMP: tmpdir, TMP: tmpdir });
    expect.soft(JSON.parse(status.stdout), status.all).toMatchObject({ detached: observation });
    const laterLogs = await run(['dev:logs']);
    expect
      .soft(JSON.parse(laterLogs.stdout))
      .toMatchObject({ logFile, lines, detached: observation });

    const packageFile = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    fs.writeFileSync(
      packageFile,
      JSON.stringify({ ...pkg, expo: { 'agent-cli': { target: 'expo-go' } } })
    );
    expect((await run(start, runEnv)).exitCode).toBe(20);
    fixture.releaseFingerprint();
    const metro = () => readStubExpoInvocations(root).filter(({ args }) => args[0] === 'start');
    expect(await waitForAsync(() => metro().length > 0, 15_000)).toBe(true);
    expect(stubEasArgs(root).filter(([command]) => command === 'build')).toHaveLength(1);
    expect(metro()).toHaveLength(1);
  } finally {
    await killAsync(parent, 'SIGKILL');
    if (contender) await killAsync(contender, 'SIGKILL');
    await fixture.cleanup();
  }
});

it.concurrent.for(platforms.flatMap((platform) => [false, true].map((eas) => ({ platform, eas }))))(
  'stops startup while fingerprinting (%j)',
  async ({ platform, eas }, { expect }) => {
    const fixture = await setupDetachedFixtureAsync();
    const { root, port, env, heldPids, processes } = fixture;
    const releaseStop = path.join(root, 'release-simulator-stop');
    const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) =>
      executeAgentCliAsync(root, [...args, '--json'], {
        env: { ...env, ...overrides },
        reject: false,
      });
    const bindingRoot = canonicalizeExistingPath(root);
    await writeCloudBindingAsync(expoHomeOf(root), bindingRoot, { id: 'captured', platform });
    const parent = spawnAgentCli(
      root,
      ['dev', `--${platform}`, '--eas', '--detach', '--port', String(port), '--json'],
      { env: { ...env, HOLD_FINGERPRINT: '1' } }
    );
    const output = collectOutput(parent);
    let pendingStop: Promise<unknown> | undefined;
    try {
      expect(await waitForAsync(() => heldPids().length === 1, 15_000), output.all).toBe(true);
      expect(await readDevLockAsync(root)).toBeNull();
      const pids = [...processes().map(({ pid }) => pid), ...heldPids()];
      expect(pids).toHaveLength(2);
      const otherPort = String(await freePortAsync());
      for (const args of [
        ['--port', otherPort],
        ['--force'],
        ['--release'],
        ['--signal', 'SIGKILL'],
      ]) {
        const refused = await run(['dev:stop', ...args]);
        expect.soft(refused.exitCode, refused.all).toBe(20);
        expect(pids.every(isProcessRunning), refused.all).toBe(true);
      }

      const stopping = run(
        ['dev:stop', '--port', String(port), ...(eas ? ['--eas'] : [])],
        eas ? { STUB_SIM_STOP_RELEASE_FILE: releaseStop } : {}
      );
      pendingStop = Promise.allSettled([stopping]);
      if (eas) {
        expect(
          await waitForAsync(
            () => stubEasArgs(root).some(([verb]) => verb === 'simulator:stop'),
            10000
          )
        ).toBe(true);
        const blocked = await run([
          'dev',
          `--${platform}`,
          '--eas',
          '--detach',
          '--port',
          String(port),
        ]);
        expect(blocked.exitCode, blocked.all).toBe(20);
        const duplicate = await run(['dev:stop', '--eas']);
        expect(duplicate.exitCode, duplicate.all).toBe(20);
        await writeCloudBindingAsync(expoHomeOf(root), bindingRoot, { id: 'successor', platform });
        fs.writeFileSync(releaseStop, '');
      }
      const stopped = await stopping;
      pendingStop = undefined;
      const stops = stubEasArgs(root).filter(([verb]) => verb === 'simulator:stop');
      expect(stops).toEqual(eas ? [buildSessionStopArgs('captured')] : []);
      expect(
        JSON.parse(
          fs.readFileSync(cloudBindingFile(expoHomeOf(root), bindingRoot, platform), 'utf8')
        ).device.id
      ).toBe(eas ? 'successor' : 'captured');
      expect.soft(stopped.exitCode, stopped.all).toBe(0);
      expect.soft(JSON.parse(stopped.stdout), stopped.all).toMatchObject({ stopped: true });
      expect(pids.filter(isProcessRunning), 'owner and fingerprint process exited').toEqual([]);

      expect(fs.existsSync(path.join(root, '.expo/dev/detached-claim'))).toBe(false);
      const easCalls = stubEasArgs(root);
      fixture.releaseFingerprint();
      expect(await readDevLockAsync(root)).toBeNull();
      expect(processes()).toHaveLength(1);
      expect(stubEasArgs(root)).toEqual(easCalls);
      expect(readStubExpoInvocations(root).filter(({ args }) => args[0] === 'start')).toEqual([]);
    } finally {
      try {
        if (eas && pendingStop) fs.writeFileSync(releaseStop, '');
      } finally {
        await pendingStop;
        await killAsync(parent, 'SIGKILL');
        await fixture.cleanup();
      }
    }
  }
);

it.concurrent.for(platforms)(
  'recovers %s only after uncertain claims are manually quiesced',
  async (platform, { expect }) => {
    const fixture = await setupDetachedFixtureAsync();
    const { root, port, env } = fixture;
    const run = (args: string[]) =>
      executeAgentCliAsync(root, [...args, '--json'], { env, reject: false });
    const start = ['dev', `--${platform}`, '--eas', '--detach', '--port', String(port)];
    const claim = path.join(root, '.expo/dev/detached-claim');
    const id = '00000000-0000-4000-8000-000000000001';
    const directory = path.join(claim, id);
    try {
      fs.mkdirSync(claim, { recursive: true });
      for (const stage of ['empty', 'incomplete', 'malformed', 'unanswered']) {
        if (stage === 'incomplete') fs.mkdirSync(directory);
        if (stage === 'malformed') fs.writeFileSync(path.join(directory, 'owner.json'), '{}');
        if (stage === 'unanswered')
          fs.writeFileSync(
            path.join(directory, 'owner.json'),
            JSON.stringify({
              id,
              projectRoot: root,
              directory,
              request: '[]',
              pid: process.pid,
              port,
              logFile: path.join(root, '.expo/dev/logs', `dev-detached-${id}.log`),
              control: { port: await freePortAsync(), token: id },
            })
          );
        const refused = await run(start);
        expect(refused.exitCode, refused.all).toBe(20);
        expect(refused.all).toContain('Quiesce all callers');
        expect((await run(['dev:stop'])).exitCode).toBe(20);
        expect(fixture.processes()).toEqual([]);
        expect(stubEasArgs(root)).toEqual([]);
      }
      const logs = await run(['dev:logs']);
      expect(JSON.parse(logs.stdout)).toMatchObject({ detached: { phase: 'uncertain' } });
      fs.renameSync(claim, `${claim}.quiesced`);
      fs.appendFileSync(
        path.join(root, 'capture-process.cjs'),
        `
        if (owner && process.env.CRASH_AFTER_CANCEL) {
          const response = require('node:http').ServerResponse.prototype;
          const flush = response.flushHeaders;
          response.flushHeaders = function () {
            flush.call(this);
            if (this.statusCode === 202) process.kill(process.pid, 'SIGKILL');
          };
        }
      `
      );
      const crashing = spawnAgentCli(root, [...start, '--json'], {
        env: { ...env, HOLD_FINGERPRINT: '1', CRASH_AFTER_CANCEL: '1' },
      });
      const crashed = waitForExitAsync(crashing, collectOutput(crashing));
      expect(await waitForAsync(() => fixture.heldPids().length === 1, 15000)).toBe(true);
      const interrupted = (await readDetachedAttemptAsync(canonicalizeExistingPath(root)))!.ref!;
      const incomplete = await run(['dev:stop', '--eas']);
      expect(incomplete.exitCode, incomplete.all).toBe(22);
      await crashed;
      expect(isProcessAlive(interrupted.pid)).toBe(false);
      expect(await readDevLockAsync(root)).toBeNull();
      expect(stubEasArgs(root).filter(([verb]) => verb === 'simulator:stop')).toEqual([]);
      expect(fs.existsSync(interrupted.directory)).toBe(true);
      expect((await run(start)).exitCode).toBe(20);
      expect(
        await waitForAsync(() => fixture.heldPids().every((pid) => !isProcessRunning(pid)), 5000)
      ).toBe(true);
      fs.renameSync(claim, `${claim}.crashed`);
      for (let repeat = 0; repeat < 2; repeat++) {
        const started = await run(start);
        expect(started.exitCode, started.all).toBe(0);
        const pid = JSON.parse(started.stdout).pid;
        const stopped = await run(['dev:stop']);
        expect(stopped.exitCode, stopped.all).toBe(0);
        expect(await waitForAsync(() => !isProcessAlive(pid) && !fs.existsSync(claim), 5000)).toBe(
          true
        );
        expect(await readDevLockAsync(root)).toBeNull();
      }
    } finally {
      await fixture.cleanup();
    }
  }
);

it.concurrent.for(platforms)(
  'cleans its own %s partial start after readiness refuses',
  async (platform, { expect }) => {
    const fixture = await setupDetachedFixtureAsync();
    const { root, port, env } = fixture;
    const expo = path.join(root, 'node_modules/expo/bin/cli');
    fs.writeFileSync(
      expo,
      fs
        .readFileSync(expo, 'utf8')
        .replace('encodeURI(cwd)', "encodeURI(tunnelUp ? cwd + '-other' : cwd)")
    );
    try {
      const result = await executeAgentCliAsync(
        root,
        ['smoke', `--${platform}`, '--eas', '--port', String(port), '--no-screenshot', '--json'],
        {
          env: {
            ...env,
            STUB_EXPO_TUNNEL_HOST: 'owned.tunnel.example',
            STUB_EXPO_TUNNEL_DELAY_MS: '3000',
          },
          reject: false,
        }
      );
      expect(JSON.parse(result.stdout), result.all).toMatchObject({
        phases: expect.arrayContaining([
          expect.objectContaining({ id: 'start-dev-server', status: 'failed' }),
        ]),
        environment: {
          cleanup: expect.arrayContaining([
            expect.objectContaining({ resource: 'dev-server', ok: true }),
          ]),
        },
      });
      const owners = fixture.processes().filter(({ owner }) => owner);
      expect(owners).toHaveLength(1);
      expect(readStubExpoInvocations(root).filter(({ args }) => args[0] === 'start')).toHaveLength(
        1
      );
      expect(owners.every(({ pid }) => !isProcessAlive(pid))).toBe(true);
      expect(await readDevLockAsync(root)).toBeNull();
      expect(fs.existsSync(path.join(root, '.expo/dev/detached-claim'))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }
);

it.concurrent.for(platforms)(
  'keeps the %s winner when a pre-spawned smoke loses after lock publication',
  async (platform, { expect }) => {
    const fixture = await setupDetachedFixtureAsync();
    const { root, port, env } = fixture;
    const parent = spawnAgentCli(
      root,
      [
        'dev',
        `--${platform}`,
        '--eas',
        '--detach',
        '--no-fingerprint-cache',
        '--port',
        String(port),
        '--json',
      ],
      {
        env: { ...env, HOLD_CANDIDATE: '1', HOLD_FINGERPRINT: '1' },
      }
    );
    const smoke = spawnAgentCli(
      root,
      ['smoke', `--${platform}`, '--eas', '--port', String(port), '--no-screenshot', '--json'],
      {
        env: { ...env, HOLD_CANDIDATE: 'smoke' },
      }
    );
    const smokeOutput = collectOutput(smoke);
    const smokeEnded = waitForExitAsync(smoke, smokeOutput);
    collectOutput(parent);
    try {
      expect(
        await waitForAsync(
          () => fixture.processes().filter(({ owner }) => owner).length === 2,
          15000
        )
      ).toBe(true);
      fixture.releaseCandidates();
      expect(await waitForAsync(() => fixture.heldPids().length === 1, 15000)).toBe(true);
      fixture.releaseFingerprint();
      expect(
        await waitForAsync(async () => (await readDevLockAsync(root))?.phase === 'serving', 15000)
      ).toBe(true);
      const winner = await readDevLockAsync(root);
      fixture.releaseSmokeCandidate();
      const result = await smokeEnded;
      expect(JSON.parse(result.stdout), result.all).toMatchObject({
        phases: expect.arrayContaining([
          expect.objectContaining({
            id: 'start-dev-server',
            status: 'failed',
            reason: expect.stringContaining('detached startup still owns'),
          }),
        ]),
        environment: {
          cleanup: expect.arrayContaining([
            expect.objectContaining({ resource: 'dev-server', ok: true, target: null }),
          ]),
        },
      });
      expect(await readDevLockAsync(root)).toMatchObject({ pid: winner!.pid });
      expect(isProcessAlive(winner!.pid)).toBe(true);
      expect(stubEasArgs(root).filter(([command]) => command === 'build')).toHaveLength(1);
      expect(readStubExpoInvocations(root).filter(({ args }) => args[0] === 'start')).toHaveLength(
        1
      );
    } finally {
      await killAsync(parent, 'SIGKILL');
      await killAsync(smoke, 'SIGKILL');
      await fixture.cleanup();
    }
  }
);

it.each([spawnSubprocessAsync, spawnCaptureAsync])(
  'authenticates stop grants and drains active, queued and fallback runners (%#)',
  async (activeRunner) => {
    const root = await setupFixtureAsync('go-app');
    fs.mkdirSync(path.join(root, '.expo/dev/logs'), { recursive: true });
    const script = path.join(root, 'runner.cjs');
    const log = path.join(root, 'children.jsonl');
    fs.writeFileSync(
      script,
      `
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid }) + '\\n');
      setInterval(() => {}, 1000);
    `
    );
    await installStubBinAsync(root, 'npx', script);
    const runner = path.join(root, process.platform === 'win32' ? 'npx.cmd' : 'npx');
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const calls = () => readJsonLines<{ pid: number }>(log);
    let queuedStarted = false,
      deadlineEnded = false;
    process.env[DETACHED_ATTEMPT_ENV] = randomUUID();
    const finished = withDetachedOwnerAsync(
      root,
      resolveDevOptions(['--ios', '--detach']),
      async () => {
        const active = activeRunner(runner, ['spec', 'active']);
        await waitForAsync(() => calls().length === 1, 5000);
        const queuedRunner =
          activeRunner === spawnSubprocessAsync ? spawnCaptureAsync : spawnSubprocessAsync;
        const queued = withSubprocessDeadlineAsync(5000, 'outer', () =>
          withSubprocessDeadlineAsync(500, 'inner', async () => {
            try {
              await queuedRunner(runner, ['spec', 'queued']);
            } catch {
              await queuedRunner(process.execPath, [script, 'fallback']);
            } finally {
              await held;
            }
          })
        ).catch((error) => {
          deadlineEnded = true;
          return error;
        });
        queuedStarted = true;
        await active;
        await queued;
      }
    ).catch((error) => error);
    delete process.env[DETACHED_ATTEMPT_ENV];
    try {
      expect(await waitForAsync(() => queuedStarted, 5000)).toBe(true);
      const owner = (await readDetachedAttemptAsync(root))!.ref!;
      const post = (action: string, headers = {}, signal?: AbortSignal) =>
        fetch(`http://127.0.0.1:${owner.control.port}/${action}`, {
          method: 'POST',
          signal,
          headers: {
            Authorization: owner.control.token,
            'x-detached-attempt': owner.id,
            'x-detached-cancel': 'true',
            ...headers,
          },
        });
      for (const headers of [{ Authorization: 'wrong' }, { 'x-detached-attempt': 'wrong' }])
        expect((await post('cancel', headers)).status).toBe(401);
      const abort = new AbortController();
      const first = await post('cancel', {}, abort.signal);
      expect(first.status).toBe(202);
      const grant = { 'x-detached-grant': first.headers.get('x-detached-grant')! };
      abort.abort();
      await first.text().catch(() => {});
      expect((await post('cancel')).status).toBe(409);
      expect((await post('release', grant)).status).toBe(204);
      const second = await cancelDetachedAttemptAsync(owner, resolveDevStopOptions([]));
      expect((await post('release', grant)).status).toBe(409);
      expect((await post('cancel')).status).toBe(409);
      let completed = false;
      void second.completion.then(() => {
        completed = true;
      });
      expect(
        await waitForAsync(() => calls().every(({ pid }) => !isProcessRunning(pid)), 5000)
      ).toBe(true);
      expect(await waitForAsync(() => deadlineEnded, 5000)).toBe(true);
      expect(completed).toBe(false);
      expect(fs.existsSync(owner.directory)).toBe(true);
      release();
      expect(await second.completion).toEqual([]);
      expect(await finished).toMatchObject({ code: 'DEV_INTERRUPTED' });
      expect(calls()).toHaveLength(1);
    } finally {
      release();
      for (const { pid } of calls())
        if (isProcessRunning(pid)) await signalProcessAsync(pid, 'SIGKILL');
      await finished;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

it.each([
  ['cancel-failure', false, 'subprocess'],
  ['cancel-failure', true, 'capture'],
  ['deadline-failure', false, 'capture'],
  ['deadline-failure', true, 'capture'],
  ['cancel', false, 'subprocess'],
  ['cancel', false, 'capture'],
  ['timeout', false, 'subprocess'],
] as const)(
  'reports managed startup drain from tree termination evidence (%s, eas=%s, %s)',
  async (mode, eas, runner) => {
    const fixture = await setupDetachedFixtureAsync();
    const root = canonicalizeExistingPath(fixture.root);
    const records = () =>
      readJsonLines<{ event: string; pid: number; body?: string }>(path.join(root, 'tree.jsonl'));
    const child = spawn(
      process.execPath,
      [path.resolve(__dirname, '../fixtures/startup-tree.cjs'), 'owner', root, mode, runner],
      {
        env: { ...process.env, ...fixture.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      }
    );
    const output = collectOutput(child);
    const exited = waitForExitAsync(child, output);
    const failure = mode.includes('failure');
    let stop: ReturnType<typeof executeAgentCliAsync> | undefined;
    let completion: Promise<unknown> | undefined;
    try {
      expect(
        await waitForAsync(() => records().some(({ event }) => event === 'leaf'), 15000),
        output.all
      ).toBe(true);
      const owner = (await readDetachedAttemptAsync(root))!.ref!;
      const tool = records().find(({ event }) => event === 'tool')!.pid;
      const leaf = records().find(({ event }) => event === 'leaf')!.pid;
      if (mode === 'deadline-failure' || mode === 'timeout')
        expect(
          await waitForAsync(() => records().some(({ event }) => event === 'direct-close'), 5000)
        ).toBe(true);
      if (eas) {
        await writeCloudBindingAsync(expoHomeOf(root), root, { id: 'captured', platform: 'ios' });
        stop = executeAgentCliAsync(root, ['dev:stop', '--eas', '--json', '--timeout', '10s'], {
          env: fixture.env,
          reject: false,
        });
        completion = stop;
        expect(
          await waitForAsync(() => records().some(({ event }) => event === 'accepted'), 5000)
        ).toBe(true);
      } else {
        const headers = {
          Authorization: owner.control.token,
          'x-detached-attempt': owner.id,
          'x-detached-cancel': 'true',
        };
        const response = await fetch(`http://127.0.0.1:${owner.control.port}/cancel`, {
          method: 'POST',
          headers,
        });
        expect(response.status).toBe(202);
        completion = response.text();
        void completion.catch(() => {});
        expect(
          (
            await fetch(`http://127.0.0.1:${owner.control.port}/release`, {
              method: 'POST',
              headers: {
                ...headers,
                'x-detached-grant': response.headers.get('x-detached-grant')!,
              },
            })
          ).status
        ).toBe(204);
      }
      let completed = false;
      void completion.then(
        () => {
          completed = true;
        },
        () => {
          completed = true;
        }
      );
      expect(
        await waitForAsync(() => records().some(({ event }) => event === 'direct-close'), 5000)
      ).toBe(true);
      expect(isProcessRunning(tool)).toBe(false);
      expect(await waitForAsync(() => isProcessRunning(leaf) === failure, 5000)).toBe(true);
      expect(completed).toBe(false);
      expect(fs.existsSync(owner.directory)).toBe(true);
      fs.writeFileSync(path.join(root, 'release-tree-task'), '');
      const result = await completion;
      expect(await waitForAsync(() => !isProcessAlive(owner.pid), 5000), output.all).toBe(true);
      await exited;
      expect(isProcessAlive(owner.pid)).toBe(false);
      if (failure) {
        if (stop) {
          expect(result).toMatchObject({ exitCode: 22 });
          expect(JSON.parse((await stop).stdout)).toMatchObject({
            stopped: false,
          });
          expect(fs.existsSync(cloudBindingFile(expoHomeOf(root), root, 'ios'))).toBe(true);
        } else expect(result).toBe('');
        expect(records().filter(({ event }) => event === 'receipt')).toEqual([
          expect.objectContaining({ body: '' }),
        ]);
        expect(fs.readdirSync(path.dirname(owner.directory))).toEqual([owner.id]);
        expect((await readDetachedAttemptAsync(root))?.observation.phase).toBe('uncertain');
        const beforeRetry = stubEasArgs(root);
        const retry = await executeAgentCliAsync(
          root,
          ['dev', '--ios', '--eas', '--detach', '--json'],
          { env: fixture.env, reject: false }
        );
        expect(retry.exitCode, retry.all).toBe(20);
        expect(stubEasArgs(root)).toEqual(beforeRetry);
        expect(readStubExpoInvocations(root)).toEqual([]);
        expect(
          stubEasArgs(root).filter(([verb]) => verb === 'simulator:stop' || verb === 'build')
        ).toEqual([]);
        expect(fixture.processes().filter(({ owner }) => !owner)).toEqual([]);
        expect(isProcessRunning(leaf)).toBe(true);
      } else {
        expect(JSON.parse(result as string)).toMatchObject({ id: owner.id, drained: true });
        expect(fs.existsSync(owner.directory)).toBe(false);
      }
    } finally {
      fs.writeFileSync(path.join(root, 'release-tree-task'), '');
      await killAsync(child, 'SIGKILL');
      const pids = [...new Set(records().map(({ pid }) => pid))];
      for (const pid of pids) if (isProcessRunning(pid)) await signalProcessAsync(pid, 'SIGKILL');
      expect(await waitForAsync(() => pids.every((pid) => !isProcessRunning(pid)), 5000)).toBe(
        true
      );
      await stop;
      await completion?.catch(() => {});
      await fixture.cleanup();
    }
  }
);
