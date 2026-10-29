// @ref llp/0005-runtime-loop-tools.rfc.md §Verifying the route
// Opening a route on a device, with none of the reporting.
//
// This is `@expo/agent-cli navigate` with its output removed, extracted so `@expo/agent-cli smoke` can perform the
// same act as part of a larger answer. The alternative was for `smoke` to compose the same six
// steps itself — the route check, the scheme resolution, the Expo Go decision, the device probe,
// the deep link, the exit code — and a second composition of those steps is a second place for the
// findings of llp/0005 to be forgotten: the `/--/?` marker the root route needs, the route table
// that has to be consulted *before* the link, the dev server that is found rather than assumed.
//
// So the composition lives here and both callers use it. `navigateAsync` is this function plus the
// event, the follow-ups and the two output channels; `smoke` is this function inside a phase.

import { targetSelectionOf } from '../runtime/resolveTargetSelection';
import {
  AGENT_DEVICE_SPEC,
  acceptCloudAlertAsync,
  isOpenInAppAlert,
  openUrlOnCloudSimulatorAsync,
  readCloudAlertAsync,
  cloudSessionListCommand,
  readControllerError,
} from '../device/cloudSimulator';
import { cloudNeedsTunnelError, cloudVerbFailedError } from '../device/cloudErrors';
import { event as cliEvent } from '../events';
import { readConfiguredAppId, resolveAppId } from '../runtime/appId';
import { stopAppOnDeviceAsync } from '../runtime/appProcess';
import { probeDevServerAsync } from '../runtime/devServer';
import {
  classifyTargets,
  deviceInventoryForSelectionAsync,
  withAndroidReverseAsync,
} from '../runtime/targetSelection';
import { scopedListClassifier } from '../runtime/waitReady';
import { reverseLoopbackPortAsync, type ReverseResult } from './adbReverse';
import { openUrlOnDeviceAsync } from './deepLink';
import {
  resolveDeviceAsync,
  type DeviceBackend,
  type NavigateDevice,
  type NavigatePlatform,
} from './device';
import { debugEvent } from './events';
import {
  finalizeRouteUrl,
  loadRouteFactsAsync,
  provisionalRouteUrl,
  type ResolvedRoute,
  type RouteUrlOptions,
} from './routeResolution';

export interface OpenRouteOptions extends RouteUrlOptions {
  /**
   * How long to wait for an app on this platform to register a debugger target, in milliseconds.
   *
   * Zero — the default — opens the link and reports what the device tool said, which is what a
   * caller with a connection phase of its own (`smoke`) wants. `navigate` passes a budget, because
   * `am start` exiting 0 says only that the *intent* was delivered: the Android run this exists for
   * landed on Expo Go's error screen and reported success [friction run 6, F50].
   */
  confirmAttachMs?: number;
  /**
   * Stop the app and open the link again when the first one did not attach.
   *
   * Only reached on Android, and only once. Expo Go's `ErrorActivity` does not retry the manifest
   * fetch, so a second intent into a stuck instance changes nothing — the process has to go first.
   */
  recoverStuckApp?: boolean;
  /**
   * The device the caller already resolved for this run (`dev`'s bound device, `smoke`'s device
   * choice), so the open and its attachment checks use that device and inspect nothing twice. The
   * lease is not extended here: the caller's own resolution extended it.
   *
   * @ref llp/0035-one-device-per-worktree.rfc.md §How `dev` uses it
   */
  device?: NavigateDevice;
}

/** One open of a URL on a device, and what came of it. */
export interface DevLauncherOpen {
  /** The launcher URL: `<scheme>://?__expo_url=<dev server origin>`. */
  url: string;
  /** The device command that opened it, for reproducing the step by hand. */
  command: string;
  /** Its exit code: non-zero means the device refused it. */
  exitCode: number | null;
  /** Whether an app of this platform attached after it, inside the budget this open was given. */
  attached: boolean;
  /** How long the wait for that took, in milliseconds. */
  waitedMs: number;
}

