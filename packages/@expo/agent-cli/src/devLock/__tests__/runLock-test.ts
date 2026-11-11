// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — the writer, against a real
// lock address and a real event log.

import fs from 'fs';
import path from 'path';
import { flushEventLogger, installEventLogger } from '2g';

import { readDevServerLockAsync } from '../client';
import { RunLock, withRunLockAsync } from '../runLock';
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
