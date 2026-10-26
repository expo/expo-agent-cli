// @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
import fs from 'fs';
import path from 'path';
import { vol } from 'memfs';

import { writeCloudBinding } from '../../deviceBinding/__tests__/fakeCloudBinding';
import { lockInfo } from '../../devLock/__tests__/fakeLock';
import { detachedPidLine } from '../childVerdict';
import { childStartsSessionSync } from '../detachEasProgress';
import { detachedLogPath } from '../logFile';
import { EAS_SESSION_START_TIMEOUT_MS, EAS_TUNNEL_WAIT_MS } from '../easSession';
import { isProcessAlive } from '../processLiveness';

vi.mock('../processLiveness', () => ({ isProcessAlive: vi.fn() }));

const projectRoot = '/project';
const MINUTE = 60_000;
const START_WINDOW_MS = EAS_TUNNEL_WAIT_MS + EAS_SESSION_START_TIMEOUT_MS;

type Row = {
  lock?: Parameters<typeof lockInfo>[0];
  lockAgeMs?: number;
  logPid?: number | null;
  alive?: boolean;
  binding?: { boundAgoMs: number; expiresInMs: number };
};

describe(childStartsSessionSync, () => {
  beforeEach(() => vol.reset());

  it.each<[string, Row, boolean]>([
    ['a live child that is starting its session', {}, true],
    ['a lock for the other platform', { lock: { easPlatform: 'android' } }, false],
    ['a lock that names no EAS platform', { lock: { easPlatform: null } }, false],
    ['a child whose EAS open finished', { lock: { easOpenFinished: true } }, false],
    ['a lock past the start window', { lockAgeMs: START_WINDOW_MS }, false],
    ['a log whose line 1 names another pid', { logPid: 4343 }, false],
    ['no detached log', { logPid: null }, false],
    ['a child that is gone', { alive: false }, false],
    ['a live binding', { binding: { boundAgoMs: 0, expiresInMs: 60 * MINUTE } }, false],
    [
      'an expired binding from before the lock',
      { binding: { boundAgoMs: 2 * 60 * MINUTE, expiresInMs: -MINUTE } },
      true,
    ],
    [
      'an expired binding made since the lock',
      { binding: { boundAgoMs: 0, expiresInMs: -1 } },
      false,
    ],
  ])('%s → %s', (_name, row, expected) => {
    const now = Date.now();
    const lock = lockInfo({
      easPlatform: 'ios',
      startedAt: new Date(now - (row.lockAgeMs ?? MINUTE)).toISOString(),
      ...row.lock,
    });
    const logPid = row.logPid === undefined ? lock.pid : row.logPid;
    if (logPid != null) {
      fs.mkdirSync(path.dirname(detachedLogPath(projectRoot)), { recursive: true });
      fs.writeFileSync(detachedLogPath(projectRoot), `${detachedPidLine(logPid)}\nplan\n`);
    }
    vi.mocked(isProcessAlive).mockReturnValue(row.alive ?? true);
    if (row.binding) {
      writeCloudBinding(projectRoot, 'ios', 'sess', {
        boundAt: new Date(now - row.binding.boundAgoMs).toISOString(),
        expiresAt: new Date(now + row.binding.expiresInMs).toISOString(),
      });
    }

    expect(childStartsSessionSync(projectRoot, lock, 'ios')).toBe(expected);
  });
});