/** Everything one open amounts to, with nothing printed. */
export interface OpenRouteResult extends ResolvedRoute {
  /**
   * Which device layer acted: `local-ios`, `local-android`, or `cloud`.
   *
   * Reported next to {@link platform} rather than folded into it, because `ios` no longer says
   * where the device is — a cloud session runs iOS too. It is the fact that decides whether the
   * command a reader can repeat by hand is `xcrun`, `adb`, or `eas simulator:exec`.
   */
  deviceBackend: DeviceBackend;
  platform: NavigatePlatform;
  deviceId: string;
  /** Simulator name, when the platform tool reported one. */
  deviceName?: string;
  appId: string | null;
  /** The device command that was run, for reproducing the step by hand. */
  command: string;
  /** Exit code of that command: non-zero means the device refused the deep link. */
  exitCode: number | null;
  /** What the device tool wrote, for a caller that reports it. */
  stdout: string;
  stderr: string;
  /** The `adb` binary that was run, so a follow-up names a command this machine can run (F49). */
  adbPath: string | null;
  /**
   * What `adb reverse` did before the link, or null on a platform that needs none.
   *
   * @see ./adbReverse — why an Android link to a dev server on this machine cannot work without it.
   */
  reverse: ReverseResult | null;
  /**
   * The launcher URL this run opened **before** the route link, or null when it opened none.
   *
   * Non-null exactly when the ladder of F123 fired: a development build, nothing attached, a dev
   * server to point it at, and a budget to wait with. Reported beside {@link command} because two
   * links were delivered and a report that named one of them would describe half the run.
   */
  launch: DevLauncherOpen | null;
  /** Whether an app of this platform was seen to attach afterwards. */
  attach: AttachCheck;
}

/** Whether the app was seen to connect to the dev server after the link was opened. */
export interface AttachCheck {
  /** Whether this run looked at all. False when the caller asked for no wait. */
  checked: boolean;
  /**
   * An app on this platform holds a debugger target on this dev server.
   *
   * Null exactly when {@link checked} is false. **Never assumed**: a link that was delivered and an
   * app that is running are different facts, and reporting the first as the second is F50.
   */
  confirmed: boolean | null;
  /** How long the wait took, in milliseconds. */
  waitedMs: number;
  /** How many debugger targets this platform had when the wait ended. */
  targets: number;
  /** Whether the app was stopped and the link opened a second time. */
  recovered: boolean;
  /**
   * What the system dialog on a cloud session turned out to be, or null when none was looked for.
   *
   * @see AlertCheck — and llp/0005 §Cloud simulator.
   */
  alert: AlertCheck | null;
  /** Why it is not confirmed, or null when it is. */
  reason: string | null;
}

/**
 * The one system dialog this command answers, and what it took to establish that it was the one.
 *
 * `found` and `accepted` are separate facts because the interesting case is `found: true` with
 * `accepted: false` — an alert was on the screen and it was **not** the one this run's own link
 * raised, so it was left alone and named instead.
 */
export interface AlertCheck {
  /** Whether the device was asked what alert it had. */
  checked: boolean;
  /** Whether the controller reported an alert at all. */
  found: boolean;
  /** Whether this run answered it. */
  accepted: boolean;
  /** The controller command that read it, for reproducing the step by hand. */
  command: string;
  /** What happened, in the words of whichever layer said it. */
  reason: string;
}

/**
 * Resolve a deep link for a route and open it on a device.
 *
 * @throws {CommandError} whatever the route URL resolution throws, and whatever
 * {@link resolveDeviceAsync} throws when this machine has no device to open the link on.
 */
