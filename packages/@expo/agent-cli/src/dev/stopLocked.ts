// @ref llp/0005-runtime-loop-tools.rfc.md §Stopping the app
import { lockAddressFor, probeDevServerLockAsync, type DevServerLockInfo } from '../devLock';
import { clearDevRunRecord } from '../devLock/runRecord';
import { captureDetachedRun, discardRunCommand } from './detachedOwnership';
import { debugEvent } from './events';
import { isProcessAlive } from './processLiveness';
import { isPortFreeAsync, POLL_INTERVAL_MS, signalProcessAsync } from './processStop';
import type { DevStopOptions } from './resolveStopOptions';
import type { DevStopResultJson } from './stopTypes';

export async function stopLockedDevServerAsync(
  lock: DevServerLockInfo,
  options: DevStopOptions,
  startedAt: number
): Promise<{ report: DevStopResultJson; finishing: boolean }> {
  const base: DevStopResultJson = {
    admission: null,
    discardedRun: null,
    recoveryCommand: null,
    stopped: false,
    pid: lock.pid,
    port: lock.port,
    url: lock.url,
    lockHeld: true,
    signal: null,
    forced: false,
    forceRefusedBy: null,
    processStillRunning: false,
    portStillAnswering: false,
    easPlatform: lock.easPlatform,
    reason: null,
    detail: null,
    untracked: false,
    waitedMs: 0,
    followups: [],
  };

  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — the dev server is already
  // gone, and the pid waits for its session start to return the id it binds. Nothing is signalled:
  // SIGKILL would lose that id.
  if (lock.phase === 'finishing') {
    base.stopped = true;
    base.processStillRunning = isProcessAlive(lock.pid);
    base.portStillAnswering = !(await isPortFreeAsync(lock.port));
    base.waitedMs = Date.now() - startedAt;
    return { report: base, finishing: true };
  }

  // A signal that cannot be delivered is not a failure to stop: a lock answering for a pid that
  // is gone is the one case the socket cannot produce on its own, but a lock held by a *different*
  // user's process can, and `ESRCH` there means the thing is already not running.
  const capturedRun = captureDetachedRun(lock.projectRoot, lock.pid);
  const sent = await signalProcessAsync(lock.pid, options.signal);
  base.signal = sent.delivered ? options.signal : null;
  debugEvent('stop_signalled', { pid: lock.pid, signal: options.signal, ok: sent.delivered });

  const outcome = await waitForStopAsync(lock, options.timeoutMs);
  base.waitedMs = Date.now() - startedAt;
  base.processStillRunning = !outcome.processGone;
  base.portStillAnswering = !outcome.portFree;
  debugEvent('stop_outcome', outcome);

  // The two facts that are about the thing this command signalled. The port is not one of them.
  if (outcome.processGone && outcome.lockGone) {
    if (sent.delivered && capturedRun) {
      if (process.platform === 'win32') {
        capturedRun.release();
        base.admission = 'released';
      } else if (options.signal === 'SIGKILL') {
        base.admission = 'retained';
        base.detail = `Forced stop of pid ${lock.pid}; processes in other groups may still be running on port ${lock.port}. The ownership record was retained. Discard only that record with "${discardRunCommand(capturedRun.id)}".`;
        base.recoveryCommand = discardRunCommand(capturedRun.id);
      }
    }
    base.stopped = true;
    // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — a stop that ends the
    // holder without its cleanup (Windows `taskkill /F`) leaves its record; this stop ends it.
    clearDevRunRecord(lock.projectRoot, lock.pid);
    return { report: base, finishing: false };
  }
  // @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions — the run's lock says
  // `finishing`: its dev server is gone, and the pid waits for its session start.
  if (outcome.finishing) {
    base.stopped = true;
    return { report: base, finishing: true };
  }

  base.reason = 'still-running';
  base.detail = !outcome.processGone
    ? sent.delivered
      ? `${options.signal} was sent to ${lock.pid}, and that process was still running ${options.timeoutMs}ms later`
      : `${options.signal} could not be delivered to ${lock.pid} (${sent.error ?? 'no reason given'}), and that process is still running`
    : // The pid went and the lock did not. The socket is held by something, so the dev server this
      // project would be found at is not this command's to have stopped.
      `pid ${lock.pid} is gone, but this project's dev-server lock is still answering, so something else is holding it`;
  return { report: base, finishing: false };
}

/** What the three checks said the last time they were asked. */
interface StopOutcome {
  /** The pid the lock named no longer exists. The primary evidence that the signal worked. */
  processGone: boolean;
  /** The project's dev-server lock no longer answers, so nothing holds it. */
  lockGone: boolean;
  /** Nothing answered `/status` on the port. Secondary: the port is not the process. */
  portFree: boolean;
  /** The pid's lock answers `finishing`: its dev server is gone, and it binds its session. */
  finishing: boolean;
}

/**
 * Poll until the signalled process and the lock have both gone, the lock says `finishing`, or the
 * budget runs out.
 *
 * For an ordinary run the port never gates the answer. It used to: "stopped" meant the lock and
 * the port had both gone quiet, which reads as caution and is a wrong answer whenever anything else
 * is on the port — including this CLI's own IPv4-only check meeting a listener the dev server never
 * knew about (llp/0005 §Stopping the app). The pid is what the signal was sent to,
 * so the pid is what says whether it worked.
 *
 * The lock stays in the condition because it is about this project rather than about the port
 * number: while it answers, another command would still be pointed at a dev server here.
 *
 * A lock of the same pid that answers `finishing` ends the wait too: the run's dev server is gone,
 * and the pid binds the session its start returns.
 * @ref llp/0035-one-device-per-worktree.rfc.md §Preserved sessions
 */
async function waitForStopAsync(lock: DevServerLockInfo, timeoutMs: number): Promise<StopOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [probe, portFree] = await Promise.all([
      probeDevServerLockAsync(lockAddressFor(lock.projectRoot).address),
      isPortFreeAsync(lock.port),
    ]);
    const lockGone = !probe.connected;
    const current = probe.info;
    const processGone = !isProcessAlive(lock.pid);
    const atDeadline = Date.now() + POLL_INTERVAL_MS >= deadline;
    const finishing = current?.pid === lock.pid && current.phase === 'finishing';
    const outcome = { processGone, lockGone, portFree, finishing };
    if ((processGone && lockGone) || finishing || atDeadline) {
      return outcome;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
