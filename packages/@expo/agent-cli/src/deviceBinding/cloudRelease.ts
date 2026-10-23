// @ref llp/0035-one-device-per-worktree.rfc.md §Session cleanup
// The one release path of an EAS session stop: remove this worktree's binding under the registry
// lock, stop the session, and write the binding back when the stop fails.
import { cloudStopCommand, stopAndWriteBackAsync } from './cleanup';
import { readCloudBindings, type CloudBinding } from './cloud';
import { debugEvent } from './events';
import { clearInspectCache } from './inspect';
import { bindingPathFor, removeBindingFile, withRegistryLockAsync } from './registry';
import { WRITE_LOCK_WAIT_MS } from './release';
import { defaultTools } from './tools';
import type { DeviceTools } from './types';

export interface CloudRelease {
  id: string;
  /** This worktree's binding of the session, null for a session with no binding. */
  binding: CloudBinding | null;
  ok: boolean;
  reason: string | null;
}

/**
 * Stop every session in `ids`, in order. One registry section first removes this worktree's
 * bindings of them, at any lease age; a failed stop writes its binding back. A session with no
 * binding is stopped too.
 */
export async function releaseCloudSessionsAsync(
  projectRoot: string,
  ids: string[],
  reason: string,
  tools: DeviceTools = defaultTools()
): Promise<{ releases: CloudRelease[]; lockError: string | null }> {
  const removed = new Map<string, { file: string; binding: CloudBinding }>();
  let lockError: string | null = null;
  try {
    await withRegistryLockAsync(
      async () => {
        for (const binding of readCloudBindings(projectRoot).bindings) {
          if (!ids.includes(binding.device.id)) continue;
          const file = bindingPathFor(projectRoot, binding.device.platform, 'cloud');
          removeBindingFile(file);
          removed.set(binding.device.id, { file, binding });
        }
      },
      { waitMs: WRITE_LOCK_WAIT_MS, tools }
    );
  } catch (error) {
    // The sessions still bill: stop them, and keep their bindings for the next stop.
    lockError = error instanceof Error ? error.message : String(error);
  } finally {
    clearInspectCache();
  }
  const releases: CloudRelease[] = [];
  for (const id of ids) {
    const entry = removed.get(id);
    const result = await stopReleasedAsync(projectRoot, id, reason, tools, entry);
    releases.push({ id, binding: entry?.binding ?? null, ...result });
  }
  return { releases, lockError };
}

/** The stop of a released session. A failed stop's reason ends with the command that stops it. */
async function stopReleasedAsync(
  projectRoot: string,
  id: string,
  reason: string,
  tools: DeviceTools,
  removed?: { file: string; binding: CloudBinding }
): Promise<{ ok: boolean; reason: string | null }> {
  const result = await stopAndWriteBackAsync(projectRoot, id, tools, removed);
  debugEvent('device_cloud_session_released', { sessionId: id, reason, ok: result.ok });
  return result.ok ? result : { ok: false, reason: endsIt(result.reason ?? 'the stop failed', id) };
}

function endsIt(why: string, id: string): string {
  return `${why}; "${cloudStopCommand(id)}" ends it`;
}

export type StartedRelease =
  | { outcome: 'stopped' }
  | { outcome: 'failed' | 'kept'; reason: string };

/**
 * Stop a session this run started, through the release path. One registry section checks the
 * bindings and removes this run's: a binding with origin `dotenv` was written by another run that
 * selected the session through the dotenv, so the session is kept. A binding this run wrote has
 * origin `started`, since only the run that started a session writes that origin.
 * An unreadable binding file or a lock that cannot be taken keeps the session too.
 *
 * @ref llp/0035-one-device-per-worktree.rfc.md §Session binding — a session no binding records belongs to no run
 */
export async function releaseStartedSessionAsync(
  projectRoot: string,
  id: string,
  reason: string,
  tools: DeviceTools = defaultTools()
): Promise<StartedRelease> {
  let section: { kept: string } | { removed?: { file: string; binding: CloudBinding } };
  try {
    section = await withRegistryLockAsync(
      async () => {
        const { bindings, unreadable } = readCloudBindings(projectRoot);
        const binding = bindings.find(({ device }) => device.id === id);
        if (binding?.device.origin === 'dotenv')
          return { kept: 'another run in this worktree recorded it' };
        if (unreadable[0]) return { kept: `the binding at ${unreadable[0].path} cannot be read` };
        if (!binding) return {};
        const file = bindingPathFor(projectRoot, binding.device.platform, 'cloud');
        removeBindingFile(file);
        return { removed: { file, binding } };
      },
      { waitMs: WRITE_LOCK_WAIT_MS, tools }
    );
  } catch (error) {
    section = {
      kept: `the device registry could not be locked (${error instanceof Error ? error.message : String(error)})`,
    };
  } finally {
    clearInspectCache();
  }
  if ('kept' in section) return { outcome: 'kept', reason: `${section.kept}, so it stays` };
  const result = await stopReleasedAsync(projectRoot, id, reason, tools, section.removed);
  return result.ok
    ? { outcome: 'stopped' }
    : { outcome: 'failed', reason: result.reason ?? endsIt('the stop failed', id) };
}
