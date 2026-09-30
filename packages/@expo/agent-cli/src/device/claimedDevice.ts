// @ref llp/0028-one-device-per-agent.rfc.md §Every verb uses the claim
// The one place a local verb gets its device: the device this worktree claimed on the platform, or
// a free one it claims now. It builds the local inventory for the registry's allocation, and boots
// the device when the caller allows it. Nothing else picks "the first booted" device.

import os from 'os';

import {
  allocateDeviceAsync,
  classifyClaimAsync,
  devicesAllClaimedError,
  readClaims,
  releaseClaim,
  touchClaim,
  withRegistryLockAsync,
  writeClaim,
  type DeviceCandidate,
  type DeviceClaim,
  type DevicePlatform,
} from '../deviceClaims';
import { removeClaimFile } from '../deviceClaims/registry';
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
  emulatorPort,
  emulatorSerial,
  findFreeEmulatorPortAsync,
  parseAvds,
  parseSimulators,
  resolveEmulator,
  type EmulatorBoot,
  type SimulatorEntry,
} from './bootDevice';
import { androidDeviceNameAsync } from './installDevBuild';
import { simulatorHasAppAsync } from './installedApps';

export type LocalDeviceBackend = 'local-ios' | 'local-android';

export interface ClaimedDevice {
  ok: true;
  backend: LocalDeviceBackend;
  /** Simulator UDID or adb serial. */
  id: string;
  name: string;
  claim: DeviceClaim;
  /** This call booted the device. */
  booted: boolean;
  /** Why this device, as one clause for a report. */
  choice: string;
  /** Android only: the adb every later call on this device uses. */
  adb: AdbResolution | null;
}

export type DeviceRefusalKind =
  /** `simctl` or `adb` could not run. */
  | 'no-tool'
  /** No device is up (allowBoot false), or none exists to boot. */
  | 'no-device'
  /** `DEVICES_ALL_CLAIMED`. */
  | 'exhausted'
  /** `--device` named nothing this machine has. */
  | 'not-found'
  /** `--device` named a device another live worktree holds. */
  | 'claimed'
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
}

export type ClaimedDeviceResult = ClaimedDevice | DeviceRefusal;

