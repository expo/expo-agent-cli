// @ref llp/0005-runtime-loop-tools.rfc.md §One preflight for the runtime family
// @ref llp/0010-agent-conventions.rfc.md §Exit codes
// The one question every `runtime:*` command asks before it does any work: is there anything to
// talk to, and what is it.
//
// **Why one module.** Six commands need the same two facts — a dev server, and something connected
// to it — and each one used to establish them its own way. `runtime:eval` read `/json/list` three
// times (discovery, the device index, the "is an app there" check) and any two of those reads could
// disagree about which app was attached. `runtime:tree` asked its bundle gate *first*, so a run with
// no app spent the gate's whole budget before it could say the obvious thing. `runtime:reload` wrote
// its own "no dev server" prose, with a different `How:` line from the identical failure next door.
// The refusals were the same failure in four voices, and the *order* of the checks differed per
// command, which is what makes a family feel like four tools.
//
// **What it answers with.** The populated connection — the dev server URL, how it was found, the
// debugger targets, and the platform-scoped subset a command may read — so that nothing downstream
// resolves any of it again. Or one refusal, in one shape:
//
//   What  which list is empty, and on which dev server
//   Why   no app is connected, **or** no dev server is running there — never the two conflated
//   How   the ladder out, with `--eas` kept on every command in it when the caller passed it
//
// **Two exit codes, and the difference is whether asking again can help** (llp/0010 §Exit codes).
// No dev server is `1`: nothing answered, and nothing this CLI can do in a second changes that, so
// `1`'s promise — "running the same line again changes nothing" — holds. An empty *target* list is
// `22`, and it is the one refusal here where that promise was false: a reloading app is absent from
// `/json/list` for about half a second, and `runtime:tree` run straight after a reload reported "no
// app" four times in five, recovering on a plain retry every time [friction run 9, F141]. So the
// question is asked for the length of that window before it is answered, and a list that is still
// empty afterwards is reported as inconclusive rather than as a call to fix.

import { resolveTargetSelectionAsync } from './resolveTargetSelection';
import { liveCloudBindings } from '../deviceBinding/cloud';
import * as Log from '../log';
import type { NavigatePlatform } from '../navigate/device';
import { PROGRAM_PREFIX } from '../programName';
import { hostPlatform } from '../smoke/suggest';
import { CommandError } from '../utils/errors';
import type { CdpTarget } from './cdpClient';
import {
  APP_RECONNECT_GRACE_MS,
  howToNameTheDevServer,
  normalizeDevServerUrl,
  probeDevServerAsync,
  type DevServerSource,
} from './devServer';
import { discoverDevServerAsync } from './discoverDevServer';
import { emptyScopeError, noAppConnectedError, reachTheAppLadder, withData } from './scopeRefusal';
import {
  skippedAppsOf,
  describeSkippedApps,
  describeSelectedDevice,
  EMPTY_DEVICE_INVENTORY,
  type DeviceInventory,
  type ClassifiedTargets,
  type TargetSelection,
} from './targetSelection';

/**
 * Where a runtime command was run, when it was run in a project.
 *
 * Only used to find the dev server: a project knows where its own dev server listens, and a command
 * that has no project to ask falls back to scanning ports.
 */
export interface RuntimeContext {
  projectRoot?: string | null;
}

/**
 * What a command cannot do its job without.
 *
 * - **`debugger-target`** — a JavaScript runtime to read or drive: `runtime:eval`, `runtime:errors`,
 *   `runtime:tree`, `runtime:tap`, `runtime:type`. Nothing they do means anything without one.
 * - **`dev-server`** — a dev server and nothing more. `runtime:reload` is here because it can
 *   *start* an app that is not running, so "no app is connected" is a rung of its ladder rather
 *   than a refusal — but with no dev server there is no bundle to reload onto, and stopping the app
 *   would replace a stale screen with no screen.
 * - **`optional`** — neither. `runtime:stop` acts on a *device*, and an app can be running with no
 *   dev server behind it at all; the dev server is its strongest evidence for **which** app is
 *   running and never a precondition (llp/0010 §Other gates, in brief
 *   is success).
 */
export type RuntimeNeed = 'debugger-target' | 'dev-server' | 'optional';

