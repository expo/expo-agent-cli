import { isTunnelCurrent, resolveDevServerReachAsync } from '../../dev/advertisedUrl';
import { liveCloudBindings } from '../../deviceBinding/cloud';
import {
  openUrlOnDeviceAsync,
  resolveDeepLinkUrl,
  readProjectSchemeConfig,
} from '../../navigate/deepLink';
import { resolveDeviceAsync, type NavigateDevice } from '../../navigate/device';
import { isCallerNamedDevServer } from '../../navigate/routeResolution';
import { decideExpoGoTarget } from '../../navigate/target';
import { PROGRAM_PREFIX } from '../../programName';
import { checkExpoGoCompatibilityAsync, decidesAgainstExpoGo } from '../../project/expoGo';
import { readProjectNativeDirsAsync } from '../../project/nativeCode';
import {
  isInstalledDependencyAsync,
  listDependencyNames,
  readProjectPackageJsonAsync,
} from '../../project/nodeModules';
import { readConfiguredAppId, resolveAppId } from '../appId';
import { stopAppOnDeviceAsync } from '../appProcess';
import { type CdpTarget } from '../cdpClient';
import { type ReloadAttempt } from './attempt';
import { type ReloadOptions } from './resolveOptions';

/** Reload by stopping the app on the device and opening it again. */
export async function reloadOnDeviceAsync(
  projectRoot: string,
  options: ReloadOptions,
  devServerUrl: string,
  own: (targets: CdpTarget[]) => CdpTarget[]
): Promise<{ attempt: ReloadAttempt; device: NavigateDevice | null }> {
  let device: NavigateDevice;
  try {
    // @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator.
    // `required` and never `fallback`: only `--eas` sends this to a device that bills by the
    // minute, and a machine with nothing booted is told it has nothing.
    device = await resolveDeviceAsync(options.platform, {
      cloud: options.cloud ? 'required' : 'off',
      projectRoot,
    });
  } catch (error: unknown) {
    // Without --eas the local rungs answer for a worktree whose device is an EAS session, so their
    // refusal (an expired local lease, say) names the wrong device. Name the session instead.
    const session = options.cloud
      ? undefined
      : liveCloudBindings(projectRoot).find(
          (binding) => options.platform == null || binding.device.platform === options.platform
        );
    return {
      attempt: {
        method: 'device',
        ok: false,
        reason: session
          ? `this worktree's device is ${session.device.platform} EAS Simulator session ${session.device.id}; the relaunch acts on it only with --eas: run "${PROGRAM_PREFIX} runtime:reload --${session.device.platform} --eas"`
          : error instanceof Error
            ? error.message.split('\n')[0]!
            : String(error),
        leftAppStopped: null,
      },
      device: null,
    };
  }

  const appId = await resolveAppIdAsync(projectRoot, devServerUrl, device, own, options.appId);
  const stopped = await stopAppOnDeviceAsync({
    platform: device.platform,
    deviceId: device.deviceId,
    appId,
    adb: device.adb,
    backend: device.backend,
    projectRoot,
  });
  if (!stopped.ok) {
    return {
      attempt: {
        method: 'device',
        ok: false,
        reason: `${stopped.command} failed: ${stopped.reason}`,
        // The stop is what failed, so the app is where it was.
        leftAppStopped: null,
      },
      device,
    };
  }

  // Starting it again is the deep link, which is the same step `navigate` runs — so a run with a
  // `--route` opens the route directly and a run without one opens the root.
  const opened = await openRouteAsync(projectRoot, options, devServerUrl, device);
  if (opened == null || opened.exitCode !== 0) {
    return {
      attempt: {
        method: 'device',
        ok: false,
        reason: `the app was stopped, but the device refused the link that would start it again (${opened?.command ?? 'no command ran'})`,
        // Stopped and not started: the app is off the screen because of this run.
        leftAppStopped: appId,
      },
      device,
    };
  }

  return {
    attempt: {
      method: 'device',
      ok: true,
      reason: `${stopped.command}, then ${opened.command}`,
      leftAppStopped: null,
    },
    device,
  };
}

