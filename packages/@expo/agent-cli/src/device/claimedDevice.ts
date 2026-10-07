// @ref llp/0030-one-device-per-agent.rfc.md §Every verb uses the claim
// The one place a local verb gets its device: the device this worktree claimed on the platform, or
// a free one it claims now. It builds the local inventory for the registry's allocation, and boots
// the device when the caller allows it. A verb that only reads peeks instead: the same choice, and
// no claim written, touched or released. Nothing else picks "the first booted" device.

import os from 'os';

import {
  allocateDeviceAsync,
  deviceRegistryDirectory,
  devicesAllClaimedError,
  isSameClaim,
  markClaimBootedAsync,
  peekDeviceAsync,
  readClaim,
  releaseClaim,
  releaseProjectClaimsAsync,
  touchClaim,
  withRegistryLockAsync,
  type ClassifiedClaim,
  type DeviceAction,
  type DeviceCandidate,
  type DeviceClaim,
  type DevicePlatform,
} from '../deviceClaims';
import * as Log from '../log';
import { parseAndroidDevices } from '../navigate/device';
import { canonicalizeExistingPath } from '../utils/dir';
import { CommandError } from '../utils/errors';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { adbNotRunnableError, resolveAdb, runAdbAsync, type AdbResolution } from './adb';
import {
  bootEmulatorAsync,
  bootSimulatorAsync,
  BOOT_DEVICE_TIMEOUT_MS,
  compareSimulators,
  compareVersions,
  CREATED_SIMULATOR_PREFIX,
  emulatorPort,
  emulatorSerial,
  findFreeEmulatorPortAsync,
  parseAvds,
  parseSimulators,
  resolveEmulator,
  shutdownDeviceAsync,
  type EmulatorBoot,
  type SimulatorEntry,
} from './bootDevice';
import { androidDeviceNameAsync } from './installDevBuild';
import { describeReapedDevice, reapDeletedWorktreeClaimsAsync } from './reapClaims';
import { simulatorHasAppAsync } from './installedApps';

export type LocalDeviceBackend = 'local-ios' | 'local-android';

interface DeviceAnswer {
  ok: true;
  backend: LocalDeviceBackend;
  /** How the claim gets it: this worktree's claim, a free booted device, a free shut-down one, a new one. */
  action: DeviceAction;
  /** Why this device, as one clause for a report. */
  choice: string;
  /** Whether the device has {@link ResolveClaimedDeviceOptions.appId}. Null when nobody asked. */
  hasApp: boolean | null;
  /** Android only: the adb every later call on this device uses. */
  adb: AdbResolution | null;
}

interface ExistingDevice extends DeviceAnswer {
  /** Simulator UDID or adb serial. */
  id: string;
  name: string;
  state: DeviceCandidate['state'];
}

/** The device a claim would get now, as `peek` answers without claiming it. */
export type PeekedDevice =
  | ExistingDevice
  /** The simulator `create` has not made yet. */
  | (DeviceAnswer & { action: 'create'; id: null; name: null; state: null });

export interface ClaimedDevice extends ExistingDevice {
  state: 'booted';
  claim: DeviceClaim;
  /** This call booted the device. */
  booted: boolean;
}

export type DeviceRefusalKind =
  /** `simctl` or `adb` could not run. */
  | 'no-tool'
  /** `simctl` or `adb` failed, or the registry could not be read or written. Nothing was claimed. */
  | 'unavailable'
  /** No device is up (allowBoot false), or none exists to boot. */
  | 'no-device'
  /** `DEVICES_ALL_CLAIMED`. */
  | 'exhausted'
  /** `--device` named nothing this machine has. */
  | 'not-found'
  /** `--device` named a device another live worktree holds, or one took the claim over meanwhile. */
  | 'claimed'
  /** {@link ResolveClaimedDeviceOptions.requireApp}, and the device to boot has not got the app. */
  | 'no-app'
  | 'boot-failed';

export interface DeviceRefusal {
  ok: false;
  kind: DeviceRefusalKind;
  /** One clause, in the words the device probes used before claims: "no booted iOS simulator was found". */
  reason: string;
  error: CommandError;
  /** The device a failed boot was about. */
  deviceId: string | null;
  name: string | null;
  /**
   * `no-device` only: booted devices exist, and other live worktrees hold every one of them. A
   * caller that would fall back to "the first booted device" must refuse instead.
   */
  holders: { id: string; projectRoot: string }[];
}

