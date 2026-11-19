// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — ready includes the app.
import type { DevServerLockInfo } from '../devLock';
import { EXIT_OUTCOME_TIMEOUT } from '../exitCodes';
import type { NativePlatform } from '../plan/types';
import { PROGRAM_PREFIX } from '../programName';
import type { LoadedAppWait } from '../runtime/appLoaded';
import { resolveScopeAsync } from '../runtime/resolveTargetSelection';
import { scopedAppReaderAsync } from '../runtime/scopedAppReader';
import { CommandError } from '../utils/errors';

/** The app that a `dev --detach` run opened: on its EAS session, or on its local binding. */
export interface DevAppOpen {
  on: 'eas' | 'local';
  platform: NativePlatform;
  /** Targets listed before an open that reloads an attached app: the app from before it. */
  staleTargetIds: readonly string[];
}

/** How an EAS re-run got its session on the running dev server. */
export type ReuseSession =
  | { kind: 'none' }
  /** The running child still starts the session; this run waited for its id. */
  | { kind: 'followed'; sessionId: string | null }
  /** This run opened the app on the session again, which reloads an attached app. */
  | { kind: 'reopened'; sessionId: string | null; staleTargetIds: readonly string[] };

/** What a `dev --detach` run did that decides whether it opened an app. */
export type DevRun =
  | {
      kind: 'spawned';
      /** The platform of the EAS session the child opens the app on. */
      easPlatform: NativePlatform | null;
      /** The platform of this worktree's local binding. */
      boundPlatform: NativePlatform | null;
      open: boolean;
    }
  | {
      kind: 'reused';
      easPlatform: NativePlatform | null;
      /** `none` for a `smoke` reuse, which opens nothing. */
      session: ReuseSession;
    };

/** The `app` of the `--json` report: the app wait ended with a loaded app. */
export interface DevAppReport {
  attached: true;
  /** @see AppLoaded — never false here: an app that ran no bundle ends the wait with exit 22. */
  loaded: true | null;
  waitedMs: number;
}

/** Why the app wait stopped without an app: the dev server exited, or stopped answering. */
export type DevServerGone = { gone: 'exited' | 'not-answering' };

/** The app to wait for: only `--wait-ready` waits, and only for an app that the run opened. */
export function appWaitOf(waitReady: boolean, run: DevRun): DevAppOpen | null {
  if (!waitReady) return null;
  if (run.kind === 'reused') {
    const { session, easPlatform } = run;
    if (session.kind === 'none' || session.sessionId == null || easPlatform == null) return null;
    const staleTargetIds = session.kind === 'reopened' ? session.staleTargetIds : [];
    return { on: 'eas', platform: easPlatform, staleTargetIds };
  }
  if (run.easPlatform != null) return { on: 'eas', platform: run.easPlatform, staleTargetIds: [] };
  return run.open && run.boundPlatform != null
    ? { on: 'local', platform: run.boundPlatform, staleTargetIds: [] }
    : null;
}

/**
 * Wait for the app of the scope that a runtime command with the run's flags reads: with `--eas`,
 * this worktree's EAS session; else its local binding of the platform.
 *
 * @returns the report of a loaded app, or why the dev server is gone.
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
): Promise<DevAppReport | DevServerGone> {
  const startedAt = Date.now();
  const targetSelection = await resolveScopeAsync({
    projectRoot,
    flags: { platform: opened.platform, eas: opened.on === 'eas' },
  });
  const reader = await scopedAppReaderAsync(lock.url, targetSelection, projectRoot);
  // The child ran `adb reverse` for a local Android open; an EAS session has no adb.
  const waitAsync = reader.waiter(opened.on === 'local' && opened.platform === 'android');
  const wait = await waitAsync(startedAt + budgetMs, {
    stillWanted,
    staleTargetIds: opened.staleTargetIds,
  });
  const waitedMs = Date.now() - startedAt;
  switch (wait.kind) {
    case 'loaded':
      return { attached: true, loaded: wait.loaded, waitedMs };
    case 'abandoned':
      return { gone: 'exited' };
    case 'not-attached':
      if (!wait.devServerAnswered) return { gone: 'not-answering' };
      throw devAppWaitError(wait, { lock, opened, waitedMs });
    case 'not-loaded':
      throw devAppWaitError(wait, { lock, opened, waitedMs });
  }
}

function devAppWaitError(
  wait: Extract<LoadedAppWait, { kind: 'not-loaded' | 'not-attached' }>,
  { lock, opened, waitedMs }: { lock: DevServerLockInfo; opened: DevAppOpen; waitedMs: number }
): CommandError {
  const { platform } = opened;
  const eas = opened.on === 'eas';
  const navigate = `${PROGRAM_PREFIX} navigate /${eas ? ' --eas' : ''} --${platform}`;
  const where = eas
    ? `the Expo simulator session of this worktree`
    : `the ${platform} device bound to this worktree`;
  const lines =
    wait.kind === 'not-loaded'
      ? [
          `The dev server is up on ${lock.url} (pid ${lock.pid}), and the app on ${where} attached to it but ran no JavaScript bundle within ${waitedMs}ms.`,
          `Why: --wait-ready waits for the app that the next runtime command reads, and its runtime answers that no bundle ran. It may still load its first bundle, or show a launcher or an error screen. The dev server is still running.`,
          `How: run "${navigate}", which waits for the bundle. "${PROGRAM_PREFIX} dev:logs" shows what the bundler did.`,
        ]
      : [
          `The dev server is up on ${lock.url} (pid ${lock.pid}), and no app on ${where} attached to it within ${waitedMs}ms.`,
          `Why: --wait-ready waits for the app that the next runtime command reads, and the dev server lists no debugger target for it. The open may have failed, or the app may still load its first bundle. The dev server is still running.`,
          `How: run "${navigate}", which opens the app and waits for it. "${PROGRAM_PREFIX} dev:logs" says what the open did.`,
        ];
  const error = new CommandError(
    wait.kind === 'not-loaded' ? 'APP_NOT_LOADED' : 'DEV_DETACH_APP_NOT_ATTACHED',
    lines.join('\n')
  );
  error.suggestedCommand = navigate;
  error.exitCode = EXIT_OUTCOME_TIMEOUT;
  error.data = {
    url: lock.url,
    pid: lock.pid,
    platform,
    waitedMs,
    debuggerTargets: wait.kind === 'not-loaded' ? wait.targets : 0,
  };
  return error;
}
