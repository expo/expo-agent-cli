// @ref llp/0030-one-device-per-worktree.rfc.md §Records
import { bindingPathFor, readBindingFile } from './registry';
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

/** Compare the acquisition too: a later dev may have rebound the same device. */
export function sameBinding(a: Binding, b: Binding): boolean {
  const identity = ({ projectRoot, boundAt, device }: Binding) => [
    projectRoot,
    boundAt,
    device.backend,
    device.platform,
    deviceIdOf(device),
    device.backend === 'local-android' ? device.origin.kind : device.origin,
    ...(device.backend === 'local-android' && device.origin.kind === 'spawned'
      ? [device.origin.avd, device.origin.port, device.origin.emulatorPid]
      : []),
  ];
  return JSON.stringify(identity(a)) === JSON.stringify(identity(b));
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
    .filter((entry) => entry.backend !== 'cloud' && (!platform || entry.platform === platform))
    .flatMap(({ file }) => {
      const read = readBindingFile(file);
      return read.kind === 'binding' ? [deviceReport(read.binding)] : [];
    });
}
