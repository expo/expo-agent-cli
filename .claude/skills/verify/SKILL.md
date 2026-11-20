---
name: verify
description: Drive the built @expo/agent-cli command-line tool (`expo-agent-cli`) against the committed Expo Router app (apps/eas-example) as a development build, on a local iOS simulator and a local Android emulator, and keep the evidence. Use it to prove that a change to a command works for a user - status, dev, navigate, runtime:*, smoke, typecheck - before you say the change is done.
---

# Verify @expo/agent-cli

The product is a CLI. A user runs it in an Expo project and reads the exit code, stdout and stderr. This skill runs the built bin of `packages/@expo/agent-cli` (`bin/cli.js`, which loads `build/cli/`) in the committed app `apps/eas-example`: Expo Router, `expo-dev-client`, routes `/` and `/explore`. Nothing is stubbed. The app runs as a development build, not in Expo Go.

Run every command from the repo root. The helper is `.claude/skills/verify/verify.mjs`:

```sh
V=.claude/skills/verify/verify.mjs
node $V launch                      # build the CLI and prepare apps/eas-example
node $V doctor                      # read-only: is this run worth driving?
node $V run [--label <name>] -- <cli arguments>
node $V run --until <regex> [--timeout <seconds>] -- <cli arguments>
node $V run --kill-after <seconds> -- <cli arguments>
node $V wait-server [minutes]       # wait until the project's dev server answers
node $V port                        # print a free port from 8600 up
node $V cleanup [--purge]           # stop what the run started and restore the app
```

Other surfaces exist and this skill does not cover them: the unit suite (`bun run test`), the stub e2e suite (`bun run test:e2e`), and the live vitest suites (`e2e-live/RUNBOOK.md`). Those are tests. This skill is the interactive proof.

## Scope

Run only what the change can break. Decide from the diff, before `launch`.

| The diff changes                                                   | Run                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Only docs, `llp/`, tests, comments, or CI files                    | Nothing.                                                                               |
| A pure function, a parser, or a table, with a unit test            | Nothing. The unit suite is the proof.                                                  |
| Output text or JSON of a command that needs no device              | That command, once. No device.                                                         |
| The behavior of one device command                                 | The recipes of that feature, on both platforms.                                        |
| `dev`, device binding, the dev-server lock, or shared runtime code | The full map, on both platforms.                                                       |
| `apps/eas-example` native dependencies or app config               | `dev` on both platforms, then `smoke`. Expect one full native build for each platform. |

- When two rows match, use the lower row.
- When no row matches, run the feature whose files the diff touches.
- When you run nothing, say so in the report and name the row.
- A person can ask for more. Then run what the person asks.

## Launch

```sh
node $V launch
```

1. Refuses to start when `apps/eas-example` has uncommitted changes. Cleanup restores the app with git, so a change that is already there would be lost.
2. `bun run build` in `packages/@expo/agent-cli`. The bin runs the bundle, not `src/`. An edit to `src/` is not in the bin until a build.
3. Links `apps/eas-example/.expo/build-cache` to the shared build cache, `~/Library/Caches/agent-cli-verify/build-cache` on macOS. `AGENT_CLI_VERIFY_HOME` moves it.

Ready means the last output is a JSON object with `"ready": true`. It names `projectDir`, `evidenceDir`, and `cachedBuilds`: the builds that the cache holds. Launch takes about 15 seconds.

The app is driven in place, in this checkout. Each checkout has its own dev server, its own devices and its own `ios/` and `android/` directories. All of them are git-ignored.

### Native builds come from a cache, keyed by fingerprint

`launch` builds nothing native. `dev --ios` and `dev --android` do, when this checkout has no build yet:

```sh
PORT=$(node $V port)
node $V run --label dev-ios -- dev --ios --detach --wait-ready --port "$PORT" --json
node $V wait-server 40
```

- The app sets `buildCacheProvider` to `@expo/local-build-cache-provider`. `expo run:ios` and `expo run:android` look in the cache for `<platform>-<fingerprint>-…` before they compile, and store each new build there.
- The fingerprint comes from the app config and the native dependencies in `bun.lock`. Checkouts on the same commit have the same fingerprint, so one build serves all of them. An edit under `src/` does not change it.
- **Cache hit:** `expo prebuild` runs, then the cached build is installed. No compile. Observed in a new checkout: 82 seconds on iOS, 12 seconds on Android.
- **Cache miss:** a full local build. Observed: iOS 4 to 5 minutes. Android 3 minutes with a warm Gradle cache, 28 minutes with a cold one.
- **Later starts in the same checkout:** the plan rule is `dev-client-fresh`, and `dev` starts in seconds.
- During a build, `dev --detach --wait-ready` exits `22` with `DEV_DETACH_STILL_BUILDING` after 120 seconds. The build continues. `wait-server` polls `status --json` until this project's dev server answers. Do not run `dev` again while the build runs: it exits `20` with `DEV_SERVER_RUNNING`.
- One project has one dev server, and `dev` takes one platform. To change platform, run `dev:stop`, then `dev` with the other platform flag.
- A change to the app's native dependencies or app config changes the fingerprint. The next `dev` on each platform is a cache miss, once for the machine.

## Doctor

```sh
node $V doctor
```

It prints one JSON object and exits 0 when `ok` is true. Run it first when a result looks wrong.

