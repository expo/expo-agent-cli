// @ref llp/0021-honest-reports.rfc.md §How they show up
// The `next` line of `status`: which platform it is for, which port a re-run keeps, and the command
// that gets this worktree a device. Pure: `statusAsync` reads the facts, and this decides.

import { loopbackPortOfUrl } from '../navigate/adbReverse';
import type { DevServerLockInfo } from '../devLock';
import { withDevServerPort } from '../dev/forwardedArgs';
import type { LastDevRequest } from '../dev/lastRequest';
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

/** What the recorded bindings say about one platform's device. */
function bindingsFor(
  bindings: BindingSummary[],
  platform: PlanPlatform,
  now: number
): {
  cloud: BindingSummary[];
  /** The platform of the cloud session `next` can verify against: this one's, else any. */
  cloudPlatform: BindingSummary['platform'] | null;
  bound: BindingSummary[];
  liveBound: boolean;
  /** This platform's EAS Simulator session whose lease expired, when nothing else is bound. */
  expiredSession: BindingSummary | undefined;
} {
  const { cloud, expiredCloud } = cloudBindings(bindings);
  const bound = bindings.filter((entry) => entry.platform === platform);
  const liveBound = bound.some((entry) => Date.parse(entry.expiresAt) > now);
  return {
    cloud,
    cloudPlatform:
      (cloud.find((entry) => entry.platform === platform) ?? cloud[0])?.platform ?? null,
    bound,
    liveBound,
    expiredSession:
      cloud.length === 0 && !liveBound
        ? expiredCloud.find((entry) => entry.platform === platform)
        : undefined,
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
}: NextTargetFacts): {
  platform: PlanPlatform;
  requestedPort: number | null;
  recoveryPort: number | null;
} {
  const boundPlatforms = [...new Set(bindings.map((entry) => entry.platform))];
  const platform =
    named ??
    ownServer?.easPlatform ??
    request?.platform ??
    (boundPlatforms.length === 1 ? boundPlatforms[0]! : resolveDefaultPlatform(state));
  const requestedPort =
    devServerUrl != null
      ? loopbackPortOfUrl(devServerUrl)
      : (ownServer?.port ?? request?.port ?? null);
  // A selected address is a preference, not permission to take another project's port.
  const recoveryPort =
    devServer?.projectRootMatched === false && requestedPort === loopbackPortOfUrl(devServer.url)
      ? null
      : requestedPort;
  return { platform, requestedPort, recoveryPort };
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
  requestedPort: number | null;
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
  requestedPort,
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
  const { cloud, cloudPlatform, bound, liveBound, expiredSession } = bindingsFor(
    bindings ?? [],
    platform,
    host.now
  );
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
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app, §Dependencies not installed
  // — no app to act on outranks every device next below: each of them runs `dev`, which stops first.
  if (state.app !== 'ready') {
    return next;
  }
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
  const easServer = ownServer?.easPlatform === platform ? ownServer : null;
  const bound = bindings ? bindings.filter((e) => e.platform === platform) : [];
  const liveBound = bound.some((entry) => Date.parse(entry.expiresAt) > host.now);
  const expiredSession =
    cloud.length === 0 && !liveBound && expiredCloud.find((entry) => entry.platform === platform);
  const port = ownServer?.port === requestedPort ? recoveryPort : (ownServer?.port ?? recoveryPort);
  const eas = !!(easServer || expiredSession);
  const { devArgs, devCommand } = devRerun(platform, request, port, devNext, eas);
  if ((request || recoveryPort != null) && next.command.startsWith(`${PROGRAM_PREFIX} dev `))
    next.command =
      platform === 'web'
        ? `${PROGRAM_PREFIX} dev --web${devArgs.map((arg) => ` ${arg}`).join('')}`
        : devCommand;
  // An unfinished session start is observed; rebinding after it finishes needs a deliberate restart.
  const pendingSession =
    easServer?.easPlatform && host.childStartsSession(easServer, easServer.easPlatform);
  const stopFirst = ownServer ? `${PROGRAM_PREFIX} dev:stop && ` : '';
  if (expiredSession && !pendingSession) {
    // @ref llp/0021-honest-reports.rfc.md §How they show up
    next = {
      ...devNext,
      command: `${stopFirst}${devCommand}`,
      why: `The lease on the bound ${expiredSession.platform} EAS Simulator session ${expiredSession.id} expired. This command binds a session again.`,
    };
  } else if (
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
    const unreadable = host.unreadableBindingFile(platform);
    const command = pendingSession ? `${PROGRAM_PREFIX} dev:logs` : `${stopFirst}${devCommand}`;
    const easWhy = easServer
      ? pendingSession
        ? `The dev server's EAS Simulator session for ${platform} is starting. Read its logs and check status again when startup finishes.`
        : `The dev server's EAS Simulator session for ${platform} is not bound. Stop the server before starting a run that binds it; plain dev:stop preserves existing sessions.`
      : null;
    next = {
      ...devNext,
      command: unreadable ? `rm -f '${unreadable}' && ${command}` : command,
      steps: pendingSession ? [] : devNext.steps,
      why: unreadable
        ? `The binding file ${unreadable} does not parse; a newer CLI may have written it.`
        : (easWhy ??
          (bound.length
            ? `The lease on the bound ${platform} device expired.${ownServer ? ' Stop the running dev server before rebinding it.' : ''}`
            : `No ${platform} device is bound to this worktree.${ownServer ? ' The running dev server must restart to bind one.' : ''}`)),
    };
  }
  return ownServer ? ownedServerNext(next, !!pendingSession) : next;
}

/** Bare starts are refused while an own lock exists, even with a live device binding. */
function ownedServerNext(next: NextActionStatus, pendingSession: boolean): NextActionStatus {
  if (!next.command.startsWith(`${PROGRAM_PREFIX} dev `)) return next;
  return pendingSession
    ? {
        ...next,
        command: `${PROGRAM_PREFIX} dev:logs`,
        steps: [],
        why: 'The EAS session is still starting. Read its logs and check status again.',
      }
    : {
        ...next,
        command: `${PROGRAM_PREFIX} dev:stop && ${next.command}`,
        why: `${next.why} Stop the owned dev-server process before starting another run.`,
      };
}

/** The `dev` re-run that keeps the saved request's flags and the recovery port. */
function devRerun(
  platform: PlanPlatform,
  request: LastDevRequest | null,
  recoveryPort: number | null,
  devNext: NextActionStatus,
  eas: boolean
): { backend: string | null; devArgs: string[]; devCommand: string } {
  const backend = eas
    ? 'eas'
    : (request?.buildBackend ?? (devNext.command.includes(' --eas') ? 'eas' : null));
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
