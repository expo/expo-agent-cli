// @ref llp/0035-one-device-per-worktree.rfc.md §Records
import { PROGRAM_PREFIX } from '../programName';
import { isStale } from './lease';
import { bindingPathFor, listBindingFiles, readBindingFile } from './registry';
import {
  deviceIdOf,
  deviceNameOf,
  localBackendOf,
  type Binding,
  type DevicePlatform,
  type ReleasedDevice,
} from './types';

export function ownBindingFiles(projectRoot: string) {
  return (['ios', 'android'] as const).flatMap((platform) =>
    ([localBackendOf(platform), 'cloud'] as const).map((backend) => ({
      platform,
      backend,
      file: bindingPathFor(projectRoot, platform, backend),
    }))
  );
}

export function deviceReport(binding: Binding): ReleasedDevice {
  const { device } = binding;
  return {
    backend: device.backend,
    platform: device.platform,
    id: deviceIdOf(device),
    name: deviceNameOf(device),
    released: false,
    shutDown: false,
    reason: null,
  };
}

export function keptDevices(projectRoot: string, platform?: DevicePlatform): ReleasedDevice[] {
  return ownBindingFiles(projectRoot)
    .filter((entry) => !platform || entry.platform === platform)
    .flatMap(({ file }) => {
      const read = readBindingFile(file);
      return read.kind === 'binding'
        ? [{ ...deviceReport(read.binding), released: null, reason: backendReason(read.binding) }]
        : [];
    });
}

export function unreadableBindingFiles(projectRoot: string, platform?: DevicePlatform) {
  return ownBindingFiles(projectRoot).filter(
    (entry) =>
      entry.backend !== 'cloud' &&
      (!platform || entry.platform === platform) &&
      readBindingFile(entry.file).kind === 'unreadable'
  );
}

function backendReason(binding: Binding): string | null {
  return binding.device.backend === 'cloud'
    ? `recorded, not checked; use ${PROGRAM_PREFIX} dev:stop --eas to stop it`
    : null;
}

/** A live local iOS binding, keyed the way a booted simulator is reported: by udid. */
export interface LiveIosBinding {
  udid: string;
  name: string;
  projectRoot: string;
  /** The binding is `projectRoot`'s, the worktree that asked. */
  own: boolean;
}

/**
 * Every worktree's local iOS binding that is still live: lease not expired, root not deleted.
 * A released binding keeps its file with an expired lease, so it is not here.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
 */
export function liveIosBindings(projectRoot: string, now = new Date()): LiveIosBinding[] {
  const ownFile = bindingPathFor(projectRoot, 'ios', 'local-ios');
  return listBindingFiles('ios', 'local-ios').flatMap((file) => {
    const read = readBindingFile(file);
    if (read.kind !== 'binding' || isStale(read.binding, now)) return [];
    const { device, projectRoot: root } = read.binding;
    if (device.backend !== 'local-ios') return [];
    return [{ udid: device.udid, name: device.name, projectRoot: root, own: file === ownFile }];
  });
}
