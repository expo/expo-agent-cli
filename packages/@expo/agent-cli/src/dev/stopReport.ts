import type { DevStopResultJson } from './stopTypes';

/** A report of the unlocked path before anything was looked at: nothing ran, nothing was sent. */
export function emptyStopReport(port: number | null, startedAt: number): DevStopResultJson {
  return {
    admission: null,
    discardedRun: null,
    recoveryCommand: null,
    stopped: false,
    pid: null,
    port,
    url: null,
    lockHeld: false,
    signal: null,
    forced: false,
    forceRefusedBy: null,
    processStillRunning: null,
    easPlatform: null,
    portStillAnswering: null,
    reason: 'not-running',
    detail: 'no dev-server lock answered for this project, and nothing was listening for it',
    untracked: false,
    waitedMs: Date.now() - startedAt,
    followups: [],
  };
}
