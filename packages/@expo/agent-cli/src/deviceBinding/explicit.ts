// @ref llp/0035-one-device-per-worktree.rfc.md §Choice
import { rerunDevCommand } from '../plan/rerun';
import { canonicalizeExistingPath } from '../utils/dir';
import { EXIT_NEEDS_HUMAN } from '../exitCodes';
import { CommandError } from '../utils/errors';
import { PROGRAM_PREFIX } from '../programName';
import type { AndroidInventory } from './choose';
import type { Cleanup } from './cleanup';
import { deviceUnavailableError, notReusableError } from './errors';
import { instanceGone } from './emulator';
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
/** `--device`'s value, and the caller's `dev` arguments without it, which a refusal's How repeats (`rerunDevCommand`). */
export type ExplicitRequest = { query: string; rerun: readonly string[] };
type Foreign = { file: string; binding: Binding; stale: boolean };
type Choice = { device: ExplicitCandidate; reused: boolean; transfer: string[] };
type Unready = AndroidInventory['unready'];
type ExplicitReason =
  | 'explicit-not-found'
  | 'explicit-not-ready'
  | 'explicit-bound'
  | 'own-explicit-over-owned';
type RefusalFacts = { matches?: string[]; root?: string; state?: string; rerun: readonly string[] };

/** Pure choice; refusing never changes the current binding. */
export function chooseExplicitDevice(
  own: Binding | null,
  others: Foreign[],
  candidates: ExplicitCandidate[],
  { query, rerun }: ExplicitRequest,
  platform: DevicePlatform,
  reuseOnly: boolean,
  unready: Unready = []
): Choice {
  const matches = candidates.filter(
    (device) =>
      deviceIdOf(device).toLowerCase() === query.toLowerCase() ||
      (device.backend === 'local-ios' && device.name.toLowerCase() === query.toLowerCase())
  );
  const listed = unready.find(({ serial }) => serial.toLowerCase() === query.toLowerCase());
  if (matches.length === 0 && listed)
    throw explicitError('explicit-not-ready', listed.serial, platform, {
      state: listed.state,
      rerun,
    });
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
  tools: DeviceTools,
  unready: Unready = []
) {
  const backend = localBackendOf(platform);
  const file = bindingPathFor(projectRoot, platform, backend);
  const read = readBindingFile(file);
  if (read.kind === 'unreadable')
    throw deviceUnavailableError('unreadable', { platform, path: file });
  let own = read.kind === 'binding' ? read.binding : null;
  if (own?.device.backend === 'local-android' && own.device.origin.kind === 'spawned') {
    const device = own.device;
    if (instanceGone(tools, own.device.origin) != null) own = null;
    // adb can still list the owned instance offline; the instance check is the reuse proof.
    else if (!candidates.some((candidate) => deviceIdOf(candidate) === device.serial))
      candidates = [...candidates, device];
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
    choice: chooseExplicitDevice(own, others, candidates, explicit, platform, reuseOnly, unready),
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
  actions: Cleanup[],
  unready: Unready = []
) {
  const { file, own, choice } = readExplicitChoice(
    projectRoot,
    platform,
    candidates,
    explicit,
    reuseOnly,
    tools,
    unready
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
  reason: ExplicitReason,
  name: string,
  platform: DevicePlatform,
  { matches = [], root, state, rerun }: RefusalFacts
): CommandError {
  const { what, how, line } = refusalText(reason, name, platform, { matches, root, state, rerun });
  const error = new CommandError('DEVICE_UNAVAILABLE', `${what}\nHow: ${line}`);
  error.exitCode =
    reason === 'explicit-not-ready' ? EXIT_NEEDS_HUMAN : reason === 'explicit-bound' ? 20 : 1;
  error.suggestedCommand = how;
  error.data = { reason, ...(matches.length ? { matches } : {}), ...(root ? { root } : {}) };
  if (state) error.data.state = state;
  return error;
}

function refusalText(
  reason: ExplicitReason,
  name: string,
  platform: DevicePlatform,
  { matches = [], root, state, rerun }: RefusalFacts
): { what: string; how: string; line: string } {
  if (reason === 'explicit-not-ready') {
    const how = rerunDevCommand(platform, rerun, name);
    return {
      what: `adb lists ${name} as ${state}, so it cannot be bound.`,
      how,
      line: `${state === 'unauthorized' ? 'allow USB debugging on the device' : 'reconnect the device'}, then run "${how}".`,
    };
  }
  if (reason === 'explicit-bound') {
    const how = rerunDevCommand(platform, rerun);
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
    const how = rerunDevCommand(platform, rerun, matches[0]);
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
