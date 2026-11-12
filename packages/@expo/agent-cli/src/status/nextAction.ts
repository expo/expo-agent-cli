// @ref llp/0021-honest-reports.rfc.md §How they show up
// The `next` line of `status`: which platform it is for, which port a re-run keeps, and the command
// that gets this worktree a device. Pure: `statusAsync` reads the facts, and this decides.

import { loopbackPortOfUrl } from '../navigate/adbReverse';
import type { DevServerLockInfo } from '../devLock';
import { withDevServerPort } from '../dev/forwardedArgs';
import type { LastDevRequest } from '../dev/lastRequest';
import type { DetachedObservation } from '../dev/devRunTypes';
import { decideRecovery, renderRecovery } from '../dev/recovery';
import type { BindingSummary } from '../deviceBinding/summary';
import type { DevicePlatform } from '../deviceBinding/types';
import type { LastBuildRecord } from '../plan/lastBuild';
import { recoveryRequestFor } from '../dev/recoveryRequest';
import type { DeviceBackend, PlanPlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import type { ProjectState, StartPlan } from '../project/types';
import { buildNextActionStatus, resolveDefaultPlatform, verifyAction } from './sections';
import { quoteArgument } from '../utils/consent';
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
  /** This project's dev-server lock, in any phase. */
  ownLock: DevServerLockInfo | null;
  request: LastDevRequest | null;
  bindings: BindingSummary[];
  devServer: DevServerStatus | null;
  state: ProjectState;
}

/** The platform `next` is for, and the local port a re-run of `dev` keeps. */
export function resolveNextTarget({
  platform: named,
  devServerUrl,
  ownLock,
  request,
  bindings,
  devServer,
  state,
}: NextTargetFacts): {
  platform: PlanPlatform;
  requestedPort: number | null;
  recoveryPort: number | null;
} {
  const ownServer = servingLock(ownLock);
  const boundPlatforms = [...new Set(bindings.map((entry) => entry.platform))];
  const platform =
    named ??
    ownServer?.easPlatform ??
    request?.platform ??
    (boundPlatforms.length === 1 ? boundPlatforms[0]! : resolveDefaultPlatform(state));
  const requestedPort =
    devServerUrl != null
      ? loopbackPortOfUrl(devServerUrl)
      : (ownServer?.port ?? (typeof request?.port === 'number' ? request.port : null));
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
  unreadableBindingFile(platform: DevicePlatform): string | null;
}

export interface NextActionFacts {
  ownership?: DetachedObservation;
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
  /** This project's dev-server lock, in any phase. */
  ownLock: DevServerLockInfo | null;
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
  ownLock,
  request,
  deviceBackend,
  plan,
  host,
  ownership,
}: NextActionFacts): NextActionStatus {
  const { cloud, cloudPlatform, bound, liveBound, expiredSession } = bindingsFor(
    bindings ?? [],
    platform,
    host.now
  );
  const recoveryPlan = plan && recoveryPort != null ? withDevServerPort(plan, recoveryPort) : plan;
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
  const ownServer = servingLock(ownLock);
  const easServer = ownServer?.easPlatform === platform ? ownServer : null;
  const implicitEas =
    plan?.buildLocation?.runsOn === 'eas' && plan.buildLocation.selection?.implicit;
  const port = ownServer?.port === requestedPort ? recoveryPort : (ownServer?.port ?? recoveryPort);
  const currentRequest =
    ownership?.kind === 'live' ? (ownership.attempt.request ?? request) : request;
  const restart = recoveryRequestFor(platform, currentRequest, {
    port,
    deviceBackend: easServer || expiredSession || implicitEas ? 'eas' : deviceBackend,
  });
  const facts = { ownership, lock: ownLock, request: restart };
  const pending = decideRecovery({ ...facts, needsStart: false });
  if (pending) return { ...devNext, ...renderRecovery(pending), steps: [] };
  if (state.app !== 'ready') return devNext;
  const ended = endedRunNext(devServer, cloud, platform, devNext);
  if (ended) return ended;
  const verify = verifyAction(devServer, device, state, devBuildScheme, cloudPlatform);
  const needsBinding =
    platform !== 'web' &&
    bindings &&
    !liveBound &&
    cloud.length === 0 &&
    !(
      devServer?.running &&
      devServer.appsConnected > 0 &&
      devServer.projectRootMatched !== false &&
      ownServer?.easPlatform !== platform
    ) &&
    (easServer != null ||
      (deviceBackend !== 'eas' && !host.devicesDisabled && host.bindsPlatform(platform)));
  if (verify && !expiredSession && !needsBinding) return { ...devNext, ...verify, steps: [] };
  const unreadable = needsBinding ? host.unreadableBindingFile(platform) : null;
  const why = expiredSession
    ? `The lease on the bound ${expiredSession.platform} EAS Simulator session ${expiredSession.id} expired. This command binds a session again.`
    : unreadable
      ? `The binding file ${unreadable} does not parse; a newer CLI may have written it.`
      : needsBinding
        ? easServer
          ? `The dev server's EAS Simulator session for ${platform} is not bound. Stop the server before starting a run that binds it; plain dev:stop preserves existing sessions.`
          : bound.length
            ? `The lease on the bound ${platform} device expired.${ownServer ? ' Stop the running dev server before rebinding it.' : ''}`
            : `No ${platform} device is bound to this worktree.${ownServer ? ' The running dev server must restart to bind one.' : ''}`
        : devNext.why;
  const recovery = renderRecovery(decideRecovery({ ...facts, needsStart: true, why }));
  return {
    ...devNext,
    ...recovery,
    command: unreadable
      ? `rm -f ${quoteArgument(unreadable)} && ${recovery.command}`
      : recovery.command,
    why: why ?? recovery.why,
  };
}

/** The live cloud binding this CLI started for `platform`, else any it started; null for none. */
function startedSession(cloud: BindingSummary[], platform: PlanPlatform): BindingSummary | null {
  const started = cloud.filter((entry) => entry.origin === 'started');
  return started.find((entry) => entry.platform === platform) ?? started[0] ?? null;
}

/**
 * `dev:stop --eas` for a dev server a killed `dev --eas` left beside its session
 * (`DevServerStatus.ownerEnded`); null otherwise.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
 */
function endedRunNext(
  devServer: DevServerStatus | null,
  cloud: BindingSummary[],
  platform: PlanPlatform,
  devNext: NextActionStatus
): NextActionStatus | null {
  const session = devServer?.ownerEnded ? startedSession(cloud, platform) : null;
  if (!session) return null;
  return {
    ...devNext,
    command: `${PROGRAM_PREFIX} dev:stop --eas`,
    why: `the run that started this dev server and EAS session ${session.id} ended; this stops both`,
  };
}

/** The lock of a dev server that serves, or null for none or a run that builds or finishes. */
function servingLock(lock: DevServerLockInfo | null): DevServerLockInfo | null {
  return lock?.phase === 'serving' ? lock : null;
}
