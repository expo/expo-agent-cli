import type { ScreenshotResult } from '../device/screenshot';
import type { DeviceBackend } from '../navigate/device';
import { noScreenshot, showingReason } from './results';
import type { SmokeOutcome, SmokePhaseStatus } from './types';
import type { PhaseWalk, SmokeRunReport, WalkRun } from './walk/walk';

/**
 * The picture, and the device it was taken on.
 *
 * The device travels with it because the screenshot phase is the one step that resolves a device of
 * its own — every other phase either has one already or does not need one (F98).
 */
interface CaptureOutcome {
  screenshot: ScreenshotResult;
  deviceId: string | null;
  deviceBackend: DeviceBackend | null;
}

/**
 * Take the picture, or record why there is none.
 *
 * Degrading rather than failing is the decision: a screenshot is evidence attached to an answer,
 * and a run on a machine with no simulator has still answered whether the app throws. Reporting
 * `ok: false` with a reason keeps that honest without spending the verdict on it — the outcome
 * never depends on this phase, in either direction.
 */
async function captureIfPossible(
  walk: PhaseWalk,
  /**
   * What the picture is a picture *of*, as far as this run can tell.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Loading the app is not navigating it
   * Three cases, because a reader believes a screenshot without checking it and all three look
   * plausible: the project's own screen, the **dev launcher's** screen — which is what a
   * development build shows when the loading link was opened and the bundle did not arrive — and
   * a device with neither on it.
   */
  showing: 'project' | 'dev-launcher' | 'device'
): Promise<CaptureOutcome> {
  const { deps, options, phases } = walk;
  const { deviceId, deviceBackend } = walk.report;
  const at = deps.now();
  const push = (status: SmokePhaseStatus, reason: string | null) =>
    phases.push({ id: 'screenshot', status, ms: deps.now() - at, reason });

  if (!options.screenshot) {
    const skipped = noScreenshot('no screenshot was taken (--no-screenshot)');
    push('skipped', skipped.reason);
    return { screenshot: skipped, deviceId, deviceBackend };
  }

  let device = deviceId;
  let backend = deviceBackend;
  if (device == null) {
    // The run's own device probe, so this phase never resolves a second one (F98).
    const probe = await walk.deviceAsync();
    backend = probe.backend;
    if (probe.deviceId == null) {
      const skipped = noScreenshot(
        `no screenshot was taken: ${probe.reason ?? 'no booted device was found to photograph'}`
      );
      push('skipped', skipped.reason);
      // Null, not the probe's backend: nothing was found, so there is no device for the run to name
      // and a backend on its own would say a device was used.
      return { screenshot: skipped, deviceId: null, deviceBackend: null };
    }
    device = probe.deviceId;
  }

  // @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
  //
  // Here rather than at the top of this function, because everything above it is a decision and
  // this is where the work starts: a run with `--no-screenshot`, or one with no device to
  // photograph, has no wait to announce. The settle below is the wait, which is why the line comes
  // before it and not before the capture.
  deps.progress('screenshot', null);

  // @ref ./timeouts §APP_SETTLE_MS — friction run 6, F57. A no-op unless this run moved the app and
  // has not waited yet. Usually already done: the runtime read needs the same settle and asks for
  // it first, on every path that reaches it.
  await walk.app.settleAsync();

  const result = await deps.captureScreenshot(device, backend);
  // @ref llp/0005-runtime-loop-tools.rfc.md §The device that can open the app. A picture is the
  // one piece of evidence a reader believes without checking, and a home screen, a dev launcher
  // and an app that failed to render look equally plausible. An `ok` beside a run whose app never
  // connected has to say what it is a picture *of*.
  push(result.ok ? 'ok' : 'skipped', result.ok ? showingReason(showing) : result.reason);
  // Handed back, and this is F98. A healthy app opens nothing — the `app` phase finds it already
  // connected and the `route` phase is skipped — so before this the two steps that set the run's
  // device fields never ran, and a run that had photographed a **billed cloud session** reported
  // `deviceBackend: null` next to the `eas simulator:exec … screenshot` that took the picture
  // [observed — live cloud, 2026-08-27]. The device a run used is a fact of the run, whichever phase
  // found it.
  return { screenshot: result, deviceId: device, deviceBackend: backend };
}

/** Take the picture and end the run with it, on the device the picture was taken on. */
export async function stopWithPicture(
  walk: PhaseWalk,
  outcome: SmokeOutcome,
  showing: 'project' | 'dev-launcher' | 'device',
  extra: Partial<SmokeRunReport> = {}
): Promise<WalkRun> {
  const captured = await captureIfPossible(walk, showing);
  return walk.done(outcome, {
    ...extra,
    deviceId: captured.deviceId,
    deviceBackend: captured.deviceBackend,
    screenshot: captured.screenshot,
  });
}
