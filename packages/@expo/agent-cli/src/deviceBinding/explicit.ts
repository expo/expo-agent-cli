// @ref llp/0035-one-device-per-worktree.rfc.md §Choice
import { quoteArgument } from '../utils/consent';
import { canonicalizeExistingPath } from '../utils/dir';
import { CommandError } from '../utils/errors';
import { isPlatformFlag } from '../plan/platformFlags';
import { PROGRAM_PREFIX } from '../programName';
import type { Cleanup } from './cleanup';
import { deviceUnavailableError, notReusableError } from './errors';
import { isStale, leaseFrom } from './lease';
import {
  bindingPathFor,
  listBindingFiles,
  readBindingFile,
  removeBindingFile,
  writeBindingFile,
} from './registry';
import {
  deviceIdOf,
  deviceNameOf,
  localBackendOf,
  type Binding,
  type BoundDevice,
  type DevicePlatform,
  type DeviceTools,
} from './types';

export type ExplicitCandidate = Extract<BoundDevice, { backend: 'local-ios' | 'local-android' }>;
/** `--device`'s value, and the caller's `dev` arguments without it, which a refusal's How repeats. */
export type ExplicitRequest = { query: string; rerun: readonly string[] };
type Foreign = { file: string; binding: Binding; stale: boolean };
type Choice = { device: ExplicitCandidate; reused: boolean; transfer: string[] };

/** Pure choice; refusing never changes the current binding. */
export function chooseExplicitDevice(
  own: Binding | null,
  others: Foreign[],
  candidates: ExplicitCandidate[],
  { query, rerun }: ExplicitRequest,
  platform: DevicePlatform,
  reuseOnly: boolean
): Choice {
  const matches = candidates.filter(
    (device) =>
      deviceIdOf(device).toLowerCase() === query.toLowerCase() ||
      (device.backend === 'local-ios' && device.name.toLowerCase() === query.toLowerCase())
  );
  if (matches.length !== 1)
    throw explicitError('explicit-not-found', query, platform, {
      matches: matches.map(deviceIdOf),
      rerun,
    });
  const device = matches[0]!;
  const id = deviceIdOf(device);
  if (own && deviceIdOf(own.device) === id)
    return { device: own.device as ExplicitCandidate, reused: true, transfer: [] };
  const holders = others.filter(({ binding }) => deviceIdOf(binding.device) === id);
  const blocked = holders.find(
    ({ binding, stale }) =>
      !stale ||
      (binding.device.backend === 'local-ios'
        ? binding.device.origin !== 'explicit'
        : binding.device.backend === 'local-android' && binding.device.origin.kind !== 'explicit')
  );
  if (blocked)
    throw explicitError('explicit-bound', deviceNameOf(device), platform, {
      root: blocked.binding.projectRoot,
      rerun,
    });
  if (
    device.backend === 'local-ios' &&
    device.name.startsWith('agent-cli ') &&
    holders.length === 0
  )
    throw explicitError('explicit-not-found', query, platform, { rerun });
  if (reuseOnly)
    throw notReusableError(
      platform,
      own ? { bound: deviceNameOf(own.device), named: deviceNameOf(device) } : undefined
    );
  if (own?.device.backend === 'local-android' && own.device.origin.kind === 'spawned')
    throw explicitError('own-explicit-over-owned', own.device.serial, platform, { rerun });
  return { device, reused: false, transfer: holders.map(({ file }) => file) };
}

/** Read under the lock when acquiring; read-only callers can use the same choice for a plan. */
export function readExplicitChoice(
  projectRoot: string,
  platform: DevicePlatform,
  candidates: ExplicitCandidate[],
  explicit: ExplicitRequest,
  reuseOnly: boolean,
  tools: DeviceTools
) {
  const backend = localBackendOf(platform);
  const file = bindingPathFor(projectRoot, platform, backend);
  const read = readBindingFile(file);
  if (read.kind === 'unreadable')
    throw deviceUnavailableError('unreadable', { platform, path: file });
  const own = read.kind === 'binding' ? read.binding : null;
  if (
    own?.device.backend === 'local-android' &&
    own.device.origin.kind === 'spawned' &&
    tools.isPidAlive(own.device.origin.emulatorPid) &&
    !candidates.some((candidate) => deviceIdOf(candidate) === deviceIdOf(own.device))
  ) {
    // adb can still list the owned instance offline; its live pid is the reuse proof.
    candidates = [...candidates, own.device];
  }
  const others = listBindingFiles(platform, backend)
    .filter((other) => other !== file)
    .flatMap((file) => {
      const read = readBindingFile(file);
      return read.kind === 'binding'
        ? [{ file, binding: read.binding, stale: isStale(read.binding, tools.now()) }]
        : [];
    });
  return {
    file,
    own,
    choice: chooseExplicitDevice(own, others, candidates, explicit, platform, reuseOnly),
  };
}

