// @ref llp/0030-one-device-per-agent.rfc.md §The registry
// Liveness against a real dev-server lock, because the socket is the primary check.

import { acquireDevServerLockAsync } from '../../devLock';
import { cleanupTempProjects, makeTempProject } from '../../devLock/__tests__/tempProject';
import { CLAIM_GRACE_MS, classifyClaimAsync } from '../liveness';
import type { DeviceClaim } from '../types';

// The suite-wide `fs` mock is memfs, which the kernel cannot bind a socket inside.
vi.unmock('fs');
vi.unmock('node:fs');

const NOW = new Date('2026-09-30T12:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - CLAIM_GRACE_MS - 1000).toISOString();
const JUST_NOW = new Date(NOW.getTime() - 1000).toISOString();

function claim(projectRoot: string, touchedAt: string): DeviceClaim {
  return {
    backend: 'local-ios',
    platform: 'ios',
    id: 'UDID-1',
    projectRoot,
    pid: 1,
    claimedAt: LONG_AGO,
    touchedAt,
    created: false,
    booted: false,
  };
}

const held: { release(): void }[] = [];

async function holdLockAsync(projectRoot: string): Promise<{ release(): void }> {
  const result = await acquireDevServerLockAsync({
    url: 'http://127.0.0.1:8097',
    port: 8097,
    pid: process.pid,
    startedAt: NOW.toISOString(),
    projectRoot,
  });
  if (result.status !== 'acquired') {
    throw new Error(`expected the lock to be acquired, got ${result.status}`);
  }
  held.push(result.lock);
  return result.lock;
}

afterEach(() => {
  for (const lock of held.splice(0)) {
    lock.release();
  }
  cleanupTempProjects();
});

describe('classifyClaimAsync', () => {
  it(`is live while the dev server of the worktree answers, however old the touch`, async () => {
    const projectRoot = makeTempProject();
    await holdLockAsync(projectRoot);

    expect(await classifyClaimAsync(claim(projectRoot, LONG_AGO), { now: NOW })).toBe('live');
  });

  it(`is live within the grace period with no dev server, for navigate and screenshots`, async () => {
    const projectRoot = makeTempProject();

    expect(await classifyClaimAsync(claim(projectRoot, JUST_NOW), { now: NOW })).toBe('live');
  });

  it(`is stale with no dev server and no recent touch`, async () => {
    const projectRoot = makeTempProject();

    expect(await classifyClaimAsync(claim(projectRoot, LONG_AGO), { now: NOW })).toBe('stale');
  });

  it(`is stale once the dev server is gone`, async () => {
    const projectRoot = makeTempProject();
    const lock = await holdLockAsync(projectRoot);
    lock.release();

    expect(await classifyClaimAsync(claim(projectRoot, LONG_AGO), { now: NOW })).toBe('stale');
  });

  it(`is stale for a worktree that no longer exists`, async () => {
    expect(await classifyClaimAsync(claim('/no/such/worktree', LONG_AGO), { now: NOW })).toBe(
      'stale'
    );
  });

  it(`does not probe the socket for a claim inside the grace period`, async () => {
    const probeLock = vi.fn(async () => null);

    expect(await classifyClaimAsync(claim('/work/here', JUST_NOW), { now: NOW, probeLock })).toBe(
      'live'
    );
    expect(probeLock).not.toHaveBeenCalled();
  });
});
