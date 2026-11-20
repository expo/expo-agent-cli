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
node $V doctor                      # is this run worth driving?
node $V run [--label <name>] -- <cli arguments>
node $V run --until <regex> [--timeout <seconds>] -- <cli arguments>
node $V run --kill-after <seconds> -- <cli arguments>
node $V wait-server [minutes]       # wait until the project's dev server answers
node $V cleanup                     # stop what the run started and keep the evidence
node $V purge                       # delete ios/, android/ and .expo/ of the app
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

1. `bun run build` in `packages/@expo/agent-cli`. The bin runs the bundle, not `src/`. An edit to `src/` is not in the bin until a build. `run` refuses a bundle that is older than `src/`: run `launch` again. A second `launch` builds again and continues the same run.
2. Links `apps/eas-example/.expo/build-cache` to the shared build cache, `~/Library/Caches/agent-cli-verify/build-cache` on macOS. `AGENT_CLI_VERIFY_HOME` moves it. Builds that are already in `.expo/build-cache` move to the shared cache.
3. Records the uncommitted state of `apps/eas-example`, and prints the changed files as `appStatus`. `cleanup` compares against it.

Ready means the last output is a JSON object with `"ready": true`. It names `projectDir`, `evidenceDir`, and `cachedBuilds`: the builds that the cache holds. Launch takes about 15 seconds.

The app is driven in place, in this checkout. Each checkout has its own dev server, its own devices and its own `ios/` and `android/` directories. All of them are git-ignored. An uncommitted change in the app is part of what the run proves.

`launch` builds nothing native. The first `dev --ios` and `dev --android` of a checkout do:

```sh
node $V run --label dev-ios -- dev --ios --detach --wait-ready --json
node $V wait-server 40
```

The app sets `buildCacheProvider`, so a build comes from the shared cache when the cache has the fingerprint of the app. [features/dev-server.md](features/dev-server.md) has the cache rules, the times, and the `wait-server` step.

## Doctor

```sh
node $V doctor
```

It prints one JSON object. It exits 0 when `ok` is true, and 1 when not. Run it first when a result looks wrong.

| Key                | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `bundleStale`      | `true`: a file in the package `src/` is newer than the bundle. Run `launch`. |
| `version`          | What the bin answers to `--version`.                                         |
| `run`              | The run in progress, or `null`. `null` means run `launch`.                   |
| `projectInstalled` | `apps/eas-example` has its `node_modules/expo`.                              |
| `appStatus`        | `git status --porcelain` of the app. Empty means no change.                  |
| `statusError`      | Not `null`: `status --json` gave no report.                                  |
| `devServer`        | From `status --json`: the URL, `running`, and `appsConnected`.               |
| `binding`          | The devices bound to this checkout. Empty before the first `dev`.            |
| `bootedSimulators` | Every booted simulator on the machine. Not all of them belong to the run.    |

Doctor runs `status --json` in the app. That command writes its caches under `.expo` and nothing else.

## Drive

Each drive is one `run`. The helper runs the bin in `apps/eas-example`, prints its stdout and stderr, exits with its exit code, and writes one evidence file. Put the CLI arguments after `--`.

```sh
node $V run -- status
node $V run -- navigate /explore --ios
node $V run --until "screen=explore" -- runtime:tree --all --ios
node $V run --label smoke-android -- smoke --android --no-start --json
```

- `--until <regex>` repeats a read-only command every 4 seconds until its stdout matches, for at most `--timeout` seconds (default 180). It prints and records the last attempt. It exits `124` when nothing matched.
- `run` kills a command that does not exit in time, and then exits `124`. The limit is 600 seconds, and 60 seconds for each attempt of `--until`. `--kill-after <seconds>` changes it. The evidence file records the kill. A kill is a finding about the CLI: report it.
- `124` and `125` are the helper's own codes. `124`: no result. `125`: the helper could not do its work, for example no run in progress, a wrong option, or a stale bundle. In `run`, every other exit code is the exit code of the CLI.
- `wait-server [minutes]` is the same loop on `status --json`. It ends when this project's dev server answers, and exits `124` after the limit (default 25 minutes).
- The helper removes `NODE_ENV` and `npm_config_minimum_release_age` from the child. It sets `EXPO_NO_TELEMETRY=1` and `NO_COLOR=1`, and a UTF-8 locale that `pod install` needs. Do not start the bin by another path during a proof.

The recipes, the driving conventions and the proof standard are in the feature map: start at [features/README.md](features/README.md). A proof that covers one entry point is incomplete when the map lists others. Run each device recipe on both platforms.

## Evidence

Evidence goes to `.claude/skills/verify/.artifacts/<run-id>/`. The directory is git-ignored. Each `run` writes `NNN-<label>.txt` with the argv, the working directory, the exit code, the duration, stdout and stderr. `cleanup` copies this run's smoke screenshots (`smoke-*.png`) and `dev-detached.log` there. The CLI starts that log again for each detached `dev`, so the copy holds the last start only.

Run the command a user runs, through `run`. Do not call a function from `src/` and do not use the stub `expo` or stub `eas` of `e2e/`. Quote the evidence file path in the report. Say which entry points and which platform you did not drive.

## Cleanup

```sh
node $V cleanup
```

1. Runs `dev:stop --release` in the app. That command signals only the process that the project's own dev-server lock names. It shuts down the simulator that this checkout created and ends the emulator that this checkout started.
2. Copies screenshots and the log to the evidence directory, and ends the run.
3. Compares the uncommitted state of the app, file content included, with the state at `launch`. When they differ, cleanup exits `125` and lists the changed files. The run has ended at that point. Cleanup never changes the app: undo a recipe edit yourself.

The native projects, the build cache and the evidence stay. `node $V purge` deletes `ios/`, `android/` and `.expo/` of the app in this checkout, when no run is in progress and no dev server runs. The shared build cache stays. To force a full build, delete the matching entry in the build cache directory by hand.

When `dev:stop` does not exit 0, cleanup stops and changes nothing else. Read the `cleanup-dev-stop` evidence file, fix the cause, and run cleanup again. Never kill a process by name, and never run `xcrun simctl shutdown all` or `adb emu kill` on a device that this run did not start: other worktrees have their own servers and devices.

Run cleanup after a failed attempt too.

## Not covered

[features/README.md](features/README.md) §Not mapped yet has the list. The `live-project` suite covers `new` and `install`.