/** The dev server, and what is connected to it, read once. */
export interface RuntimeConnection {
  /** The dev server origin that answered, or the one that was tried and did not. */
  devServerUrl: string;
  /** Which discovery step produced it: `flag`, `lock`, `log`, `default` or `scan`. */
  devServerSource: DevServerSource;
  /** Whether the caller named the dev server, with `--dev-server-url` or `--port`. */
  named: boolean;
  /** The dev server answered its debugger target list. */
  reachable: boolean;
  /** Why it did not, or null when it did. */
  unreachableReason: string | null;
  /** Every debugger target it listed, unscoped — what the *report* owes a reader. */
  targets: CdpTarget[];
  /** Connected targets classified once for every reader of this connection. */
  classifiedTargets: ClassifiedTargets;
  /** The platform and device this command intends to read. */
  targetSelection: TargetSelection;
  /** Known devices and worktree bindings used to classify {@link targets} for {@link targetSelection}. */
  deviceInventory: DeviceInventory;
}

/**
 * The counts a refusal carries, so an agent branches on numbers rather than on prose.
 *
 * @ref llp/0010-agent-conventions.rfc.md §The `--json` error envelope — the key set never varies,
 * and a fact the run does not have is null. `commandSocketClients` is null for every command that
 * never opens the dev server's `/message` socket, which is all of them but `runtime:reload`.
 */
export interface RuntimePreflightData {
  devServerUrl: string;
  devServerReachable: boolean;
  /** How many runtimes `GET /json/list` named. */
  debuggerTargets: number;
  /** How many clients `getpeers` named on the client command socket, or null when nothing asked. */
  commandSocketClients: number | null;
  /** The platform the caller asked for, or null when they named none. */
  platform: string | null;
}

export interface RuntimePreflightOptions {
  need: RuntimeNeed;
  /** The `--dev-server-url`/`--port` the caller named, or null to discover one. */
  devServerUrl: string | null;
  /** Require an app on this platform instead of any app. */
  platform?: NavigatePlatform;
  /**
   * The caller passed `--eas`, so every command in the ladder keeps the flag.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §Cloud simulator — F5x and S5. A
   * suggestion that drops it sends a caller to a local simulator their machine has not got, and one
   * that drops `--tunnel` starts a dev server the session cannot reach.
   */
  cloud?: boolean;
  /**
   * How long to keep asking while the target list is empty, in milliseconds.
   *
   * Unset is {@link APP_RECONNECT_GRACE_MS} for a command that needs a runtime and zero for one that
   * does not, which is the default a caller almost never has reason to override.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload — F39, and **F141.** The grace
   * was `runtime:errors`' alone, because F39 was found on the `reload → errors` chain the CLI's own
   * follow-ups print. `runtime:tree` asks the identical question and asked it once: run straight
   * after a reload it read the list inside the app's re-registration window, found it empty, and
   * reported "no app is connected" — four times in five, recovering on a plain retry every time
   * [observed — friction run 9, F141]. The window belongs to the *question*, not to the command.
   */
  retryMs?: number;
  /**
   * What this machine's device tools reported, instead of asking them.
   *
   * Commands never pass them — reading them for the targets that were just listed is the point of
   * the preflight. They are here for a caller that already has them, and for the tests, which must
   * not spawn `simctl` and `adb` to ask about a platform.
   */
  deviceInventory?: DeviceInventory;
}

/** How often the target list is re-read while the grace period runs. */
const APP_RECONNECT_POLL_MS = 250;

/**
 * Resolve the connection a runtime command needs, or refuse in the family's one shape.
 *
 * @throws {CommandError} `NO_DEV_SERVER` when nothing answers and the command needs one,
 * `NO_APP_CONNECTED` when the dev server runs and names no runtime this command may read.
 */
