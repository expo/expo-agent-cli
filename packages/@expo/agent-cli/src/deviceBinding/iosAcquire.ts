// @ref llp/0035-one-device-per-worktree.rfc.md §Choice
import { canonicalizeExistingPath } from '../utils/dir';
import { chooseIosDevice, type IosInventory } from './choose';
import { deviceUnavailableError } from './errors';
import { createSimulatorAsync, readIosInventoryAsync } from './ios';
import { bindExplicitSection, type ExplicitRequest } from './explicit';
import { acquireSectionAsync } from './reap';
import { leaseFrom } from './lease';
import {
  bindingPathFor,
  digestForRoot,
  readBindingFile,
  removeBindingFile,
  writeBindingFile,
  type BindingRead,
} from './registry';
import { deviceIdOf, type Binding, type DeviceTools, type AcquireAction } from './types';

/** Lease renewals and renames do not invalidate a device inventory. */
export function bindingIdentity(read: BindingRead): string {
  return read.kind === 'binding'
    ? `${read.binding.device.backend}:${deviceIdOf(read.binding.device)}`
    : read.kind;
}

/** The section: read the own binding, choose, write. `simctl create` runs inside it. */
export async function bindIosSectionAsync(
  projectRoot: string,
  {
    inventory,
    reuseOnly,
    tools,
  }: { inventory: IosInventory; reuseOnly: boolean; tools: DeviceTools }
): Promise<{ binding: Binding; wasBooted: boolean; action: AcquireAction }> {
  const file = bindingPathFor(projectRoot, 'ios', 'local-ios');
  const read = readBindingFile(file);
  if (read.kind === 'unreadable') {
    throw deviceUnavailableError('unreadable', { platform: 'ios', path: file });
  }
  const own = read.kind === 'binding' ? read.binding : null;
  const choice = chooseIosDevice({ own, inventory, reuseOnly, digest: digestForRoot(projectRoot) });
  if (own != null && choice.kind !== 'reuse') {
    removeBindingFile(file);
  }
  if (choice.kind === 'refuse') {
    throw deviceUnavailableError(choice.reason, { platform: 'ios' });
  }
  const lease = leaseFrom(tools.now());
  if (choice.kind === 'reuse') {
    const reused = { ...choice.binding, ...lease };
    writeBindingFile(file, reused);
    return { binding: reused, wasBooted: choice.listed.state === 'Booted', action: 'reused' };
  }
  const udid = await createSimulatorAsync(tools, choice);
  const created: Binding = {
    version: 1,
    device: { backend: 'local-ios', platform: 'ios', udid, name: choice.name, origin: 'created' },
    projectRoot: canonicalizeExistingPath(projectRoot),
    ...lease,
  };
  writeBindingFile(file, created);
  return { binding: created, wasBooted: false, action: 'created' };
}

type IosAcquireOptions = {
  reuseOnly: boolean;
  tools: DeviceTools;
  explicit?: ExplicitRequest;
  signal?: AbortSignal;
};

/** Each inventory belongs to the binding identity observed before the device list was read. */
export async function bindIosAsync(
  projectRoot: string,
  { reuseOnly, tools, explicit, signal }: IosAcquireOptions
) {
  const file = bindingPathFor(projectRoot, 'ios', 'local-ios');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = readBindingFile(file);
    const inventory = await readIosInventoryAsync(tools);
    const bound = await acquireSectionAsync(
      projectRoot,
      tools,
      async (actions) => {
        const read = readBindingFile(file);
        if (read.kind === 'unreadable') {
          throw deviceUnavailableError('unreadable', { platform: 'ios', path: file });
        }
        if (bindingIdentity(read) !== bindingIdentity(before)) return null;
        if (explicit === undefined)
          return bindIosSectionAsync(projectRoot, { inventory, reuseOnly, tools });
        const candidates = inventory.simulators
          .filter((sim) => sim.isAvailable)
          .map((sim) => ({
            backend: 'local-ios' as const,
            platform: 'ios' as const,
            udid: sim.udid,
            name: sim.name,
            origin: 'explicit' as const,
          }));
        const result = bindExplicitSection(
          projectRoot,
          'ios',
          candidates,
          explicit,
          reuseOnly,
          tools,
          actions
        );
        return {
          ...result,
          wasBooted: inventory.simulators.some(
            (sim) => sim.udid === deviceIdOf(result.binding.device) && sim.state === 'Booted'
          ),
        };
      },
      inventory,
      signal
    );
    if (bound != null) return bound;
  }
  throw deviceUnavailableError('binding-changed', { platform: 'ios' });
}
