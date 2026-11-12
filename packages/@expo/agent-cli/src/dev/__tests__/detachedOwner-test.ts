import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  readDetachedAttemptAsync,
  retireDetachedAttempt,
  withDetachedOwnerAsync,
  DETACHED_ATTEMPT_ENV,
} from '../detachedOwner';
import { resolveDevOptions } from '../resolveOptions';
import { trackStartupTask } from '../../utils/startupTasks';
import { devLogsAsync } from '../logsAsync';
import { resolveDevLogsOptions } from '../resolveLogsOptions';
import * as Log from '../../log';

vi.mock('../../log');

vi.unmock('fs');
vi.unmock('node:fs');
const os = await vi.importActual<typeof import('os')>('os');
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-owner-'));
  fs.mkdirSync(path.join(root, '.expo/dev/logs'), { recursive: true });
});
afterEach(() => {
  delete process.env[DETACHED_ATTEMPT_ENV];
  fs.rmSync(root, { recursive: true, force: true });
});
const options = resolveDevOptions(['--ios', '--detach']);
const start = (run: () => Promise<void>) => {
  process.env[DETACHED_ATTEMPT_ENV] = randomUUID();
  return withDetachedOwnerAsync(root, options, run);
};

function signal() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it('keeps a failed startup owned until its background work settles, then retires once', async () => {
  const entered = signal(),
    work = signal();
  const failure = new Error('startup failed');
  const finished = start(async () => {
    trackStartupTask(work.promise);
    entered.resolve();
    throw failure;
  }).catch((error) => error);
  try {
    await entered.promise;
    const owner = (await readDetachedAttemptAsync(root))!.ref!;
    expect(owner).toMatchObject({ pid: process.pid });
    fs.writeFileSync(owner.logFile, 'owned log\n');
    const otherLog = path.join(path.dirname(owner.logFile), `dev-detached-${randomUUID()}.log`);
    fs.writeFileSync(otherLog, 'other generation\n');
    fs.writeFileSync(path.join(path.dirname(otherLog), 'current'), path.basename(otherLog));
    await devLogsAsync(root, resolveDevLogsOptions(['--json']));
    expect(JSON.parse(vi.mocked(Log.log).mock.calls.at(-1)![0] as string)).toMatchObject({
      logFile: owner.logFile,
      lines: ['owned log'],
    });
    await expect(
      start(async () => {
        throw new Error('must not run');
      })
    ).rejects.toMatchObject({ exitCode: 22 });
    const claim = path.dirname(owner.directory);
    const rootRemovalBlocker = path.join(claim, 'root-removal-blocker');
    fs.writeFileSync(rootRemovalBlocker, '');
    work.reject(new Error('background failed'));
    expect(await finished).toBe(failure);
    expect(fs.existsSync(owner.directory)).toBe(false);
    expect((await readDetachedAttemptAsync(root))?.observation.phase).toBe('uncertain');
    fs.unlinkSync(rootRemovalBlocker);
    expect(retireDetachedAttempt(owner)).toBe(false);
    expect(fs.existsSync(claim)).toBe(true);
    fs.renameSync(claim, `${claim}.quiesced`);
    const replacementEntered = signal(),
      release = signal();
    const replacement = start(async () => {
      replacementEntered.resolve();
      await release.promise;
    });
    try {
      await replacementEntered.promise;
      const successor = (await readDetachedAttemptAsync(root))!.ref!;
      expect(successor.id).not.toBe(owner.id);
      expect(retireDetachedAttempt(owner)).toBe(false);
      expect((await readDetachedAttemptAsync(root))?.ref?.id).toBe(successor.id);
    } finally {
      release.resolve();
      await replacement;
    }
    expect(await readDetachedAttemptAsync(root)).toBeNull();
  } finally {
    work.resolve();
    await finished;
  }
});
