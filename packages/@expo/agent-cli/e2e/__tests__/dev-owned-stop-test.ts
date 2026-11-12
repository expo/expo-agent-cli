import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  readDetachedAttemptAsync,
  requestOwnedStopAsync,
  withDetachedOwnerAsync,
  DETACHED_ATTEMPT_ENV,
} from '../../src/dev/detachedOwner';
import { resolveDevOptions } from '../../src/dev/resolveOptions';
import { resolveDevStopOptions } from '../../src/dev/resolveStopOptions';
import { isProcessAlive, isProcessRunning } from '../../src/dev/processLiveness';
import { signalProcessAsync } from '../../src/dev/processStop';
import { buildSessionStopArgs } from '../../src/device/eas';
import { canonicalizeExistingPath } from '../../src/utils/dir';
import { setupDetachedFixtureAsync } from '../detachedFixture';
import { cloudBindingFile, stubEasArgs, writeCloudBindingAsync } from '../stubEas';
import {
  spawnAgentCli,
  collectOutput,
  installStubBinAsync,
  killAsync,
  waitForExitAsync,
  executeAgentCliAsync,
  expoHomeOf,
  readDevLockAsync,
  readJsonLines,
  waitForAsync,
} from '../utils';

it.concurrent.for([
  ...(['ios', 'android'] as const).flatMap((platform) =>
    (['plain', 'eas', 'natural'] as const).map((mode) => ({ platform, mode, failure: false }))
  ),
  { platform: 'ios' as const, mode: 'plain' as const, failure: true },
  { platform: 'android' as const, mode: 'eas' as const, failure: true },
  { platform: 'android' as const, mode: 'deadline' as const, failure: false },
])(
  'keeps the owner and late EAS start outside the selected tree (%j)',
  async ({ platform, mode, failure }, { expect }) => {
    const fixture = await setupDetachedFixtureAsync();
    const root = canonicalizeExistingPath(fixture.root);
    const release = (name: string) => fs.writeFileSync(path.join(root, name), '');
    const records = () =>
      readJsonLines<{ event: string; pid: number; body?: string }>(
        path.join(root, 'owned-stop.jsonl')
      );
    const env = {
      ...fixture.env,
      NODE_OPTIONS: `${fixture.env.NODE_OPTIONS} --require ${JSON.stringify(path.resolve(__dirname, '../fixtures/owned-stop.cjs'))}`,
      OWNED_STOP_ROOT: root,
      OWNED_STOP_FAILURE: failure ? '1' : '0',
      STUB_EXPO_DELAY_MS: mode === 'natural' ? '3000' : '90000',
      STUB_SIM_START_ID: 'late-owned',
    };
    const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
      executeAgentCliAsync(root, [...args, '--json'], { env: { ...env, ...extra }, reject: false });
    const stops = () => stubEasArgs(root).filter(([verb]) => verb === 'simulator:stop');
    let stopping: ReturnType<typeof run> | undefined;
    try {
      const started = await run([
        'dev',
        `--${platform}`,
        '--eas',
        '--detach',
        '--port',
        String(fixture.port),
      ]);
      expect(started.exitCode, started.all).toBe(0);
      expect(
        await waitForAsync(
          () =>
            ['expo', 'leaf', 'eas-start'].every((event) =>
              records().some((record) => record.event === event)
            ),
          15000
        )
      ).toBe(true);
      const owner = (await readDetachedAttemptAsync(root))!.ref!;
      const expo = records().find(({ event }) => event === 'expo')!.pid;
      const leaf = records().find(({ event }) => event === 'leaf')!.pid;
      const eas = records().find(({ event }) => event === 'eas-start')!.pid;
      expect([owner.pid, expo, leaf, eas].every(isProcessRunning)).toBe(true);
      expect(fs.existsSync(cloudBindingFile(expoHomeOf(root), root, platform))).toBe(false);
      const otherPlatform = platform === 'ios' ? 'android' : 'ios';
      await writeCloudBindingAsync(expoHomeOf(root), root, {
        id: 'captured-owned',
        platform: otherPlatform,
      });
      const otherRoot = path.join(root, 'another-worktree');
      fs.mkdirSync(otherRoot);
      await writeCloudBindingAsync(expoHomeOf(root), otherRoot, { id: 'unrelated', platform });
      if (mode === 'natural') {
        expect(
          await waitForAsync(
            async () => (await readDevLockAsync(root))?.phase === 'finishing',
            10000
          )
        ).toBe(true);
      }
      if (platform === 'ios' && mode === 'plain' && !failure) {
        for (const flags of [
          ['--signal', 'SIGKILL'],
          ['--signal', 'SIGINT'],
          ['--port', String(fixture.port + 1)],
        ]) {
          expect((await run(['dev:stop', ...flags])).exitCode).toBe(20);
          expect([owner.pid, expo, leaf, eas].every(isProcessRunning)).toBe(true);
        }
        const legacy = await fetch(`http://127.0.0.1:${owner.control.port}/cancel`, {
          method: 'POST',
          headers: {
            Authorization: owner.control.token,
            'x-detached-attempt': owner.id,
            'x-detached-cancel': 'true',
          },
        });
        expect(legacy.status).toBe(409);
        expect(legacy.headers.get('x-detached-grant')).toBeNull();
      }
      const plain = mode === 'plain' || mode === 'natural';
      const incomplete = failure || mode === 'deadline';
      stopping = run(['dev:stop', ...(plain ? [] : ['--eas']), '--timeout', '1s'], {
        STUB_SIM_STOP_RELEASE_FILE: path.join(root, 'release-cleanup'),
        ...(mode === 'deadline' ? { AGENT_CLI_EAS_SESSION_WAIT_MS: '200' } : {}),
      });
      expect(
        await waitForAsync(() => records().some(({ event }) => event === 'grant'), 10000)
      ).toBe(true);
      expect(await waitForAsync(() => !isProcessRunning(expo), 5000)).toBe(true);
      expect(
        await waitForAsync(() => isProcessRunning(leaf) === (failure || mode === 'natural'), 5000)
      ).toBe(true);
      expect(isProcessRunning(owner.pid)).toBe(true);
      expect(isProcessRunning(eas)).toBe(true);
      expect(stops()).toEqual([]);
      if (failure) {
        expect((await readDevLockAsync(root))?.phase).not.toBe('finishing');
        const result = await stopping;
        expect(result.exitCode, result.all).toBe(plain ? 20 : 22);
        expect(JSON.parse(result.stdout)).toMatchObject({ stopped: false, signal: null });
      } else if (mode === 'deadline') {
        const result = await stopping;
        expect(result.exitCode, result.all).toBe(22);
        expect(JSON.parse(result.stdout)).toMatchObject({
          stopped: true,
          signal: null,
          processStillRunning: true,
          session: { stopped: false },
        });
      } else if (plain) {
        const result = await stopping;
        expect(result.exitCode, result.all).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          stopped: true,
          signal: null,
          processStillRunning: true,
          easPlatform: platform,
        });
        expect((await readDevLockAsync(root))?.phase).toBe('finishing');
        if (mode === 'natural')
          stopping = run(['dev:stop', '--eas', '--timeout', '500ms'], {
            STUB_SIM_STOP_RELEASE_FILE: path.join(root, 'release-cleanup'),
          });
      }
      if (!incomplete && mode !== 'plain') {
        expect(
          await waitForAsync(
            () =>
              records().filter(({ event }) => event === 'grant').length ===
              (mode === 'natural' ? 2 : 1),
            5000
          )
        ).toBe(true);
        const concurrent = await run(['dev:stop']);
        expect(concurrent.exitCode, concurrent.all).toBe(20);
      }
      if (failure) {
        process.env[DETACHED_ATTEMPT_ENV] = randomUUID();
        await expect(
          withDetachedOwnerAsync(
            root,
            resolveDevOptions([`--${platform}`, '--detach']),
            async () => {
              throw new Error('A successor acquired an uncertain owner claim.');
            }
          )
        ).rejects.toMatchObject({ code: 'DEV_DETACHED_START_RUNNING' });
      } else {
        const successor = await run([
          'dev',
          `--${platform}`,
          '--eas',
          '--detach',
          '--port',
          String(fixture.port + 1),
        ]);
        expect(successor.exitCode, successor.all).toBe(20);
      }
      expect(isProcessRunning(eas)).toBe(true);
      expect(fs.existsSync(owner.directory)).toBe(true);
      release('release-session');
      expect(await waitForAsync(() => !isProcessAlive(owner.pid), 10000)).toBe(true);
      expect(await readDevLockAsync(root)).toBeNull();
      if (incomplete || mode === 'plain') {
        expect(stops()).toEqual([]);
        expect(fs.existsSync(owner.directory)).toBe(incomplete);
        expect(
          JSON.parse(fs.readFileSync(cloudBindingFile(expoHomeOf(root), root, platform), 'utf8'))
            .device.id
        ).toBe('late-owned');
        if (incomplete) {
          expect(records().filter(({ event, body }) => event === 'receipt' && body)).toEqual([]);
          expect((await run(['dev', `--${platform}`, '--eas', '--detach'])).exitCode).toBe(20);
        }
      } else {
        expect(await waitForAsync(() => stops().length > 0, 10000)).toBe(true);
        expect(fs.existsSync(owner.directory)).toBe(true);
        const receipt = records().find(({ event }) => event === 'receipt')!;
        expect(JSON.parse(receipt.body!)).toMatchObject({
          id: owner.id,
          drained: true,
          sessions: [{ id: 'late-owned', platform }],
        });
        expect((await run(['dev', `--${platform}`, '--eas', '--detach'])).exitCode).toBe(20);
        await writeCloudBindingAsync(expoHomeOf(root), root, {
          id: 'replacement',
          platform: otherPlatform,
        });
        release('release-cleanup');
        const result = await stopping;
        expect(result.exitCode, result.all).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          stopped: true,
          signal: null,
          processStillRunning: false,
        });
        expect(stops()).toHaveLength(2);
        expect(stops()).toEqual(
          expect.arrayContaining([
            buildSessionStopArgs('captured-owned'),
            buildSessionStopArgs('late-owned'),
          ])
        );
        expect(fs.existsSync(owner.directory)).toBe(false);
        expect(fs.existsSync(cloudBindingFile(expoHomeOf(root), root, platform))).toBe(false);
        expect(
          JSON.parse(
            fs.readFileSync(cloudBindingFile(expoHomeOf(root), root, otherPlatform), 'utf8')
          ).device.id
        ).toBe('replacement');
      }
      expect(fs.existsSync(cloudBindingFile(expoHomeOf(root), otherRoot, platform))).toBe(true);
    } finally {
      release('release-session');
      release('release-cleanup');
      await stopping;
      for (const { pid } of records())
        if (isProcessRunning(pid)) await signalProcessAsync(pid, 'SIGKILL');
      expect(
        await waitForAsync(() => records().every(({ pid }) => !isProcessRunning(pid)), 5000)
      ).toBe(true);
      await fixture.cleanup();
    }
  }
);