export type ClaimedDeviceResult = ClaimedDevice | DeviceRefusal;

export type PeekedDeviceResult = PeekedDevice | DeviceRefusal;

export interface ResolveClaimedDeviceOptions {
  /**
   * `claim` reaps deleted worktrees, writes and touches the claim, and boots or creates the device.
   * `peek` is for a verb that only reads: the same choice and the same refusals, and it reaps,
   * writes, releases, boots and creates nothing.
   */
  mode: 'claim' | 'peek';
  platform: DevicePlatform;
  projectRoot: string;
  /** `--device`: a UDID, serial or name. Skips allocation, and still writes the claim. */
  explicit?: string | null;
  /** False for verbs that read a device: they never boot or create one. A peek only says it would. */
  allowBoot: boolean;
  /** Devices with this app installed rank first among the shut-down ones. */
  appId?: string | null;
  /** Decline to boot a device that has not got {@link appId}. */
  requireApp?: boolean;
  timeoutMs?: number;
  /** Told the device before it boots, so a boot that hangs is still one the caller holds. */
  onBooting?: (device: { deviceId: string; backend: LocalDeviceBackend }) => void;
}

interface LocalCandidate extends DeviceCandidate {
  name: string;
  /** Simulators only. */
  simulator?: SimulatorEntry;
  hasApp?: boolean;
  /** Emulators that are not running: how to start one on this serial. */
  emulator?: EmulatorBoot;
}

interface Inventory {
  candidates: LocalCandidate[];
  adb: AdbResolution | null;
  /** Android with allowBoot: how many AVDs this machine has. Null when nobody listed them. */
  avdCount: number | null;
}

type InventoryResult = { ok: true; inventory: Inventory } | DeviceRefusal;

const BACKEND: Record<DevicePlatform, LocalDeviceBackend> = {
  ios: 'local-ios',
  android: 'local-android',
};

const NOUN: Record<DevicePlatform, string> = {
  ios: 'iOS simulator',
  android: 'Android emulator',
};

/**
 * How many devices of one platform this machine may hold claims on.
 *
 * simlock's defaults, which budget about 1.5 GiB per simulator and 4 GiB per emulator.
 */
export function deviceCapacity(
  platform: DevicePlatform,
  {
    env = process.env,
    cpus = os.cpus().length,
    totalMemBytes = os.totalmem(),
  }: { env?: NodeJS.ProcessEnv; cpus?: number; totalMemBytes?: number } = {}
): number {
  const override = Number(env.EXPO_AGENT_MAX_DEVICES);
  if (Number.isInteger(override) && override > 0) {
    return override;
  }
  if (platform === 'ios') {
    return Math.max(1, Math.floor(cpus / 2));
  }
  const totalRamGb = totalMemBytes / 1024 ** 3;
  return Math.max(1, Math.min(Math.floor(cpus / 4), Math.floor(totalRamGb / 8)));
}

interface Seen {
  inventory: Inventory | null;
  claims: ClassifiedClaim[];
}

export async function resolveClaimedDeviceAsync(
  options: ResolveClaimedDeviceOptions & { mode: 'peek' }
): Promise<PeekedDeviceResult>;
export async function resolveClaimedDeviceAsync(
  options: ResolveClaimedDeviceOptions & { mode: 'claim' }
): Promise<ClaimedDeviceResult>;
export async function resolveClaimedDeviceAsync(
  options: ResolveClaimedDeviceOptions
): Promise<ClaimedDeviceResult | PeekedDeviceResult>;
export async function resolveClaimedDeviceAsync(
  options: ResolveClaimedDeviceOptions
): Promise<ClaimedDeviceResult | PeekedDeviceResult> {
  const projectRoot = canonicalizeExistingPath(options.projectRoot);
  if (options.mode === 'claim') {
    // @ref llp/0030-one-device-per-agent.rfc.md §Release and cleanup
    for (const device of await reapDeletedWorktreeClaimsAsync(projectRoot)) {
      Log.progress(`Reaped ${describeReapedDevice(device)}.`);
    }
  }
  const seen: Seen = { inventory: null, claims: [] };
  const result = await resolveWithInventoryAsync(options, projectRoot, seen);
  if (result.ok || result.kind !== 'no-device') {
    return result;
  }
  const holders = holdersOfEveryBooted(BACKEND[options.platform], projectRoot, seen);
  if (holders.length === 0) {
    return result;
  }
  const error = devicesAllClaimedError(
    options.platform,
    holders,
    `Every booted ${NOUN[options.platform]} is claimed by another worktree.`
  );
  return { ...result, holders, error };
}

