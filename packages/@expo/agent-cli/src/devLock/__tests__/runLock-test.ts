// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — the writer, against a real
// lock address and a real event log.

import fs from 'fs';
import { EventEmitter } from 'events';
import { spawnSync, type ChildProcess } from 'child_process';
import { killProcessTree } from '../../utils/processGroup';
import path from 'path';
import { flushEventLogger, installEventLogger } from '2g';

import { readDevServerLockAsync } from '../client';
import { RunLock, withRunLockAsync } from '../runLock';
import * as lockServer from '../server';
import {
  createStartupScope,
  withStartupTasksAsync,
  canOpenStartup,
  trackStartupChild,
} from '../../utils/startupTasks';
import { cleanupTempProjects, makeTempProject } from './tempProject';

// The suite-wide `fs` mock is memfs, which the kernel cannot bind a socket inside.
vi.unmock('fs');
vi.unmock('node:fs');

const eventLog = path.join(makeTempProject(), 'events.jsonl');
installEventLogger(eventLog);

afterAll(() => cleanupTempProjects());

const published = {
  type: 'published',
  port: 8321,
  source: 'arg',
  since: Date.now(),
  easPlatform: 'ios',
} as const;

async function loggedEventsAsync(): Promise<{ _e: string }[]> {
  await flushEventLogger();
  return fs
    .readFileSync(eventLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe(RunLock, () => {
  it(`changes nothing on an illegal publish and reports it on the debug stream`, async () => {
    const projectRoot = makeTempProject();
    await withRunLockAsync(projectRoot, async (lock) => {
      await lock.publishAsync({ ...published, phase: 'serving' });
      lock.apply({ type: 'eas-open-started' });
      lock.apply({ type: 'server-exited' });

      await lock.publishAsync({ ...published, phase: 'building', port: 8322 });

      expect(await readDevServerLockAsync(projectRoot)).toMatchObject({
        phase: 'finishing',
        port: 8321,
      });
    });
    expect(await loggedEventsAsync()).toContainEqual(
      expect.objectContaining({
        _e: 'cli:dev_lock_illegal_transition',
        phase: 'finishing',
        event: 'published',
      })
    );
  });
});

describe(withRunLockAsync, () => {
  it.each([
    ['returns', null],
    ['throws', new Error('the run failed')],
  ] as const)(`releases the run's lock when the run %s`, async (_name, failure) => {
    const projectRoot = makeTempProject();
    let answered: unknown = null;
    const settled = withRunLockAsync(projectRoot, async (lock) => {
      await lock.publishAsync({ ...published, phase: 'serving' });
      answered = await readDevServerLockAsync(projectRoot);
      if (failure) throw failure;
    });

    await (failure ? expect(settled).rejects.toBe(failure) : settled);
    expect(answered).toMatchObject({ port: 8321 });
    expect(await readDevServerLockAsync(projectRoot)).toBeNull();
  });
});

it.each(['cancel', 'tainted', 'handoff', 'released', 'in-use', 'failed'] as const)(
  'arbitrates the first answering lock against %s without losing foreground behavior',
  async (ordering) => {
    const projectRoot = makeTempProject();
    const scope = createStartupScope();
    const lock = new RunLock(projectRoot);
    const acquire = lockServer.acquireDevServerLockAsync;
    let resume!: () => void;
    let listening!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const answered = new Promise<void>((resolve) => (listening = resolve));
    const spy = vi
      .spyOn(lockServer, 'acquireDevServerLockAsync')
      .mockImplementation(async (info) => {
        const result =
          ordering === 'failed'
            ? {
                status: 'failed' as const,
                address: projectRoot,
                error: new Error('publication failed'),
              }
            : await acquire(info);
        listening();
        await gate;
        return result;
      });
    const holder =
      ordering === 'in-use'
        ? await acquire({
            ...published,
            phase: 'serving',
            url: 'http://127.0.0.1:8321',
            pid: process.pid,
            projectRoot,
            startedAt: new Date().toISOString(),
            portReported: false,
            easOpenFinished: false,
          })
        : null;
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const finished = withStartupTasksAsync(async () => {
      trackStartupChild(child);
      await lock.publishAsync({ ...published, phase: 'serving' });
      return canOpenStartup();
    }, scope).catch((error) => error);
    try {
      await answered;
      if (ordering === 'failed') expect(await readDevServerLockAsync(projectRoot)).toBeNull();
      else expect(await readDevServerLockAsync(projectRoot)).toMatchObject({ port: 8321 });
      if (ordering === 'tainted') {
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
          throw Object.assign(new Error(), { code: 'EPERM' });
        });
        vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
        killProcessTree(child);
        kill.mockRestore();
      }
      child.emit('close', 0);
      if (ordering === 'cancel') expect(scope.cancel()).toBe('accepted');
      if (ordering === 'released') lock.apply({ type: 'run-ended' });
      resume();
      const outcome = await finished;
      if (ordering === 'handoff') {
        expect(outcome).toBe(true);
        expect(scope.cancel()).toBe('locked');
      } else expect(outcome).toMatchObject({ code: 'DEV_INTERRUPTED' });
      lock.apply({ type: 'run-ended' });
      if (holder?.status === 'acquired') holder.lock.release();
      expect(await readDevServerLockAsync(projectRoot)).toBeNull();
    } finally {
      child.emit('close', 0);
      resume();
      await finished;
      spy.mockRestore();
      lock.apply({ type: 'run-ended' });
      if (holder?.status === 'acquired') holder.lock.release();
    }
  }
);
