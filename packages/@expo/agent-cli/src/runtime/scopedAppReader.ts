// @ref llp/0005-runtime-loop-tools.rfc.md §A loaded app
import { waitForLoadedAppAsync, type LoadedAppWait } from './appLoaded';
import type { CdpTarget } from './cdpClient';
import { probeDevServerAsync } from './devServer';
import {
  classifyTargets,
  deviceInventoryForSelectionAsync,
  withAndroidReverseAsync,
  type TargetSelection,
} from './targetSelection';
import { scopedListClassifier } from './waitReady';

/** Wait for a loaded app of one scope until `deadline`, or until `stillWanted` says no. */
export type LoadedAppWaiter = (
  deadline: number,
  stillWanted?: () => boolean
) => Promise<LoadedAppWait>;

/**
 * Read the apps of one scope: once now, for the decisions before an open, and again on each poll.
 * `navigate` and `dev --wait-ready` both read through it.
 *
 * The device tools are asked again for a changed list, within the budget of the wait that polls.
 * `adb reverse` is read after an own reverse, which can be what places an app beside a twin of the
 * same model.
 */
export async function scopedAppReaderAsync(
  devServerUrl: string,
  targetSelection: TargetSelection,
  projectRoot: string | null
): Promise<{
  decisionTargets: CdpTarget[];
  waiterAsync: (readReverse: boolean) => Promise<LoadedAppWaiter>;
}> {
  const first = await probeDevServerAsync(devServerUrl);
  const inventory = await deviceInventoryForSelectionAsync(
    first.targets,
    targetSelection,
    projectRoot,
    devServerUrl
  );
  return {
    decisionTargets: first.reachable
      ? classifyTargets(first.targets, targetSelection, inventory).read
      : [],
    waiterAsync: async (readReverse) => {
      const facts = readReverse
        ? await withAndroidReverseAsync(targetSelection, inventory, devServerUrl)
        : inventory;
      const classify = scopedListClassifier(targetSelection, facts, first.targets, devServerUrl);
      return (deadline, stillWanted) =>
        waitForLoadedAppAsync(devServerUrl, classify, deadline, stillWanted);
    },
  };
}
