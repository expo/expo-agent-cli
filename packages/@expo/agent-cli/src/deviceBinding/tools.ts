// @ref llp/0030-one-device-per-worktree.rfc.md §Records
// The platform tools the registry drives, as subprocesses. Injected in tests.

import { spawnCaptureAsync } from '../utils/spawnCapture';
import type { DeviceTools } from './types';

export function defaultTools(): DeviceTools {
  return {
    simctl: (args, options) => spawnCaptureAsync('xcrun', ['simctl', ...args], options),
    now: () => new Date(),
    isPidAlive,
  };
}

/** `EPERM` is a process this user may not signal, which is a process that is there. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}
