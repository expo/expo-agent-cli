// @ref llp/0005-runtime-loop-tools.rfc.md §Stopping the app
// Signalling a process `dev:stop` has proved, and waiting for it to go. The pid is the evidence;
// the port only rides along. The locked stop polls with these helpers; `--force` signals and waits
// here.

import { spawnCaptureAsync } from '../utils/spawnCapture';
import { windowsTaskkillCommand } from '../utils/windowsShim';
import { isProcessAlive } from './processLiveness';
import type { DevStopOptions } from './resolveStopOptions';

/** How often to re-check whether a signalled dev server has gone. */
export const POLL_INTERVAL_MS = 150;

/** What {@link signalAndWaitAsync} decides about the process it signalled; `dev:stop` reports it as is. */
export interface SignalOutcome {
  /** The process is gone. */
  stopped: boolean;
  /** The signal sent, or null when it could not be delivered. */
  signal: NodeJS.Signals | null;
  reason: 'still-running' | null;
  detail: string | null;
  processStillRunning: boolean;
  portStillAnswering: boolean;
  waitedMs: number;
}

/**
 * Signal `pid` and wait for it to go. The pid is what says whether it worked; the port only rides
 * along (llp/0005 §Stopping the app).
 */
export async function signalAndWaitAsync(
  pid: number,
  port: number,
  options: Pick<DevStopOptions, 'signal' | 'timeoutMs'>,
  startedAt: number
): Promise<SignalOutcome> {
  const sent = await signalProcessAsync(pid, options.signal);
  const outcome = await waitForProcessGoneAsync(pid, port, options.timeoutMs);
  return {
    stopped: outcome.processGone,
    signal: sent.delivered ? options.signal : null,
    reason: outcome.processGone ? null : 'still-running',
    detail: outcome.processGone
      ? null
      : `${options.signal} was sent to ${pid}, and that process was still running ${options.timeoutMs}ms later`,
    processStillRunning: !outcome.processGone,
    portStillAnswering: !outcome.portFree,
    waitedMs: Date.now() - startedAt,
  };
}

/**
 * Send a signal to a pid, without letting a delivery failure become an exception.
 *
 * On Windows `process.kill` maps every signal onto an immediate terminate, and it reaches only the
 * process named — a dev server started through a batch shim has its bundler in a child that would
 * survive. `taskkill /T` covers the tree, so that is what is used there. It is best effort and
 * untested on that platform, which is why the result says whether the call was made rather than
 * whether it worked.
 */
export async function signalProcessAsync(
  pid: number,
  signal: NodeJS.Signals
): Promise<{ delivered: boolean; error?: string }> {
  if (process.platform === 'win32') {
    const result = await spawnCaptureAsync(
      windowsTaskkillCommand(),
      ['/PID', String(pid), '/T', '/F'],
      {
        timeoutMs: 5000,
      }
    );
    return result.spawnError
      ? { delivered: false, error: result.spawnError.message }
      : { delivered: result.exitCode === 0, error: result.stderr.trim() || undefined };
  }
  try {
    process.kill(pid, signal);
    return { delivered: true };
  } catch (error: unknown) {
    return { delivered: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Poll until a signalled pid with no lock has gone, or the budget runs out. */
async function waitForProcessGoneAsync(
  pid: number,
  port: number,
  timeoutMs: number
): Promise<{ processGone: boolean; portFree: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const processGone = !isProcessAlive(pid);
    if (processGone) {
      return { processGone, portFree: await isPortFreeAsync(port) };
    }
    if (Date.now() + POLL_INTERVAL_MS >= deadline) {
      return { processGone, portFree: await isPortFreeAsync(port) };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Whether nothing listens on the port: a refused connection, not a slow answer. */
export async function isPortFreeAsync(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(400),
    });
    return false;
  } catch (error: unknown) {
    // A listener that does not answer in time is still a listener.
    return !(error instanceof Error && error.name === 'TimeoutError');
  }
}
