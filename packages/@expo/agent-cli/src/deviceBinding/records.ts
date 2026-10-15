// @ref llp/0035-one-device-per-worktree.rfc.md §Records
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
      return read.kind === 'binding' ? [{ ...deviceReport(read.binding), released: null }] : [];
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
