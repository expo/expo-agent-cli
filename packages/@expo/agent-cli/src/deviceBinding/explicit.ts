// @ref llp/0030-one-device-per-worktree.rfc.md §Choice
import { canonicalizeExistingPath } from '../utils/dir';
import { CommandError } from '../utils/errors';
import { PROGRAM_PREFIX } from '../programName';
import type { Cleanup } from './cleanup';
import { deviceCommand, deviceUnavailableError } from './errors';
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
type Foreign = { file: string; binding: Binding; stale: boolean };
type Choice = { device: ExplicitCandidate; reused: boolean; transfer: string[] };

/** Pure choice; refusing never changes the current binding. */
export function chooseExplicitDevice(
  own: Binding | null,
  others: Foreign[],
  candidates: ExplicitCandidate[],
  query: string,
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
    });
  if (
    device.backend === 'local-ios' &&
    device.name.startsWith('agent-cli ') &&
    holders.length === 0
  )
    throw explicitError('explicit-not-found', query, platform);
  if (reuseOnly) throw deviceUnavailableError('not-reusable', { platform });
  if (own?.device.backend === 'local-android' && own.device.origin.kind === 'spawned')
    throw explicitError('own-explicit-over-owned', own.device.serial, platform);
  return { device, reused: false, transfer: holders.map(({ file }) => file) };
}

/** Read under the lock when acquiring; read-only callers can use the same choice for a plan. */
export function readExplicitChoice(
  projectRoot: string,
  platform: DevicePlatform,
  candidates: ExplicitCandidate[],
  query: string,
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
    choice: chooseExplicitDevice(own, others, candidates, query, platform, reuseOnly),
  };
}

export function bindExplicitSection(
  projectRoot: string,
  platform: DevicePlatform,
  candidates: ExplicitCandidate[],
  query: string,
  reuseOnly: boolean,
  tools: DeviceTools,
  actions: Cleanup[]
) {
  const { file, own, choice } = readExplicitChoice(
    projectRoot,
    platform,
    candidates,
    query,
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
  if (!choice.reused && own?.device.backend === 'local-ios' && own.device.origin === 'created')
    actions.push({ binding: own, action: 'delete', reason: 'replaced by --device' });
  for (const transferred of choice.transfer) removeBindingFile(transferred);
  return { binding, action: choice.reused ? ('reused' as const) : ('explicit' as const) };
}

function explicitError(
  reason: 'explicit-not-found' | 'explicit-bound' | 'own-explicit-over-owned',
  name: string,
  platform: DevicePlatform,
  { matches = [], root }: { matches?: string[]; root?: string } = {}
): CommandError {
  const what =
    reason === 'explicit-bound'
      ? `${name} is bound to the worktree ${root}.`
      : reason === 'own-explicit-over-owned'
        ? `This worktree runs the emulator instance ${name}.`
        : `No device uniquely matches "${name}"${matches.length ? `; matches: ${matches.join(', ')}` : ''}.`;
  const how =
    reason === 'explicit-bound'
      ? deviceCommand(platform)
      : reason === 'own-explicit-over-owned'
        ? `${PROGRAM_PREFIX} dev:stop --release`
        : `${PROGRAM_PREFIX} status --json`;
  const error = new CommandError(
    'DEVICE_UNAVAILABLE',
    `${what}\nHow: ${reason === 'explicit-bound' ? 'remove --device, then ' : ''}run "${how}".`
  );
  error.exitCode = reason === 'explicit-bound' ? 20 : 1;
  error.data = { reason, ...(matches.length ? { matches } : {}), ...(root ? { root } : {}) };
  return error;
}
