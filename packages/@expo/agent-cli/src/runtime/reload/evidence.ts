// @ref llp/0021-honest-reports.rfc.md — each label names its own witnesses.
import type { NativePlatform } from '../../plan/types';
import type { DeviceInventory, TargetSelection } from '../targetSelection';
import { waitForFreshAppConnectionAsync } from '../waitReady';
import { contextReplacedTargets, keepsPageId, type ReloadAttempt } from './attempt';
import {
  waitForNewBundleAsync,
  type BundleSignalMark,
  type BundleSignalObservation,
} from './bundleSignal';
import type { ReloadResultJson } from './reloadAsync';
import type { CommandSocketChurn, PreparedRungOne } from './rungOne';

/**
 * The count behind the label, in one clause.
 *
 * F95: `verified by message-socket-peers` on its own is a name, and the reader's only way to check it
 * used to be a number belonging to a different signal. Each label reads its own field.
 */
export function describeEvidence(report: ReloadResultJson): string {
  switch (report.verifiedBy) {
    case 'message-socket-peers':
      return `${report.commandSocketChurn.reconnected} client(s) registered on the dev server's command socket that it had not listed before`;
    case 'fresh-debugger-target':
      return `${report.appsReconnected} debugger target(s) the dev server had not listed before`;
    case 'dev-server-bundle':
      return `${report.bundlesAfterReload.count} bundle(s) the dev server finished after this command acted`;
    case 'app-relaunch':
      return 'the app was stopped on the device and started again';
    case 'debugger-context-replaced':
      return `${contextReplacedTargets(report.attempts)
        .map((each) => each.deviceName)
        .join(', ')} answered from a new JavaScript context after Page.reload`;
    default:
      return 'nothing';
  }
}

/** Everything a label could be named off, as the payload will carry it. */
export interface VerificationEvidence {
  churn: CommandSocketChurn;
  freshTargets: number;
  bundle: BundleSignalObservation | null;
  attempts: readonly ReloadAttempt[];
}

/**
 * Whether the payload holds this label's **own** evidence, non-empty.
 *
 * @ref llp/0021-honest-reports.rfc.md §The rules — F95.
 *
 * The rule `verifiedBy` is chosen by, spelled once so a fifth label cannot be added without saying
 * what would prove it. Each case names a field of {@link ReloadResultJson} and nothing else: a reader
 * who wants to check the label reads that field, and a label whose field is empty is not printed.
 */
export function hasEvidenceFor(
  label: NonNullable<ReloadResultJson['verifiedBy']>,
  evidence: VerificationEvidence
): boolean {
  switch (label) {
    case 'message-socket-peers':
      return evidence.churn.observed === true && evidence.churn.reconnected > 0;
    case 'fresh-debugger-target':
      return evidence.freshTargets > 0;
    case 'dev-server-bundle':
      return evidence.bundle?.observed === true && evidence.bundle.newBundles > 0;
    case 'app-relaunch':
      // The relaunch is its own observation — `simctl terminate` names a process and fails when there
      // is none — so what has to be in the payload is the attempt that made it, succeeding.
      return evidence.attempts.some((attempt) => attempt.method === 'device' && attempt.ok);
    case 'debugger-context-replaced':
      return contextReplacedTargets(evidence.attempts).length > 0;
  }
}

/** What the wait for a cloud reload found: the target list, and the dev server's own output. */
export interface ReloadEvidence {
  appsConnected: number;
  freshTargets: number;
  timedOut: boolean;
  waitedMs: number;
  bundle: BundleSignalObservation;
}

/**
 * Wait for either proof a reload leaves: a fresh debugger target, or a bundle the dev server served.
 *
 * Two watches on one budget, and the first to answer ends the wait — the target list because it is
 * the stronger fact and the rest of the CLI needs it, the log because on some apps it is the only one
 * there is (S11). Every rung uses it (wave 21); until then the log was read on the cloud path alone,
 * which made one question have two answers.
 */
