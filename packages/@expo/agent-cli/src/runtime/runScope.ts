// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// Which debugger targets one run reads, decided in one place.
//
// Three inputs, kept apart on purpose: the targets the dev server lists, the facts this machine's
// device tools report, and the run's scope, which is the caller's decision. `placeTargets` is the
// one function that combines them, so every runtime read places a target the same way.

import type { LiveIosBinding } from '../deviceBinding/records';
import type { BoundDevice } from '../deviceBinding/types';
import type { NavigateDevice, NavigatePlatform } from '../navigate/device';
import type { CdpTarget } from './cdpClient';
import { platformOfTarget } from './targetPlatform';

/** What this machine's device tools report. Facts only: no decision of this run is in here. */
export interface DeviceFacts {
  /** Booted simulators of every runtime, as `xcrun simctl` reports them. */
  booted: { name: string; udid: string }[];
  /** Hardware models of attached Android devices, as `adb devices -l` reports them. */
  androidModels: string[];
  /**
   * Every worktree's live local iOS binding, read only for a run in a project. A run with no
   * project root (`dev:wait`, a `navigate` wait) has no "this worktree", so it reads none.
   */
  iosBindings: LiveIosBinding[];
}

/** Facts that know nothing, for a run that did not need to ask the device tools. */
export const NO_DEVICE_FACTS: DeviceFacts = { booted: [], androidModels: [], iosBindings: [] };

/** The decision of which targets this run reads, made once by the caller. */
export interface RunScope {
  /**
   * The platform this run reads, and what named it: a flag, or the device bound to this worktree
   * (llp/0035 §Readers). Null reads every platform.
   */
  platform: { value: NavigatePlatform; by: 'flag' | 'bound-device' } | null;
  /**
   * The device this run reads. `eas-flag` is a run with `--eas` and a platform, or a `navigate`
   * that resolved to an EAS Simulator session: the session of that platform is the device. `bound`
   * is the device bound to this worktree on the run's platform, whether a flag or the binding named
   * that platform.
   */
  device: { kind: 'any' } | { kind: 'eas-flag' } | { kind: 'bound'; device: BoundDevice };
}

/** The scope a command's flags give: the platform flag, and `--eas` when a platform names a session. */
export function scopeOfFlags({
  platform,
  eas,
}: {
  platform: NavigatePlatform | null | undefined;
  eas: boolean;
}): RunScope {
  if (platform == null) {
    return { platform: null, device: { kind: 'any' } };
  }
  return { platform: { value: platform, by: 'flag' }, device: { kind: eas ? 'eas-flag' : 'any' } };
}

/** The scope of a device a run already resolved: a cloud device is the EAS Simulator session. */
export function scopeOfDevice(device: Pick<NavigateDevice, 'backend' | 'platform'>): RunScope {
  return scopeOfFlags({ platform: device.platform, eas: device.backend === 'cloud' });
}

/**
 * The scope of the device bound to this worktree: its platform, and the device itself.
 *
 * @param by what named the platform: a flag of the device's platform, or the binding itself.
 */
export function scopeOfBoundDevice(
  device: BoundDevice,
  by: NonNullable<RunScope['platform']>['by']
): RunScope {
  return { platform: { value: device.platform, by }, device: { kind: 'bound', device } };
}

/** Whether this scope is an EAS Simulator iOS session bound to this worktree. */
function boundIosSession(scope: RunScope): boolean {
  return (
    scope.device.kind === 'bound' &&
    scope.device.device.backend === 'cloud' &&
    scope.device.device.platform === 'ios'
  );
}

/** Whether this scope's device is an EAS Simulator session: named by `--eas`, or bound. */
export function readsEasSession(scope: RunScope): boolean {
  return (
    scope.device.kind === 'eas-flag' ||
    (scope.device.kind === 'bound' && scope.device.device.backend === 'cloud')
  );
}

/** The one name of a bound device, for the scope line on stderr. */
export function describeBoundDevice(device: BoundDevice): string {
  switch (device.backend) {
    case 'local-ios':
      return `the iOS simulator "${device.name}"`;
    case 'local-android':
      return `the Android device ${device.serial}`;
    case 'cloud':
      return `the EAS Simulator session ${device.id}`;
  }
}

/** Where one target falls for one scope. */
export type Placement =
  | { group: 'read' }
  | { group: 'other-platform'; platform: NavigatePlatform }
  | { group: 'undetermined' }
  | { group: 'other-worktree'; projectRoots: string[] }
  | { group: 'other-device' };

