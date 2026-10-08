// @ref llp/0005-runtime-loop-tools.rfc.md
// @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator
// @ref llp/0030-one-device-per-worktree.rfc.md §Readers
// Device resolution for deep-link navigation. Three backends. The local ones are the devices this
// worktree bound with `dev` (`src/deviceBinding/`), read from the registry and verified through
// the platform tools as subprocesses; until llp/0032 binds Android, that rung is still the first
// attached `adb` device.
//
// The third is not on this machine at all: an EAS Simulator session, driven through `eas
// simulator:*` (`src/device/cloudSimulator.ts`). It is opt-in per caller rather than always
// considered, because it is the only backend that costs money and the only one whose invocations
// this package has never verified against a live service. `navigate` and `smoke` put it on their
// ladder as a *fallback*; `runtime:stop` and `runtime:reload` reach for it only when `--eas`
// names it, so a session that happens to be up never quietly bills a run a local device would have
// served.

import {
  adbNotRunnableError,
  parseAndroidDevices,
  resolveAdb,
  runAdbAsync,
  type AdbResolution,
} from '../device/adb';
import {
  cloudSessionStartCommand,
  cloudPlatformUnknownError,
  cloudPlatformMismatchError,
  cloudSessionUnavailableError,
  cloudSessionUnknownError,
  probeCloudSessionAsync,
  readCloudSessionIdSync,
  type CloudSessionProbe,
} from '../device/cloudSimulator';
import { findBoundDeviceAsync, type AndroidRung, type BoundDevice } from '../deviceBinding';
import { PROGRAM_PREFIX } from '../programName';
import { CommandError } from '../utils/errors';
import { debugEvent } from './events';

export type NavigatePlatform = 'ios' | 'android';

/**
 * Which of the three device layers acted.
 *
 * Reported rather than inferred from `platform`, because `ios` no longer says where the device is:
 * a cloud session runs iOS too, and the difference decides whether the dev server has to be
 * tunnelled, whether `adb reverse` applies, and which command a reader can run by hand.
 */
export type DeviceBackend = 'local-ios' | 'local-android' | 'cloud';

export interface NavigateDevice {
  backend: DeviceBackend;
  platform: NavigatePlatform;
  /** Simulator UDID, or `adb` serial. */
  deviceId: string;
  /** Simulator name, when the platform tool reports one. */
  name?: string;
  /**
   * The `adb` this device was found with, so every later call uses the same binary.
   *
   * Android only. Resolving once and carrying it is what stops a run from finding the SDK for the
   * device probe and then spawning a bare `adb` for the deep link (`src/device/adb.ts`).
   */
  adb?: AdbResolution;
  /** The device's hardware model, as `adb devices -l` reports it. Android only. */
  model?: string;
}

export interface DeviceProbe {
  device: NavigateDevice | null;
  /** Why no device was found, for the error message. */
  reason?: string;
  /**
   * The device tool itself could not be run, so nothing was asked about devices.
   *
   * Carried separately from {@link reason} because the two need different headlines: "no device is
   * attached" is a fact about the machine's devices, and this is a fact about the machine's SDK.
   * Reporting the first for the second is friction run 6's F49.
   */
  toolError?: CommandError;
}

/** A bound device as the deep-link ladder drives it. */
export function navigateDeviceOf(device: BoundDevice): NavigateDevice {
  switch (device.backend) {
    case 'local-ios':
      return { backend: 'local-ios', platform: 'ios', deviceId: device.udid, name: device.name };
    case 'local-android':
      return {
        backend: 'local-android',
        platform: 'android',
        deviceId: device.serial,
        adb: resolveAdb(),
      };
    case 'cloud':
      return { backend: 'cloud', platform: device.platform, deviceId: device.id };
  }
}

/** Read the first ready device out of `adb devices`. */
export function parseFirstAndroidDevice(stdout: string): string | null {
  return parseAndroidDevices(stdout)[0]?.deviceId ?? null;
}

/**
 * Look for an attached Android device or emulator. Never throws: no device is an answer.
 *
 * An `adb` that could not be started is **not** folded into that answer. It comes back as
 * {@link DeviceProbe.toolError}, so the caller reports a missing SDK as a missing SDK — the
 * headline "no Android device or emulator is attached" is only reachable once `adb` has run
 * (`src/device/adb.ts`, friction run 6's F49).
 */