/** The live claims of other worktrees on the booted devices, when they cover every booted one. */
function holdersOfEveryBooted(
  backend: LocalDeviceBackend,
  projectRoot: string,
  { inventory, claims }: Seen
): { id: string; projectRoot: string }[] {
  const holders: { id: string; projectRoot: string }[] = [];
  for (const candidate of inventory?.candidates ?? []) {
    if (candidate.state !== 'booted') {
      continue;
    }
    const holder = claims.find(
      (claim) =>
        claim.backend === backend &&
        claim.id === candidate.id &&
        claim.liveness === 'live' &&
        claim.projectRoot !== projectRoot
    );
    if (holder == null) {
      return [];
    }
    holders.push({ id: holder.id, projectRoot: holder.projectRoot });
  }
  return holders;
}

async function resolveWithInventoryAsync(
  options: ResolveClaimedDeviceOptions,
  projectRoot: string,
  seen: Seen
): Promise<ClaimedDeviceResult | PeekedDeviceResult> {
  const { mode, platform, explicit, allowBoot } = options;
  const backend = BACKEND[platform];

  const listDevices = async (claims: ClassifiedClaim[]): Promise<LocalCandidate[]> => {
    seen.claims = claims;
    const listed = await listInventoryAsync(platform, {
      claims,
      projectRoot,
      appId: options.appId ?? null,
      explicit: explicit != null,
      allowBoot,
    });
    if (!listed.ok) {
      throw new InventoryRefusal(listed);
    }
    seen.inventory = listed.inventory;
    return listed.inventory.candidates;
  };

  let picked: {
    action: DeviceAction;
    candidate: LocalCandidate;
    /** Never written by a peek. */
    claim: DeviceClaim;
    fresh: boolean;
    choice: string;
  };
  try {
    // A simulator created now has no app, so a caller that needs the app gets none created.
    const canCreate = allowBoot && platform === 'ios' && !explicit && !options.requireApp;
    const shared = {
      projectRoot,
      platform,
      backend,
      listDevices,
      capacity: deviceCapacity(platform),
      rank: rankCandidates,
      explicit: explicit ?? undefined,
      matches: (candidate: LocalCandidate, query: string) =>
        candidate.id === query || candidate.name === query,
      // The name outlives the claim: `dev:stop` deletes the claim, and a crash between
      // `simctl create` and the claim write leaves none.
      isCreated: (candidate: LocalCandidate) =>
        candidate.simulator != null && candidate.name.startsWith(CREATED_SIMULATOR_PREFIX),
    };
    const allocation =
      mode === 'peek'
        ? await peekDeviceAsync({ ...shared, canCreate })
        : await allocateDeviceAsync({
            ...shared,
            createDevice: canCreate ? createSimulatorAsync : undefined,
            deleteDevice: platform === 'ios' ? deleteSimulatorAsync : undefined,
          });
    switch (allocation.kind) {
      case 'reuse': {
        const candidate = seen.inventory!.candidates.find(({ id }) => id === allocation.claim.id)!;
        picked = {
          action: 'reuse',
          candidate,
          claim: allocation.claim,
          fresh: false,
          choice: explicit ? '--device named it' : 'this worktree claimed it already',
        };
        break;
      }
      case 'take':
        picked = {
          ...allocation,
          action: 'take',
          fresh: true,
          choice: explicit ? '--device named it' : 'it was up and no other worktree claimed it',
        };
        break;
      case 'boot':
        picked = {
          ...allocation,
          action: 'boot',
          fresh: true,
          choice: explicit
            ? '--device named it'
            : allocation.candidate.hasApp
              ? `it has ${options.appId} installed`
              : platform === 'ios'
                ? 'it is the free simulator this machine last used'
                : 'no other worktree claimed this emulator',
        };
        break;
      case 'create':
        return {
          ok: true,
          backend,
          action: 'create',
          id: null,
          name: null,
          state: null,
          choice: 'every simulator is claimed, so one would be created for this worktree',
          hasApp: options.appId != null ? false : null,
          adb: null,
        };
      case 'created':
        picked = {
          ...allocation,
          action: 'create',
          candidate: {
            ...allocation.candidate,
            hasApp: options.appId != null ? false : allocation.candidate.hasApp,
          },
          fresh: true,
          choice: 'every simulator was claimed, so this one was created for this worktree',
        };
        break;
      case 'exhausted':
        return exhaustedRefusal(platform, allocation.holders, seen.inventory, allowBoot);
      case 'claimed':
        return explicitClaimedRefusal(explicit!, allocation.holders);
      case 'not-found':
        return explicitNotFoundRefusal(platform, explicit!, seen.inventory);
    }
  } catch (error: unknown) {
    if (error instanceof InventoryRefusal) {
      return error.refusal;
    }
    return unavailableRefusal(
      platform,
      error instanceof Error ? error.message : String(error),
      (error as NodeJS.ErrnoException).code
        ? `make ${deviceRegistryDirectory()} writable: every worktree's device claims are kept there`
        : 'fix the failure above, then run the command again'
    );
  }

  const { action, candidate, claim, fresh, choice } = picked;
  const adb = seen.inventory?.adb ?? null;
  const peeked = (): ExistingDevice => ({
    ok: true,
    backend,
    action,
    id: candidate.id,
    name: candidate.name,
    state: candidate.state,
    choice,
    hasApp: candidate.hasApp ?? null,
    adb,
  });
  const device = async (booted: boolean): Promise<ClaimedDeviceResult> => {
    const held = touchClaim(claim) ?? heldClaim(claim);
    if (held == null) {
      return lostClaimRefusal(platform, candidate, readClaim(backend, candidate.id));
    }
    if (explicit) {
      // One device per platform per worktree: the named device replaces the one held before, but
      // only once it proved usable, so a failed `--device` keeps the device that works. The claim
      // goes even when the shutdown fails, so the named device is the one this worktree holds.
      await releaseProjectClaimsAsync(projectRoot, async (other) => {
        if (other.backend !== backend || other.id === candidate.id) {
          return { release: false };
        }
        if (other.booted || other.created) {
          const shutdown = await shutdownDeviceAsync(other.id, backend, { adb: adb ?? undefined });
          if (!shutdown.ok) {
            Log.progress(`${other.id}, which --device replaced, is still up: ${shutdown.reason}.`);
          }
        }
        return { release: true };
      });
    }
    return { ...peeked(), state: 'booted', claim: held, booted };
  };

  if (candidate.state === 'booted') {
    return mode === 'peek' ? peeked() : await device(false);
  }
  if (!allowBoot) {
    if (fresh && mode === 'claim') {
      releaseClaim(claim);
    }
    return refusal(
      'no-device',
      fresh
        ? noBootedReason(platform, seen.inventory)
        : `the ${NOUN[platform]} this worktree claimed (${candidate.name}) is not booted`
    );
  }

  // A boot that cannot open the app costs a minute and answers nothing (llp/0005 §The device that
  // can open the app), so it is declined before it starts.
  if (options.requireApp && candidate.hasApp === false) {
    if (fresh && mode === 'claim') {
      releaseClaim(claim);
    }
    return refusal(
      'no-app',
      `no free ${NOUN[platform]} has ${options.appId} installed, so booting one would open nothing`
    );
  }

  if (platform === 'android' && candidate.emulator == null) {
    return refusal(
      'no-device',
      `this machine has no Android virtual device to start ${candidate.id} with. Create one in Android Studio Device Manager`
    );
  }
  if (mode === 'peek') {
    return peeked();
  }

  // `dev:stop` shuts down only a device whose claim says this CLI booted it, and a boot that times
  // out has still started the device. So the claim says so before the wait.
  const booting = (await markClaimBootedAsync(claim)) ?? heldClaim(claim);
  if (booting == null) {
    return lostClaimRefusal(platform, candidate, readClaim(backend, candidate.id));
  }
  options.onBooting?.({ deviceId: candidate.id, backend });
  const timeoutMs = options.timeoutMs ?? BOOT_DEVICE_TIMEOUT_MS[platform];
  const emulatorBoot = candidate.emulator
    ? await bootEmulatorAsync(candidate.emulator, { timeoutMs, adb: adb ?? undefined, choice })
    : null;
  const boot =
    emulatorBoot ??
    (await bootSimulatorAsync({ udid: candidate.id, name: candidate.name }, { timeoutMs, choice }));
  if (!boot.ok) {
    const ownsSerial = emulatorBoot?.ownsSerial ?? true;
    await withRegistryLockAsync(async () => {
      const shutdown = ownsSerial
        ? await shutdownDeviceAsync(candidate.id, backend, { adb: adb ?? undefined })
        : null;
      if (!shutdown?.ok) {
        emulatorBoot?.kill();
      }
      // A serial another emulator answers on is not this worktree's to hold.
      if (fresh || !ownsSerial) {
        releaseClaim(booting);
      }
    });
    return {
      ...refusal('boot-failed', boot.reason ?? `${candidate.name} did not boot`),
      deviceId: candidate.id,
      name: candidate.name,
    };
  }
  return await device(true);
}

