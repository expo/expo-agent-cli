# Dev server

A user gets the app onto a device and gets the terminal back. `dev --ios --detach` or `dev --android --detach` runs the plan: it builds the development build when none is recorded, starts the dev server, and binds a device to the project. `dev:logs` reads what the run printed, and `dev:stop` ends it.

## Sub-features

- `dev-first-build` gets the development build, then serves: from the build cache when the cache has this fingerprint, otherwise by a local build.
- `dev-start` starts the server in seconds when the build is recorded and installed.
- `dev-second-start` refuses a second start while a dev run is up, and starts nothing.
- `dev-logs` prints the detached run's output.
- `dev-stop` stops the server that the project's lock names, and keeps the device bound.
- `dev-stop-release` also shuts down the simulator, or ends the emulator, that this project started.

## How to get to it (user POV)

- Run `npx @expo/agent-cli dev --ios --detach --wait-ready`, or `--android`.
- Run `npx @expo/agent-cli dev:logs`.
- Run `npx @expo/agent-cli dev:stop`, or `npx @expo/agent-cli stop`.
- Run `npx @expo/agent-cli dev:stop --release`.

## Driving it with verify.mjs

Preconditions:

- The baseline of [README.md](./README.md).
- `PORT=$(node $V port)`.
- No dev server runs for the app.

- **First build, cache miss.** In a checkout with no build for `$PF`, and no entry for this fingerprint in `cachedBuilds`, run `node $V run --label dev-first-build-$PF -- dev --$PF --detach --wait-ready --port "$PORT" --json`. Exit code `22` after 120 seconds, with `error.code: "DEV_DETACH_STILL_BUILDING"`. Then run `node $V wait-server 45`. It prints `{"running":true,…}`. `APP/.expo/dev/logs/dev-detached.log` has `Build Succeeded` on iOS and `BUILD SUCCESSFUL` on Android, and the build cache directory has a new entry `$PF-<fingerprint>-…`.
- **First build, cache hit.** In a checkout with no build for `$PF`, when `cachedBuilds` has the entry, run the same command. Exit code `0`. The log has a line `› Installing …/.expo/build-cache/$PF-<fingerprint>-…` and no compile step.
- **Start.** In a checkout that has the build, run `node $V run --label dev-start-$PF -- dev --$PF --detach --wait-ready --port "$PORT" --json`. Exit code `0` in seconds. stdout is one object with `ready: true`, `alreadyRunning: false`, `port` equal to `$PORT`, and `device.platform` equal to `$PF`. The log starts with `Smart start plan (rule: dev-client-fresh, target: dev-client)`.
- **Second view.** Read the state. Run `node $V run -- status --no-followups`. stdout has `dev server  running on http://127.0.0.1:$PORT · via lock · bundler ready` and a `device` line that names the simulator (`ios agent-cli …`) or the emulator (`android emulator-…`).
- **Second start.** Start it again, for the same or the other platform. Run `node $V run --label dev-second-start -- dev --android --detach --wait-ready --port "$PORT" --json`. Exit code `20`. stdout is one object with `error.code: "DEV_SERVER_RUNNING"`, and `error.data.pid` equals the `pid` of the running server.
- **Logs.** Read the output. Run `node $V run --label dev-logs -- dev:logs`. Exit code `0`. After the app has loaded once, the untrusted block has a line `iOS Bundled …` or `Android Bundled …` with `node_modules/expo-router/entry.js`.
- **Stop.** Stop the server. Run `node $V run --label dev-stop-$PF -- dev:stop --json --no-followups`. Exit code `0`. The object has `stopped: true`, `lockHeld: true`, `processStillRunning: false`, `portStillAnswering: false`, and `devices[0].shutDown: false`.
- **Second view.** Run `node $V run -- status --no-followups`. stdout has `dev server  not running`, and the `device` line still names the device.
- **Release.** `node $V cleanup` runs `dev:stop --release --json`. Its evidence file is `NNN-cleanup-dev-stop.txt`, with `released: true` and `shutDown: true` for each device.

## Gotchas

- Always pass `--port`. Without it the server takes 8081, which another project on the machine can hold.
- `dev --ios` without `--detach` holds the terminal until the server stops. Do not run it through `run`.
- The `DEV_DETACH_STILL_BUILDING` message says to run the same command again and that it follows the build. It does not: the second call exits `20` with `DEV_SERVER_RUNNING` and `phase: "building"`. Use `wait-server`.
- Times seen: a cache hit took 82 seconds on iOS, most of it `expo prebuild` with CocoaPods, and 12 seconds on Android. A full iOS build took 4 to 5 minutes. A full Android build took 3 minutes with a warm Gradle cache and 28 minutes with a cold one. A run that ends inside the 120 seconds gives exit `0` and no `DEV_DETACH_STILL_BUILDING`.
- The cache key is the fingerprint. A change to the native dependencies or the app config of `apps/eas-example` gives a new fingerprint and one cache miss for each platform.
- The devices of both platforms stay bound to the project after a `dev:stop`. A development build that still runs on the other device connects to the new dev server by itself. Then `runtime:tree --ios` reads the iOS app on a server that `dev --android` started. Pass the platform flag on every device command.
- The first Android run can fail after the build with `Expo stopped waiting for the ADB device property/boot query operation to finish`, and the log ends with `PLAN_STEP_FAILED`. The emulator was under load from the build. Run the Start command again: Gradle is incremental then, and the install took 30 seconds.
- `dev` also cleans device bindings of other projects on the machine: it shuts down a simulator whose binding expired, and deletes the simulator of a worktree that no longer exists. `dev:logs` lists them as `Released … (expired)` and `Deleted … (deleted-worktree)`. Tell the user before the first `dev` when a simulator from another checkout is booted.
- The device binding has an expiry (`device.expiresAt`, one hour after the start). A long session can lose it.
- `dev:stop` stops the dev server. It does not stop the app; that is `runtime:stop`.
- `dev:stop` leaves alone a port that no lock answers for. Do not add `--force` to make a proof pass: that stops a server this run did not start.