/**
 * Open the route (or the root) on a device, building the URL exactly as `navigate` does.
 *
 * **Including the host** (F96, the third URL-construction path this CLI had). The sentence above was
 * true when it was written and stopped being true in wave 17, when `navigate` learned to read the
 * host a *device* reaches out of the dev server's manifest: this function kept passing only the
 * origin the dev server listens on, so a project served through a tunnel or a proxy got a link
 * naming this machine. It is exactly wrong for a phone on another network, and it reaches a cloud
 * session too: the *relaunch* rung skips this open, because its own verb already carried the route,
 * but a `--route` run that reloaded over the **command socket** lands through here on whichever
 * backend is in play — including a session in a datacenter.
 *
 * @see src/dev/advertisedUrl.ts — and `resolveRouteUrlAsync`, which does the same thing for the two
 * callers that also need a route check and a target decision from the dev server's own target list.
 */
export async function openRouteAsync(
  projectRoot: string,
  options: ReloadOptions,
  devServerUrl: string,
  known: NavigateDevice | null
): Promise<{
  url: string;
  command: string;
  exitCode: number | null;
  device: NavigateDevice;
} | null> {
  const [config, nativeDirs, packageJson, reach] = await Promise.all([
    readProjectSchemeConfig(projectRoot),
    readProjectNativeDirsAsync(projectRoot),
    readProjectPackageJsonAsync(projectRoot),
    // The same question `navigate` asks, through the same function: not where this dev server
    // listens, but where a device reaches it. `options.devServerUrl` is the caller's flag, so a run
    // that pinned a host keeps it and every other run gets the advertised one.
    isCallerNamedDevServer({ devServerUrl: options.devServerUrl ?? null })
      ? Promise.resolve(null)
      : resolveDevServerReachAsync(projectRoot),
  ]);
  const usesDevClient = await isInstalledDependencyAsync(
    projectRoot,
    listDependencyNames(packageJson),
    'expo-dev-client'
  );
  const target = decideExpoGoTarget({
    appIdOverride: options.appId,
    targetAppIds: [],
    hasNativeDirs: nativeDirs.ios || nativeDirs.android,
    usesDevClient,
    // @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
    // This rung starts an app that is not running, so it builds the same deep link `navigate` does
    // and owes the same answer: starting Expo Go for a project that cannot run there would put the
    // wrong app on the screen and call it a reload.
    expoGoCompatible: decidesAgainstExpoGo(await checkExpoGoCompatibilityAsync(projectRoot)),
  });

  const resolved = resolveDeepLinkUrl({
    route: options.route ?? '/',
    schemeOverride: options.scheme,
    config,
    isExpoGo: target.isExpoGo,
    devServerUrl,
    // Only a tunnel that is *current*, for the reason `resolveRouteUrlAsync` gives: a host read out
    // of a log whose dev server has since stopped is worse than the address of this machine.
    reachHost: reach && isTunnelCurrent(reach) ? (reach.advertised?.host ?? null) : null,
    platform: options.platform ?? null,
  });
  if (!resolved.ok) {
    return null;
  }

  const device =
    known ??
    (await resolveDeviceAsync(options.platform, {
      cloud: options.cloud ? 'required' : 'off',
      projectRoot,
    }));
  const result = await openUrlOnDeviceAsync({
    platform: device.platform,
    deviceId: device.deviceId,
    url: resolved.url,
    appId: options.appId,
    adb: device.adb,
    backend: device.backend,
    projectRoot,
  });
  return { url: resolved.url, command: result.command, exitCode: result.exitCode, device };
}

/**
 * The application id to stop, resolved the way `runtime:stop` resolves it.
 *
 * @see ../appId — the dev server outranks the app config, because the config says what a build of
 * this project would be called and the dev server says what is running.
 */
async function resolveAppIdAsync(
  projectRoot: string,
  devServerUrl: string,
  device: NavigateDevice,
  own: (targets: CdpTarget[]) => CdpTarget[],
  appIdOverride?: string
): Promise<string> {
  const { probeDevServerAsync } = require('../devServer') as typeof import('../devServer');
  const probe = await probeDevServerAsync(devServerUrl);
  return resolveAppId({
    platform: device.platform,
    appIdOverride,
    // Only this worktree's apps: a skipped app's id stops the wrong app (llp/0005 §Target owner).
    targetAppIds: own(probe.targets)
      .map((target) => target.appId)
      .filter(Boolean),
    configured: readConfiguredAppId(projectRoot, device.platform),
  }).appId;
}
