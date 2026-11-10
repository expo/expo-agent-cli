import { type RuntimeConnection } from '../preflight';
import { type ReloadAttempt } from './attempt';
import { firstLine } from '../../utils/text';

/**
 * Whether the app's `expo` global can reload it, asked before anything is asked of it.
 *
 * The diagnostic strings it answers with are also what makes the two expressions distinguishable in
 * a test double — not the `typeof` in it, which the promise-settling wrapper adds to every
 * expression this CLI sends (`src/runtime/promiseSettling.ts`).
 */
const RELOAD_PROBE_EXPRESSION = `(function () {
  var e = globalThis.expo;
  if (e == null) return 'no-expo-global';
  return typeof e.reloadAppAsync === 'function' ? 'ready' : 'no-reload-function';
})()`;

/** The reload itself. Returns before the runtime tears itself down, or never returns at all. */
const RELOAD_CALL_EXPRESSION = `(function () {
  globalThis.expo.reloadAppAsync();
  return 'sent';
})()`;

/**
 * How long the reload call is given to answer before the silence is read as the runtime going away.
 *
 * Short on purpose. `expo.reloadAppAsync()` tears down the JavaScript context that is answering the
 * request, so an answer is the *unusual* outcome and a long wait here would only delay the wait that
 * actually proves something — the debugger target registering again.
 */
const RUNTIME_RELOAD_ANSWER_MS = 4000;

/**
 * Reload by asking the app's own `expo` global to reload it, over the debugger.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — the cloud loop, K2 and K3.
 *
 * The mechanism a caller chooses, and never one `auto` reaches for. It goes over the same CDP socket
 * `runtime:eval` uses, at the same target the same `/json/list` names, so an app this CLI can read
 * is an app this can ask — which is exactly the case the command socket could not serve: a cloud
 * app over a tunnel was in the target list and had no peer on `/message`, and this reloaded it.
 *
 * **On Expo Go the same call closes the app** [observed — Expo Go SDK 57, iOS 26.5 simulator,
 * 2026-08-27: the app left the screen and `/json/list` was still empty 13 s later]. That is the
 * whole reason this is opt-in: one runtime reloads and another quits, the difference is not
 * something this command can read in advance, and a mechanism that sometimes closes the app is not
 * one to run on a caller's behalf.
 *
 * It is `expo.reloadAppAsync()` because that is what a Hermes runtime has. There is no `require` and
 * no `import()` in it, so `DevSettings.reload()` is unreachable from an expression; the `expo`
 * global is the one door, and it was found by dumping `Object.keys(expo)`
 * [observed, cloud simulator, 2026-08-27]. `runtime:eval --help` documents the same idiom,
 * so that a caller who needs to do this by hand does not have to rediscover it.
 *
 * **Nothing here claims a reload.** The probe says the function exists, the call says it was sent,
 * and the proof is the caller's own wait for a debugger target the dev server had not listed before.
 * An app whose runtime stops answering mid-call is the expected shape of success, so a timeout on
 * the call is reported as "sent" rather than as a failure.
 */
export async function reloadOverRuntimeAsync(
  {
    devServerUrl,
    targetSelection,
    deviceInventory,
  }: Pick<RuntimeConnection, 'devServerUrl' | 'targetSelection' | 'deviceInventory'>,
  connectedApps: number
): Promise<ReloadAttempt> {
  const failed = (reason: string): ReloadAttempt => ({
    method: 'runtime',
    ok: false,
    reason,
    leftAppStopped: null,
  });

  if (connectedApps === 0) {
    return failed(
      `no app is connected to the dev server, so there is no runtime to ask — this method reloads an app through its debugger and cannot start one`
    );
  }

  const { CdpClient, isMethodNotFoundError } =
    require('../cdpClient') as typeof import('../cdpClient');

  let client: import('../cdpClient').CdpClient;
  try {
    client = new CdpClient({ metroUrl: devServerUrl, targetSelection, deviceInventory });
  } catch (error: unknown) {
    return failed(
      `could not open a debugger connection to the app: ${error instanceof Error ? firstLine(error.message) : String(error)}`
    );
  }

  let probe: string;
  try {
    const answer = await client.evaluateAsync(RELOAD_PROBE_EXPRESSION, {
      awaitPromise: false,
      timeoutMs: RUNTIME_RELOAD_ANSWER_MS,
    });
    if (answer.exceptionText) {
      return failed(
        `the app threw while it was asked whether it can reload itself: ${answer.exceptionText}`
      );
    }
    probe = String(answer.value ?? 'no-answer');
  } catch (error: unknown) {
    return failed(
      isMethodNotFoundError(error)
        ? `the app's runtime has no debugger to ask: it answered "method not found" to Runtime.evaluate, which is what Expo Go for Android does`
        : `the app did not answer over the debugger: ${error instanceof Error ? firstLine(error.message) : String(error)}`
    );
  }

  if (probe !== 'ready') {
    return failed(
      probe === 'no-expo-global'
        ? `the app has no "expo" global, so there is nothing on it to reload with — this needs an app built on the expo package`
        : probe === 'no-reload-function'
          ? `the app's "expo" global has no reloadAppAsync, so this runtime cannot be asked to reload itself — a newer expo package has it`
          : `the app answered the reload probe with "${probe}", which this command cannot read`
    );
  }

  try {
    await client.evaluateAsync(RELOAD_CALL_EXPRESSION, {
      awaitPromise: false,
      timeoutMs: RUNTIME_RELOAD_ANSWER_MS,
    });
  } catch {
    // A runtime that stops answering is what a reload looks like from here, so this is not a
    // failure — and it is not a success either. The wait for a fresh target decides.
    return {
      method: 'runtime',
      ok: true,
      reason: `expo.reloadAppAsync() was called over the debugger and the runtime stopped answering, which is what a reload looks like from here`,
      leftAppStopped: null,
    };
  }

  return {
    method: 'runtime',
    ok: true,
    reason: `expo.reloadAppAsync() was called over the debugger`,
    leftAppStopped: null,
  };
}