it.each([
  'handoff',
  'between',
  'queued',
  'active',
  'port-move',
  'helper-failure',
  'disconnect',
  'crash',
] as const)(
  'latches owned stop at the %s boundary without cancelling finishing helpers',
  async (schedule) => {
    const fixture = await setupDetachedFixtureAsync();
    const root = canonicalizeExistingPath(fixture.root);
    const records = () =>
      readJsonLines<{ event: string; pid: number; body?: string }>(path.join(root, 'tree.jsonl'));
    const release = (name: string) => fs.writeFileSync(path.join(root, name), '');
    const runner = path.join(root, 'queued-runner.cjs');
    fs.writeFileSync(
      runner,
      `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'tree.jsonl'))}, JSON.stringify({event:'unexpected-spawn',pid:process.pid})+'\\n');`
    );
    await installStubBinAsync(root, 'npx', runner);
    const child = spawn(
      process.execPath,
      [
        path.resolve(__dirname, '../fixtures/startup-tree.cjs'),
        'owner',
        root,
        `locked-${schedule}`,
        'subprocess',
      ],
      {
        env: { ...process.env, ...fixture.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      }
    );
    const output = collectOutput(child);
    const exited = waitForExitAsync(child, output);
    let control: Awaited<ReturnType<typeof requestOwnedStopAsync>> | undefined;
    try {
      const ready =
        schedule === 'helper-failure'
          ? 'late'
          : ['active', 'port-move', 'disconnect', 'crash'].includes(schedule)
            ? 'leaf'
            : 'boundary';
      expect(
        await waitForAsync(() => records().some(({ event }) => event === ready), 15000),
        output.all
      ).toBe(true);
      const owner = (await readDetachedAttemptAsync(root))!.ref!;
      if (schedule === 'disconnect' || schedule === 'crash') {
        await writeCloudBindingAsync(expoHomeOf(root), root, { id: 'captured', platform: 'ios' });
        const stopper = spawnAgentCli(root, ['dev:stop', '--eas', '--json', '--timeout', '2s'], {
          env: fixture.env,
        });
        const stopped = waitForExitAsync(stopper, collectOutput(stopper));
        try {
          expect(
            await waitForAsync(() => records().some(({ event }) => event === 'accepted'), 5000)
          ).toBe(true);
          expect(
            await waitForAsync(
              () =>
                records()
                  .filter(({ event }) => event === 'tool' || event === 'leaf')
                  .every(({ pid }) => !isProcessRunning(pid)),
              5000
            )
          ).toBe(true);
          if (schedule === 'disconnect') await killAsync(stopper, 'SIGKILL');
          else await killAsync(child, 'SIGKILL');
          release('release-tree-task');
          const result = await stopped;
          if (schedule === 'crash') {
            expect(result.exitCode, result.all).toBe(22);
            expect(JSON.parse(result.stdout)).toMatchObject({
              stopped: false,
              signal: null,
              processStillRunning: false,
            });
          }
          await exited;
          expect(fs.existsSync(owner.directory)).toBe(true);
          expect(fs.existsSync(cloudBindingFile(expoHomeOf(root), root, 'ios'))).toBe(true);
          expect(stubEasArgs(root).filter(([verb]) => verb === 'simulator:stop')).toEqual([]);
          expect(
            (
              await executeAgentCliAsync(root, ['dev', '--ios', '--eas', '--detach', '--json'], {
                env: fixture.env,
                reject: false,
              })
            ).exitCode
          ).toBe(20);
        } finally {
          await killAsync(stopper, 'SIGKILL');
        }
        return;
      }

      const options = resolveDevStopOptions([
        '--port',
        String(fixture.port),
        '--timeout',
        '10s',
        ...(schedule === 'active' ? ['--force'] : schedule === 'between' ? ['--release'] : []),
      ]);
      const failure = schedule === 'helper-failure';
      if (schedule === 'port-move') {
        await expect(requestOwnedStopAsync(owner, options)).rejects.toMatchObject({
          code: 'DEV_DETACHED_STOP_UNCERTAIN',
        });
        expect(records().some(({ event }) => event === 'port-moved')).toBe(true);
        expect(records().some(({ event }) => event === 'accepted')).toBe(false);
        expect(
          records()
            .filter(({ event }) => event === 'tool' || event === 'leaf')
            .every(({ pid }) => isProcessRunning(pid))
        ).toBe(true);
        options.port = null;
      }
      control = await requestOwnedStopAsync(owner, options);
      expect(control.action).toBe('stop-run');
      let completed = false;
      void control.completion.then(() => {
        completed = true;
      });
      if (schedule === 'queued')
        expect(
          await waitForAsync(() => records().some(({ event }) => event === 'queue-ended'), 5000)
        ).toBe(true);
      if (['active', 'port-move', 'disconnect', 'crash'].includes(schedule)) {
        expect(
          await waitForAsync(
            () =>
              records()
                .filter(({ event }) => event === 'tool' || event === 'leaf')
                .every(({ pid }) => !isProcessRunning(pid)),
            5000
          )
        ).toBe(true);
      }
      if (failure) {
        const late = records().find(({ event }) => event === 'late')!.pid;
        expect(isProcessRunning(late)).toBe(true);
        expect(records().some(({ event }) => event === 'direct-close')).toBe(true);
        expect(isProcessRunning(records().find(({ event }) => event === 'leaf')!.pid)).toBe(true);
      }
      expect(isProcessRunning(owner.pid)).toBe(true);
      expect(completed).toBe(false);
      release('release-boundary');
      release('release-late');
      release('release-tree-task');
      expect(await control.completion).toEqual(failure ? null : []);
      await exited;
      expect(isProcessAlive(owner.pid)).toBe(false);
      expect(await readDevLockAsync(root)).toBeNull();
      expect(fs.existsSync(owner.directory)).toBe(failure);
      if (['handoff', 'between', 'queued'].includes(schedule))
        expect(
          records().filter(({ event }) => ['tool', 'leaf', 'unexpected-spawn'].includes(event))
        ).toEqual([]);
      if (failure) expect(records().filter(({ event }) => event === 'late-exit')).toHaveLength(1);
    } finally {
      release('release-boundary');
      release('release-late');
      release('release-tree-task');
      control?.dispose();
      await killAsync(child, 'SIGKILL');
      for (const { pid } of records())
        if (isProcessRunning(pid)) await signalProcessAsync(pid, 'SIGKILL');
      expect(
        await waitForAsync(() => records().every(({ pid }) => !isProcessRunning(pid)), 5000)
      ).toBe(true);
      await fixture.cleanup();
    }
  }
);