/** The claim, when its file still names it. A touch can fail on IO alone. */
function heldClaim(claim: DeviceClaim): DeviceClaim | null {
  const current = readClaim(claim.backend, claim.id);
  return current != null && isSameClaim(current, claim) ? current : null;
}

/** The claim was released or taken over while this call held it. Nothing is released here. */
function lostClaimRefusal(
  platform: DevicePlatform,
  candidate: LocalCandidate,
  current: DeviceClaim | null
): DeviceRefusal {
  const lost = { deviceId: candidate.id, name: candidate.name };
  if (current != null) {
    const error = new CommandError(
      'DEVICE_CLAIMED',
      [
        `${candidate.name} (${candidate.id}) was claimed by another worktree while this command used it: ${current.projectRoot}.`,
        `How: run this command again, so this worktree gets a device of its own.`,
      ].join('\n')
    );
    error.data = { id: current.id, projectRoot: current.projectRoot };
    return {
      ...refusal('claimed', `${candidate.name} is claimed by ${current.projectRoot}`, error),
      ...lost,
    };
  }
  return {
    ...refusal(
      'no-device',
      `this worktree's claim on the ${NOUN[platform]} ${candidate.name} was released while this command used it`
    ),
    ...lost,
  };
}

/** Carries a refusal out of `listDevices`, which runs inside the registry lock. */
class InventoryRefusal extends Error {
  constructor(readonly refusal: DeviceRefusal) {
    super(refusal.reason);
  }
}

