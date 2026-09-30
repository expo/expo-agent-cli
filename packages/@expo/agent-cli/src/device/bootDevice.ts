// @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
// @ref llp/0028-one-device-per-agent.rfc.md §Android boot
// Boot a local device, and shut one down again.
//
// Which device boots is not decided here: it is the device this worktree claims
// (`./claimedDevice.ts`, llp/0028). This module holds the boot mechanics, through the same platform
// tools as subprocesses, with no simulator or emulator library linked in.
//
// **Only what this module started is ever shut down.** Nothing here decides that; the caller does
// (`src/smoke/phases.ts`). What this module guarantees is the other half of it: `bootDeviceAsync` reports
// the id it booted before it waits for anything, so a boot that hangs is still a device its caller
// knows it is holding.
//
// Three live facts are pinned here rather than rediscovered, and each of them cost somebody a run:
//
//  1. **`-ports <console>,<adb>` on the emulator.** Without it the emulator binds ephemeral ports
//     and `adb devices` never lists it at all — not "offline", *absent* [observed — friction run 6,
//     F62, and again on 2026-08-27]. So the serial is known before the boot rather than after.
//  2. **`sys.boot_completed`, not `adb devices`.** `adb` reports the serial as `offline` for the
//     first seconds and then `device`, and Android itself is up later still. An `adb shell` before
//     that answers `device offline`.
//  3. **`simctl boot`, and never Simulator.app.** Opening the UI app is what needs a macOS
//     Automation grant, and a refusal there is the failure llp/0005 §The run brings its own environment
//     uses records for `expo start --ios`. `simctl boot` needs no grant, and `simctl openurl` and
//     `simctl io … screenshot` both work against a simulator whose window nobody opened.

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import type { DeviceBackend } from '../navigate/device';
import { spawnCaptureAsync } from '../utils/spawnCapture';
import { resolveAdb, runAdbAsync, type AdbResolution } from './adb';

/**
 * How long a boot may take, per platform, before it is called a failure.
 *
 * Both are measured rather than chosen. A cold iOS simulator takes roughly a minute; an Android
 * emulator takes several, which is why the live tier waits four. Generous, because the cost of a
 * bound that is too short is a boot failure reported for a device that was coming up fine.
 */
export const BOOT_DEVICE_TIMEOUT_MS: Record<'ios' | 'android', number> = {
  ios: 120_000,
  android: 240_000,
};

/** How often a boot wait re-asks the device whether it is up. */
const BOOT_POLL_MS = 2_000;

/** What one boot amounted to. Never throws: a device that would not come up is a result. */
export interface BootDeviceResult {
  ok: boolean;
  /** The device that came up, or the one that was asked to and did not. */
  deviceId: string | null;
  backend: DeviceBackend | null;
  /** The name a person would recognise it by, when the tool reported one. */
  name: string | null;
  /** Why none came up, as one sentence. Null exactly when {@link ok} is true. */
  reason: string | null;
  /**
   * Nothing was booted **on purpose**, because no device could have opened the app.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §The device that can open the app
   * Distinct from an ordinary failure, and the distinction is the whole point of asking before
   * booting: a boot that could not have opened the app costs a minute and answers nothing, so
   * declining it is the *right* outcome and the report has to say so rather than describing a
   * simulator that would not start.
   */
  refused: boolean;
  /**
   * This device was booted **without** having the app, for a caller that said it could install it.
   *
   * @ref ./bootDevice §mayInstall. Only ever true when the caller passed `mayInstall`, and it is
   * the caller's cue to install before it opens anything.
   */
  installNeeded?: boolean;
  /**
   * Why this device was chosen, for a report that has to explain itself.
   *
   * Null when none was. One clause, in the terms of the rule that picked it — "has Expo Go
   * installed", "already booted".
   */
  choice: string | null;
}

/** What one shutdown amounted to. Never throws, for the same reason. */
export interface ShutdownDeviceResult {
  ok: boolean;
  reason: string | null;
}

export interface BootDeviceOptions {
  /** The worktree the device is claimed for (llp/0028 §The registry). */
  projectRoot: string;
  /** How long the boot may take before it is called a failure. */
  timeoutMs: number;
  /**
   * Told the id as soon as there is one, and before the device is touched.
   *
   * The caller registers its cleanup from here, so a boot that is issued and then hangs is still
   * a device somebody is responsible for shutting down.
   */
  onBooting?: (device: { deviceId: string; backend: DeviceBackend }) => void;
  /**
   * The application the caller is about to open, when it knows.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §The device that can open the app
   * Given, a free device that **has this app installed** ranks first, and without
   * {@link mayInstall} the boot declines rather than booting one that could not open it.
   */
  appId?: string | null;
  /** What the app is called in a sentence, for the refusal. Defaults to {@link appId}. */
  appLabel?: string | null;
  /** The command that puts the app on a device, named by the refusal when there is one. */
  installWith?: string | null;
  /**
   * The caller can put {@link appId} on a device itself, so a device without it is not a refusal.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Putting Expo Go on a simulator that has not got it
   */
  mayInstall?: boolean;
}