/** The placements of a target this run sees and skips on purpose. */
export type SkipPlacement = Extract<Placement, { group: 'other-worktree' | 'other-device' }>;

/** A skipped app, as a report names it. */
export type SkippedApp = { deviceName: string } & SkipPlacement;

/** A target list, grouped by {@link Placement}. */
export interface PlacedTargets {
  /** The targets this run may read. */
  read: CdpTarget[];
  /** Targets shown to be on another platform than the scope's. */
  otherPlatform: { target: CdpTarget; platform: NavigatePlatform }[];
  /** Targets whose platform nothing decided, in a platform scope. Never read. */
  undetermined: CdpTarget[];
  /** Targets this run skips: another worktree's app, or an app on another device. Never read. */
  skipped: { target: CdpTarget; placement: SkipPlacement }[];
}

/** The skipped targets of a placed list, as a report names them. */
export function skippedAppsOf(placed: Pick<PlacedTargets, 'skipped'>): SkippedApp[] {
  return placed.skipped.map(({ target, placement }) => ({
    deviceName: target.deviceName,
    ...placement,
  }));
}

/** The one sentence every report, refusal and stderr line uses to name the skipped apps. */
export function describeSkippedApps(apps: readonly SkippedApp[]): string {
  const each = apps.map((app) => {
    switch (app.group) {
      case 'other-worktree':
        return `"${app.deviceName}" runs on a simulator another worktree bound (${app.projectRoots.join(', ')})`;
      case 'other-device':
        return `"${app.deviceName}" is not the device bound to this worktree`;
    }
  });
  return `Skipped ${apps.length} app${apps.length === 1 ? '' : 's'}: ${each.join('; ')}.`;
}

/**
 * The other worktrees whose simulator this target runs on, or null when it may be this one's.
 *
 * A target names its device by name only. So it is another worktree's only when every booted
 * simulator with that name has a udid that only other worktrees bind. A name nothing booted has,
 * or a simulator nobody or this worktree binds, keeps the target.
 */
function otherWorktreesOf(
  target: Pick<CdpTarget, 'deviceName'>,
  facts: DeviceFacts
): string[] | null {
  const booted = facts.booted.filter((simulator) => simulator.name === target.deviceName);
  const roots = new Set<string>();
  for (const { udid } of booted) {
    const owners = facts.iosBindings.filter((binding) => binding.udid === udid);
    if (owners.length === 0 || owners.some((binding) => binding.own)) {
      return null;
    }
    owners.forEach((binding) => roots.add(binding.projectRoot));
  }
  return roots.size > 0 ? [...roots] : null;
}

function placeTarget(
  target: Pick<CdpTarget, 'appId' | 'deviceName'>,
  scope: RunScope,
  facts: DeviceFacts
): Placement {
  const projectRoots = otherWorktreesOf(target, facts);
  if (projectRoots != null) {
    return { group: 'other-worktree', projectRoots };
  }
  if (scope.platform == null) {
    return { group: 'read' };
  }
  const { platform } = platformOfTarget(target, facts);
  if (platform != null && platform !== scope.platform.value) {
    return { group: 'other-platform', platform };
  }
  // A local simulator's targets carry its name. A local Android target carries only the model,
  // so it scopes the platform and not the device.
  if (scope.device.kind === 'bound' && scope.device.device.backend === 'local-ios') {
    return target.deviceName === scope.device.device.name
      ? { group: 'read' }
      : { group: 'other-device' };
  }
  // A session target carries the cloud simulator's model, which no local tool reports. So a target
  // on a booted local simulator is not the session's app, even with the session app's app id.
  if (
    boundIosSession(scope) &&
    facts.booted.some((simulator) => simulator.name === target.deviceName)
  ) {
    return { group: 'other-device' };
  }
  return platform == null ? { group: 'undetermined' } : { group: 'read' };
}

/**
 * Group a target list by where each target falls.
 *
 * `undetermined` is its own group rather than being folded into `read`, and that is the whole
 * point: a run that cannot tell what it is talking to must not earn a platform's verdict from it.
 *
 * One rule needs the whole list, so it lives here and not in `platformOfTarget`: on an EAS
 * Simulator iOS session, exactly one undetermined target is the session's app. Its device name is
 * the cloud simulator's model, which no local tool reports, and a development build's app id is
 * often the same on both platforms. The run named the session, or this worktree bound it, so the
 * one target nothing on this machine claims is its app. Two such targets stay undetermined: nothing says which one is the
 * session's. An Android session needs no rule, because its device name shape places it. A target
 * on another worktree's simulator is skipped in every scope, so it never takes that slot.
 */