function refusal(kind: DeviceRefusalKind, reason: string, error?: CommandError): DeviceRefusal {
  return {
    ok: false,
    kind,
    reason,
    error: error ?? new CommandError('NO_DEVICE', `${capitalize(reason)}.`),
    deviceId: null,
    name: null,
    holders: [],
  };
}

/** A tool or the registry failed, so this worktree cannot know which device is its own. */
function unavailableRefusal(platform: DevicePlatform, why: string, how: string): DeviceRefusal {
  const what = `no ${NOUN[platform]} could be claimed for this worktree`;
  return refusal(
    'unavailable',
    `${what}: ${why}`,
    new CommandError(
      'DEVICE_UNAVAILABLE',
      [`${capitalize(what)}.`, `Why: ${why}.`, `How: ${how}.`].join('\n')
    )
  );
}

function noBootedReason(platform: DevicePlatform, inventory: Inventory | null): string {
  const anyBooted = inventory?.candidates.some((candidate) => candidate.state === 'booted');
  if (anyBooted) {
    return `every booted ${NOUN[platform]} is claimed by another worktree`;
  }
  return platform === 'ios'
    ? 'no booted iOS simulator was found'
    : 'no Android device or emulator is attached';
}

function exhaustedRefusal(
  platform: DevicePlatform,
  holders: { id: string; projectRoot: string }[],
  inventory: Inventory | null,
  allowBoot: boolean
): DeviceRefusal {
  if (holders.length === 0) {
    return refusal(
      'no-device',
      !allowBoot
        ? noBootedReason(platform, inventory)
        : platform === 'ios'
          ? 'this machine has no iOS simulator to boot. Install an iOS runtime in Xcode Settings > Components'
          : inventory?.avdCount
            ? 'no emulator console port in 5554-5584 is free to start an Android virtual device on'
            : 'this machine has no Android virtual device to start. Create one in Android Studio Device Manager, or name a USB device with --device <serial>'
    );
  }
  const error = devicesAllClaimedError(platform, holders);
  return refusal('exhausted', error.message.split('\n', 1)[0]!, error);
}