export interface ResolveClaimedDeviceOptions {
  platform: DevicePlatform;
  projectRoot: string;
  /** `--device`: a UDID, serial or name. Skips allocation, and still writes the claim. */
  explicit?: string | null;
  /** False for verbs that read a device: they never boot or create one. */
  allowBoot: boolean;
  /** Devices with this app installed rank first among the shut-down ones. */
  appId?: string | null;
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

export async function resolveClaimedDeviceAsync(
  options: ResolveClaimedDeviceOptions
): Promise<ClaimedDeviceResult> {
  const { platform, explicit, allowBoot } = options;
  const backend = BACKEND[platform];
  const projectRoot = canonicalizeExistingPath(options.projectRoot);

  const seen: { inventory: Inventory | null } = { inventory: null };
  const listDevices = async (): Promise<LocalCandidate[]> => {
    const listed = await listInventoryAsync(platform, {
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

  let picked: { candidate: LocalCandidate; claim: DeviceClaim; fresh: boolean; choice: string };
  try {
    if (explicit) {
      const result = await claimExplicitAsync(platform, projectRoot, explicit, await listDevices());
      if (!result.ok) {
        return result;
      }
      picked = result;
    } else {
      const allocation = await allocateDeviceAsync<LocalCandidate>({
        projectRoot,
        platform,
        backend,
        listDevices,
        createDevice: allowBoot && platform === 'ios' ? createSimulatorAsync : undefined,
        deleteDevice: platform === 'ios' ? deleteSimulatorAsync : undefined,
        capacity: deviceCapacity(platform),
        rank: rankCandidates,
      });
      switch (allocation.kind) {
        case 'reuse': {
          const candidate = seen.inventory!.candidates.find(
            ({ id }) => id === allocation.claim.id
          )!;
          picked = {
            candidate,
            claim: allocation.claim,
            fresh: false,
            choice: 'this worktree claimed it already',
          };
          break;
        }
        case 'take':
          picked = {
            ...allocation,
            fresh: true,
            choice: 'it was up and no other worktree claimed it',
          };
          break;
        case 'boot':
          picked = {
            ...allocation,
            fresh: true,
            choice: allocation.candidate.hasApp
              ? `it has ${options.appId} installed`
              : platform === 'ios'
                ? 'it is the free simulator this machine last used'
                : 'no other worktree claimed this emulator',
          };
          break;
        case 'created':
          picked = {
            ...allocation,
            fresh: true,
            choice: 'every simulator was claimed, so this one was created for this worktree',
          };
          break;
        case 'exhausted':
          return exhaustedRefusal(platform, allocation.holders, seen.inventory, allowBoot);
      }
    }
  } catch (error: unknown) {
    if (error instanceof InventoryRefusal) {
      return error.refusal;
    }
    return refusal(
      'no-device',
      `no ${NOUN[platform]} could be claimed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const { candidate, claim, fresh, choice } = picked;
  const adb = seen.inventory?.adb ?? null;
  const device = (booted: boolean): ClaimedDevice => ({
    ok: true,
    backend,
    id: candidate.id,
    name: candidate.name,
    claim: touchClaim(claim) ?? claim,
    booted,
    choice,
    adb,
  });

  if (candidate.state === 'booted') {
    return device(false);
  }
  if (!allowBoot) {
    if (fresh) {
      releaseClaim(claim);
    }
    return refusal(
      'no-device',
      fresh
        ? noBootedReason(platform, seen.inventory)
        : `the ${NOUN[platform]} this worktree claimed (${candidate.name}) is not booted`
    );
  }

  if (platform === 'android' && candidate.emulator == null) {
    return refusal(
      'no-device',
      `this machine has no Android virtual device to start ${candidate.id} with. Create one in Android Studio Device Manager`
    );
  }

  options.onBooting?.({ deviceId: candidate.id, backend });
  const timeoutMs = options.timeoutMs ?? BOOT_DEVICE_TIMEOUT_MS[platform];
  const boot = candidate.emulator
    ? await bootEmulatorAsync(candidate.emulator, { timeoutMs, adb: adb ?? undefined, choice })
    : await bootSimulatorAsync({ udid: candidate.id, name: candidate.name }, { timeoutMs, choice });
  if (!boot.ok) {
    return {
      ...refusal('boot-failed', boot.reason ?? `${candidate.name} did not boot`),
      deviceId: candidate.id,
      name: candidate.name,
    };
  }
  return device(true);
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
  };
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
      allowBoot
        ? platform === 'ios'
          ? 'this machine has no iOS simulator to boot. Install an iOS runtime in Xcode Settings > Components'
          : 'this machine has no Android virtual device to start. Create one in Android Studio Device Manager'
        : noBootedReason(platform, inventory)
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

async function claimExplicitAsync(
  platform: DevicePlatform,
  projectRoot: string,
  explicit: string,
  candidates: LocalCandidate[]
): Promise<
  | { ok: true; candidate: LocalCandidate; claim: DeviceClaim; fresh: boolean; choice: string }
  | DeviceRefusal
> {
  const backend = BACKEND[platform];
  const matches = candidates.filter(({ id, name }) => id === explicit || name === explicit);
  const candidate =
    matches.find(({ id }) => id === explicit) ??
    matches.find(({ state }) => state === 'booted') ??
    matches[0];
  if (candidate == null) {
    const known = candidates.map(({ id, name }) => `${name} (${id})`).join(', ') || 'none';
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

  return await withRegistryLockAsync(async () => {
    const claims = readClaims().filter((claim) => claim.backend === backend);
    const existing = claims.find((claim) => claim.id === candidate.id);
    if (existing && existing.projectRoot !== projectRoot) {
      if ((await classifyClaimAsync(existing)) === 'live') {
        const error = new CommandError(
          'DEVICE_CLAIMED',
          [
            `--device "${explicit}" is claimed by another worktree: ${existing.projectRoot}.`,
            `How: run dev:stop in that worktree, or name another device.`,
          ].join('\n')
        );
        error.data = { id: candidate.id, projectRoot: existing.projectRoot };
        return refusal('claimed', `${candidate.name} is claimed by ${existing.projectRoot}`, error);
      }
      removeClaimFile(existing);
    }
    // One device per platform per worktree: naming another gives up the one held before.
    for (const claim of claims) {
      if (claim.projectRoot === projectRoot && claim.id !== candidate.id) {
        releaseClaim(claim);
      }
    }
    if (existing?.projectRoot === projectRoot) {
      return {
        ok: true as const,
        candidate,
        claim: existing,
        fresh: false,
        choice: '--device named it',
      };
    }
    const now = new Date().toISOString();
    const claim: DeviceClaim = {
      backend,
      platform,
      id: candidate.id,
      projectRoot,
      pid: process.pid,
      claimedAt: now,
      touchedAt: now,
      created: existing?.created ?? false,
    };
    writeClaim(claim);
    return { ok: true as const, candidate, claim, fresh: true, choice: '--device named it' };
  });
}

interface InventoryOptions {
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
    return refusal(
      'no-device',
      `"xcrun simctl list devices" failed: ${listed.stderr.trim() || `exit code ${listed.exitCode}`}`
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
  return { ok: true, inventory: { candidates, adb: null } };
}

/**
 * Running emulators, this worktree's claims, and at most one emulator that could be started.
 *
 * Physical devices are never allocated (llp/0028 §Out of scope): one is listed only when this
 * worktree claimed it with `--device`, or when `--device` is being matched now.
 */
async function listEmulatorsAsync({
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
    return refusal(
      'no-device',
      `"${adb.bin} devices -l" failed: ${listed.stderr.trim() || `exit code ${listed.exitCode}`}`
    );
  }

  const claims = readClaims().filter((claim) => claim.backend === 'local-android');
  const mine = claims.filter((claim) => claim.projectRoot === projectRoot);
  const candidates: LocalCandidate[] = [];
  const runningAvds: string[] = [];
  for (const { deviceId, model } of parseAndroidDevices(listed.stdout)) {
    const isEmulator = emulatorPort(deviceId) != null;
    if (!isEmulator && !explicit && !mine.some((claim) => claim.id === deviceId)) {
      continue;
    }
    const name = isEmulator ? await androidDeviceNameAsync(deviceId, { run: runWith(adb) }) : null;
    if (name) {
      runningAvds.push(name);
    }
    candidates.push({ id: deviceId, name: name ?? model ?? deviceId, state: 'booted' });
  }
  const running = new Set(candidates.map(({ id }) => id));
  const othersStarting = claims.filter(
    (claim) => claim.projectRoot !== projectRoot && !running.has(claim.id)
  ).length;

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
    return { ok: true, inventory: { candidates, adb } };
  }

  const taken = new Set(claims.map((claim) => emulatorPort(claim.id)));
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
    return { ok: true, inventory: { candidates, adb } };
  }

  const holdsOne = candidates.some(({ state }) => state === 'shutdown');
  if (!holdsOne && running.size + othersStarting < deviceCapacity('android')) {
    const port = await freePortAsync();
    const candidate = port == null ? null : startable(port);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return { ok: true, inventory: { candidates, adb } };
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
 * simulator in a private one (llp/0028 §Device set).
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
  while (taken.includes(`agent-cli ${index}`)) {
    index += 1;
  }
  const name = `agent-cli ${index}`;
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
