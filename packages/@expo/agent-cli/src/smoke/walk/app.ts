import { describeSkippedApps } from '../../runtime/targetSelection';
import type { AppConnectionResult } from '../../runtime/waitReady';
import { stopWithPicture } from './capture';
import type { SmokeAppFit, SmokeRun } from '../contract';
import { appendReason } from '../results';
import { APP_PROBE_MS } from '../timeouts';
import type { SmokePhase, SmokePhaseStatus } from '../types';
import type { DeviceReady } from './device';
import type { PhaseWalk, Step, WalkRun } from './walk';

/** The route opened when nothing was named and there is no app to read. */
const ROOT_ROUTE = '/';

/** What the `app` phase came to, and what the device said if it refused the deep link. */
interface AppOpen {
  connection: AppConnectionResult;
  /**
   * Null when the device was not asked. Otherwise why it refused this run's deep link, when the
   * device could say: "asked, and the device explained nothing" is a real answer.
   *
   * @ref llp/0005-runtime-loop-tools.rfc.md §A refused link is a device without the app
   * Reported as a value and not only in the phase's sentence, for the same reason every other
   * finding here is: the follow-ups branch on it, and a re-run is never the answer to it.
   */
  refused: { fit: SmokeAppFit | null } | null;
}

// ---- Phase 5: is an app attached, and can one be opened if not? ---------------------------
export async function appStep(walk: PhaseWalk, ready: DeviceReady): Promise<Step<SmokePhase>> {
  const {
    value: { connection, refused },
    phase,
  } = await walk.record(
    'app',
    () => openAppAsync(walk, ready),
    // The whole phase, because on this path almost all of it is the wait above.
    { bootstrap: () => walk.app.openedByThisRun && walk.coldEnvironment() }
  );

  const { appsConnected, skippedApps } = connection;
  Object.assign(walk.report, { appsConnected, skippedApps });
  if (appsConnected === 0) {
    return { stop: await noAppExit(walk, phase, refused) };
  }
  return { next: phase };
}

async function openAppAsync(
  walk: PhaseWalk,
  { firstConnection, appReplaced }: DeviceReady
): Promise<{ status: SmokePhaseStatus; reason?: string | null; value: AppOpen }> {
  const { deps, options, environment } = walk;
  const { devServerUrl } = walk.report;
  // Reused when the boot decision above already asked. It answered "nothing is attached", which
  // is still true of a simulator that has only just finished booting — and asking again would
  // spend a second wait on a fact this run established one phase ago.
  const first =
    firstConnection ??
    (await deps.waitForAppConnection(devServerUrl, Math.min(walk.remaining(), APP_PROBE_MS)));
  // `!appReplaced` is the whole of the fix above: an install replaced the app, so a count that
  // says one is attached is describing the process the install ended.
  // EAS's --open-url launches the app without opening an agent-device controller session.
  // Go through the normal open once for a session we created, even if Metro already sees the
  // app. This binds the controller for screenshots and makes a second reload unnecessary.
  const needsCloudController =
    walk.report.cloudRoute === 'required' && environment.device === 'booted';
  if (!appReplaced && first.appsConnected > 0 && !needsCloudController) {
    return { status: 'ok' as const, value: { connection: first, refused: null } };
  }

  // Nothing is attached. `navigate` is what puts an app in that list, so the gate opens one
  // rather than waiting out its budget on a state it could have changed itself. This is friction
  // run 1's F4 absorbed into the gate, and the same reasoning F48-8 gave `status.next`: a wait
  // for an app cannot succeed while nothing is opening one.
  const device = await walk.deps.probeDevice();
  if (device.deviceId == null) {
    return {
      status: 'inconclusive' as const,
      reason: `no app is connected to the dev server, and ${device.reason ?? 'no device was found to open one on'}`,
      value: { connection: first, refused: null },
    };
  }

  // **One budget, spent across the open and the wait after it.** The open now waits for the app
  // it loads (F123's ladder is gated on that), and the wait below asks the same question — so a
  // budget handed to each would be two of them: a cold run whose app never arrives would spend
  // four minutes to report what it knew after two.
  // @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
  //
  // The second line this phase says, and the only phase that says two. The reason is that the
  // phase does two things of very different sizes: a two-second look for an app that is already
  // there, and — when there is none — an open followed by a wait that on a cold environment is
  // two minutes. One line covering both would either overstate the look or say nothing about the
  // wait, and the wait is the longest single thing this command ever does.
  const attachDeadline = deps.now() + walk.attachBudget();
  deps.progress('app', Math.max(0, attachDeadline - deps.now()));
  const opened = await deps.openRoute(
    options.route ?? ROOT_ROUTE,
    devServerUrl,
    Math.max(0, attachDeadline - deps.now())
  );
  walk.app.noteOpened(opened);
  if (opened.exitCode !== 0) {
    // @ref llp/0005-runtime-loop-tools.rfc.md §A refused link is a device without the app
    //
    // "The device refused the deep link" is what happened and not why, and it reads as a fault in
    // the device. The why is almost always one thing: nothing on that device handles this
    // project's scheme, because the app is not there. `simctl openurl` says so with `115` and
    // says nothing else [observed — Kudo, local run, 2026-09-04, a development build and a
    // simulator that had not got it], and a report that stopped at the refusal sent its reader to
    // `navigate`, which is refused in exactly the same way for ever (llp/0009).
    const fit = await deps.explainSilentApp(opened.deviceId, opened.deviceBackend);
    return {
      status: 'failed' as const,
      reason: [
        `no app was connected, and the device refused the deep link that would have opened one ("${opened.command}" exited ${opened.exitCode ?? 'on a signal'})`,
        fit?.mismatch,
      ]
        .filter(Boolean)
        .join(' · '),
      value: { connection: first, refused: { fit } },
    };
  }

  // @ref ../timeouts §APP_ATTACH_TIMEOUT_MS. The deep link is a request and not a result: the open
  // exited 0 above, and what is waited for here is a **debugger target appearing** — the app
  // launching, fetching the manifest and downloading its bundle. On an environment this run made
  // cold that is its own cost and gets its own budget; on a warm one it is a slow app, which is
  // what the caller's `--timeout` is for.
  const second = await deps.waitForAppConnection(
    devServerUrl,
    Math.max(0, attachDeadline - deps.now())
  );
  return second.appsConnected > 0
    ? {
        status: 'ok' as const,
        reason: `opened ${opened.url} to connect one`,
        value: { connection: second, refused: null },
      }
    : {
        status: 'inconclusive' as const,
        reason: `${opened.url} was opened on the device and no app had attached when the budget ran out`,
        value: { connection: second, refused: null },
      };
}

