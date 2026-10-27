// @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment.
import type { ChildProcess } from 'child_process';

import { resolveDevStopOptions } from '../dev/resolveStopOptions';
import { devStopAsync, type DevStopResultJson } from '../dev/stopAsync';
import type { NativePlatform } from '../plan/types';
import { whatAndHow } from './format';
import type { SmokeReleaseResult } from './phases';

/** Stop only this smoke run's child; a skipped ownership check grants no device cleanup authority. */
export async function stopOwnedDevServerAsync(
  projectRoot: string,
  platform: NativePlatform,
  release: boolean,
  child: ChildProcess | null
): Promise<SmokeReleaseResult> {
  const captured: { report: DevStopResultJson | null } = { report: null };
  await devStopAsync(
    projectRoot,
    {
      ...resolveDevStopOptions(['--no-followups']),
      release,
      platform,
    },
    {
      print: false,
      ownedChild: child,
      onReport: (stopped) => {
        captured.report = stopped;
      },
    }
  );
  const stopped = captured.report;
  const serverStopped = stopped
    ? stopped.stopped || stopped.reason === 'not-running'
    : !release && (!child || child.exitCode !== null || child.signalCode !== null);
  return {
    ok: serverStopped,
    target: stopped?.url ?? (stopped?.port == null ? null : `port ${stopped.port}`),
    reason: serverStopped
      ? null
      : (stopped?.detail ??
        (release
          ? 'this run no longer owns a server lock; device cleanup was skipped to protect other runs'
          : 'the started child is still running without its server lock; cleanup left it untouched')),
    // A refused release leaves each kept row without a reason; dev:stop's refusal is that reason.
    devices: release
      ? stopped?.devices?.map((device) =>
          device.released || device.reason != null || stopped.deviceError == null
            ? device
            : { ...device, reason: whatAndHow(stopped.deviceError) }
        )
      : undefined,
  };
}