/** The own created simulator a new explicit choice deletes, or null. */
export function replacedByExplicit(own: Binding | null, choice: Choice): Binding | null {
  return !choice.reused && own?.device.backend === 'local-ios' && own.device.origin === 'created'
    ? own
    : null;
}

export function bindExplicitSection(
  projectRoot: string,
  platform: DevicePlatform,
  candidates: ExplicitCandidate[],
  explicit: ExplicitRequest,
  reuseOnly: boolean,
  tools: DeviceTools,
  actions: Cleanup[]
) {
  const { file, own, choice } = readExplicitChoice(
    projectRoot,
    platform,
    candidates,
    explicit,
    reuseOnly,
    tools
  );
  const binding: Binding = {
    version: 1,
    projectRoot: canonicalizeExistingPath(projectRoot),
    device: choice.device,
    ...leaseFrom(tools.now()),
  };
  writeBindingFile(file, binding);
  const replaced = replacedByExplicit(own, choice);
  if (replaced)
    actions.push({ binding: replaced, action: 'delete', reason: 'replaced by --device' });
  for (const transferred of choice.transfer) removeBindingFile(transferred);
  return { binding, action: choice.reused ? ('reused' as const) : ('explicit' as const) };
}

function explicitError(
  reason: 'explicit-not-found' | 'explicit-bound' | 'own-explicit-over-owned',
  name: string,
  platform: DevicePlatform,
  { matches = [], root, rerun }: { matches?: string[]; root?: string; rerun: readonly string[] }
): CommandError {
  const { what, how, line } = refusalText(reason, name, platform, { matches, root, rerun });
  const error = new CommandError('DEVICE_UNAVAILABLE', `${what}\nHow: ${line}`);
  error.exitCode = reason === 'explicit-bound' ? 20 : 1;
  error.suggestedCommand = how;
  error.data = { reason, ...(matches.length ? { matches } : {}), ...(root ? { root } : {}) };
  return error;
}

function refusalText(
  reason: 'explicit-not-found' | 'explicit-bound' | 'own-explicit-over-owned',
  name: string,
  platform: DevicePlatform,
  { matches, root, rerun }: { matches: string[]; root?: string; rerun: readonly string[] }
): { what: string; how: string; line: string } {
  if (reason === 'explicit-bound') {
    const how = devCommand(platform, rerun);
    return {
      what: `${name} is bound to the worktree ${root}.`,
      how,
      line: `remove --device, then run "${how}".`,
    };
  }
  if (reason === 'own-explicit-over-owned') {
    const how = `${PROGRAM_PREFIX} dev:stop --release`;
    return {
      what: `This worktree runs the emulator instance ${name}.`,
      how,
      line: `run "${how}".`,
    };
  }
  if (matches.length) {
    const how = devCommand(platform, rerun, matches[0]);
    return {
      what: `No device uniquely matches "${name}"; matches: ${matches.join(', ')}.`,
      how,
      line: `run "${how}", or pass another match to --device.`,
    };
  }
  const how = platform === 'ios' ? 'xcrun simctl list devices available' : 'adb devices';
  const listed = platform === 'ios' ? 'name or UDID' : 'serial';
  return {
    what: `No device uniquely matches "${name}".`,
    how,
    line: `run "${how}", then pass a listed ${listed} to --device.`,
  };
}

/** The caller's `dev` command again, platform first, with `--device <device>` before any `--`. */
function devCommand(platform: DevicePlatform, rerun: readonly string[], device?: string): string {
  const separator = rerun.indexOf('--') < 0 ? rerun.length : rerun.indexOf('--');
  const args = [
    ...rerun.slice(0, separator).filter((arg) => !isPlatformFlag(arg)),
    ...(device ? ['--device', device] : []),
    ...rerun.slice(separator),
  ];
  return `${PROGRAM_PREFIX} dev --${platform}${args.map((arg) => ` ${quoteArgument(arg)}`).join('')}`;
}