export async function openRouteAsync(
  projectRoot: string,
  options: OpenRouteOptions
): Promise<OpenRouteResult> {
  const { platform, appId } = options;
  const facts = await loadRouteFactsAsync(projectRoot, options);
  const devServerUrl = facts.devServer.devServerUrl;

  // A project-only URL makes the no-device diagnostic useful. The authoritative app kind and
  // URL are finalized below, after the concrete device is known.
  const device =
    options.device ??
    (await resolveDeviceAsync(platform, {
      url: provisionalRouteUrl(facts),
      devServerRunning: facts.devServer.reachable,
      cloud: options.cloud,
      projectRoot,
    }));

  const budgetMs = options.confirmAttachMs ?? 0;
  const reads = await deviceTargetReaderAsync(devServerUrl, device);
  const resolved = finalizeRouteUrl(facts, reads.decisionTargets);
  debugEvent('url_resolved', { url: resolved.url, resolution: resolved.resolution });

  // @ref src/device/cloudSimulator.ts §cloudNeedsTunnelError — refused before anything is opened.
  // A cloud simulator is on EAS's network, so a `127.0.0.1` or LAN host in the link resolves to
  // something that is not this machine, exactly as it does on an Android emulator (F50) — and
  // unlike the emulator there is no `adb reverse` to fix it. Checked here rather than inside the
  // URL resolver, because it is a fact about the *device*, and the same URL is perfectly good for
  // the simulator on this desk.
  if (
    device.backend === 'cloud' &&
    (resolved.hostType === 'localhost' || resolved.hostType === 'lan')
  ) {
    throw cloudNeedsTunnelError(resolved.url, resolved.hostType, device.platform);
  }

  // Decided before the reverse, because the two links need different ports forwarded: the launcher
  // URL carries the dev server's origin inside its `__expo_url` parameter, and a route link for a
  // development build carries no host at all.
  //
  // Whether the app is attached is asked of the device this run opens, not of the platform flag:
  // with no flag, an app of another platform on the same dev server is not this device's app.
  const launcherUrl =
    budgetMs > 0 && !resolved.isExpoGo && reads.decisionTargets.length === 0
      ? devLauncherUrlOf(resolved)
      : null;

  // @ref ./adbReverse — before the link, never after. `exp://127.0.0.1:<port>` means the *device's*
  // loopback, so an emulator resolves it to a port nothing listens on and Expo Go lands on its
  // error screen with `am start` having exited 0 (F50).
  //
  // The **dev server's** URL when a launcher open is about to happen: what has to be reachable then
  // is the origin the launcher will fetch the bundle from. The launcher URL carries it in a query
  // parameter, so reading the URL's own host would forward nothing (F123).
  const reverse =
    device.platform === 'android' && device.adb != null
      ? await reverseLoopbackPortAsync({
          adb: device.adb,
          deviceId: device.deviceId,
          url: launcherUrl == null ? resolved.url : devServerUrl,
        })
      : null;
  if (reverse?.ok === false) {
    debugEvent('adb_reverse_failed', { reason: reverse.reason ?? '' });
  }
  const waitAsync = budgetMs > 0 ? await reads.attachWaiterAsync(reverse) : null;

  // @ref llp/0005-runtime-loop-tools.rfc.md §Pointing an app at this dev server — F123, and the
  // whole reason this call sits above the route link rather than beside it.
  const startedAt = Date.now();
  const launch = await launchDevClientFirstAsync({
    projectRoot,
    options,
    device,
    waitAsync,
    launcherUrl,
    budgetMs,
  });

  const result = await openUrlOnBackendAsync(device, {
    projectRoot,
    url: resolved.url,
    appId,
  });

  const attach = await confirmAttachAsync({
    projectRoot,
    options,
    device,
    devServerUrl,
    waitAsync,
    url: resolved.url,
    isExpoGo: resolved.isExpoGo,
    openedOk: result.exitCode === 0,
    // What is left of the caller's budget. A launcher open that attached in four seconds leaves
    // almost all of it for the route link, and one that spent the lot still leaves a floor — the
    // route link has only just been delivered, and `checked: false` would report a wait that did
    // happen as one that did not.
    budgetMs:
      launch == null
        ? budgetMs
        : Math.max(budgetMs - (Date.now() - startedAt), ROUTE_ATTACH_FLOOR_MS),
  });

  cliEvent('navigate', {
    route: resolved.route,
    url: resolved.url,
    devServerUrl,
    devServerSource: resolved.devServerSource,
    deviceBackend: device.backend,
    platform: device.platform,
    deviceId: device.deviceId,
    exitCode: result.exitCode,
    reversedPort: reverse?.port ?? null,
    attached: attach.confirmed,
    launchUrl: launch?.url ?? null,
  });

  return {
    ...resolved,
    reverse,
    launch,
    attach,
    adbPath: device.adb?.bin ?? null,
    deviceBackend: device.backend,
    platform: device.platform,
    deviceId: device.deviceId,
    deviceName: device.name,
    appId: appId ?? null,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Open the URL on whichever backend resolved, and report it the same way for all three.
 *
 * The two local backends and the cloud one differ in what a non-zero exit *means*, which is why
 * they are not simply two commands behind one call. `xcrun simctl openurl` exiting non-zero is the
 * device refusing the link — a fact about the app on it, which `navigate` reports and exits `1`
 * for. `eas simulator:exec` exiting non-zero is any of: a session that ended mid-run, a signed-out
 * account, a controller flag this CLI got wrong, or a binary that was never the EAS CLI. None of
 * those is "the device refused", and reporting them as that would send a reader to reinstall Expo
 * Go. So the cloud path raises the tool failure instead, with what the tool printed and — for a
 * signed-out account — the needs-human handoff that makes it exit `7` (llp/0010).
 */
async function openUrlOnBackendAsync(
  device: NavigateDevice,
  {
    projectRoot,
    url,
    appId,
    launchActivity,
  }: { projectRoot: string; url: string; appId?: string; launchActivity?: string }
): Promise<{ command: string; stdout: string; stderr: string; exitCode: number | null }> {
  if (device.backend !== 'cloud') {
    return await openUrlOnDeviceAsync({
      platform: device.platform,
      deviceId: device.deviceId,
      url,
      appId,
      // @ref src/device/approveScheme §appIdForScheme. Passed on the **local** branch too, which
      // it was not: this parameter existed for the cloud path, which needs it to find the session,
      // so the local open never received it — and the scheme approval that resolves this project's
      // bundle identifier out of its app config therefore resolved nothing at all
      // [observed, 2026-09-04, after two other layers of the same shape].
      projectRoot,
      // @see BuildOpenUrlCommandParams.launchActivity — set only for the dev launcher's own URL on
      // Android, where a BROWSABLE intent reaches a code path that dies on a cold app (F123).
      launchActivity,
      adb: device.adb,
    });
  }

  const result = await openUrlOnCloudSimulatorAsync({
    projectRoot,
    sessionId: device.deviceId,
    url,
    platform: device.platform,
  });
  if (result.spawnError || result.exitCode !== 0) {
    throw cloudVerbFailedError(result, {
      what: `${url} was not opened on the cloud simulator.`,
      how: `Check the session is still running with "${cloudSessionListCommand()}" — a session can end between the moment it was listed and the moment a verb reaches it. Start a new one if it has.`,
    });
  }
  return {
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/** How often the debugger target list is re-read while the attach wait runs. */
const ATTACH_POLL_MS = 500;

/**
 * The least this run waits for the **route link** after a launcher open spent the whole budget.
 *
 * Not a second budget: the caller's `--attach-timeout` is what bounds the run, and this is only the
 * floor under whatever is left of it. Without one, a launcher open that used every millisecond
 * would leave the route link reported as `checked: false` — "this run did not wait" — for a run that
 * had waited a minute and a half.
 */
const ROUTE_ATTACH_FLOOR_MS = 2_000;

/**
 * Wait until an app of this scope holds a debugger target, or the deadline.
 *
 * @returns how many targets this scope had when the wait ended: zero means the deadline won.
 */
type AttachWaiter = (deadline: number) => Promise<number>;

/**
 * Read this device's apps: once now, for the decisions before the link, and again on each poll.
 *
 * The device tools are asked again for a changed list, within the budget of the wait that polls.
 * `adb reverse` is asked before the link, which decides the launcher, and again after this run's
 * own reverse, which can be what places its app beside a twin of the same model.
 */
async function deviceTargetReaderAsync(devServerUrl: string, device: NavigateDevice) {
  const targetSelection = targetSelectionOf({ flags: { platform: null, eas: false }, device });
  const first = await probeDevServerAsync(devServerUrl);
  const inventory = await deviceInventoryForSelectionAsync(
    first.targets,
    targetSelection,
    null,
    devServerUrl
  );
  return {
    decisionTargets: first.reachable
      ? classifyTargets(first.targets, targetSelection, inventory).read
      : [],
    attachWaiterAsync: async (reverse: ReverseResult | null): Promise<AttachWaiter> => {
      const facts = reverse?.ok
        ? await withAndroidReverseAsync(targetSelection, inventory, devServerUrl)
        : inventory;
      const classify = scopedListClassifier(targetSelection, facts, first.targets, devServerUrl);
      return async (deadline) => {
        for (;;) {
          const probe = await probeDevServerAsync(devServerUrl);
          const count = probe.reachable ? (await classify(probe.targets, deadline)).read.length : 0;
          if (count > 0 || Date.now() >= deadline) {
            return count;
          }
          await new Promise((resolve) => setTimeout(resolve, ATTACH_POLL_MS));
        }
      };
    },
  };
}

/**
 * Open the dev launcher's own URL first, when the app this route is for is not loaded.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Pointing an app at this dev server
 * **F123.** `<scheme>://<route>` navigates an app that is *already* running against a dev server;
 * `<scheme>://?__expo_url=<origin>` is what gets it running. They are both the
 * app's own scheme and they are not interchangeable — so a run that had just decided "no app is
 * connected to the dev server, and the project depends on expo-dev-client" was handing a not-loaded
 * app the link that only a loaded app understands, spending its whole attach budget, and exiting 22
 * after 90.6 s while holding the other URL in its own `connect` array [observed — wave 29,
 * `evidence/61-navigate-after-stop-android.json`].
 *
 * Four conditions, and each rules out a case where loading first would be wrong:
 *
 *  1. **a development build** — `exp://<host>` already carries the dev server, so Expo Go has
 *     nothing to be pointed at first;
 *  2. **nothing attached** — an app that *is* running understands the route link, and reloading it
 *     would throw away the state the caller is navigating within;
 *  3. **a launcher URL exists** — it needs a dev server to point at and a scheme to be addressed
 *     to, and `buildConnectUrls` returns nothing when either is missing;
 *  4. **a budget to wait with** — the launcher fetches a bundle, and a route link delivered into
 *     that gap lands on an app that has not finished loading. `--no-wait-attach` passes none and
 *     keeps exactly the behaviour it had.
 *
 * `smoke` used to be in that fourth exception, and it was wrong there once it started booting its
 * own simulators: a cold development build got the route link, and the run photographed the dev
 * launcher's screen [observed, 2026-09-01; llp/0005 §Loading the app is not navigating it].
 * It passes a budget now, which is how it joins this ladder rather than building a URL of its own.
 *
 * Never throws, and never fails the run: a launcher open the device refused is reported as one, and
 * the route link is opened after it either way — it is what the caller asked for.
 *
 * Decided in its own function because the answer is needed *before* the open: on Android the port
 * that has to be forwarded is the dev server's when this fires and the route link's when it does
 * not, and `adb reverse` runs before anything is opened.
 *
 * @returns the launcher URL to open first, or null when this run opens only the route link.
 */
function devLauncherUrlOf(resolved: ResolvedRoute): string | null {
  return resolved.connect.find((entry) => entry.target === 'dev-build')?.url ?? null;
}

/** Open the launcher URL {@link devLauncherUrlOf} gave, and wait for the app it loads. */
async function launchDevClientFirstAsync({
  projectRoot,
  options,
  device,
  waitAsync,
  launcherUrl,
  budgetMs,
}: {
  projectRoot: string;
  options: OpenRouteOptions;
  device: NavigateDevice;
  waitAsync: AttachWaiter | null;
  /** The launcher URL to open first, or null when this ladder does not fire. */
  launcherUrl: string | null;
  budgetMs: number;
}): Promise<DevLauncherOpen | null> {
  if (launcherUrl == null || waitAsync == null) {
    return null;
  }

  const startedAt = Date.now();
  const opened = await openUrlOnBackendAsync(device, {
    projectRoot,
    url: launcherUrl,
    appId: options.appId,
    // @see BuildOpenUrlCommandParams.launchActivity — the difference between an app that loads and
    // an app on `DevLauncherErrorActivity`. Null on iOS and on a project whose application id
    // cannot be read, and then this is the ordinary link open it has always been.
    launchActivity: androidLaunchActivityFor(projectRoot, device, options),
  });
  debugEvent('dev_launcher_opened', { url: launcherUrl, exitCode: opened.exitCode ?? -1 });

  // A refused open has nothing to wait for, and the budget belongs to the route link that follows.
  if (opened.exitCode !== 0) {
    return {
      url: launcherUrl,
      command: opened.command,
      exitCode: opened.exitCode,
      attached: false,
      waitedMs: 0,
    };
  }

  const targets = await waitAsync(startedAt + budgetMs);
  return {
    url: launcherUrl,
    command: opened.command,
    exitCode: opened.exitCode,
    attached: targets > 0,
    waitedMs: Date.now() - startedAt,
  };
}

/** The activity the Expo CLI hands a dev launcher URL to, or null when this is not that case. */
function androidLaunchActivityFor(
  projectRoot: string,
  device: NavigateDevice,
  options: OpenRouteOptions
): string | undefined {
  if (device.platform !== 'android' || device.backend === 'cloud') {
    return undefined;
  }
  // `--app-id` first, for the same reason every other read of it is: the caller knows which
  // application they installed. `.MainActivity` is the Expo CLI's own default for a project that
  // names no launch activity of its own [reference — `AndroidPlatformManager`
  // §_resolveAlternativeLaunchUrl].
  const appId = options.appId ?? readConfiguredAppId(projectRoot, 'android');
  return appId ? `${appId}/.MainActivity` : undefined;
}

/**
 * Wait for an app on this platform to hold a debugger target, and recover a stuck one once.
 *
 * "The device took the intent" and "the app is running this project" are different facts, and the
 * whole of F50 is the first having been reported as the second. What proves the second is a
 * debugger target **on this platform** — scoped, because a dev server with an iOS simulator already
 * attached would otherwise confirm an Android link from the simulator's target
 * (`src/runtime/targetPlatform.ts`).
 *
 * The recovery is one force-stop and one fresh link, and only on Android: Expo Go's error screen
 * keeps the process alive and does not retry the manifest fetch, so a second intent into it changes
 * nothing. Automatic rather than suggested, because the state it clears is one this command caused.
 *
 * **On a cloud session there is a second recovery, for a second cause** (S10). The link is handed to
 * the system, iOS asks "Open in 'Expo Go'?", and on a device nobody is sitting in front of, that
 * dialog is never answered — so nothing loads, and the honest `attached: false` this produces is
 * about a modal rather than about the app [observed — live run, 2026-08-26, where
 * `agent-device alert accept` proved the causality; and again live cloud, 2026-08-27, 60.9 s].
 *
 * @see resolveOpenDialogAsync — why answering it is this command's to do, and what stops that from
 * becoming "answer any system prompt".
 */
async function confirmAttachAsync({
  projectRoot,
  options,
  device,
  devServerUrl,
  waitAsync,
  url,
  isExpoGo,
  openedOk,
  budgetMs,
}: {
  projectRoot: string;
  options: OpenRouteOptions;
  device: NavigateDevice;
  devServerUrl: string;
  waitAsync: AttachWaiter | null;
  url: string;
  /** The link this run opened targets Expo Go, whatever the app config names. */
  isExpoGo: boolean;
  openedOk: boolean;
  /** How long this check may wait. The caller's own budget, less whatever it has already spent. */
  budgetMs: number;
}): Promise<AttachCheck> {
  if (budgetMs <= 0 || waitAsync == null) {
    return uncheckedAttach('this run did not wait for the app to attach');
  }
  if (!openedOk) {
    return uncheckedAttach('the device refused the deep link, so nothing was opened to wait for');
  }

  const startedAt = Date.now();

  let targets = await waitAsync(startedAt + budgetMs);
  let recovered = false;
  let alert: AlertCheck | null = null;

  // The cloud recovery, before the Android one: a modal that is never answered blocks whatever the
  // force-stop-and-relink would do next, so the dialog has to come off the screen first.
  if (targets === 0 && device.backend === 'cloud') {
    alert = await resolveOpenDialogAsync({
      sessionId: device.deviceId,
      projectRoot,
      platform: device.platform,
      appLabel: options.appId ?? EXPO_GO_DIALOG_LABEL,
    });
    debugEvent('attach_alert', { found: alert.found, accepted: alert.accepted });
    if (alert.accepted) {
      targets = await waitAsync(Date.now() + budgetMs);
    }
  }

  // The gate is the **platform**, not the machine. It used to be `local-android`, because the
  // recovery is a force-stop and the first cut of the cloud backend believed the controller had no
  // verb for one. `agent-device close <app-id>` is that verb, so an Android session recovers
  // exactly as an Android emulator does (llp/0005 §Cloud simulator). It
  // stays Android-only: this is the Android-specific stuck-app shape of llp/0005-runtime-loop-tools.rfc.md §Android, and
  // running it on iOS would restart an app that is merely slow.
  const canRecover = device.platform === 'android' && device.backend !== 'local-ios';
  if (targets === 0 && canRecover && options.recoverStuckApp !== false) {
    // This device's read is empty here, so no attached app names the id: `--app-id`, then the app
    // config, then Expo Go. The other apps on the dev server belong to other devices. A run that
    // opened Expo Go stops Expo Go: `android.package` is normal on a managed app that runs in it.
    const { appId } = resolveAppId({
      platform: device.platform,
      appIdOverride: options.appId,
      targetAppIds: [],
      configured: isExpoGo ? null : readConfiguredAppId(projectRoot, device.platform),
    });
    const stopped = await stopAppOnDeviceAsync({
      platform: device.platform,
      deviceId: device.deviceId,
      appId,
      adb: device.adb,
      backend: device.backend,
      projectRoot,
    });
    debugEvent('attach_recovery', { appId, stopped: stopped.ok });
    if (stopped.ok) {
      recovered = true;
      const again = await openUrlOnDeviceAsync({
        platform: device.platform,
        deviceId: device.deviceId,
        url,
        appId: options.appId,
        adb: device.adb,
        backend: device.backend,
        projectRoot,
      });
      if (again.exitCode === 0) {
        targets = await waitAsync(Date.now() + budgetMs);
      }
    }
  }

  const waitedMs = Date.now() - startedAt;
  return {
    checked: true,
    confirmed: targets > 0,
    waitedMs,
    targets,
    recovered,
    alert,
    reason:
      targets > 0
        ? null
        : `no ${device.platform} app registered a debugger target on ${devServerUrl} within ${waitedMs}ms${
            recovered ? ', including after the app was stopped and the link opened again' : ''
          }${alert?.accepted ? ', including after the system dialog this link raised was accepted' : ''}`,
  };
}

/** An attach check that did not look, and why. */
function uncheckedAttach(reason: string): AttachCheck {
  return {
    checked: false,
    confirmed: null,
    waitedMs: 0,
    targets: 0,
    recovered: false,
    alert: null,
    reason,
  };
}

/**
 * The name the "Open in …?" dialog carries for Expo Go, which is its display name and not its id.
 *
 * Matched loosely by {@link isOpenInAppAlert} — the bundle id's last component matches too — so a
 * run that knows only `host.exp.Exponent` still recognises the dialog.
 */
const EXPO_GO_DIALOG_LABEL = 'Expo Go';

/**
 * Read the alert on a cloud session's device, and answer the one this run's own link raised.
 *
 * **Why this command answers a system dialog at all.** llp/0008 keeps this CLI out of the business
 * of granting permissions on somebody's behalf, and that is not what this is. The caller ran
 * `--eas <route>`, which *is* the instruction "open this route on the cloud simulator". iOS then
 * asked whether it may do the thing that was just asked for, on a machine in a datacenter with
 * nobody in front of it. Answering it completes the requested action and authorises nothing beyond
 * it — and the precedent is one file up: the Android stuck-app recovery is already automatic rather
 * than suggested, "because the state it clears is one this command caused" [decided — wave 23,
 * llp/0005 §Cloud simulator].
 *
 * **What keeps that from becoming "answer any prompt".** Four gates, and all four are cheap:
 *
 *  1. only on `--eas` — a dialog on the machine at somebody's desk has somebody at it;
 *  2. only after **this run's own** open exited 0;
 *  3. only when nothing attached within the caller's budget, so the happy path spends no verb;
 *  4. the alert is **read before it is answered**, and answered only when it names the app the URL
 *     was for. Anything else is reported and left on the screen.
 *
 * Never throws: a controller that refuses the read is a fact about the device, and this is a
 * recovery inside a check that already has an honest answer without it.
 */
async function resolveOpenDialogAsync({
  sessionId,
  projectRoot,
  platform,
  appLabel,
}: {
  sessionId: string;
  projectRoot: string;
  platform: NavigatePlatform;
  appLabel: string;
}): Promise<AlertCheck> {
  const read = await readCloudAlertAsync({ projectRoot, sessionId }).catch((error: unknown) => ({
    command: `${AGENT_DEVICE_SPEC} alert get`,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: null,
    spawnError: null,
    binPath: null,
  }));
  const output = `${read.stdout}\n${read.stderr}`;
  const base = { checked: true, command: read.command };

  // The controller's own empty answer: exit 1, `Error (COMMAND_FAILED): alert not found`
  // [observed — `agent-device@latest alert get`, 2026-08-27]. Not a failure of this step.
  if (read.exitCode !== 0) {
    const controller = readControllerError(output);
    return {
      ...base,
      found: false,
      accepted: false,
      reason:
        controller?.message.toLowerCase().includes('not found') === true
          ? 'the device had no alert on it, so nothing was blocking the link'
          : `the alert on the device could not be read (${controller?.message ?? (firstLine(read.stderr) || `exit ${read.exitCode ?? 'on a signal'}`)})`,
    };
  }
  if (!isOpenInAppAlert(output, appLabel)) {
    return {
      ...base,
      found: true,
      accepted: false,
      // Named rather than answered, and named with what it said: an alert this run did not cause is
      // not this run's to dismiss, and a reader who can see its text can decide.
      reason: `an alert was on the device and it does not name ${appLabel}, so it is not the dialog this link raised and it was left alone: ${firstLine(read.stdout) || firstLine(read.stderr)}`,
    };
  }

  const accepted = await acceptCloudAlertAsync({ projectRoot, sessionId }).catch(() => null);
  if (accepted == null || accepted.exitCode !== 0) {
    return {
      ...base,
      found: true,
      accepted: false,
      reason: `the "open in ${appLabel}" dialog was on the device and the controller refused to accept it (${accepted == null ? 'the verb could not be run' : (readControllerError(`${accepted.stderr}\n${accepted.stdout}`)?.message ?? `exit ${accepted.exitCode ?? 'on a signal'}`)})`,
    };
  }
  return {
    ...base,
    found: true,
    accepted: true,
    reason: `the system asked whether to open the link in ${appLabel} — a dialog nothing on a ${platform} cloud simulator is there to answer — and this run accepted it`,
  };
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}
