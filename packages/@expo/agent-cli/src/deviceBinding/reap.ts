// @ref llp/0035-one-device-per-worktree.rfc.md §Reap
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
import type { CloudBinding } from './cloud';
import type { Binding, DeviceTools } from './types';

/** The longest an EAS Simulator session runs; a binding older than this names an ended session. */
const EAS_SESSION_CAP_MS = 115 * 60_000;

function rootDeleted(root: string): boolean {
  try {
    fs.lstatSync(root);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function pastSessionCap(binding: Binding, now: Date): boolean {
  return now.getTime() - Date.parse(binding.boundAt) > EAS_SESSION_CAP_MS;
}

/**
 * The cloud bindings of deleted worktrees whose session the reap stops. Reads files only: no `eas`
 * call and no registry lock, so `status` can name them.
 */
export function deletedWorktreeSessions(projectRoot: string, now: Date): CloudBinding[] {
  const own = new Set(ownBindingFiles(projectRoot).map(({ file }) => file));
  return [...listBindingFiles('ios', 'cloud'), ...listBindingFiles('android', 'cloud')].flatMap(
    (file) => {
      if (own.has(file)) return [];
      const read = readBindingFile(file);
      if (read.kind !== 'binding') return [];
      const { binding } = read;
      const { device } = binding;
      return device.backend === 'cloud' &&
        device.origin !== 'dotenv' &&
        rootDeleted(binding.projectRoot) &&
        !pastSessionCap(binding, now)
        ? [{ ...binding, device }]
        : [];
    }
  );
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
    ...listBindingFiles('ios', 'cloud'),
    ...listBindingFiles('android', 'cloud'),
  ];
  for (const file of files) {
    if (own.has(file)) continue;
    const read = readBindingFile(file);
    if (read.kind !== 'binding') continue;
    const binding = read.binding;
    const deleted = rootDeleted(binding.projectRoot);
    if (!deleted && !isExpired(binding, tools.now())) continue;
    const cleanup = chooseCleanup(binding, deleted, projectRoot, tools, inventory);
    if (!cleanup) continue;
    if (cleanup.action === 'shutdown') {
      writeBindingFile(file, { ...binding, expiresAt: tools.now().toISOString() });
      actions.push(cleanup);
    } else {
      removeBindingFile(file);
      actions.push({ ...cleanup, removedFile: file });
    }
  }
  return actions;
}

/** @param callerRoot the worktree reaping; a deleted worktree's session is stopped from it. */
function chooseCleanup(
  binding: Binding,
  deleted: boolean,
  callerRoot: string,
  tools: DeviceTools,
  inventory?: IosInventory
): Cleanup | null {
  const { device } = binding;
  const reason = deleted ? 'deleted-worktree' : 'expired';
  const result = (action: Exclude<Cleanup['action'], 'stop-cloud'>, why = reason): Cleanup => ({
    binding,
    action,
    reason: why,
    reaped: true,
  });
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
  if (device.backend === 'cloud') {
    if (device.origin === 'dotenv') return result('forget');
    if (pastSessionCap(binding, tools.now())) return result('forget', 'session-cap');
    return {
      binding,
      action: 'stop-cloud',
      stopRoot: deleted ? callerRoot : binding.projectRoot,
      reason,
      reaped: true,
    };
  }
  return null;
}

export async function reapDevicesAsync(
  projectRoot: string,
  { tools = defaultTools() }: { tools?: DeviceTools } = {}
) {
  const actions: Cleanup[] = [];
  let reports: CleanupReport[] = [];
  let error: string | null = null;
  try {
    await withRegistryLockAsync(async () => reapSection(projectRoot, tools, undefined, actions), {
      tools,
      waitMs: WRITE_LOCK_WAIT_MS,
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    clearInspectCache();
    // A later file failure must not abandon an earlier queued emulator kill.
    reports = await runCleanupAsync(actions, tools);
  }
  return { reports, error };
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
