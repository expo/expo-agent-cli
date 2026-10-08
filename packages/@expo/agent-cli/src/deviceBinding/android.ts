// @ref llp/0030-one-device-per-worktree.rfc.md §Choice
// @ref llp/0032-android-instance.plan.md §Android boot
// The Android half of the registry: the port choice and the detached spawn under the lock, the
// boot poll after it, and the kill of an instance this CLI spawned. The tool calls are
// `./emulator.ts`.

import { canonicalizeExistingPath } from '../utils/dir';
import {
  chooseAndroidDevice,
  consolePortOf,
  type AndroidInventory,
  type BoundSerial,
} from './choose';
import { ADB_CALL_TIMEOUT_MS } from './emulator';
import { deviceUnavailableError } from './errors';
import { isExpired, leaseFrom } from './lease';
import {
  bindingPathFor,
  listBindingFiles,
  readBindingFile,
  removeBindingFile,
  writeBindingFile,
} from './registry';
import type { AcquireAction, Binding, DeviceTools, EmulatorHandle } from './types';

const BOOT_POLL_MS = 2_000;

type SpawnedOrigin = { kind: 'spawned'; avd: string; port: number; emulatorPid: number };

/** Every Android binding of another worktree. */
function otherBindings(ownFile: string): Binding[] {
  return listBindingFiles('android', 'local-android')
    .filter((file) => file !== ownFile)
    .map((file) => readBindingFile(file))
    .flatMap((read) => (read.kind === 'binding' ? [read.binding] : []));
}

/**
 * The console ports no spawn may take: every running `emulator-NNNN`, every Android binding whose
 * lease is live, and every binding whose instance is alive, because a reap kills it only after the
 * section.
 */
export function busyPortsOf(
  runningSerials: string[],
  bindings: Binding[],
  tools: DeviceTools
): { busy: Set<number>; boundBy: BoundSerial[] } {
  const busy = new Set<number>();
  const boundBy: BoundSerial[] = [];
  const bound = new Set<string>();
  for (const binding of bindings) {
    const { device } = binding;
    if (device.backend !== 'local-android') {
      continue;
    }
    const port =
      device.origin.kind === 'spawned' ? device.origin.port : consolePortOf(device.serial);
    const alive = device.origin.kind === 'spawned' && tools.isPidAlive(device.origin.emulatorPid);
    if (port != null && (alive || !isExpired(binding, tools.now()))) {
      busy.add(port);
      bound.add(device.serial);
      boundBy.push({ id: device.serial, root: binding.projectRoot });
    }
  }
  for (const serial of runningSerials) {
    const port = consolePortOf(serial);
    if (port != null) {
      busy.add(port);
      if (!bound.has(serial)) {
        boundBy.push({ id: serial, root: null });
      }
    }
  }
  return { busy, boundBy };
}

export interface AndroidSection {
  binding: Binding;
  action: AcquireAction;
  /** The child of a spawn, for the boot watcher; null on a reuse. */
  handle: EmulatorHandle | null;
}

/** The section: read the own binding, choose a port, spawn and write serial then pid, under the lock. */
export async function bindAndroidSectionAsync(
  projectRoot: string,
  {
    inventory,
    reuseOnly,
    tools,
  }: { inventory: AndroidInventory; reuseOnly: boolean; tools: DeviceTools }
): Promise<AndroidSection> {
  const file = bindingPathFor(projectRoot, 'android', 'local-android');
  const read = readBindingFile(file);
  if (read.kind === 'unreadable') {
    throw deviceUnavailableError('unreadable', { platform: 'android', path: file });
  }
  const own = read.kind === 'binding' ? read.binding : null;
  const ownDevice = own?.device.backend === 'local-android' ? own.device : null;
  const ownPresent =
    ownDevice != null &&
    (ownDevice.origin.kind === 'spawned'
      ? tools.isPidAlive(ownDevice.origin.emulatorPid)
      : inventory.runningSerials.includes(ownDevice.serial));
  const { busy, boundBy } = busyPortsOf(inventory.runningSerials, otherBindings(file), tools);
  const choice = chooseAndroidDevice({
    own,
    ownPresent,
    inventory,
    reuseOnly,
    busyPorts: busy,
    boundBy,
  });
  if (own != null && choice.kind !== 'reuse') {
    removeBindingFile(file);
  }
  if (choice.kind === 'refuse') {
    throw deviceUnavailableError(choice.reason, { platform: 'android', boundBy: choice.boundBy });
  }
  if (choice.kind === 'reuse') {
    const reused = { ...choice.binding, ...leaseFrom(tools.now()) };
    writeBindingFile(file, reused);
    return { binding: reused, action: 'reused', handle: null };
  }
  return spawnInstance(file, projectRoot, choice, tools);
}