export async function preflightRuntimeAsync(
  {
    need,
    devServerUrl,
    platform,
    cloud = false,
    retryMs,
    deviceInventory: knownDeviceInventory,
  }: RuntimePreflightOptions,
  context: RuntimeContext = {}
): Promise<RuntimeConnection> {
  // The default belongs to the `need`, not to the command (F141): every command that cannot work
  // without a runtime waits out the window a reloading app is invisible in, and no command that can
  // work without one is made to wait for it.
  const retryBudgetMs = retryMs ?? (need === 'debugger-target' ? APP_RECONNECT_GRACE_MS : 0);
  const named = devServerUrl != null;
  const discovery = await discoverDevServerAsync(devServerUrl ?? undefined, {
    projectRoot: context.projectRoot ?? undefined,
  });
  const url = normalizeDevServerUrl(discovery.devServerUrl);

  let reachable = discovery.reachable;
  let targets = discovery.targets;
  let unreachableReason = discovery.reason ?? null;

  // Only an empty list is worth asking again about: an unreachable dev server does not become
  // reachable by re-reading it within three seconds, and a list with something in it is an answer.
  if (reachable && targets.length === 0 && retryBudgetMs > 0) {
    const deadline = Date.now() + retryBudgetMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, APP_RECONNECT_POLL_MS));
      const probe = await probeDevServerAsync(url);
      reachable = probe.reachable;
      targets = probe.targets;
      unreachableReason = probe.reason ?? null;
      if (!reachable || targets.length > 0) {
        break;
      }
    }
  }

  const { targetSelection, deviceInventory, classifiedTargets } = await resolveTargetSelectionAsync(
    {
      projectRoot: context.projectRoot ?? null,
      flags: { platform, eas: cloud },
      targets: reachable ? targets : [],
      deviceInventory: reachable
        ? knownDeviceInventory
        : (knownDeviceInventory ?? EMPTY_DEVICE_INVENTORY),
      devServerUrl: url,
    }
  );
  const base: RuntimeConnection = {
    devServerUrl: url,
    devServerSource: discovery.source,
    named,
    reachable,
    unreachableReason: reachable ? null : unreachableReason,
    targets,
    classifiedTargets,
    targetSelection,
    deviceInventory,
  };

  if (!reachable) {
    if (need === 'optional') {
      return { ...base, targets: [] };
    }
    throw noDevServerError({
      devServerUrl: url,
      reason: unreachableReason,
      named,
      cloud,
      platform,
      reloadable: need === 'dev-server',
    });
  }

  if (need === 'debugger-target' && targets.length === 0) {
    throw noAppConnectedError({ devServerUrl: url, retryMs: retryBudgetMs, cloud, platform });
  }

  // Only a command that *requires* a runtime refuses on an empty scope. For `reload` an empty scope
  // is a rung of its ladder — it can start the app — and for `stop` it is the state llp/0010 §The
  // seventh and eighth calls a success.
  if (need === 'debugger-target' && classifiedTargets.read.length === 0) {
    const error = emptyScopeError(url, targetSelection, classifiedTargets, deviceInventory);
    // A local binding outranks a live session of this worktree; only --eas reads the session.
    if (
      targetSelection.bound &&
      targetSelection.device?.backend !== 'cloud' &&
      context.projectRoot != null &&
      liveCloudBindings(context.projectRoot).length > 0
    ) {
      error.message += ` This worktree also has a live EAS Simulator session. The local binding comes first, so only a command that takes --eas reaches the session.`;
    }
    throw error;
  }
  if (
    targetSelection.bound &&
    targetSelection.device != null &&
    classifiedTargets.read.length > 0
  ) {
    Log.progress(
      `Scoped to ${targetSelection.platform?.value}: ${describeSelectedDevice(targetSelection.device)}, the device bound to this worktree.`
    );
  }
  const skipped = skippedAppsOf(classifiedTargets);
  if (skipped.length > 0) {
    Log.progress(describeSkippedApps(skipped));
  }
  return base;
}

/**
 * Nothing answered on the dev server this command was going to use.
 *
 * Kept apart from {@link noAppConnectedError} because the recoveries are opposite: one starts a dev
 * server, the other opens an app on a dev server that is already running. An agent that could not
 * tell them apart would restart a healthy dev server.
 */
export function noDevServerError({
  devServerUrl,
  reason,
  named,
  cloud = false,
  platform,
  reloadable = false,
}: {
  devServerUrl: string;
  reason: string | null;
  named: boolean;
  cloud?: boolean;
  platform?: NavigatePlatform;
  /** The command reloads the app, which is what makes a missing dev server actively harmful. */
  reloadable?: boolean;
}): CommandError {
  const error = new CommandError(
    'NO_DEV_SERVER',
    [
      `No Expo dev server answered at ${devServerUrl}, so there is ${reloadable ? 'nothing to reload the app onto' : 'no app runtime to talk to'}.`,
      `Why: the request for the debugger target list failed (${reason ?? 'no answer'}).${
        reloadable
          ? ' A reload makes the app fetch its bundle again, and without a dev server that fetch has nowhere to go — the app would be left on a loading screen rather than on the fixed code.'
          : ''
      }`,
      `How: ${reachTheAppLadder({ state: 'no-dev-server', cloud, platform })} ${howToNameTheDevServer(named)}`,
    ].join('\n')
  );
  // The same command the How: names. They disagreed — `npx expo start` in one and `npx @expo/agent-cli dev`
  // in the other — which is one failure telling a reader two things [observed — friction run 5].
  error.suggestedCommand = `${PROGRAM_PREFIX} dev --detach${cloud ? ' --tunnel' : ''} --${platform ?? hostPlatform()}`;
  return withData(error, { devServerUrl, devServerReachable: false, platform });
}
