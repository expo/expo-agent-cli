import type { AppConnectionResult } from '../../runtime/waitReady';
import { noScreenshot } from '../results';
import { APP_PROBE_MS, BUILD_DEV_SERVER_TIMEOUT_MS, START_SESSION_TIMEOUT_MS } from '../timeouts';
import type { PhaseWalk, Step } from './walk';

/** What phase 4 and the install hand the `app` phase. */
export interface DeviceReady {
  /**
   * The app probe the boot decision needed, kept for the `app` phase that asks the same question.
   *
   * Null on a run that never had to decide about a boot, which is every run with a device already.
   */
  firstConnection: AppConnectionResult | null;
  /**
   * This run replaced the app on the device, so nothing that was attached before is still running.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
   * Read by the `app` phase, which must open rather than take the attached-app shortcut: a target
   * the dev server still lists is one the install has already killed.
   */
  appReplaced: boolean;
}

// ---- Phase 4: is there a device, and does this run boot one? ------------------------------
//
// @ref llp/0027-everything-on-eas.rfc.md §smoke
// `--eas` named the device, and the device it named is not on this machine. The run still brings
// its own environment: the session in progress on this platform, or one it starts with the app
// on its command line — and ends again afterwards, the way a booted simulator is shut down.
async function startSessionStep(walk: PhaseWalk): Promise<Step<null>> {
  const { deps, environment, cleanups, report } = walk;
  const { value: session } = await walk.record(
    'start-session',
    async () => {
      const result = await deps.ensureEasSession(report.devServerUrl);
      if (result.sessionId != null && result.started) {
        cleanups.push({
          resource: 'session',
          target: result.sessionId,
          release: () => deps.stopEasSession(result.sessionId!),
        });
      }
      return result.ok
        ? {
            status: 'ok' as const,
            reason: result.started
              ? `started EAS Simulator session ${result.sessionId} for this run`
              : `EAS Simulator session ${result.sessionId} was already up`,
            value: result,
          }
        : {
            status: 'failed' as const,
            reason: result.reason ?? 'no session came up, and nothing said why',
            value: result,
          };
    },
    { budgetMs: START_SESSION_TIMEOUT_MS, bootstrap: true }
  );
  if (session.ok && session.sessionId != null) {
    environment.device = session.started ? 'booted' : 'reused';
    return { next: null };
  }
  environment.device = 'failed';
  walk.skipRest(
    'app',
    'no EAS Simulator session was reached, so there was nothing to open the app on and nothing to read'
  );
  return {
    stop: walk.done('failed', {
      screenshot: noScreenshot('no EAS Simulator session was reached, so nothing was photographed'),
    }),
  };
}

/**
 * `--eas` named the device, and the device it named is not on this machine: booting a
 * simulator here would be answering a question about a session with a laptop (llp/0005 §Cloud simulator).
 *
 * The next value says whether the boot said its device has no app: a simulator the registry
 * created this run, whose disk holds nothing to read (llp/0035 §iOS smoke).
 */
async function bootStep(
  walk: PhaseWalk
): Promise<Step<{ firstConnection: AppConnectionResult; bootInstallNeeded: boolean }>> {
  const { deps, environment, cleanups } = walk;
  // The **app** is asked about first, and the device only if nothing answers. Two reasons, and
  // they point the same way. An app attached to this dev server is the app under test whatever
  // it is running on — a phone on the same network is a device none of this machine's tools can
  // see — so a simulator booted beside it would cost a minute and then photograph an empty
  // screen to answer for the app that is really running. And it keeps the ordinary healthy run
  // spawning no device tool at all until the picture is taken, which is where it always did.
  const firstConnection = await deps.waitForAppConnection(
    walk.report.devServerUrl,
    Math.min(walk.remaining(), APP_PROBE_MS)
  );
  if (firstConnection.appsConnected !== 0 || (await walk.deviceAsync()).deviceId != null) {
    return { next: { firstConnection, bootInstallNeeded: false } };
  }
  const { value: boot } = await walk.record(
    'boot-device',
    async () => {
      const result = await deps.bootDevice();
      if (
        result.ok &&
        result.deviceId &&
        !cleanups.some(({ resource }) => resource === 'dev-server')
      ) {
        cleanups.push({
          resource: 'device',
          target: result.deviceId,
          release: () => deps.releaseDevice(),
        });
      }
      return result.ok && result.deviceId != null
        ? {
            status: 'ok' as const,
            reason: `booted ${result.deviceId} for this run${result.choice ? ` because ${result.choice}` : ''}`,
            value: result,
          }
        : {
            status: 'failed' as const,
            reason: result.reason ?? 'no device came up, and nothing said why',
            value: result,
          };
    },
    { bootstrap: true }
  );
  if (boot.ok && boot.deviceId != null) {
    environment.device = 'booted';
    environment.deviceChoice = boot.choice ?? null;
    environment.boundDevice = boot.bound
      ? { id: boot.deviceId, ...boot.bound, released: false, shutDown: false }
      : null;
    return { next: { firstConnection, bootInstallNeeded: boot.installNeeded === true } };
  }
  environment.device = 'failed';
  walk.skipRest(
    'app',
    'no device could be booted, so there was nothing to open the app on and nothing to read'
  );
  return {
    stop: walk.done('failed', {
      screenshot: noScreenshot('no device came up, so nothing was photographed'),
    }),
  };
}