export async function probeAndroidDeviceAsync(): Promise<DeviceProbe> {
  const { stdout, stderr, exitCode, spawnError, adb, notRunnable } = await runAdbAsync([
    'devices',
    '-l',
  ]);

  if (notRunnable) {
    return {
      device: null,
      reason: `"adb" could not be run (${spawnError?.message ?? 'no reason given'}), so no device was looked for`,
      toolError: adbNotRunnableError(adb, spawnError?.message ?? 'the process did not start'),
    };
  }
  if (exitCode !== 0) {
    return {
      device: null,
      reason: `"${adb.bin} devices -l" failed: ${stderr.trim() || `exit code ${exitCode}`}`,
    };
  }

  const device = parseAndroidDevices(stdout)[0];
  if (!device) {
    return { device: null, reason: 'no Android device or emulator is attached' };
  }

  debugEvent('device_resolved', { platform: 'android', deviceId: device.deviceId });
  return {
    device: {
      backend: 'local-android',
      platform: 'android',
      deviceId: device.deviceId,
      adb,
      model: device.model ?? undefined,
    },
  };
}

/**
 * Main's Android rung as the rung loop takes it, until llp/0032 binds Android. The `adb` the probe
 * resolved is kept on the side, so `openRoute`'s `adb reverse` still runs with it.
 */
const androidRung = (found: { adb?: AdbResolution; model?: string }): AndroidRung => {
  return async () => {
    const probe = await probeAndroidDeviceAsync();
    if (probe.toolError) {
      return { device: null, toolError: probe.toolError };
    }
    if (!probe.device) {
      return { device: null };
    }
    found.adb = probe.device.adb;
    found.model = probe.device.model;
    return {
      device: {
        backend: 'local-android',
        platform: 'android',
        serial: probe.device.deviceId,
        origin: { kind: 'explicit' },
      },
    };
  };
};

/**
 * Look for a cloud simulator session this project can drive. Never throws: no session is an answer.
 *
 * **The service answers this, not the filesystem.** The first cut of this rung was gated on
 * `.env.eas-simulator` existing, which is cheaper and wrong in both directions: the file outlives
 * the session it names, and a session started by MCP, by another terminal, or by a
 * `simulator:start --json` never writes it. So the rung spawns one `eas simulator:list`, and the
 * cost of that is paid here on purpose — this is about to open a link on a device, and llp/0005
 * §Cloud simulator is where the split between this ladder and the instant suggestion ladders is
 * argued.
 *
 * `platform` is passed through as a **preference** for picking between several live sessions, not
 * as a filter: the caller compares afterwards, so a session on the other platform is reported as
 * one rather than hidden behind "no session".
 *
 * @see src/device/cloudSimulator.ts — where the argv lives, and how much of it has been verified.
 */
export async function probeCloudDeviceAsync(
  projectRoot: string,
  { platform = null }: { platform?: NavigatePlatform | null } = {}
): Promise<{ device: NavigateDevice | null; probe: CloudSessionProbe }> {
  const probe = await probeCloudSessionAsync({ projectRoot, platform });
  if (probe.state !== 'active' || probe.platform == null || probe.sessionId == null) {
    // A live session whose platform could not be read is not a device this can be handed: the URL
    // shape differs per platform. The caller raises `cloudPlatformUnknownError` for it.
    return { device: null, probe };
  }

  debugEvent('device_resolved', { platform: probe.platform, deviceId: probe.sessionId });
  return {
    device: {
      backend: 'cloud',
      platform: probe.platform,
      deviceId: probe.sessionId,
      // The session's own `--name` when it has one, because a project with several sessions up has
      // just had one chosen for it, and the name is what says which (llp/0005 §Cloud simulator).
      name: probe.sessionName ?? 'EAS Simulator session',
    },
    probe,
  };
}

/**
 * Resolve the device to open the deep link on.
 *
 * Three backends and one order. `--eas` (`cloud: 'required'`) names the cloud session and nothing
 * else is looked at, because a caller that named a device meant that device. Otherwise the
 * **bound** local device wins: the rung loop of llp/0030 §Readers inspects this worktree's
 * bindings, any `up` one wins, and the winner's lease is extended. The cloud is the last rung,
 * taken only when every local rung passed and this project has a session on record.
 *
 * @throws {CommandError} `NO_BOUND_DEVICE` when no local device is bound and no session serves,
 * and the tool error when a device tool could not run.
 */
