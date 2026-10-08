// @ref llp/0030-one-device-per-worktree.rfc.md §Reap
import fs from 'fs';

import type { IosInventory } from './choose';
import { runCleanupAsync, type Cleanup, type CleanupReport } from './cleanup';
import { clearInspectCache } from './inspect';
import { isExpired } from './lease';
import { ownBindingFiles } from './records';
import {
  listBindingFiles,
  readBindingFile,
  removeBindingFile,
  withRegistryLockAsync,
  writeBindingFile,
} from './registry';
import { WRITE_LOCK_WAIT_MS } from './release';
import { defaultTools } from './tools';
import type { Binding, DeviceTools } from './types';

function rootDeleted(root: string): boolean {
  try {
    fs.lstatSync(root);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Called under the registry lock, after the caller's write. No device subprocesses here. */
export function reapSection(
  projectRoot: string,
  tools: DeviceTools,
  inventory?: IosInventory,
  actions: Cleanup[] = []
): Cleanup[] {
  const own = new Set(ownBindingFiles(projectRoot).map(({ file }) => file));
  const files = [
    ...listBindingFiles('ios', 'local-ios'),
    ...listBindingFiles('android', 'local-android'),
  ];
  for (const file of files) {
    if (own.has(file)) continue;
    const read = readBindingFile(file);
    if (read.kind !== 'binding') continue;
    const binding = read.binding;
    const deleted = rootDeleted(binding.projectRoot);
    if (!deleted && !isExpired(binding, tools.now())) continue;
    const cleanup = chooseCleanup(binding, deleted, tools, inventory);
    if (!cleanup) continue;
    if (cleanup.action === 'shutdown') {
      writeBindingFile(file, { ...binding, expiresAt: tools.now().toISOString() });
    } else {
      removeBindingFile(file);
    }
    actions.push(cleanup);
  }
  return actions;
}

function chooseCleanup(
  binding: Binding,
  deleted: boolean,
  tools: DeviceTools,
  inventory?: IosInventory
): Cleanup | null {
  const { device } = binding;
  const result = (
    action: Cleanup['action'],
    reason = deleted ? 'deleted-worktree' : 'expired'
  ): Cleanup => ({ binding, action, reason, reaped: true });
  if (device.backend === 'local-ios') {
    const listed = inventory?.simulators.find(
      ({ udid, isAvailable }) => udid === device.udid && isAvailable
    );
    if (inventory && !listed) return result('forget', 'device-gone');
    if (device.origin === 'explicit') return deleted ? result('forget') : null;
    if (deleted && process.platform === 'darwin') return result('delete');
    if (listed && listed.state !== 'Shutdown') return result('shutdown');
  }
  if (device.backend === 'local-android') {
    if (device.origin.kind === 'spawned')
      return tools.isPidAlive(device.origin.emulatorPid)
        ? result('kill')
        : result('forget', 'device-gone');
    if (deleted) return result('forget');
  }
  return null;
}

export async function reapDevicesAsync(
  projectRoot: string,
  { tools = defaultTools() }: { tools?: DeviceTools } = {}
) {
  const actions: Cleanup[] = [];
  let reports: CleanupReport[] = [];
  try {
    await withRegistryLockAsync(async () => reapSection(projectRoot, tools, undefined, actions), {
      tools,
      waitMs: WRITE_LOCK_WAIT_MS,
    });
  } finally {
    clearInspectCache();
    // A later file failure must not abandon an earlier queued emulator kill.
    reports = await runCleanupAsync(actions, tools);
  }
  return reports;
}

/** Reap even a refused choice, then run every queued action outside the lock. */
export async function acquireSectionAsync<T>(
  projectRoot: string,
  tools: DeviceTools,
  work: (actions: Cleanup[]) => Promise<T>,
  inventory?: IosInventory
): Promise<T> {
  const actions: Cleanup[] = [];
  try {
    return await withRegistryLockAsync(
      async () => {
        try {
          return await work(actions);
        } finally {
          reapSection(projectRoot, tools, inventory, actions);
        }
      },
      { tools, waitMs: WRITE_LOCK_WAIT_MS }
    );
  } finally {
    clearInspectCache();
    await runCleanupAsync(actions, tools);
  }
}
