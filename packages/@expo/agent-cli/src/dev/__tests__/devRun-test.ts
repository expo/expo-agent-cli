import { randomUUID } from 'node:crypto';

import { makeTempProject, cleanupTempProjects } from '../../devLock/__tests__/tempProject';
import { cancelDetachedRunAsync, observeDetachedRunAsync } from '../detachedOwnership';
import { withDevRunAsync } from '../devRun';
import type { MetroReady } from '../devRunTypes';
import { resolveDevOptions } from '../resolveOptions';
import { startupRequestFrom } from '../startupRequest';

vi.unmock('fs');
vi.unmock('node:fs');
afterAll(cleanupTempProjects);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const request = startupRequestFrom(resolveDevOptions(['--ios', '--local', '--no-open']));
const detached = () => ({ id: randomUUID(), logFile: '/tmp/owned-run.log' });

it('cancels an admitted run before any serving work and reports completed release', async () => {
  const root = makeTempProject();
  const started = deferred<void>();
  const work = withDevRunAsync(root, { request, detached: detached() }, async (run) => {
    started.resolve();
    await new Promise<void>((resolve) =>
      run.signal.addEventListener('abort', () => resolve(), { once: true })
    );
    run.signal.throwIfAborted();
  }).catch((error: Error) => error);
  await started.promise;
  const observation = await observeDetachedRunAsync(root);
  expect(observation).toMatchObject({
    kind: 'live',
    progress: { kind: 'starting' },
    attempt: { request },
  });
  if (observation.kind !== 'live') throw new Error('Expected live owner');
  const outcome = await cancelDetachedRunAsync(observation.attempt, {
    signal: 'SIGTERM',
    deadline: Date.now() + 3000,
  });
  expect(outcome).toMatchObject({ kind: 'finished', admission: 'released' });
  expect(await work).toMatchObject({ code: 'DEV_INTERRUPTED' });
  expect(await observeDetachedRunAsync(root)).toEqual({ kind: 'none' });
});

it('holds admission after Metro ends until its local open settles', async () => {
  const root = makeTempProject();
  const server = deferred<number>();
  const opening = deferred<void>();
  const ready = deferred<(server: MetroReady) => void>();
  const opened = deferred<void>();
  const work = withDevRunAsync(root, { request, detached: detached() }, (run) =>
    run.serveAsync(
      (callback) => {
        ready.resolve(callback);
        return server.promise;
      },
      {
        kind: 'local',
        async runAsync() {
          opened.resolve();
          await opening.promise;
          return { kind: 'settled' };
        },
      }
    )
  );
  (await ready.promise)({ url: 'http://localhost:8081', port: 8081 });
  await opened.promise;
  expect(await observeDetachedRunAsync(root)).toMatchObject({ progress: { kind: 'starting' } });
  server.resolve(0);
  expect(await observeDetachedRunAsync(root)).toMatchObject({ progress: { kind: 'stopping' } });
  opening.resolve();
  expect(await work).toMatchObject({ result: 0, mayRetry: false });
  expect(await observeDetachedRunAsync(root)).toEqual({ kind: 'none' });
});

it('requires current readiness with no open and ignores callbacks from an exited attempt', async () => {
  const root = makeTempProject();
  await withDevRunAsync(root, { request, detached: detached() }, async (run) => {
    let old!: (server: MetroReady) => void;
    await run.serveAsync(async (ready) => {
      old = ready;
      return 1;
    }, null);
    const server = deferred<number>();
    let current!: (server: MetroReady) => void;
    const serving = run.serveAsync((ready) => {
      current = ready;
      return server.promise;
    }, null);
    old({ url: 'http://localhost:8080', port: 8080 });
    expect(run.progress.kind).toBe('starting');
    current({ url: 'http://localhost:8081', port: 8081 });
    expect(await observeDetachedRunAsync(root)).toMatchObject({
      progress: { kind: 'running', server: { port: 8081 } },
    });
    run.cancel({ signal: 'SIGTERM' });
    current({ url: 'http://localhost:8082', port: 8082 });
    expect(run.progress).toMatchObject({ kind: 'stopping', metro: { server: { port: 8081 } } });
    server.resolve(0);
    await serving;
  });
});
