import type { DevServerLockInfo } from '../types';

/** A dev-server lock as a run writes it; a test names only the fields it is about. */
export function lockInfo(overrides: Partial<DevServerLockInfo> = {}): DevServerLockInfo {
  return {
    url: 'http://127.0.0.1:8081',
    port: 8081,
    pid: 4242,
    startedAt: '2026-08-23T00:00:00.000Z',
    projectRoot: '/project',
    easPlatform: null,
    easOpenFinished: false,
    phase: 'serving',
    ...overrides,
  };
}
