// @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — ready includes the app.
import type { DevServerLockInfo } from '../devLock';
import { PROGRAM_PREFIX } from '../programName';
import { waitForLoadedAppAsync, type AppLoaded } from '../runtime/appLoaded';
import { probeDevServerAsync } from '../runtime/devServer';
import { resolveScopeAsync } from '../runtime/resolveTargetSelection';
import { appNotLoadedError } from '../runtime/scopeRefusal';
import { deviceInventoryForSelectionAsync } from '../runtime/targetSelection';
import { scopedListClassifier } from '../runtime/waitReady';
import { CommandError } from '../utils/errors';
import { EXIT_OUTCOME_TIMEOUT } from '../exitCodes';

/** What the app wait of `dev --detach --wait-ready` saw. */
export interface DevAppWait {
  /** An app of the run's scope holds a debugger target. */
  attached: boolean;
  /** @see AppLoaded */
  loaded: AppLoaded;
  waitedMs: number;
}

/**
 * Wait for the app of the scope that the next runtime command reads: this worktree's local binding
 * of the platform, else its one live EAS session.
 */
export async function waitForDevAppAsync(
  projectRoot: string,
  {
    devServerUrl,
    platform,
    eas,
    budgetMs,
    stillWanted,
  }: {
    devServerUrl: string;
    platform: 'ios' | 'android';
    eas: boolean;
    budgetMs: number;
    stillWanted: () => boolean;
  }
): Promise<DevAppWait> {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const targetSelection = await resolveScopeAsync({ projectRoot, flags: { platform, eas } });
  const first = await probeDevServerAsync(devServerUrl);
  const inventory = await deviceInventoryForSelectionAsync(
    first.targets,
    targetSelection,
    projectRoot,
    devServerUrl
  );
  const classify = scopedListClassifier(targetSelection, inventory, first.targets, devServerUrl);
  const { targets, loaded } = await waitForLoadedAppAsync(
    devServerUrl,
    classify,
    deadline,
    stillWanted
  );
  return { attached: targets > 0, loaded, waitedMs: Date.now() - startedAt };
}

/** The refusal for a wait that ended with no loaded app, or null for a loaded or unaskable one. */
export function devAppWaitError(
  wait: DevAppWait,
  { lock, platform, eas }: { lock: DevServerLockInfo; platform: 'ios' | 'android'; eas: boolean }
): CommandError | null {
  if (wait.attached && wait.loaded !== false) return null;
  if (wait.attached) {
    return appNotLoadedError({
      devServerUrl: lock.url,
      waitedMs: wait.waitedMs,
      cloud: eas,
      platform,
      debuggerTargets: 1,
    });
  }
  const navigate = `${PROGRAM_PREFIX} navigate /${eas ? ' --eas' : ''} --${platform}`;
  const where = eas
    ? `the EAS Simulator session of this worktree`
    : `the ${platform} device bound to this worktree`;
  const error = new CommandError(
    'DEV_DETACH_APP_NOT_ATTACHED',
    [
      `The dev server is up on ${lock.url} (pid ${lock.pid}), and no app on ${where} attached to it within ${wait.waitedMs}ms.`,
      `Why: --wait-ready waits for the app that the next runtime command reads, and the dev server lists no debugger target for it. The open may have failed, or the app may still load its first bundle. The dev server is still running.`,
      `How: run "${navigate}", which opens the app and waits for it. "${PROGRAM_PREFIX} dev:logs" says what the open did.`,
    ].join('\n')
  );
  error.suggestedCommand = navigate;
  error.exitCode = EXIT_OUTCOME_TIMEOUT;
  error.data = { url: lock.url, pid: lock.pid, platform, waitedMs: wait.waitedMs };
  return error;
}
