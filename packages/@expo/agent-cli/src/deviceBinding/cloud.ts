// @ref llp/0034-eas-session-binding.plan.md §PR 5
import { canonicalizeExistingPath } from '../utils/dir';
import { deviceUnavailableError } from './errors';
import { clearInspectCache } from './inspect';
import { isExpired, leaseFrom } from './lease';
import { acquireSectionAsync } from './reap';
import { deviceReport, ownBindingFiles } from './records';
import {
  bindingPathFor,
  readBindingFile,
  removeBindingFile,
  withRegistryLockAsync,
  writeBindingFile,
} from './registry';
import { defaultTools } from './tools';
import type { Binding, DevicePlatform, DeviceTools, ReleasedDevice } from './types';

/** Read-only, including expired records when explicitly stopping sessions. */
export function ownCloudBindings(projectRoot: string, includeExpired = false): Binding[] {
  return ownBindingFiles(projectRoot)
    .filter(({ backend }) => backend === 'cloud')
    .flatMap(({ file }) => {
      const read = readBindingFile(file);
      return read.kind === 'binding' && (includeExpired || !isExpired(read.binding, new Date()))
        ? [read.binding]
        : [];
    });
}

export async function ownCloudIdsAsync(projectRoot: string): Promise<string[]> {
  return ownCloudBindings(projectRoot).flatMap(({ device }) =>
    device.backend === 'cloud' ? [device.id] : []
  );
}

export async function acquireCloudBindingAsync(
  projectRoot: string,
  {
    platform,
    id,
    origin,
    tools = defaultTools(),
  }: {
    platform: DevicePlatform;
    id: string;
    origin: 'started' | 'dotenv';
    tools?: DeviceTools;
  }
): Promise<Binding> {
  return acquireSectionAsync(projectRoot, tools, async () => {
    const file = bindingPathFor(projectRoot, platform, 'cloud');
    const read = readBindingFile(file);
    if (read.kind === 'unreadable')
      throw deviceUnavailableError('unreadable', { platform, path: file });
    const before = read.kind === 'binding' ? read.binding : null;
    const same = before?.device.backend === 'cloud' && before.device.id === id;
    const lease = leaseFrom(tools.now());
    const binding: Binding = same
      ? { ...before!, expiresAt: lease.expiresAt }
      : {
          version: 1,
          projectRoot: canonicalizeExistingPath(projectRoot),
          device: { backend: 'cloud', platform, id, origin },
          ...lease,
        };
    writeBindingFile(file, binding);
    return binding;
  });
}

/** Stop callers remove only the session they actually stopped, regardless of lease age. */
export async function releaseCloudBindingAsync(
  projectRoot: string,
  sessionId: string,
  tools = defaultTools()
): Promise<ReleasedDevice[]> {
  try {
    return await withRegistryLockAsync(
      async () => {
        const released: ReleasedDevice[] = [];
        for (const { file, backend } of ownBindingFiles(projectRoot)) {
          if (backend !== 'cloud') continue;
          const read = readBindingFile(file);
          if (
            read.kind !== 'binding' ||
            read.binding.device.backend !== 'cloud' ||
            read.binding.device.id !== sessionId
          )
            continue;
          removeBindingFile(file);
          released.push({ ...deviceReport(read.binding), released: true, shutDown: true });
        }
        return released;
      },
      { waitMs: 30_000, tools }
    );
  } finally {
    clearInspectCache();
  }
}