// ---- Is there an app on that device to open at all? ---------------------------------------
//
// @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
//
// Conditional and an *act*, like the start and the boot: only a run that installed something
// reports a row, because a machine that already had the app never had an install to do.
//
// Driven off the **device**, not off the boot. Hanging it on the boot was the first version and
// it missed the ordinary case: a simulator somebody left running without Expo Go, where this run
// boots nothing and the deep link comes back `115` [observed — iOS 26.5, 2026-09-03].
//
// Bootstrap, like the boot: a 423 MB download is cold this run caused, and charging it to
// `--timeout` would leave the error window with nothing. Only for a run allowed to bring its own
// environment — `--no-start` says read what is there, and installing an app is not reading.
//
// The next value is whether the install replaced the app (@see DeviceReady.appReplaced).
async function installStep(walk: PhaseWalk, bootInstallNeeded: boolean): Promise<Step<boolean>> {
  const { deps, environment } = walk;
  const device = await walk.deviceAsync();
  if (
    device.deviceId == null ||
    !(bootInstallNeeded || (await deps.installNeededOnDevice(device.deviceId, device.backend)))
  ) {
    return { next: false };
  }
  const releasedAfterRun =
    environment.boundDevice?.id === device.deviceId && environment.boundDevice.released !== null;
  // @ref llp/0005-runtime-loop-tools.rfc.md §The gate installs the app, whichever app it is
  //
  // The build budget rather than an install budget, because this phase now covers both and the
  // larger of the two is a native compile — the same `BUILD_DEV_SERVER_TIMEOUT_MS` the start
  // phase gives a plan that compiles. A download that finishes in twenty seconds is not made
  // slower by a bound it never reaches; a compile stopped at two minutes is a build reported as
  // failed for no reason (§It builds what the app needs, and says so first).
  const { value: installed } = await walk.record(
    'install-app',
    async () => {
      const result = await deps.installApp(device.deviceId!);
      return result.ok
        ? {
            status: 'ok' as const,
            reason: [
              `installed ${result.version ?? 'the app'} on ${device.deviceId}`,
              result.replaced ? `, replacing ${result.replaced}` : '',
              releasedAfterRun ? '' : `, and left it there`,
            ].join(''),
            value: result,
          }
        : {
            status: 'failed' as const,
            reason: result.reason ?? 'the install failed, and nothing said why',
            value: result,
          };
    },
    { budgetMs: BUILD_DEV_SERVER_TIMEOUT_MS, bootstrap: true }
  );
  if (installed.ok) {
    // @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got
    // it. **The install invalidates every read of the app that came before it.** `simctl
    // install` over a running app replaces the bundle and takes the process with it, and the
    // dev server's target list does not forget that app as quickly as the install kills it.
    //
    // So the probe taken in the boot decision above is dropped. Without this, a run that
    // replaced a running Expo Go reported `app ok` off that stale count, opened nothing, and
    // then found no app to reload, read or watch — every phase after it arguing with the one
    // above [observed, Kudo, 2026-09-03]. The run after it passed, because it found nothing
    // attached and opened the app, which is what this run has to do.
    return { next: true };
  }
  // Nothing to open. Deep-linking into a device this run has just been told has no app would
  // spend the attach budget proving what this phase already said.
  walk.skipRest('app', 'the app could not be installed, so there was nothing to open');
  return {
    stop: walk.done('failed', {
      deviceId: device.deviceId,
      deviceBackend: device.backend,
      screenshot: noScreenshot(
        'the app could not be installed, so there was nothing to photograph it running'
      ),
    }),
  };
}

/**
 * Phase 4 and the install: make sure there is a device with the app on it, for a run allowed to
 * bring its own environment. `--no-start` says read what is there.
 */
export async function prepareDeviceStep(walk: PhaseWalk): Promise<Step<DeviceReady>> {
  const { options } = walk;
  if (!options.bootstrap) {
    return { next: { firstConnection: null, appReplaced: false } };
  }
  let firstConnection: AppConnectionResult | null = null;
  let bootInstallNeeded = false;
  // Phase 1 may have changed `options.cloud`, so it is read only from here on.
  if (options.cloud === 'required') {
    const session = await startSessionStep(walk);
    if ('stop' in session) return session;
  } else {
    const booted = await bootStep(walk);
    if ('stop' in booted) return booted;
    ({ firstConnection, bootInstallNeeded } = booted.next);
  }
  const installed = await installStep(walk, bootInstallNeeded);
  if ('stop' in installed) return installed;
  return {
    next: installed.next
      ? { firstConnection: null, appReplaced: true }
      : { firstConnection, appReplaced: false },
  };
}
