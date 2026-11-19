// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — ready includes the app.
import type { DevServerLockInfo } from '../devLock';
import { EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import type { NativePlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import type { LoadedAppWait } from '../runtime/appLoaded';
import { resolveScopeAsync } from '../runtime/resolveTargetSelection';
import { scopedAppReaderAsync } from '../runtime/scopedAppReader';
import { appNotLoadedError } from '../runtime/scopeRefusal';
import { CommandError } from '../utils/errors';

/** The app that a `dev --detach` run opened: on its EAS session, or on its local binding. */
export interface DevAppOpen {
  on: 'eas' | 'local';
  platform: NativePlatform;
}

/** The `app` of the `--json` report: the app wait ended with a loaded app. */
export interface DevAppReport {
  attached: true;
  /** @see AppLoaded — never false here: an app that ran no bundle ends the wait with exit 22. */
  loaded: true | null;
  waitedMs: number;
}

/** The app to wait for: only `--wait-ready` waits, and only for an app that the run opened. */
export function appWaitOf({
  waitReady,
  opened,
}: {
  waitReady: boolean;
  opened: DevAppOpen | null;
}): DevAppOpen | null {
  return waitReady ? opened : null;
}

/**
 * Wait for the app of the scope that a runtime command with the run's flags reads: with `--eas`,
 * this worktree's EAS session; else its local binding of the platform.
 *
 * @returns the report of a loaded app, or `abandoned` when `stillWanted` said no first.
 * @throws {CommandError} exit 22 when the wait ends with no app attached, or with no bundle run.
 */
export async function waitForDevAppAsync(
  projectRoot: string,
  {
    lock,
    opened,
    budgetMs,
    stillWanted,
  }: {
    lock: DevServerLockInfo;
    opened: DevAppOpen;
    budgetMs: number;
    stillWanted: () => boolean;
  }
): Promise<DevAppReport | 'abandoned'> {
  const startedAt = Date.now();
  const targetSelection = await resolveScopeAsync({
    projectRoot,
    flags: { platform: opened.platform, eas: opened.on === 'eas' },
  });
  const reader = await scopedAppReaderAsync(lock.url, targetSelection, projectRoot);
  // The child ran `adb reverse` for a local Android open; an EAS session has no adb.
  const waitAsync = await reader.waiterAsync(
    opened.on === 'local' && opened.platform === 'android'
  );
  const wait = await waitAsync(startedAt + budgetMs, stillWanted);
  const waitedMs = Date.now() - startedAt;
  switch (wait.kind) {
    case 'loaded':
      return { attached: true, loaded: wait.loaded, waitedMs };
    case 'abandoned':
      return 'abandoned';
    default:
      throw devAppWaitError(wait, { lock, opened, waitedMs });
  }
}

function devAppWaitError(
  wait: Extract<LoadedAppWait, { kind: 'not-loaded' | 'not-attached' }>,
  { lock, opened, waitedMs }: { lock: DevServerLockInfo; opened: DevAppOpen; waitedMs: number }
): CommandError {
  const { platform } = opened;
  const eas = opened.on === 'eas';
  if (wait.kind === 'not-loaded') {
    return appNotLoadedError({
      devServerUrl: lock.url,
      waitedMs,
      cloud: eas,
      platform,
      debuggerTargets: wait.targets,
    });
  }
  const navigate = `${PROGRAM_PREFIX} navigate /${eas ? ' --eas' : ''} --${platform}`;
  const where = eas
    ? `the Expo simulator session of this worktree`
    : `the ${platform} device bound to this worktree`;
  const error = new CommandError(
    'DEV_DETACH_APP_NOT_ATTACHED',
    [
      `The dev server is up on ${lock.url} (pid ${lock.pid}), and no app on ${where} attached to it within ${waitedMs}ms.`,
      `Why: --wait-ready waits for the app that the next runtime command reads, and the dev server lists no debugger target for it. The open may have failed, or the app may still load its first bundle. The dev server is still running.`,
      `How: run "${navigate}", which opens the app and waits for it. "${PROGRAM_PREFIX} dev:logs" says what the open did.`,
    ].join('\n')
  );
  error.suggestedCommand = navigate;
  error.exitCode = EXIT_OUTCOME_TIMEOUT;
  error.data = { url: lock.url, pid: lock.pid, platform, waitedMs };
  return error;
}