export function placeTargets(
  targets: CdpTarget[],
  scope: RunScope,
  facts: DeviceFacts
): PlacedTargets {
  const placed: PlacedTargets = { read: [], otherPlatform: [], undetermined: [], skipped: [] };
  for (const target of targets) {
    const placement = placeTarget(target, scope, facts);
    switch (placement.group) {
      case 'read':
        placed.read.push(target);
        break;
      case 'other-platform':
        placed.otherPlatform.push({ target, platform: placement.platform });
        break;
      case 'undetermined':
        placed.undetermined.push(target);
        break;
      case 'other-worktree':
      case 'other-device':
        placed.skipped.push({ target, placement });
        break;
    }
  }
  const [only, ...more] = placed.undetermined;
  if (readsEasSession(scope) && scope.platform?.value === 'ios' && only && !more.length) {
    return {
      ...placed,
      read: targets.filter((target) => target === only || placed.read.includes(target)),
      undetermined: [],
    };
  }
  return placed;
}

/**
 * The facts a scope needs to place these targets, asking the device tools only when their answer
 * could change a placement.
 *
 * The bindings are files, so a run in a project always reads them. The booted simulators cost a
 * subprocess, so they are read only for a platform scope with a target the fact-free rules cannot
 * place, for a target with the name of a simulator another worktree binds, or on an EAS Simulator
 * iOS session, which sets apart every app on a booted local simulator.
 *
 * @param projectRoot this worktree, or null for a run with no project, which reads no bindings.
 */
export async function deviceFactsForScopeAsync(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[],
  scope: RunScope,
  projectRoot: string | null
): Promise<DeviceFacts> {
  const { liveIosBindings } =
    require('../deviceBinding/records') as typeof import('../deviceBinding/records');
  const iosBindings = projectRoot == null ? [] : liveIosBindings(projectRoot);
  const onOtherBinding = targets.some((target) =>
    iosBindings.some((binding) => !binding.own && binding.name === target.deviceName)
  );
  const tools =
    onOtherBinding ||
    (scope.platform != null && someUnplaceable(targets)) ||
    (boundIosSession(scope) && targets.length > 0)
      ? await readDeviceFactsAsync()
      : NO_DEVICE_FACTS;
  return { ...tools, iosBindings };
}

/**
 * The device facts, but only when the fact-free rules cannot place every target.
 *
 * Two subprocesses are cheap and not free, and Expo Go — the case nearly every one of these
 * commands runs against — is placed by its app id alone. So the tools are spawned exactly when
 * their answer could change the outcome: a development build whose device name and app id say
 * nothing `platformOfTarget` recognises.
 */
export async function deviceFactsIfNeededAsync(
  targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[]
): Promise<DeviceFacts> {
  return someUnplaceable(targets) ? await readDeviceFactsAsync() : NO_DEVICE_FACTS;
}

function someUnplaceable(targets: readonly Pick<CdpTarget, 'appId' | 'deviceName'>[]): boolean {
  return targets.some((target) => platformOfTarget(target, NO_DEVICE_FACTS).platform == null);
}

/**
 * Ask this machine's device tools what is attached.
 *
 * Never throws and never fails a command: a missing `xcrun` or `adb` only costs the strongest of
 * the platform rules, and the other two still answer for Expo Go and for React Native Android.
 */
export async function readDeviceFactsAsync(): Promise<DeviceFacts> {
  const { parseAndroidDevices, runAdbAsync } =
    require('../device/adb') as typeof import('../device/adb');
  const { parseBootedSimulators } =
    require('../device/simulators') as typeof import('../device/simulators');
  const { spawnCaptureAsync } =
    require('../utils/spawnCapture') as typeof import('../utils/spawnCapture');

  const [simctl, adb] = await Promise.all([
    spawnCaptureAsync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']).catch(() => null),
    runAdbAsync(['devices', '-l']).catch(() => null),
  ]);

  return {
    ...NO_DEVICE_FACTS,
    booted: simctl?.exitCode === 0 ? parseBootedSimulators(simctl.stdout) : [],
    androidModels:
      adb?.exitCode === 0
        ? parseAndroidDevices(adb.stdout)
            .map((device) => device.model)
            .filter((model): model is string => model != null)
        : [],
  };
}
