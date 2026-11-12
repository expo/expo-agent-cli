import type { ReleasedDevice } from '../deviceBinding';
import { discardRunCommand } from './detachedOwnership';
import type { OwnerEvidence } from './stopTarget';
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

export function retainedOwnerEvidence(
  observation: OwnerEvidence,
  devices: ReleasedDevice[],
  port: number | null
): Pick<DevStopResultJson, 'admission' | 'detail' | 'recoveryCommand'> {
  const attempt = observation.attempt;
  return {
    admission: 'retained',
    recoveryCommand:
      observation.kind === 'interrupted' ? discardRunCommand(observation.attempt.id) : null,
    detail: [
      `Detached run ${attempt?.id ?? 'unknown'}; admission was retained.`,
      attempt?.pid ? `Diagnostic pid ${attempt.pid}.` : '',
      attempt?.logFile ? `Log: ${attempt.logFile}.` : '',
      port != null ? `Port ${port}.` : '',
      ...devices
        .filter((device) => device.backend === 'cloud')
        .map((device) => `Session ${device.id} was retained.`),
      observation.kind === 'uncertain' ? observation.detail : '',
      observation.kind === 'interrupted'
        ? 'The owner ended without releasing admission. Discarding the record stops no processes or sessions.'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  };
}
