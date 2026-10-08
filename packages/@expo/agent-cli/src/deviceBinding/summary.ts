// @ref llp/0030-one-device-per-worktree.rfc.md §Output and errors
import { inspectBindingCachedAsync } from './inspect';
import { ownBindingFiles } from './records';
import { readBindingFile } from './registry';
import {
  deviceIdOf,
  deviceNameOf,
  type BindingBackend,
  type DevicePlatform,
  type InspectState,
} from './types';

export interface BindingSummary {
  platform: DevicePlatform;
  backend: BindingBackend;
  id: string;
  name: string;
  origin: string;
  state: InspectState;
  expiresAt: string;
}

/** Uses the same cached inspection as status's device section; cloud files are never probed. */
export async function readBindingSummaryAsync(
  projectRoot: string,
  timeoutMs = 2_500
): Promise<BindingSummary[]> {
  const entries = await Promise.all(
    ownBindingFiles(projectRoot).map(async ({ file, platform, backend }) => {
      const read = readBindingFile(file);
      if (read.kind !== 'binding') return [];
      const { binding } = read;
      const { device } = binding;
      const inspection = await inspectBindingCachedAsync(projectRoot, platform, backend, {
        timeoutMs,
      });
      return [
        {
          platform,
          backend,
          id: deviceIdOf(device),
          name: deviceNameOf(device),
          origin: device.backend === 'local-android' ? device.origin.kind : device.origin,
          state: inspection.state,
          expiresAt: binding.expiresAt,
        },
      ];
    })
  );
  return entries.flat();
}
