// @ref llp/0030-one-device-per-worktree.rfc.md §Entry points
// The iOS half of the registry's device calls: the inventory, `simctl create`, the boot and the
// shutdown, each one `simctl` subprocess.

import { parseSimulators } from '../device/simulators';
import { CommandError } from '../utils/errors';
import type { SpawnCaptureResult } from '../utils/spawnCapture';
import { firstLine } from '../utils/text';
import type { IosInventory } from './choose';
import { deviceUnavailableError } from './errors';
import type { DeviceTools } from './types';

/** The budget of every `simctl` call that is not a boot. */
export const SIMCTL_CALL_TIMEOUT_MS = 20_000;

export function xcrunNotRunnableError(reason: string): CommandError {
  return new CommandError(
    'XCRUN_NOT_RUNNABLE',
    [
      `Could not run "xcrun simctl", so no iOS simulator was looked at.`,
      `Why: ${reason}`,
      `How: install Xcode and its command line tools, which provide "xcrun simctl", then run this command again.`,
    ].join('\n')
  );
}

/** Pure: the newest available iOS runtime with an iPhone, out of `simctl list runtimes -j`. */
export function parseNewestIosRuntime(stdout: string): IosInventory['newestIosRuntime'] {
  let parsed: {
    runtimes?: {
      identifier?: string;
      platform?: string;
      version?: string;
      isAvailable?: boolean;
      supportedDeviceTypes?: { identifier?: string; name?: string; productFamily?: string }[];
    }[];
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const runtimes = (parsed.runtimes ?? [])
    .filter((runtime) => runtime.platform === 'iOS' && runtime.isAvailable !== false)
    .map((runtime) => ({
      identifier: runtime.identifier ?? '',
      version: (runtime.version ?? '').split('.').map(Number),
      iphones: (runtime.supportedDeviceTypes ?? []).filter(
        (type): type is { identifier: string; name?: string; productFamily?: string } =>
          type.productFamily === 'iPhone' && typeof type.identifier === 'string'
      ),
    }))
    .filter((runtime) => runtime.identifier && runtime.iphones.length > 0)
    .sort((left, right) => compareVersions(right.version, left.version));
  // The newest runtime can list only a device no app renders on (iOS 27.1 lists iPhone Duo alone),
  // so a mainstream iPhone on an older runtime beats it; the newest's first iPhone is the last
  // resort.
  for (const runtime of runtimes) {
    const mainstream = mainstreamIphone(runtime.iphones);
    if (mainstream) {
      return { identifier: runtime.identifier, deviceType: mainstream };
    }
  }
  const newest = runtimes[0];
  return newest
    ? { identifier: newest.identifier, deviceType: newest.iphones[0]!.identifier }
    : null;
}

/** An `iPhone <n> Pro`, else an `iPhone <n>`, by the name `simctl` lists the type under. */
function mainstreamIphone(types: { identifier: string; name?: string }[]): string | null {
  for (const pattern of [/^iPhone \d+ Pro$/, /^iPhone \d+$/]) {
    const match = types.find((type) => pattern.test(type.name ?? ''));
    if (match) {
      return match.identifier;
    }
  }
  return null;
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * The iOS inventory, read before the lock.
 *
 * @throws `XCRUN_NOT_RUNNABLE` when `xcrun` cannot run; `DEVICE_UNAVAILABLE` when it does not
 * answer in time.
 */
export async function readIosInventoryAsync(tools: DeviceTools): Promise<IosInventory> {
  const devices = await tools.simctl(['list', 'devices', '-j'], {
    timeoutMs: SIMCTL_CALL_TIMEOUT_MS,
  });
  assertAnswered(devices, 'list devices');
  const runtimes = await tools.simctl(['list', 'runtimes', '-j'], {
    timeoutMs: SIMCTL_CALL_TIMEOUT_MS,
  });
  assertAnswered(runtimes, 'list runtimes');
  return {
    simulators: parseSimulators(devices.stdout),
    newestIosRuntime: parseNewestIosRuntime(runtimes.stdout),
  };
}

function assertAnswered(result: SpawnCaptureResult, call: string): void {
  if (result.spawnError) {
    throw xcrunNotRunnableError(result.spawnError.message);
  }
  if (result.exitCode == null) {
    throw deviceUnavailableError('create-timeout', { platform: 'ios' });
  }
  if (result.exitCode !== 0) {
    throw xcrunNotRunnableError(
      `"xcrun simctl ${call}" exited ${result.exitCode}: ${firstLine(result.stderr) || 'no output'}`
    );
  }
}

/** `simctl create`, under the lock. A timeout kills the child and refuses `create-timeout`. */
export async function createSimulatorAsync(
  tools: DeviceTools,
  { name, deviceType, runtime }: { name: string; deviceType: string; runtime: string }
): Promise<string> {
  const created = await tools.simctl(['create', name, deviceType, runtime], {
    timeoutMs: SIMCTL_CALL_TIMEOUT_MS,
  });
  if (created.spawnError) {
    throw xcrunNotRunnableError(created.spawnError.message);
  }
  if (created.exitCode == null) {
    throw deviceUnavailableError('create-timeout', { platform: 'ios' });
  }
  const udid = firstLine(created.stdout);
  if (created.exitCode !== 0 || !udid) {
    throw xcrunNotRunnableError(
      `"xcrun simctl create" exited ${created.exitCode}: ${firstLine(created.stderr) || 'no output'}`
    );
  }
  return udid;
}

/** What one `simctl list devices -j` says about one simulator. */
export type SimulatorListing =
  | { kind: 'listed'; state: string; name: string }
  | { kind: 'missing' }
  | { kind: 'tool'; error: CommandError }
  | { kind: 'timeout' };

export async function listSimulatorAsync(
  tools: DeviceTools,
  udid: string,
  { timeoutMs = SIMCTL_CALL_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<SimulatorListing> {
  const listed = await tools.simctl(['list', 'devices', '-j'], { timeoutMs });
  if (listed.spawnError) {
    return { kind: 'tool', error: xcrunNotRunnableError(listed.spawnError.message) };
  }
  if (listed.exitCode == null) {
    return { kind: 'timeout' };
  }
  if (listed.exitCode !== 0) {
    return {
      kind: 'tool',
      error: xcrunNotRunnableError(
        `"xcrun simctl list devices" exited ${listed.exitCode}: ${firstLine(listed.stderr) || 'no output'}`
      ),
    };
  }
  const entry = parseSimulators(listed.stdout).find((simulator) => simulator.udid === udid);
  // Unavailable (its runtime is gone) reads as missing: nothing can boot it.
  return entry?.isAvailable
    ? { kind: 'listed', state: entry.state, name: entry.name }
    : { kind: 'missing' };
}

/**
 * Boot and wait. `bootstatus -b` boots only when the simulator is not `Booted` and then waits,
 * because `simctl boot` on a `Booted` simulator exits non-zero.
 */
export async function bootSimulatorAsync(
  tools: DeviceTools,
  udid: string,
  { timeoutMs }: { timeoutMs: number }
): Promise<{ ok: boolean; reason: string | null }> {
  const status = await tools.simctl(['bootstatus', udid, '-b'], { timeoutMs });
  if (status.spawnError) {
    return { ok: false, reason: `could not run "xcrun simctl": ${status.spawnError.message}` };
  }
  if (status.exitCode == null) {
    return {
      ok: false,
      reason: `"xcrun simctl bootstatus ${udid} -b" did not report it up within ${timeoutMs}ms`,
    };
  }
  if (status.exitCode !== 0) {
    return {
      ok: false,
      reason: `"xcrun simctl bootstatus ${udid} -b" exited ${status.exitCode}: ${firstLine(status.stderr) || 'no output'}`,
    };
  }
  return { ok: true, reason: null };
}

/** An already shut-down simulator counts as success. */
export async function shutdownSimulatorAsync(
  tools: DeviceTools,
  udid: string
): Promise<{ ok: boolean; reason: string | null }> {
  const result = await tools.simctl(['shutdown', udid], { timeoutMs: 60_000 });
  if (result.spawnError) {
    return { ok: false, reason: `could not run "xcrun simctl": ${result.spawnError.message}` };
  }
  if (result.exitCode !== 0 && !/current state: Shutdown/i.test(result.stderr)) {
    return {
      ok: false,
      reason: `"xcrun simctl shutdown ${udid}" exited ${result.exitCode}: ${firstLine(result.stderr) || 'no output'}`,
    };
  }
  return { ok: true, reason: null };
}