function rankCandidates(left: LocalCandidate, right: LocalCandidate): number {
  const byApp = Number(right.hasApp ?? false) - Number(left.hasApp ?? false);
  if (byApp !== 0) {
    return byApp;
  }
  return left.simulator && right.simulator ? compareSimulators(left.simulator, right.simulator) : 0;
}

function explicitNotFoundRefusal(
  platform: DevicePlatform,
  explicit: string,
  inventory: Inventory | null
): DeviceRefusal {
  const known = inventory?.candidates.map(({ id, name }) => `${name} (${id})`).join(', ') || 'none';
  const error = new CommandError(
    'DEVICE_NOT_FOUND',
    [
      `--device "${explicit}" names no ${NOUN[platform]} on this machine.`,
      `Why: it matches no UDID, serial or name. Known: ${known}.`,
      `How: pass one of the names or ids above, or drop --device to use the device this worktree claimed.`,
    ].join('\n')
  );
  return refusal(
    'not-found',
    `--device "${explicit}" names no ${NOUN[platform]} on this machine`,
    error
  );
}

function explicitClaimedRefusal(
  explicit: string,
  holders: { id: string; projectRoot: string }[]
): DeviceRefusal {
  const roots = [...new Set(holders.map(({ projectRoot }) => projectRoot))].join(', ');
  const error = new CommandError(
    'DEVICE_CLAIMED',
    [
      `--device "${explicit}" is claimed by another worktree: ${roots}.`,
      `How: run dev:stop in that worktree, or name another device.`,
    ].join('\n')
  );
  error.data = { id: holders[0]!.id, projectRoot: holders[0]!.projectRoot, holders };
  return refusal('claimed', `${explicit} is claimed by ${roots}`, error);
}

interface InventoryOptions {
  claims: ClassifiedClaim[];
  projectRoot: string;
  appId: string | null;
  /** `--device` is matched against this inventory, so physical devices and idle AVDs are in it. */
  explicit: boolean;
  allowBoot: boolean;
}

async function listInventoryAsync(
  platform: DevicePlatform,
  options: InventoryOptions
): Promise<InventoryResult> {
  return platform === 'ios'
    ? await listSimulatorsAsync(options.appId)
    : await listEmulatorsAsync(options);
}

async function listSimulatorsAsync(appId: string | null): Promise<InventoryResult> {
  const listed = await spawnCaptureAsync('xcrun', ['simctl', 'list', 'devices', '-j'], {
    timeoutMs: 60_000,
  });
  if (listed.spawnError) {
    return refusal(
      'no-tool',
      `could not run "xcrun simctl": ${listed.spawnError.message}`,
      new CommandError(
        'XCRUN_NOT_RUNNABLE',
        [
          `Could not run "xcrun simctl", so no iOS simulator was looked for.`,
          `Why: ${listed.spawnError.message}`,
          `How: install Xcode and its command line tools, which provide "xcrun simctl", or pass --eas to run the app on an EAS Simulator session.`,
        ].join('\n')
      )
    );
  }
  if (listed.exitCode !== 0) {
    return unavailableRefusal(
      'ios',
      `"xcrun simctl list devices" failed: ${listed.stderr.trim() || `exit code ${listed.exitCode}`}`,
      'run "xcrun simctl list devices" and fix what it reports'
    );
  }
  const simulators = parseSimulators(listed.stdout).filter((entry) => entry.isAvailable);
  const candidates = await Promise.all(
    simulators.map(async (entry): Promise<LocalCandidate> => ({
      id: entry.udid,
      name: entry.name,
      state: entry.state === 'Booted' ? 'booted' : 'shutdown',
      simulator: entry,
      hasApp: appId != null && (await simulatorHasAppAsync(entry.udid, appId).catch(() => false)),
    }))
  );
  return { ok: true, inventory: { candidates, adb: null, avdCount: null } };
}

/**
 * Running emulators, this worktree's claims, and at most one emulator that could be started.
 *
 * Physical devices are never allocated (llp/0030 §Out of scope): one is listed only when this
 * worktree claimed it with `--device`, or when `--device` is being matched now.
 */