/** No app attached: explain why if the device can, take a picture, and end the run. */
async function noAppExit(
  walk: PhaseWalk,
  appPhase: SmokePhase,
  refused: AppOpen['refused']
): Promise<WalkRun> {
  const { deps, report } = walk;
  const { skippedApps } = report;
  if (skippedApps.length > 0) appendReason(appPhase, describeSkippedApps(skippedApps));
  // @ref ../contract §SmokeDeps.explainSilentApp
  //
  // Nothing attached is a *symptom*, and the device often holds the cause. The commonest one is
  // an Expo Go built from another SDK: it takes the deep link, fails to load a bundle it cannot
  // run, and registers no debugger target — so the wait expires and the run reports the symptom
  // [observed — emulator-5554 on Expo Go 54.0.8 against an SDK 57 project, 119 s, 2026-09-04].
  //
  // Asked here rather than in the `app` phase itself so it costs nothing on the healthy path:
  // this branch is only reached by a run that already has nothing to read.
  // The refused-open path already asked, and already put the answer in the phase's sentence, so
  // this reads its result rather than spending a second device read — and appends nothing, which
  // is what keeps the same finding from being printed twice on one row.
  const silent = refused
    ? refused.fit
    : await deps.explainSilentApp(report.deviceId, report.deviceBackend);
  if (refused == null && silent?.mismatch != null) {
    // Appended rather than substituted: "the link was opened and nothing attached" is what the
    // phase measured, and the device fact is why. A reader needs both — the second without the
    // first would not say that the open itself succeeded.
    appendReason(appPhase, silent.mismatch);
  }

  // No app, so no runtime and no window — but there may still be a device, and a picture of
  // whatever is on it is the most useful thing left to hand back.
  // From `reload` rather than from `route`: the reload phase sits between this one and the route
  // now, and a phase that is stepped over rather than filled in is a phase missing from the
  // report — which is the one property the phase list has (`reports every phase exactly once`).
  walk.skipRest('reload', 'no app is connected, so there was nothing to read', 'screenshot');
  // The run opened the app in this phase, so whatever is on screen may still be loading.
  return stopWithPicture(
    walk,
    appPhase.status === 'failed' ? 'failed' : 'inconclusive',
    walk.app.showingWithoutApp(),
    {
      // Reported as a fact and not only as the phase's sentence, so the follow-ups can lead with
      // the command that fixes it rather than with "open the app again" — which is what they did,
      // for ever, against a device that will answer the same way every time (llp/0009).
      appMismatch: silent?.mismatch ?? null,
      appMismatchKind: silent?.kind ?? null,
    }
  );
}

// ---- Is the app that answered one this project can run at all? ---------------------------
//
// @ref llp/0005-runtime-loop-tools.rfc.md §Expo Go is only a target for a project that fits in it
//
// Not a phase of its own: it is the second half of the question the `app` phase asks. "Is an app
// attached" and "is it *this project's* app" have one answer between them, and a run that split
// them into two rows would report `app ok` above a row saying the app cannot run this project.
//
// Asked on both paths — an app this run found *and* one it opened — because the open picks its
// target from the same decision, so a mismatch on that path would mean this gate had opened the
// wrong app. Never asked when nothing is connected: there is no runtime for it to be about, and
// that path returned above.
//
// Downgrades the phase rather than stopping the run. The phases below still read the app that is
// there and still photograph it — the same rule llp/0005 §Android sets for a runtime with no
// debugger, where an empty window costs one wait and the report is more useful with it. What
// changes is that the verdict can no longer be `passed`.
//
// Returned rather than written into the report: an exit before the verdict does not report it.
export async function appFitStep(
  walk: PhaseWalk,
  appPhase: SmokePhase
): Promise<Pick<SmokeRun, 'appMismatch' | 'appMismatchKind'>> {
  const appFit = await walk.deps.checkAppFitsProject(walk.report.devServerUrl);
  const appMismatch = appFit.mismatch;
  if (appMismatch != null) {
    // A mismatch outranks a note: there is no use telling a caller their Expo Go is a patch
    // behind when the answer is that it cannot run their project at all.
    appPhase.status = 'inconclusive';
    appPhase.reason = appMismatch;
  } else if (appFit.note != null) {
    // Appended rather than substituted. The sentence already there says how the app got where it
    // is — "opened … to connect one" — which is the fact the row exists for, and a note that
    // replaced it would trade a finding for a finding.
    appendReason(appPhase, appFit.note);
  }
  return { appMismatch, appMismatchKind: appFit.kind };
}