export async function resolveDeviceAsync(
  platform: NavigatePlatform | undefined,
  context: ResolveDeviceContext
): Promise<NavigateDevice> {
  if (context.cloud === 'required') {
    return await resolveCloudDeviceAsync(platform, context);
  }

  const android: { adb?: AdbResolution; model?: string } = {};
  const found = await findBoundDeviceAsync(context.projectRoot, {
    platform,
    extend: true,
    android: androidRung(android),
  });
  if (found.device) {
    const device = navigateDeviceOf(found.device);
    debugEvent('device_resolved', { platform: device.platform, deviceId: device.deviceId });
    return device.backend === 'local-android' ? { ...device, ...android } : device;
  }

  // The cloud rung, before the tool failure and before the verdict: a machine whose `adb` will not
  // start is exactly the machine this backend is for, and a session that is up answers the question
  // whichever platform tool is missing.
  const cloud = await cloudFallbackAsync(platform, context);
  if (cloud.device) {
    return cloud.device;
  }
  if (found.toolError) {
    throw found.toolError;
  }
  throw withOtherDoors(found.refusal, context, cloud.probe);
}

/** How much of the ladder a caller wants: whether the cloud backend is on it, and how. */
export type CloudPreference =
  /** `--eas`: the session is the device, and no local tool is even asked. */
  | 'required'
  /** The default for the device-facing commands: local first, cloud when there is none. */
  | 'fallback'
  /**
   * Never. The default, and what a `runtime:*` action keeps until `--eas` names the backend.
   *
   * Not because the acts are impossible — the controller has `close <app-id>` and `open <url>`,
   * which is the whole of the stop-and-relaunch pair — but because a session **bills by the
   * minute**. A fallback that quietly reached one would spend somebody's money to answer a command
   * that asked about this machine (llp/0005 §Cloud simulator).
   */
  | 'off';

/** What the caller already worked out, and which backends it wants looked at. */
export interface ResolveDeviceContext {
  /** The URL that was resolved for the route, when the caller had got that far. */
  url?: string | null;
  /** Whether a dev server answered, so the URL is one something could act on now. */
  devServerRunning?: boolean;
  /** Whether the cloud backend is on this run's ladder. Defaults to `off`. */
  cloud?: CloudPreference;
  /** The worktree whose bindings, and whose session, are looked for. */
  projectRoot: string;
}

/**
 * The cloud rung of the ladder, taken after the local rungs passed.
 *
 * Until llp/0034 binds sessions, the fallback accepts the dotenv id only, never the newest
 * session: a worktree with no binding must not drive another worktree's session.
 *
 * A session on the **other** platform is not this run's device: `--ios` named iOS, and an Android
 * session cannot open an iOS link. It is still reported, through the probe, so the failure can say
 * that a session exists and is not the one that was asked for.
 */
async function cloudFallbackAsync(
  platform: NavigatePlatform | undefined,
  context: ResolveDeviceContext
): Promise<{ device: NavigateDevice | null; probe: CloudSessionProbe | null }> {
  if (context.cloud !== 'fallback') {
    return { device: null, probe: null };
  }
  // No dotenv id, no session this worktree may drive: nothing to ask the service about.
  const sessionId = readCloudSessionIdSync(context.projectRoot);
  if (sessionId == null) {
    return { device: null, probe: null };
  }
  const { device, probe } = await probeCloudDeviceAsync(context.projectRoot, { platform });
  const usable =
    device != null &&
    device.deviceId === sessionId &&
    (platform == null || device.platform === platform);
  return { device: usable ? device : null, probe };
}

/**
 * Resolve the cloud session as the device, for a run that named it.
 *
 * Every failure here is about the session rather than about this machine, which is why none of them
 * reuses {@link withOtherDoors}: a caller that passed `--eas` is not helped by "boot a simulator".
 */