| Key                | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `bundleStale`      | `true`: a file in the package `src/` is newer than the bundle. Run `launch`. |
| `version`          | What the bin answers to `--version`.                                         |
| `run`              | The run in progress, or `null`. `null` means run `launch`.                   |
| `projectInstalled` | `apps/eas-example` has its `node_modules/expo`.                              |
| `devServer`        | From `status --json`: the URL, `running`, and `appsConnected`.               |
| `binding`          | The devices bound to this checkout. Empty before the first `dev`.            |
| `bootedSimulators` | Every booted simulator on the machine. Not all of them belong to the run.    |

Doctor runs `status --json` in the app. That command writes only its caches under `.expo`.

## Drive

Each drive is one `run`. The helper runs the bin in `apps/eas-example`, prints its stdout and stderr, exits with its exit code, and writes one evidence file.

```sh
node $V run -- status
node $V run -- navigate /explore --ios
node $V run --until "screen=explore" -- runtime:tree --all --ios
node $V run --label smoke-android -- smoke --android --no-start --json
```

`--until <regex>` repeats a read-only command every 4 seconds until its stdout matches, for at most `--timeout` seconds (default 180). It records the last attempt and exits `22` when nothing matched. Use it for every read after an action that changes the app: a launch, a `navigate`, a reload. Do not use a fixed sleep.

`run` kills a command that does not exit within 600 seconds, and then exits `22`. `--kill-after <seconds>` changes the limit. The evidence file records the kill. A kill is a finding about the CLI: report it.

The recipes for each feature are in the feature map: start at [features/README.md](features/README.md). A proof that covers one entry point is incomplete when the map lists others.

Rules for a drive:

- **Both platforms.** Run each device recipe once with `--ios` and once with `--android`. A pass on one platform proves nothing about the other. When you can run only one, say which one you did not run.
- Read the exit code first: 0 success, 1 the command was wrong, 7 a person must act, 20 the outcome failed, 22 no conclusion.
- Use `--json` for an assertion. stdout then holds exactly one JSON object. Never parse stderr.
- Always pass `--port` to `dev`, from `node $V port`. The default 8081 can belong to another project.
- To change the app, edit files under `apps/eas-example/src/`, then run `runtime:reload`. `cleanup` undoes the edits with git. Never commit an edit that a recipe made.
- The helper removes `NODE_ENV`, `VITEST*` and `npm_config_minimum_release_age` from the child. It sets `EXPO_NO_TELEMETRY=1` and `NO_COLOR=1`, and a UTF-8 locale that `pod install` needs. Do not start the bin by another path during a proof.
- Do not pass `--eas`, do not run `deploy`, and do not set `deviceBackend: "eas"`. The app is linked to the `expo-ci` EAS project, so those commands act on the real account, and an Expo simulator session bills credits. `AGENTS.md` §Check the EAS path on EAS has the rule and the opt-ins.
- Do not pass `--go`. This skill proves the development build.

## Evidence

Evidence goes to `.claude/skills/verify/.artifacts/<run-id>/`. The directory is git-ignored. Each `run` writes `NNN-<label>.txt` with the argv, the working directory, the exit code, the duration, stdout and stderr. `cleanup` copies this run's smoke screenshots (`smoke-*.png`) and `dev-detached.log` there.

A proof must meet these standards:

- Run the command a user runs, through `run`. Do not call a function from `src/` and do not use the stub `expo` or stub `eas` of `e2e/`.
- Capture the action and the state after it. Example: `runtime:reload`, then `runtime:tree --all` that shows the new text.
- Check the side effect with a second read. Examples: `status` after `dev --detach` shows `dev server  running`; `runtime:eval` shows the value a `runtime:tap` set; `status` after `dev:stop` shows `not running`.
- Check that the app under test is the development build: `navigate --json` reports `"target": "dev-build"`.
- Prove a failure too when the change touches one: a broken bundle must give `smoke` exit 20, and a route that does not exist must give `navigate` exit 1.
- `dev --plan` prints a plan and runs nothing. Confirm that with `status`.
- Quote the evidence file path in the report. Say which entry points and which platform you did not drive.

## Cleanup

```sh
node $V cleanup
```

It runs `dev:stop --release` in the app. That command signals only the process that the project's own dev-server lock names. It shuts down the simulator that this checkout created and ends the emulator that this checkout started. It then copies screenshots and logs to the evidence directory, restores `apps/eas-example` with `git checkout` and `git clean`, and removes the run pointer. The native projects, the build cache and the evidence stay.

`node $V cleanup --purge` also deletes `ios/`, `android/` and `.expo/` of the app in this checkout. The shared build cache stays. To force a full build, delete the matching entry in the build cache directory by hand.

When `dev:stop` does not exit 0, cleanup stops and changes nothing else. Read the `cleanup-dev-stop` evidence file, fix the cause, and run cleanup again. Never kill a process by name, and never run `xcrun simctl shutdown all` or `adb emu kill` on a device that this run did not start: other worktrees have their own servers and devices.

Run cleanup after a failed attempt too.

## State of the map on 2026-11-19

- **iOS:** every recipe passed on the committed app, on a build that came from the cache.
- **Android:** every recipe passed on the committed app, on a build that came from the cache. In the checkout that had just compiled the Android build, one `smoke` and one `runtime:reload` gave exit `22` while the emulator was under load.
- Seen once on an earlier scaffold, not reproduced: an Android app that stopped answering after `runtime:reload`, and an iOS `smoke` that passed and did not exit. [features/runtime.md](features/runtime.md) and [features/smoke.md](features/smoke.md) have the details.

## Not covered

- The EAS path (`--eas`, `deploy`, `status --build`).
- Expo Go. The app has `expo-dev-client`, so Expo Go cannot run it.
- `new` and `install`. The skill no longer scaffolds a project; the `live-project` suite covers them.
- A physical device.
