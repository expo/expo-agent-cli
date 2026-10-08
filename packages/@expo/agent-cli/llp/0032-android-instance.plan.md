# 0032: `dev` binds its own Android emulator instance

**Type:** Plan
**Status:** Draft
**Systems:** `src/deviceBinding/android.ts` (new); the Android boot (`src/device/bootDevice.ts`); the Android open (`src/dev/openApp.ts`); `installDevBuild`, `askDeviceAsync`, `src/installedApp/android`; `smoke`'s Android phases; the e2e stub `adb` and a new stub `emulator`
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-10-08
**Related:** [[0030-one-device-per-worktree]] (the rules), [[0031-ios-binding]], [[0022-live-tier]]

PR 3b of [[0030-one-device-per-worktree]] §Delivery. Requires [[0031-ios-binding]]. Merges as one unit with it and [[0033-device-lifecycle]].

## Question

How does a worktree get an Android emulator nobody else has? The same question as 3a, on Android.

## State it leaves

- Two worktrees' `dev --android` run two read-only instances of one AVD on ports 5554 and 5556.
- `expo run:android --device <serial>` carries the bound serial (SDK 58 floor; the "a serial is refused" notes in `installDevBuild` and llp/0005 go).
- Live gate on SDK 58 passed (below).

## Android boot

Before the lock: `adb devices -l` and `emulator -list-avds`. Under the lock: `busyPorts` and the port choice per RFC §Choice, else `no-free-port`. Then `spawnEmulator(['-avd', avd, '-ports', 'P,P+1', '-no-snapshot-save', '-read-only'])`, then one binding with serial and pid, in that order inside one section. After it: poll `sys.boot_completed` until `BOOT_DEVICE_TIMEOUT_MS`, accepted only while the child is alive and `adb devices` lists the serial; a non-zero exit or the deadline is a failed boot.

## Wiring

- `android.ts`; the `emulatorList` and `spawnEmulator` tools; the `android-spawn` choice; the boot poll with deadline and exit watcher.
- The resolver callback and the `reuseBoundDevice` reuse of [[0031-ios-binding]] run for Android too. `AppPresenceProbe.installDevice` goes for Android. `withDevice` sets `--device <serial>`.
- `openAppOnDeviceAsync`'s Android branch takes the bound device. `resolveDeviceAsync` sets `adb: resolveAdb()` on a `local-android` winner. `installDevBuild`, `askDeviceAsync` and `installedApp/android` pass the serial; `androidDeviceNameAsync` stays for display only.
- Smoke's Android boot phase calls `acquireDeviceAsync`. `shutdownDeviceAsync` and smoke's `shutdownDevice` phase go, because every device is bound and that branch runs `emu kill` by serial (RFC Contract 6).

## Decided while building

- `src/deviceBinding/emulator.ts` holds the Android tool calls (the inventory, `get-state`, the `EMULATOR_NOT_RUNNABLE` error, the host check) beside `android.ts`, which holds the port choice, the section, the boot poll and the kill; `release.ts` holds the let-go rules of both platforms, so every file stays under the budget of [[0030-one-device-per-worktree]] §Contracts.
- `DeviceTools` gains `commandOf(pid)` and `kill(pid)` beside the RFC's members, because the kill rule reads `ps` and signals, and a unit test must see both. `commandOf` is null where `ps` does not exist and `''` for a pid it does not list, so a reused pid is never killed where `ps` runs.
- `get-state` on an instance that is still booting exits non-zero with `error: device offline`. That row is `not-up`, not `unknown`: the serial is listed, the device is not up. Only `not found` is missing, and any other non-zero exit is the tool row of the RFC.
- The host guard is `adb` resolving on disk (`resolveAdb().fromPathOnly` false); `emulator` is found beside it, so a host with neither binds nothing and `dev --android` serves for a device elsewhere.
- The `no-free-port` How line says to stop one of the listed instances by hand. The RFC names `dev:stop --release`, which [[0033-device-lifecycle]] adds; the suggested-command lint refuses a flag that does not exist yet, so 0033 swaps the line.
- The section of this PR lets go of no device: an own `spawned` binding whose pid is dead loses its file before any refusal, and a live one is reused. The `finally` that runs reaped devices' actions before a refusal lands with the reap in [[0033-device-lifecycle]].
- `status --explain --device <serial>` on Android lists through `adb devices -l` to filter and binds nothing (Contract 3); without `--device` the reader takes the bound serial and names it through `emu avd name` for display.
- `AppPresenceProbe` loses `installDevice` on both platforms: `withDevice` pins every `run` and `install` step to the bound device, so the probe answers presence only, and a `spawned` instance is `missing` without asking, like a `created` simulator.
- The foreign-flag sweep (`src/lint/foreignFlags.ts`) reads the registry's `tools.<runner>([...])` calls, so `-read-only`, `-ports`, `-avd`, `-list-avds`, `-b` and `-j` are pinned where they are spelled.

## Deletions

`EMULATOR_SERIAL`, `bootDeviceAsync`, `shutdownDeviceAsync`, smoke's `shutdownDevice` phase, `probeAndroidDeviceAsync`, `parseFirstAndroidDevice`, `NO_ANDROID_DEVICE`, the Android `installDevice`, the "until 3b" branches of [[0031-ios-binding]], and the Android help lines that `git grep -i 'attached Android\|adb devices'` finds over `src/**/index.ts` and `runtime/stopAsync.ts`.

## Tests

- A stub `emulator` that records argv, appends its serial to a state file beside the booted-state file, removes it on `SIGTERM`, and stays alive until killed. `installStubAdbAsync` lists those serials and answers `get-state` and `sys.boot_completed`. Tests kill the pids in their binding files in `afterEach`. Android device e2e skipped on win32. The dev e2e moves from `--device AVD_NAME` to the serial. A win32 lock test for the rename errors of RFC §Lock.
- Unit, named: `spawned-booting-is-not-up`, `get-state-not-found-is-gone`, `busy-ports-include-alive-emulators`, `kill-checks-arguments-not-binary`, `let-go-runs-before-refusal`.

## Live gate

Runs on a Mac with two scratch worktrees of `apps/eas-example` on SDK 58, before 3a to 4 merge (RFC Risk 1). It verifies five facts and measures one:

1. A second `-read-only` instance boots beside the first; `adb reverse` and install work on it.
2. A human's writable instance beside ours, and ours beside a human's normal launch.
3. An emulator started on a taken port exits non-zero.
4. The spawned process stays alive for the whole life of the instance. If a launcher hands off, the binding must hold the qemu child's pid instead.
5. A cold `-read-only` boot plus the install fits `BOOT_DEVICE_TIMEOUT_MS`; else the Android timeout is raised in this PR.
6. The wall time of `dev --android` from a cold instance to the open app, because every instance start pays it (RFC Decision 2).

About 350 source lines.