async function resolveCloudDeviceAsync(
  platform: NavigatePlatform | undefined,
  context: ResolveDeviceContext
): Promise<NavigateDevice> {
  const { device, probe } = await probeCloudDeviceAsync(context.projectRoot, { platform });

  if (device) {
    if (platform != null && device.platform !== platform) {
      throw cloudPlatformMismatchError(platform, device.platform, device.deviceId);
    }
    return device;
  }

  if (probe.state === 'active' && probe.sessionId != null) {
    // The session is up and did not say what it is. A caller that named a platform has answered
    // that itself; one that did not is asked, rather than having a URL shape guessed for it.
    if (platform == null) {
      throw cloudPlatformUnknownError(probe.sessionId);
    }
    return {
      backend: 'cloud',
      platform,
      deviceId: probe.sessionId,
      name: 'EAS Simulator session',
    };
  }
  if (probe.state === 'unknown' || probe.state === 'active') {
    throw cloudSessionUnknownError(probe);
  }
  throw cloudSessionUnavailableError(probe);
}

/**
 * The registry's refusal, plus the URL when one was resolved and the session when one is on record.
 *
 * "No device" is the whole truth and less than half the answer for the case this exists for: a
 * dogfood session drove Expo Go on a **cloud** simulator, from a laptop with no simulator of its
 * own, and every `navigate` it ran stopped here [observed — 2026-08-24]. The URL was resolved a
 * step earlier and thrown away with the error, and the URL is exactly what an external opener
 * needs. So it is named, and so is the flag that prints it without asking for a device at all.
 *
 * Deliberately **not** applied to the tool failures: an unrunnable `adb` or `xcrun` has a headline
 * about this machine's SDK, and burying it under an alternative is friction run 6's F49.
 */
function withOtherDoors(
  refusal: CommandError,
  context: ResolveDeviceContext,
  cloudProbe: CloudSessionProbe | null
): CommandError {
  const lines = refusal.message.split('\n');
  // The How line stays last (llp/0030 §Output and errors), so the doors go in above it.
  const how = lines.pop()!;
  if (context.url) {
    lines.push(
      `Or: this is the URL for that route — ${context.url}${
        context.devServerRunning ? '' : ' (no dev server answered, so it may not load yet)'
      }. Open it on a phone, a cloud simulator, or anywhere else that can reach the dev server; "${PROGRAM_PREFIX} navigate <route> --print-url" prints it without looking for a device.`
    );
  }
  // A session on record that this run could not use is the one alternative worth naming above the
  // URL: it is a device this CLI *can* drive, and the reader is one command away from it. Only when
  // there is one — a project that has never started a session gets no advertisement for a paid
  // feature it may not have.
  const cloudLine = cloudSessionLine(cloudProbe);
  if (cloudLine) {
    lines.push(cloudLine);
  }
  const error = new CommandError(refusal.code, [...lines, how].join('\n'));
  error.exitCode = refusal.exitCode;
  error.data = refusal.data;
  // The `Try:` stays the `dev` command (llp/0030 §Output and errors); `--print-url` is a door
  // named above it, not the next action.
  error.suggestedCommand = refusal.suggestedCommand;
  return error;
}

/** The `Or:` line for a cloud session this project has on record and this run could not use. */
function cloudSessionLine(probe: CloudSessionProbe | null): string | null {
  if (probe == null) {
    return null;
  }
  if (probe.state === 'none') {
    // A live session of a type this CLI cannot drive is still worth naming: "no device found" next
    // to a running `serve-sim` is true and leaves the reader one command short of a device.
    return probe.otherSessionCount > 0
      ? `Or: this project has ${probe.otherSessionCount} running EAS Simulator session${
          probe.otherSessionCount === 1 ? '' : 's'
        } this CLI cannot drive — ${probe.reason ?? 'none of them is an agent-device session'}. Start one it can with "${cloudSessionStartCommand()}" and pass --eas.`
      : null;
  }
  if (probe.state === 'active') {
    // Reached when the session is live and is for the *other* platform, is not this worktree's
    // dotenv session, or reported none.
    return `Or: this project has a running EAS Simulator session${
      probe.platform ? ` (${probe.platform})` : ''
    }, and it is not the device this run asked for. Run this command again with --eas and no platform flag to use it.`;
  }
  return `Or: this project has an EAS Simulator session on record and it is not usable — ${probe.reason ?? 'the service did not report it as running'}. Start a new one with "${cloudSessionStartCommand()}" and pass --eas.`;
}