/** Spawn detached, then write the binding with serial and pid; a write that fails kills the child. */
function spawnInstance(
  file: string,
  projectRoot: string,
  { port, avd }: { port: number; avd: string },
  tools: DeviceTools
): AndroidSection {
  const ports = `${port},${port + 1}`;
  const handle = tools.spawnEmulator([
    '-avd',
    avd,
    '-ports',
    ports,
    '-no-snapshot-save',
    '-read-only',
  ]);
  if (handle.pid == null) {
    handle.kill();
    throw deviceUnavailableError('spawn-failed', { platform: 'android' });
  }
  const spawned: Binding = {
    version: 1,
    device: {
      backend: 'local-android',
      platform: 'android',
      serial: `emulator-${port}`,
      origin: { kind: 'spawned', avd, port, emulatorPid: handle.pid },
    },
    projectRoot: canonicalizeExistingPath(projectRoot),
    ...leaseFrom(tools.now()),
  };
  try {
    writeBindingFile(file, spawned);
  } catch (error) {
    handle.kill();
    throw error;
  }
  return { binding: spawned, action: 'spawned', handle };
}

/**
 * Poll `sys.boot_completed` until the deadline, while the instance is alive and `adb devices`
 * lists it. `gone` answers why the instance is no longer there, or null while it is.
 */
export async function bootEmulatorAsync(
  tools: DeviceTools,
  serial: string,
  gone: () => string | null,
  { timeoutMs }: { timeoutMs: number }
): Promise<{ ok: boolean; reason: string | null }> {
  const deadline = tools.now().getTime() + timeoutMs;
  for (;;) {
    const away = gone();
    if (away) {
      return { ok: false, reason: away };
    }
    const devices = await tools.adb(['devices'], { timeoutMs: ADB_CALL_TIMEOUT_MS });
    if (devices.spawnError) {
      return { ok: false, reason: `could not run "adb": ${devices.spawnError.message}` };
    }
    const listed = devices.stdout.split(/\r?\n/).some((line) => line.split(/\s+/)[0] === serial);
    if (listed) {
      const booted = await tools.adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
        timeoutMs: 30_000,
      });
      // The child can exit during either adb call while another instance answers on its port.
      const stopped = gone();
      if (stopped) {
        return { ok: false, reason: stopped };
      }
      if (booted.exitCode === 0 && booted.stdout.trim() === '1') {
        return { ok: true, reason: null };
      }
    }
    if (tools.now().getTime() >= deadline) {
      return {
        ok: false,
        reason: `${serial} did not finish booting within ${timeoutMs}ms: "adb -s ${serial} shell getprop sys.boot_completed" never answered 1`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, BOOT_POLL_MS));
  }
}

/**
 * Kill the instance a `spawned` binding names, while its pid is alive and, where `ps` exists, its
 * arguments name the AVD and the ports. Never the binary name: the `emulator` launcher execs
 * `qemu-system-<arch>`, so the pid stays and the name does not.
 */
export function killEmulatorIfOurs(
  tools: DeviceTools,
  { emulatorPid, avd, port }: SpawnedOrigin
): { killed: boolean; reason: string | null; failed?: boolean } {
  if (!tools.isPidAlive(emulatorPid)) {
    return { killed: false, reason: `pid ${emulatorPid} is not running` };
  }
  const command = tools.commandOf(emulatorPid);
  if (
    command != null &&
    !(command.includes(`-avd ${avd}`) && command.includes(`-ports ${port},${port + 1}`))
  ) {
    return {
      killed: false,
      reason: `pid ${emulatorPid} is not the emulator instance of ${avd} on port ${port} any more`,
    };
  }
  try {
    tools.kill(emulatorPid);
    return { killed: true, reason: null };
  } catch (error: unknown) {
    return {
      killed: false,
      failed: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