export async function waitForReloadEvidenceAsync(
  devServerUrl: string,
  projectRoot: string,
  {
    timeoutMs,
    knownTargetIds,
    bundleMark,
    bundlePlatforms,
    targetSelection,
    deviceInventory,
  }: {
    targetSelection: TargetSelection;
    deviceInventory: DeviceInventory;
    timeoutMs: number;
    knownTargetIds: readonly string[];
    bundleMark: BundleSignalMark;
    /**
     * Which bundles and targets may count: a skipped app's never do (llp/0005 §Target owner), and
     * another platform's bundle never does either (F126).
     */
    bundlePlatforms: NativePlatform[] | 'any';
  }
): Promise<ReloadEvidence> {
  const startedAt = Date.now();
  // Whichever answers first ends both. Not a `Promise.race`: the loser is asked to stop and still
  // returns what its last read saw, because `appsConnected` is a number the failure text quotes and
  // an abandoned wait would leave it at zero for a dev server it had simply stopped asking.
  const settled = new AbortController();
  const targets = waitForFreshAppConnectionAsync(devServerUrl, {
    timeoutMs,
    knownTargetIds,
    targetSelection,
    deviceInventory,
    signal: settled.signal,
  }).then((result) => {
    if (result.freshTargets > 0) {
      settled.abort();
    }
    return result;
  });
  const bundle = waitForNewBundleAsync(projectRoot, {
    before: bundleMark,
    timeoutMs,
    signal: settled.signal,
    platforms: bundlePlatforms,
  }).then((result) => {
    if (result.observed) {
      settled.abort();
    }
    return result;
  });
  const [connection, observation] = await Promise.all([targets, bundle]);
  return {
    appsConnected: connection.appsConnected,
    freshTargets: connection.freshTargets,
    timedOut: connection.timedOut && !observation.observed,
    waitedMs: Date.now() - startedAt,
    bundle: observation,
  };
}

type Label = NonNullable<ReloadResultJson['verifiedBy']>;

/**
 * The strongest label whose own evidence is in the payload: the mechanism's, then the shared two.
 *
 * "The app's connection was replaced" and "the dev server served a bundle to somebody" are
 * different facts, and the stronger one belongs in the report. A label with no evidence behind it
 * is never named (F95).
 */
export function chooseVerifiedBy<Proof extends Label>(
  mechanismProof: Proof | null,
  evidence: VerificationEvidence
): Proof | 'fresh-debugger-target' | 'dev-server-bundle' | null {
  return (
    ([mechanismProof, 'fresh-debugger-target', 'dev-server-bundle'] as const).find(
      (label): label is NonNullable<typeof label> =>
        label != null && hasEvidenceFor(label, evidence)
    ) ?? null
  );
}

/** Why the shared observations were not watched after a mechanism ran. */
export type Unwatched =
  /** A new JavaScript context on the own target already proved the reload. */
  | 'context-replaced'
  /**
   * The app comes back under the page id it had, it was listed before the run, and no bundle may
   * count: nothing could arrive to prove it.
   */
  | 'nothing-can-prove';

/**
 * Watch for the shared observations after a mechanism ran, and name what proved the reload.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload. `runtime:reload` and `smoke` both
 * end their reload here, so the label is chosen by one rule.
 */
export async function observeReloadAsync<Proof extends Label>(
  devServerUrl: string,
  projectRoot: string,
  {
    prepared,
    mechanismProof,
    churn,
    attempts,
    bundleMark,
    timeoutMs,
  }: {
    prepared: PreparedRungOne;
    mechanismProof: Proof | null;
    churn: CommandSocketChurn;
    attempts: readonly ReloadAttempt[];
    bundleMark: BundleSignalMark;
    timeoutMs: number;
  }
): Promise<{
  verifiedBy: Proof | 'fresh-debugger-target' | 'dev-server-bundle' | null;
  evidence: ReloadEvidence | null;
  unwatched: Unwatched | null;
}> {
  const { bundlePlatforms } = prepared.policy;
  const unwatched: Unwatched | null =
    mechanismProof === 'debugger-context-replaced'
      ? 'context-replaced'
      : keepsPageId(attempts) != null &&
          prepared.classifiedTargets.read.length > 0 &&
          Array.isArray(bundlePlatforms) &&
          bundlePlatforms.length === 0
        ? 'nothing-can-prove'
        : null;
  const evidence =
    unwatched == null
      ? await waitForReloadEvidenceAsync(devServerUrl, projectRoot, {
          timeoutMs,
          knownTargetIds: prepared.targets.map((target) => target.id),
          targetSelection: prepared.targetSelection,
          deviceInventory: prepared.deviceInventory,
          bundleMark,
          bundlePlatforms,
        })
      : null;
  const verifiedBy = chooseVerifiedBy(mechanismProof, {
    churn,
    freshTargets: evidence?.freshTargets ?? 0,
    bundle: evidence?.bundle ?? null,
    attempts,
  });
  return { verifiedBy, evidence, unwatched };
}