/** One simulator, as `simctl list devices -j` describes it. */
export interface SimulatorEntry {
  udid: string;
  name: string;
  /** The runtime identifier it is listed under, e.g. `com.apple.CoreSimulator.SimRuntime.iOS-26-0`. */
  runtime: string;
  /** iOS version as a comparable tuple, from the runtime identifier. */
  version: number[];
  state: string;
  isAvailable: boolean;
  /**
   * When this device was last booted, as epoch milliseconds. Zero for one that never has been.
   *
   * The field that decides the choice, and it is not about recency for its own sake. **Apps are
   * installed per device**, so a simulator nobody has ever booted has no Expo Go on it and no
   * development build either — a run that booted one would spend a minute and then fail at the
   * `app` phase against a device that could never have answered.
   */
  lastBootedAt: number;
}

/**
 * Read the bootable iOS simulators out of `simctl list devices -j`.
 *
 * Only iOS runtimes: a watchOS or tvOS simulator cannot run this project's app, and booting one
 * would be a minute spent on a device every phase after it would then fail against.
 *
 * Exported because it is the half of the iOS path that can be wrong without any simulator being
 * involved, and pinning it needs no Xcode.
 */
export function parseSimulators(stdout: string): SimulatorEntry[] {
  let parsed: {
    devices?: Record<
      string,
      {
        udid?: string;
        name?: string;
        state?: string;
        isAvailable?: boolean;
        lastBootedAt?: string;
      }[]
    >;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const simulators: SimulatorEntry[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    const version = runtime.match(/\.iOS-([\d-]+)$/)?.[1];
    if (version == null || !Array.isArray(devices)) {
      continue;
    }
    for (const device of devices) {
      if (device?.udid) {
        simulators.push({
          udid: device.udid,
          name: device.name ?? '',
          runtime,
          version: version.split('-').map(Number),
          state: device.state ?? 'Unknown',
          // Absent means available: `simctl` omits the key for the ordinary case and sets it false
          // for a device whose runtime is gone.
          isAvailable: device.isAvailable !== false,
          // `simctl` omits the key entirely for a device that has never been booted, which is
          // exactly the device this must not choose.
          lastBootedAt: Date.parse(device.lastBootedAt ?? '') || 0,
        });
      }
    }
  }
  return simulators;
}

/**
 * The order in which free shut-down simulators are booted (llp/0028 §The registry, step 4).
 *
 * **The one this developer last used** first. Apps are installed per device: a simulator nobody
 * has ever booted has no Expo Go on it and no development build either, so a run that picked "the
 * newest iPhone on the newest runtime" would, on a machine with eleven simulators and one in use,
 * spend a minute booting a device that could never have answered the `app` phase. `lastBootedAt`
 * is `simctl`'s own record of which one that is [observed — 2026-08-30, a machine listing five
 * iPhones and five iPads].
 *
 * The two rules under it are for a machine where nothing has ever been booted, which is a fresh
 * Xcode install: the newest iOS runtime, and an iPhone on it.
 */
export function compareSimulators(left: SimulatorEntry, right: SimulatorEntry): number {
  const byLastBooted = right.lastBootedAt - left.lastBootedAt;
  if (byLastBooted !== 0) {
    return byLastBooted;
  }
  const byVersion = compareVersions(right.version, left.version);
  if (byVersion !== 0) {
    return byVersion;
  }
  return Number(right.name.startsWith('iPhone')) - Number(left.name.startsWith('iPhone'));
}

export function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Read the AVD names out of `emulator -list-avds`. */
export function parseAvds(stdout: string): string[] {
  return (
    stdout
      .split('\n')
      .map((line) => line.trim())
      // The tool prints its own warnings to stdout on some SDKs, and none of them is an AVD name.
      .filter((line) => line.length > 0 && !line.includes(' '))
  );
}

/**
 * Boot the device this worktree claims for the platform, and wait until it will answer.
 *
 * The choice is the claim's (`./claimedDevice.ts`); this only maps it onto the result `smoke`
 * reports. A device that is already up is returned without a boot.
 *
 * @returns what came up, or why nothing did. Never rejects.
 */
export async function bootDeviceAsync(
  platform: 'ios' | 'android',
  {
    projectRoot,
    timeoutMs,
    onBooting,
    appId = null,
    appLabel = null,
    installWith = null,
    mayInstall = false,
  }: BootDeviceOptions
): Promise<BootDeviceResult> {
  const { resolveClaimedDeviceAsync } =
    require('./claimedDevice') as typeof import('./claimedDevice');
  const resolved = await resolveClaimedDeviceAsync({
    platform,
    projectRoot,
    allowBoot: true,
    appId,
    requireApp: appId != null && !mayInstall,
    timeoutMs,
    onBooting,
  });
  if (!resolved.ok) {
    const refused = resolved.kind === 'no-app';
    return {
      ok: false,
      deviceId: resolved.deviceId,
      backend:
        resolved.deviceId == null ? null : platform === 'ios' ? 'local-ios' : 'local-android',
      name: resolved.name,
      reason: refused
        ? `no free ${platform === 'ios' ? 'iOS simulator' : 'Android emulator'} has ${appLabel ?? appId} installed, so booting one would open nothing${
            installWith ? `. Run "${installWith}" once to put the app on a device` : ''
          }`
        : resolved.reason,
      refused,
      choice: null,
    };
  }
  return {
    ok: true,
    deviceId: resolved.id,
    backend: resolved.backend,
    name: resolved.name,
    reason: null,
    refused: false,
    installNeeded: appId != null && resolved.hasApp === false,
    choice: resolved.choice,
  };
}

/** Shut down a device this process booted. Never rejects. */
export async function shutdownDeviceAsync(
  deviceId: string,
  backend: DeviceBackend,
  { adb }: { adb?: AdbResolution } = {}
): Promise<ShutdownDeviceResult> {
  if (backend === 'local-ios') {
    const result = await spawnCaptureAsync('xcrun', ['simctl', 'shutdown', deviceId], {
      timeoutMs: 60_000,
    });
    if (result.spawnError) {
      return { ok: false, reason: `could not run "xcrun simctl": ${result.spawnError.message}` };
    }
    // A simulator that is already off is the state this asked for, and `simctl` says so with a
    // non-zero code. Reporting it as a failed cleanup would be reporting the outcome we wanted.
    if (result.exitCode !== 0 && !/current state: Shutdown/i.test(result.stderr)) {
      return {
        ok: false,
        reason: `"xcrun simctl shutdown ${deviceId}" exited ${result.exitCode}: ${firstLine(result.stderr) || 'no output'}`,
      };
    }
    return { ok: true, reason: null };
  }

  if (backend === 'local-android') {
    const result = await runAdbAsync(['-s', deviceId, 'emu', 'kill'], {
      adb,
      timeoutMs: 60_000,
    });
    if (result.notRunnable) {
      return {
        ok: false,
        reason: `"adb" could not be run (${result.spawnError?.message ?? 'no reason given'})`,
      };
    }
    return result.exitCode === 0
      ? { ok: true, reason: null }
      : {
          ok: false,
          reason: `"${result.adb.bin} -s ${deviceId} emu kill" exited ${result.exitCode}: ${firstLine(result.stderr) || 'no output'}`,
        };
  }

  // The cloud backend is not this module's to shut down, and it is never registered for cleanup:
  // a session is somebody's paid resource, started outside this run and outliving it on purpose
  // (llp/0005 §Cloud simulator).
  return {
    ok: false,
    reason: `${backend} is not a device this command boots, so it has nothing to shut down`,
  };
}

/**
 * Boot one simulator, and wait for `bootstatus` to say it is up.
 *
 * @ref llp/0028-one-device-per-agent.rfc.md §Every verb uses the claim
 */
export async function bootSimulatorAsync(
  { udid, name }: { udid: string; name: string },
  {
    timeoutMs,
    now = Date.now,
    choice = null,
  }: { timeoutMs: number; now?: () => number; choice?: string | null }
): Promise<BootDeviceResult> {
  const deadline = now() + timeoutMs;
  const left = () => Math.max(1_000, deadline - now());
  const result = (ok: boolean, reason: string | null): BootDeviceResult => ({
    ok,
    deviceId: udid,
    backend: 'local-ios',
    name,
    reason,
    refused: false,
    choice,
  });

  const booted = await spawnCaptureAsync('xcrun', ['simctl', 'boot', udid], {
    timeoutMs: left(),
  });
  // "Unable to boot device in current state: Booted" is the race this run is happy to lose: the
  // device is up, which is the whole request.
  if (booted.exitCode !== 0 && !/current state: Booted/i.test(booted.stderr)) {
    return result(
      false,
      `"xcrun simctl boot ${udid}" exited ${booted.exitCode}: ${firstLine(booted.stderr) || 'no output'}`
    );
  }

  // `bootstatus` blocks until the device has finished booting, which is a different moment from
  // the boot command returning: `simctl boot` returns as soon as the boot has *started*, and an
  // `openurl` before springboard is up is refused.
  const status = await spawnCaptureAsync('xcrun', ['simctl', 'bootstatus', udid], {
    timeoutMs: left(),
  });
  if (status.exitCode !== 0) {
    return result(
      false,
      `${name} (${udid}) was asked to boot and "xcrun simctl bootstatus" did not report it up within ${timeoutMs}ms`
    );
  }
  return result(true, null);
}

/**
 * The console ports an emulator may take. The adb server scans only 5555-5585 for the adb port,
 * which is the console port + 1, so an emulator outside this range is never listed.
 */
export const EMULATOR_PORT_FIRST = 5554;
export const EMULATOR_PORT_LAST = 5584;

export function emulatorSerial(port: number): string {
  return `emulator-${port}`;
}

/** The console port of an `emulator-<port>` serial, or null for any other serial. */
export function emulatorPort(serial: string): number | null {
  const match = /^emulator-(\d+)$/.exec(serial);
  return match ? Number(match[1]) : null;
}

/**
 * The first even console port whose adb port (console + 1) is free too.
 *
 * A bind test rather than `adb devices`: an emulator that is still starting holds its ports before
 * adb lists it.
 */
export async function findFreeEmulatorPortAsync({
  isFree = isPortBindableAsync,
  skip = () => false,
}: {
  isFree?: (port: number) => Promise<boolean>;
  skip?: (port: number) => boolean;
} = {}): Promise<number | null> {
  for (let port = EMULATOR_PORT_FIRST; port <= EMULATOR_PORT_LAST; port += 2) {
    if (!skip(port) && (await isFree(port)) && (await isFree(port + 1))) {
      return port;
    }
  }
  return null;
}

function isPortBindableAsync(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** One emulator to start: the AVD, its console port, and whether another instance runs the AVD. */
export interface EmulatorBoot {
  avd: string;
  port: number;
  /** `-read-only`, which lets a second instance run an AVD that is already running. */
  readOnly: boolean;
}

/**
 * Spawn the emulator detached on its own ports, and poll `sys.boot_completed` on its serial.
 *
 * @ref llp/0028-one-device-per-agent.rfc.md §Android boot
 */
export async function bootEmulatorAsync(
  { avd, port, readOnly }: EmulatorBoot,
  {
    timeoutMs,
    now = Date.now,
    adb = resolveAdb(),
    choice = null,
  }: { timeoutMs: number; now?: () => number; adb?: AdbResolution; choice?: string | null }
): Promise<BootDeviceResult> {
  const serial = emulatorSerial(port);
  const emulator = resolveEmulator(adb);
  const result = (ok: boolean, reason: string | null): BootDeviceResult => ({
    ok,
    deviceId: serial,
    backend: 'local-android',
    name: avd,
    reason,
    refused: false,
    choice,
  });

  const args = ['-avd', avd, '-ports', `${port},${port + 1}`, '-no-snapshot-save'];
  if (readOnly) {
    args.push('-read-only');
  }

  let spawnFailure: string | null = null;
  try {
    const child = spawn(emulator, args, {
      detached: true,
      // The emulator's own output is not this run's report, and a pipe nobody reads fills up and
      // blocks it. It logs to the Android SDK's own files either way.
      stdio: 'ignore',
    });
    child.on('error', (error: Error) => {
      spawnFailure = error.message;
    });
    child.unref();
  } catch (error: unknown) {
    return result(
      false,
      `"${emulator} -avd ${avd}" could not be started: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const deadline = now() + timeoutMs;
  for (;;) {
    if (spawnFailure != null) {
      return result(false, `"${emulator} -avd ${avd}" could not be started: ${spawnFailure}`);
    }
    const probe = await runAdbAsync(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
      adb,
      timeoutMs: 30_000,
    });
    if (probe.exitCode === 0 && probe.stdout.trim() === '1') {
      return result(true, null);
    }
    if (now() >= deadline) {
      return result(
        false,
        `the emulator ${avd} did not finish booting within ${timeoutMs}ms — "${adb.bin} -s ${serial} shell getprop sys.boot_completed" never answered 1`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, BOOT_POLL_MS));
  }
}

/**
 * The `emulator` binary to spawn.
 *
 * Beside the resolved `adb` when the SDK holds one, because that is the copy belonging to the SDK
 * every other Android call in this CLI uses — a bare `emulator` on `PATH` can be a different SDK's,
 * and an AVD created in one is not listed by the other.
 */
export function resolveEmulator(
  adb: AdbResolution,
  { exists = fs.existsSync }: { exists?: (candidate: string) => boolean } = {}
): string {
  const executable = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
  const beside = path.join(path.dirname(path.dirname(adb.bin)), 'emulator', executable);
  return exists(beside) ? beside : executable;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}
