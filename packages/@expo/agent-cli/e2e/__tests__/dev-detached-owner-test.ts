import fs from 'node:fs';
import path from 'node:path';

import { isProcessAlive } from '../../src/dev/processLiveness';
import { readLastDevRequest } from '../../src/dev/lastRequest';
import { DETACHED_LOG_PATH } from '../detachUtils';
import { setupDetachedFixtureAsync } from '../detachedFixture';
import { stubEasArgs } from '../stubEas';
import {
  collectOutput,
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
    expect.soft(logged).toMatchObject({ detached: { phase: 'starting' } });
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
    expect.soft(JSON.parse(logs.stdout), logs.all).toMatchObject({ detached: observation });

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
