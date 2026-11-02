// @ref llp/0021-honest-reports.rfc.md §How they show up
// The `next` line of `status`: which platform it is for, which port a re-run keeps, and the command
// that gets this worktree a device. Pure: `statusAsync` reads the facts, and this decides.

import type { DevServerLockInfo } from '../devLock';
import { withDevServerPort, withoutPortArgs } from '../dev/forwardedArgs';
import type { LastDevRequest } from '../dev/lastRequest';
import { deviceCommand } from '../deviceBinding/errors';
import type { BindingSummary } from '../deviceBinding/summary';
import type { DevicePlatform } from '../deviceBinding/types';
import type { LastBuildRecord } from '../plan/lastBuild';
import { rerunDevCommand } from '../plan/rerun';
import type { DeviceBackend, NativePlatform, PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import type { ProjectState, StartPlan } from '../project/types';
import { buildNextActionStatus, resolveDefaultPlatform } from './sections';
import type { DevServerStatus, LocalDeviceStatus, NextActionStatus } from './types';

/**
 * The cloud bindings `status` acts on. Recorded evidence only: a live cloud binding, never a
 * `gone` one. Status makes no session service call. A cloud binding is `gone` only when its lease
 * expired; the session itself is not checked.
 */
export function cloudBindings(bindings: BindingSummary[]): {
  cloud: BindingSummary[];
  expiredCloud: BindingSummary[];
} {
  return {
    cloud: bindings.filter((entry) => entry.backend === 'cloud' && entry.state === 'recorded'),
    expiredCloud: bindings.filter((entry) => entry.backend === 'cloud' && entry.state === 'gone'),
  };
}

export interface NextTargetFacts {
  /** The platform the caller named, if any. */
  platform?: PlanPlatform;
  /** Explicit --dev-server-url. */
  devServerUrl: string | null;
  ownServer: DevServerLockInfo | null;
  request: LastDevRequest | null;
  bindings: BindingSummary[];
  devServer: DevServerStatus | null;
  state: ProjectState;
}

/** The platform `next` is for, and the local port a re-run of `dev` keeps. */
export function resolveNextTarget({
  platform: named,
  devServerUrl,
  ownServer,
  request,
  bindings,
  devServer,
  state,
}: NextTargetFacts): { platform: PlanPlatform; recoveryPort: number | null } {
  const boundPlatforms = [...new Set(bindings.map((entry) => entry.platform))];
  const platform =
    named ??
    ownServer?.easPlatform ??
    request?.platform ??
    (boundPlatforms.length === 1 ? boundPlatforms[0]! : resolveDefaultPlatform(state));
  const requestedPort =
    devServerUrl != null ? localPortOf(devServerUrl) : (ownServer?.port ?? request?.port ?? null);
  // A selected address is a preference, not permission to take another project's port.
  const recoveryPort =
    devServer?.projectRootMatched === false && requestedPort === localPortOf(devServer.url)
      ? null
      : requestedPort;
  return { platform, recoveryPort };
}

/** What the next line reads from the machine, kept out of the choice so the choice stays pure. */
export interface NextActionHost {
  now: number;
  devicesDisabled: boolean;
  bindsPlatform(platform: DevicePlatform): boolean;
  childStartsSession(lock: DevServerLockInfo, platform: NativePlatform): boolean;
  unreadableBindingFile(platform: DevicePlatform): string | null;
}

export interface NextActionFacts {
  state: ProjectState;
  record: LastBuildRecord;
  platform: PlanPlatform;
  recoveryPort: number | null;
  devServer: DevServerStatus | null;
  device: LocalDeviceStatus | null;
  devBuildScheme: string | null;
  /** Null when the binding registry could not be read. */
  bindings: BindingSummary[] | null;
  ownServer: DevServerLockInfo | null;
  request: LastDevRequest | null;
  deviceBackend: DeviceBackend;
  /** The plan `@expo/agent-cli dev` would make here, or null when it could not be made. */
  plan: StartPlan | null;
  host: NextActionHost;
}

export function chooseNextAction({
  state,
  record,
  platform,
  recoveryPort,
  devServer,
  device,
  devBuildScheme,
  bindings,
  ownServer,
  request,
  deviceBackend,
  plan,
  host,
}: NextActionFacts): NextActionStatus {
  const { cloud, expiredCloud } = cloudBindings(bindings ?? []);
  const cloudPlatform =
    (cloud.find((entry) => entry.platform === platform) ?? cloud[0])?.platform ?? null;
  const recoveryPlan = plan && recoveryPort != null ? withDevServerPort(plan, recoveryPort) : plan;
  let next = buildNextActionStatus(
    state,
    record,
    platform,
    devServer,
    device,
    // The scheme a development build of this project registers, read the same way the deep link
    // reads it: `exp://` is the Expo Go form only, and a development build's connect URL takes
    // the app's own scheme (`src/navigate/connectUrl.ts`).
    devBuildScheme,
    cloudPlatform,
    // @ref llp/0015-backend-selection-and-config.rfc.md §What `status` reports
    // The plan `@expo/agent-cli dev` would make *here* — the developer's config, this host and the
    // toolchain probe folded in — rather than the one the project's state alone implies. The two
    // differ on exactly the machines where it matters, and a `status` that reported
    // "expo run:ios" on a Linux box would be the report disagreeing with the command.
    recoveryPlan
  );
  const devNext = buildNextActionStatus(
    state,
    record,
    platform,
    null,
    device,
    devBuildScheme,
    null,
    recoveryPlan
  );
  const { backend, devArgs, devCommand } = devRerun(platform, request, recoveryPort, devNext);
  if ((request || recoveryPort != null) && next.command.startsWith(`${PROGRAM_PREFIX} dev `))
    next.command =
      platform === 'web'
        ? `${PROGRAM_PREFIX} dev --web${devArgs.map((arg) => ` ${arg}`).join('')}`
        : devCommand;
  const bound = bindings ? bindings.filter((e) => e.platform === platform) : [];
  const liveBound = bound.some((entry) => Date.parse(entry.expiresAt) > host.now);
  const expiredSession =
    cloud.length === 0 && !liveBound
      ? expiredCloud.find((entry) => entry.platform === platform)
      : undefined;
  // An own server that runs this platform's EAS session needs no restart: dev --eas waits for it.
  const easServer = ownServer?.easPlatform === platform ? ownServer : null;
  if (expiredSession) {
    // @ref llp/0021-honest-reports.rfc.md §How they show up
    next = {
      ...devNext,
      command: deviceCommand(expiredSession.platform, { eas: true }),
      why: `The lease on the bound ${expiredSession.platform} EAS Simulator session ${expiredSession.id} expired. This command binds a session again.`,
    };
  } else if (
    state.isExpoApp &&
    platform !== 'web' &&
    bindings &&
    !liveBound &&
    // An app on an own EAS server can load from Metro while the session is not bound.
    !(
      devServer?.running &&
      devServer.appsConnected > 0 &&
      devServer.projectRootMatched !== false &&
      ownServer?.easPlatform !== platform
    ) &&
    cloud.length === 0 &&
    // `dev --eas` binds a cloud session and needs no local device tools. A project whose
    // config puts this platform on EAS gets no local-device step.
    (easServer != null ||
      (deviceBackend !== 'eas' && !host.devicesDisabled && host.bindsPlatform(platform)))
  ) {
    // @ref llp/0021-honest-reports.rfc.md §How they show up
    // Detached dev can only reuse beside an own server; an expired binding can still be reused.
    // A server that runs an EAS session is never stopped, for any platform.
    const restart = ownServer != null && ownServer.easPlatform == null && bound.length === 0;
    const unreadable = host.unreadableBindingFile(platform);
    // A re-run finds the running EAS Metro through its lock, which names its port: no --port.
    const command = easServer
      ? rerunDevCommand(platform, ['--eas', ...withoutPortArgs(devArgs.slice(backend ? 1 : 0))])
      : restart
        ? `${PROGRAM_PREFIX} dev:stop && ${devCommand}`
        : devCommand;
    const easWhy = easServer
      ? `${
          host.childStartsSession(easServer, platform)
            ? `The dev server's EAS Simulator session for ${platform} is starting.`
            : `The dev server's EAS Simulator session for ${platform} is not bound yet.`
        } This command waits for it, or reopens the app on the running Metro. No restart is needed.`
      : null;
    next = {
      ...devNext,
      command: unreadable ? `rm -f '${unreadable}' && ${command}` : command,
      why: unreadable
        ? `The binding file ${unreadable} does not parse; a newer CLI may have written it.`
        : (easWhy ??
          (bound.length
            ? `The lease on the bound ${platform} device expired.`
            : `No ${platform} device is bound to this worktree.${restart ? ' The running dev server must restart to bind one.' : ''}`)),
    };
  }
  return next;
}

/** The `dev` re-run that keeps the saved request's flags and the recovery port. */
function devRerun(
  platform: PlanPlatform,
  request: LastDevRequest | null,
  recoveryPort: number | null,
  devNext: NextActionStatus
): { backend: string | null; devArgs: string[]; devCommand: string } {
  const backend = request?.buildBackend ?? (devNext.command.includes(' --eas') ? 'eas' : null);
  const devArgs = [
    ...(backend ? [`--${backend}`] : []),
    ...(request?.runTarget ? [request.runTarget === 'expo-go' ? '--go' : '--dev-client'] : []),
    ...(recoveryPort != null ? ['--port', String(recoveryPort)] : []),
  ];
  const devCommand = rerunDevCommand(
    platform,
    devArgs,
    backend === 'eas' ? undefined : request?.device
  );
  return { backend, devArgs, devCommand };
}

/** A remote URL's port is not a request to start a local Metro on that port. */
function localPortOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.port
      ? Number(parsed.port)
      : null;
  } catch {
    return null;
  }
}
