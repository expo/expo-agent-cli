// @ref llp/0005-runtime-loop-tools.rfc.md
// @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator
// @ref llp/0035-one-device-per-worktree.rfc.md §Readers
// Device resolution for deep-link navigation. Three backends. The local ones are the devices this
// worktree bound with `dev` (`src/deviceBinding/`), read from the registry and verified through
// the platform tools as subprocesses.
//
// The third is not on this machine at all: an EAS Simulator session, driven through `eas
// simulator:*` (`src/device/cloudSimulator.ts`). It is opt-in per caller rather than always
// considered, because it is the only backend that costs money and the only one whose invocations
// this package has never verified against a live service. `navigate` and `smoke` put it on their
// ladder as a *fallback*; `runtime:stop` and `runtime:reload` reach for it only when `--eas`
// names it, so a session that happens to be up never quietly bills a run a local device would have
// served.

import { readCloudBindings } from '../deviceBinding/cloud';
import { cloudRungAsync, type CloudRung, type NoDeviceProbe } from '../deviceBinding/cloudRung';
import { resolveAdb, type AdbResolution } from '../device/adb';
import {
  cloudSessionStartCommand,
  readCloudSessionIdSync,
  type CloudSessionProbe,
} from '../device/cloudSimulator';
import { cloudSessionUnavailableError, cloudSessionUnknownError } from '../device/cloudErrors';
import { findBoundDeviceAsync, type BoundDevice } from '../deviceBinding';
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

type CloudDeviceRung<P extends CloudSessionProbe = NoDeviceProbe> =
  | { kind: 'device'; device: NavigateDevice }
  | { kind: 'none'; probe: P };

/** The cloud rung, with its session as a deep-link device. */
function deviceRung<P extends CloudSessionProbe>(rung: CloudRung<P>): CloudDeviceRung<P> {
  if (rung.kind === 'none') return rung;
  const { platform: devicePlatform, id, name } = rung.device;
  debugEvent('device_resolved', { platform: devicePlatform, deviceId: id });
  return {
    kind: 'device',
    device: { backend: 'cloud', platform: devicePlatform, deviceId: id, name },
  };
}

/**
 * Resolve the device to open the deep link on.
 *
 * Three backends and one order. `--eas` (`cloud: 'required'`) names the cloud session and nothing
 * else is looked at, because a caller that named a device meant that device. Otherwise the
 * **bound** local device wins: the rung loop of llp/0035 §Readers inspects this worktree's
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

  const found = await findBoundDeviceAsync(context.projectRoot, { platform, extend: true });
  if (found.device) {
    const device = navigateDeviceOf(found.device);
    debugEvent('device_resolved', { platform: device.platform, deviceId: device.deviceId });
    return device;
  }

  // The cloud rung, before the tool failure and before the verdict: a machine whose `adb` will not
  // start is exactly the machine this backend is for, and a session that is up answers the question
  // whichever platform tool is missing.
  const cloud = await cloudFallbackAsync(platform, context);
  if (cloud?.kind === 'device') {
    return cloud.device;
  }
  if (found.toolError) {
    throw found.toolError;
  }
  throw withOtherDoors(found.refusal, context, cloud?.probe ?? null);
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
 * The cloud rung of the ladder, taken after the local rungs passed. Null when the rung was not
 * taken.
 *
 * The fallback accepts this worktree's bindings or its dotenv connection. Unbound sessions
 * are reported without becoming candidates. A binding at any age takes the rung, so an expired
 * one is refused as expired rather than hidden behind the local refusal.
 */
async function cloudFallbackAsync(
  platform: NavigatePlatform | undefined,
  context: ResolveDeviceContext
): Promise<CloudDeviceRung<CloudSessionProbe> | null> {
  if (context.cloud !== 'fallback') {
    return null;
  }
  // No dotenv id and no binding: nothing to ask the service about.
  const sessionId = readCloudSessionIdSync(context.projectRoot);
  if (sessionId == null && readCloudBindings(context.projectRoot).bindings.length === 0) {
    return null;
  }
  return deviceRung(await cloudRungAsync(context.projectRoot, platform ?? null, 'fallback'));
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
  const rung = deviceRung(await cloudRungAsync(context.projectRoot, platform ?? null, 'required'));
  if (rung.kind === 'device') {
    return rung.device;
  }
  if (rung.probe.state === 'unknown') {
    throw cloudSessionUnknownError(rung.probe);
  }
  throw cloudSessionUnavailableError(rung.probe);
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
  // The How line stays last (llp/0035 §Output and errors), so the doors go in above it.
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
  // The `Try:` stays the `dev` command (llp/0035 §Output and errors); `--print-url` is a door
  // named above it, not the next action.
  error.suggestedCommand = refusal.suggestedCommand;
  return error;
}

/** The `Or:` line for a cloud session this project has on record and this run could not use. */
function cloudSessionLine(probe: CloudSessionProbe | null): string | null {
  if (probe == null) {
    return null;
  }
  // Reached from the fallback rung: this worktree's session exists and this run could not use it.
  if (probe.state === 'queued') {
    return `Or: this worktree's EAS Simulator session ${probe.session.id} is ${
      probe.session.platform ? `${probe.session.platform} and ` : ''
    }not up yet${
      probe.session.status ? ` (status ${probe.session.status})` : ''
    }. Run this command again in a minute.`;
  }
  if (probe.state === 'active') {
    return `Or: this worktree's EAS Simulator session ${probe.session.id} is ${
      probe.session.platform ?? 'on another platform'
    }, not the device this run asked for. Run this command again with --eas and no platform flag to use it.`;
  }
  if (probe.state === 'none') {
    // A live session of a type this CLI cannot drive is still worth naming: "no device found" next
    // to a running `serve-sim` is true and leaves the reader one command short of a device.
    const lines = [];
    if (probe.wrongTypeCount > 0)
      lines.push(
        `Or: this project has ${countOf(probe.wrongTypeCount, 'running EAS Simulator session')} this CLI cannot drive — none of them is an agent-device session. Start one it can with "${cloudSessionStartCommand()}" and pass --eas.`
      );
    if (probe.unboundCount > 0)
      lines.push(
        `Or: this project has ${countOf(probe.unboundCount, 'live or pending EAS Simulator session')} that this worktree did not start, so none is selected. Start one for this worktree with "${cloudSessionStartCommand()}" and pass --eas.`
      );
    return lines.length ? lines.join('\n') : null;
  }
  // An account without the feature has no session on record to name.
  if (probe.state === 'unavailable') return null;
  return `Or: this project has an EAS Simulator session on record and it is not usable — ${probe.reason}. Start a new one with "${cloudSessionStartCommand()}" and pass --eas.`;
}

function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
