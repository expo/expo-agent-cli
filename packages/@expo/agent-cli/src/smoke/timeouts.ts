/** How long the first look for an attached app gets before the run opens one itself. */
export const APP_PROBE_MS = 2_000;

/**
 * How long the app gets to stop re-registering before anything is read from it.
 *
 * Only spent by a run that opened the app itself: a run that attached to an app already on screen
 * has nothing to settle, and the wait would be dead time in the common case.
 *
 * **Before the runtime read, not only before the picture** — and that is the correction this wave
 * made [observed — 2026-08-30, a cold-start run of the shape §The run brings its own environment
 * exists for: dev server started, simulator booted, Expo Go launched from nothing]. The `app` phase
 * answered `ok` at 7.4 s and the `runtime` phase two seconds later got `No target found`, so a run
 * whose app was on the screen and working reported `22`. Its own picture shows the app rendered.
 *
 * It is the same finding as F57, one phase earlier. F57 was about the *picture* being of a splash
 * screen; this is about the *debugger target list* still churning while the app boots, and the
 * bootstrap is what made that window common — before it, the app was nearly always opened onto a
 * simulator that was already warm.
 */
export const APP_SETTLE_MS = 4_000;

/**
 * How long the **first** compile of a dev server this run started gets, out of a budget of its own.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
 * Coming up is not reading, and this is the phase where the difference is largest: a dev server
 * that has never bundled has to transform the whole dependency graph, which is minutes on a real
 * app and milliseconds on the second run. Charging that to `--timeout` — the window meant for
 * measuring the app — is the same mistake as charging it the simulator boot, and it fails in the
 * same way: the measurement gets what the setup left over, which on a cold machine is nothing.
 *
 * Only for a dev server **this run started**. One somebody else started has either bundled
 * already or has not, and either way this run is reading their dev server rather than warming its
 * own — so `--timeout` is the honest bound there.
 */
export const FIRST_BUNDLE_TIMEOUT_MS = 180_000;

/**
 * How long an app this run opened onto a cold environment gets to attach, out of its own budget.
 *
 * The same rule one phase later. `simctl openurl` exits 0 as soon as the URL is handed over, so
 * the wait that follows is the app *launching* — and on a simulator this run booted a moment ago
 * that is a cold Expo Go start, a manifest fetch and the first bundle download before anything
 * registers a debugger target.
 *
 * Only when this run made the environment cold, by starting the dev server or booting the device.
 * An app that is slow to attach to a dev server and a device that were both already there is a
 * slow app, which is exactly what the caller's budget is for.
 */
export const APP_ATTACH_TIMEOUT_MS = 120_000;

/**
 * How long an app this run opened gets to become *readable*, after it has attached.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §The run brings its own environment
 * The third window of a cold launch, and the one nothing was waiting for. Expo Go attaches to the
 * dev server, and *then* downloads and runs the bundle — so the debugger target it registered on
 * the way in goes away and comes back when the JS runtime is created. A single read landing in
 * that gap answers `No target found` about an app that is running perfectly well, which is what a
 * cold run of a real app did: `app` `ok` at 4.2 s, `runtime` `No target found` two seconds later,
 * and the run's own screenshot showing the app on screen [observed — 2026-08-30, `friction/run7/
 * tapapp` on a simulator this run booted].
 *
 * Waiting is not a softer verdict. The question the phase asks is "can this runtime be read at
 * all", and a runtime that answers at eight seconds *can* be. In an app this run moved, a runtime
 * with no debugger is asked for {@link RUNTIME_UNSUPPORTED_GRACE_MS} (5 s) after its first "method
 * not found"; one that nothing moved is asked once. A wait that ends with no answer reports the runtime's own reason exactly as it did before.
 */
export const RUNTIME_READY_TIMEOUT_MS = 15_000;

/**
 * How long the reload gets to be proved, before the run reports that it was not.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §The app under test is the code on disk
 * `runtime:reload`'s own default is 30 s and covers a ladder that can stop and start the app. This
 * covers one broadcast on a socket that is already open, and the app fetching a bundle the dev
 * server has already built — the `bundle` phase two rows above just proved that it compiles, which
 * is the slow part. Ten seconds is the reconnect, not the compile.
 *
 * Charged to `--timeout` rather than to the bootstrap: the caller's app was already running, so
 * nothing here is this run paying for cold it caused.
 */
export const RELOAD_TIMEOUT_MS = 10_000;

/** How often the runtime is asked again while that wait runs. */
export const RUNTIME_READY_POLL_MS = 500;

/**
 * How long, from its first "method not found" to `Runtime.evaluate`, a moved app may go on answering
 * that way before the answer counts as a runtime with no debugger.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §A reloading runtime answers like one with no debugger.
 * A development build on Android answers `-32601` for about 1.5 s after a reload, on the same
 * target id [observed — EAS Simulator Android session, SDK 58 development build, 2026-10-22]. Expo
 * Go for Android answers it for ever, so this grace is its whole extra cost.
 */
export const RUNTIME_UNSUPPORTED_GRACE_MS = 5_000;

/**
 * How long the run gives a dev server to come up, out of a budget of its own.
 *
 * Not out of `--timeout`, and that is the rule for both bootstrap budgets: a cold start contains a
 * first bundle, and charging it to the budget meant for the phases that read the app would leave
 * a run that had to start its own dev server with nothing left to read it with.
 *
 * The number is the detach path's own default, because it is the same wait: `dev --detach
 * --wait-ready` is what this phase runs.
 */
export const START_DEV_SERVER_TIMEOUT_MS = 120_000;

/**
 * How long the `start-session` phase may take: the EAS CLI's own readiness wait, and then some.
 *
 * @ref llp/0027-everything-on-eas.rfc.md §smoke
 * A session boots a virtual machine and installs an app; two to four minutes was the observed
 * range, and the EAS CLI gives up on one that never becomes ready after ten [observed — expo-ci,
 * 2026-09-06]. Bootstrap, like the boot: none of it is charged to `--timeout`.
 */
export const START_SESSION_TIMEOUT_MS = 900_000;

/**
 * How long the start phase gets when the plan it runs **builds** first.
 *
 * @ref llp/0005-runtime-loop-tools.rfc.md §It builds what the app needs, and says so first
 *
 * Thirty minutes, and the number is the shape of the work rather than a measurement: a cold
 * `expo run:ios` is a pod install and a full native compile, and a machine doing it for the first
 * time on a cold Xcode cache is the slow end of that. The cost of a bound that is too short is the
 * worst kind of failure this command has — twenty minutes spent and then a timeout reported for a
 * build that was going fine.
 *
 * Bootstrap, like every other act: what the build spends is not taken out of the budget the error
 * window and the runtime read live on.
 */
export const BUILD_DEV_SERVER_TIMEOUT_MS = 1_800_000;