async function listEmulatorsAsync({
  claims: allClaims,
  projectRoot,
  explicit,
  allowBoot,
}: InventoryOptions): Promise<InventoryResult> {
  const adb = resolveAdb();
  const listed = await runAdbAsync(['devices', '-l'], { adb, timeoutMs: 30_000 });
  if (listed.notRunnable) {
    const reason = listed.spawnError?.message ?? 'the process did not start';
    return refusal(
      'no-tool',
      `"adb" could not be run (${reason}), so no device was looked for`,
      adbNotRunnableError(adb, reason)
    );
  }
  if (listed.exitCode !== 0) {
    return unavailableRefusal(
      'android',
      `"${adb.bin} devices -l" failed: ${listed.stderr.trim() || `exit code ${listed.exitCode}`}`,
      `run "${adb.bin} devices -l" and fix what it reports`
    );
  }

  const claims = allClaims.filter((claim) => claim.backend === 'local-android');
  const mine = claims.filter((claim) => claim.projectRoot === projectRoot);
  // A dead worktree's claim holds nothing: the allocation removes it, and its port is free.
  const liveOthers = claims.filter(
    (claim) => claim.projectRoot !== projectRoot && claim.liveness === 'live'
  );
  const candidates: LocalCandidate[] = [];
  const runningAvds: string[] = [];
  for (const { deviceId, model } of parseAndroidDevices(listed.stdout)) {
    const isEmulator = emulatorPort(deviceId) != null;
    if (!isEmulator && !explicit && !mine.some((claim) => claim.id === deviceId)) {
      continue;
    }
    // The AVD name picks an idle AVD to boot and matches `--device`; a read needs neither.
    const name =
      isEmulator && (allowBoot || explicit)
        ? await androidDeviceNameAsync(deviceId, { run: runWith(adb) })
        : null;
    if (name) {
      runningAvds.push(name);
    }
    candidates.push({ id: deviceId, name: name ?? model ?? deviceId, state: 'booted' });
  }
  const running = new Set(candidates.map(({ id }) => id));
  const othersStarting = liveOthers.filter((claim) => !running.has(claim.id)).length;

  const avds = allowBoot ? await listAvdsAsync(adb) : [];
  // A claim has no AVD name, so an emulator another worktree is still starting may run any AVD.
  const inUse = (avd: string) => runningAvds.includes(avd) || othersStarting > 0;
  const avdFor = (preferred: string | null): { avd: string; readOnly: boolean } | null => {
    if (preferred != null) {
      return { avd: preferred, readOnly: inUse(preferred) };
    }
    const idle = avds.find((avd) => !runningAvds.includes(avd));
    if (idle) {
      return { avd: idle, readOnly: inUse(idle) };
    }
    return avds[0] ? { avd: avds[0], readOnly: true } : null;
  };
  const startable = (port: number, preferred: string | null = null): LocalCandidate | null => {
    const avd = avdFor(preferred);
    return avd
      ? { id: emulatorSerial(port), name: avd.avd, state: 'shutdown', emulator: { ...avd, port } }
      : null;
  };

  // This worktree's claim on an emulator that is not running (a boot in progress, or one that was
  // shut down) stays a candidate, so the allocation reuses it instead of releasing it.
  for (const claim of mine) {
    const port = emulatorPort(claim.id);
    if (port != null && !running.has(claim.id)) {
      candidates.push(startable(port) ?? { id: claim.id, name: claim.id, state: 'shutdown' });
    }
  }
  if (!allowBoot) {
    return { ok: true, inventory: { candidates, adb, avdCount: null } };
  }

  const taken = new Set([...mine, ...liveOthers].map((claim) => emulatorPort(claim.id)));
  const freePortAsync = () =>
    findFreeEmulatorPortAsync({
      skip: (port) => taken.has(port) || candidates.some(({ id }) => id === emulatorSerial(port)),
    });

  if (explicit) {
    // `--device <avd>` may name an AVD that is not running; it gets a port of its own.
    for (const avd of avds.filter(
      (name) => !candidates.some((candidate) => candidate.name === name)
    )) {
      const port = await freePortAsync();
      const candidate = port == null ? null : startable(port, avd);
      if (candidate == null) {
        break;
      }
      candidates.push(candidate);
    }
    return { ok: true, inventory: { candidates, adb, avdCount: avds.length } };
  }

  const holdsOne = candidates.some(({ state }) => state === 'shutdown');
  if (!holdsOne && running.size + othersStarting < deviceCapacity('android')) {
    const port = await freePortAsync();
    const candidate = port == null ? null : startable(port);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return { ok: true, inventory: { candidates, adb, avdCount: avds.length } };
}

function runWith(adb: AdbResolution): typeof runAdbAsync {
  return (args, options = {}) => runAdbAsync(args, { ...options, adb });
}

async function listAvdsAsync(adb: AdbResolution): Promise<string[]> {
  const listed = await spawnCaptureAsync(resolveEmulator(adb), ['-list-avds'], {
    timeoutMs: 60_000,
  });
  return listed.exitCode === 0 ? parseAvds(listed.stdout) : [];
}

/**
 * `simctl create` from the newest iOS runtime and the newest iPhone it supports.
 *
 * Into the default device set: `expo run:ios` has no `--set`, so it could not build for a
 * simulator in a private one (llp/0030 §Device set).
 */
async function createSimulatorAsync(): Promise<LocalCandidate> {
  const listed = await spawnCaptureAsync('xcrun', ['simctl', 'list', 'runtimes', '-j'], {
    timeoutMs: 60_000,
  });
  const runtime = newestIosRuntime(listed.exitCode === 0 ? listed.stdout : '');
  if (runtime == null) {
    throw new Error('no available iOS runtime has an iPhone device type');
  }
  const devices = await spawnCaptureAsync('xcrun', ['simctl', 'list', 'devices', '-j'], {
    timeoutMs: 60_000,
  });
  const taken = parseSimulators(devices.stdout).map(({ name }) => name);
  let index = 1;
  while (taken.includes(`${CREATED_SIMULATOR_PREFIX}${index}`)) {
    index += 1;
  }
  const name = `${CREATED_SIMULATOR_PREFIX}${index}`;
  const created = await spawnCaptureAsync(
    'xcrun',
    ['simctl', 'create', name, runtime.deviceType, runtime.identifier],
    { timeoutMs: 60_000 }
  );
  const udid = created.stdout.trim();
  if (created.exitCode !== 0 || !udid) {
    throw new Error(
      `"xcrun simctl create" exited ${created.exitCode}: ${created.stderr.trim() || 'no output'}`
    );
  }
  return { id: udid, name, state: 'shutdown' };
}

async function deleteSimulatorAsync(claim: DeviceClaim): Promise<void> {
  const deleted = await spawnCaptureAsync('xcrun', ['simctl', 'delete', claim.id], {
    timeoutMs: 60_000,
  });
  if (deleted.exitCode !== 0) {
    throw new Error(
      `"xcrun simctl delete ${claim.id}" exited ${deleted.exitCode}: ${deleted.stderr.trim() || 'no output'}`
    );
  }
}

/**
 * The newest available iOS runtime out of `simctl list runtimes -j`, with its newest iPhone.
 *
 * `supportedDeviceTypes` lists the newest device first [observed — 2026-09-30, Xcode 27: iOS 26.4
 * lists `iPhone 17 Pro` first and `iPhone 11` last].
 */
export function newestIosRuntime(
  stdout: string
): { identifier: string; deviceType: string } | null {
  let parsed: {
    runtimes?: {
      identifier?: string;
      version?: string;
      platform?: string;
      isAvailable?: boolean;
      supportedDeviceTypes?: { identifier?: string; productFamily?: string }[];
    }[];
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const runtimes = (parsed.runtimes ?? [])
    .filter(
      (runtime) =>
        runtime.isAvailable !== false &&
        (runtime.platform === 'iOS' || runtime.identifier?.includes('.iOS-')) &&
        runtime.identifier
    )
    .map((runtime) => ({
      identifier: runtime.identifier!,
      version: (runtime.version ?? '').split('.').map(Number),
      iPhones: (runtime.supportedDeviceTypes ?? []).filter(
        (type) => type.productFamily === 'iPhone' && type.identifier
      ),
    }))
    .filter((runtime) => runtime.iPhones.length > 0)
    .sort((left, right) => compareVersions(right.version, left.version));
  const newest = runtimes[0];
  return newest
    ? { identifier: newest.identifier, deviceType: newest.iPhones[0]!.identifier! }
    : null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
