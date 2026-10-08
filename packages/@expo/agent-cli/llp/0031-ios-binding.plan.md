# 0031: `dev` binds its own iOS simulator, and every verb uses it

**Type:** Plan
**Status:** Draft
**Systems:** `src/deviceBinding/` (new); the `dev` resolver and run (`src/dev/resolveOptions.ts`, `src/dev/devAsync.ts`, `src/dev/detachAsync.ts`, `src/dev/index.ts`); the app-presence probe (`src/device/appPresence.ts`); the local open (`src/dev/openApp.ts`); `navigate`'s device resolution (`src/navigate/device.ts`); the installed readers (`src/installedApp/`); `smoke`'s device phases (`src/smoke/smokeAsync.ts`)
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-10-08
**Related:** [[0030-one-device-per-worktree]] (the rules), [[0026-dev-owns-the-open]], [[0025-dev-requires-platform]]

PR 3a of [[0030-one-device-per-worktree]] §Delivery. Requires PR 1 and PR 2. Merges as one unit with [[0032-android-instance]] and [[0033-device-lifecycle]].

## Question

How does a worktree get an iOS simulator nobody else has, and how do the other verbs find it?

## State it leaves

- Two worktrees' `dev --ios` build and open on two `agent-cli` simulators.
- `expo run:ios --device <udid>` carries the bound id, so a second worktree on a current build installs onto its fresh simulator.
- `dev --detach` on a running server boots its own `Shutdown` simulator and refuses otherwise.
- `navigate` without `dev` falls to the EAS rung, which until PR 5 accepts the dotenv id only, then refuses naming `dev`; with it, it drives the bound device only. Without a platform flag, any `up` binding wins.
- `smoke --ios` gets its simulator from the binding and leaves it bound.
- Android unchanged.

## Commit order

Module first (RFC Decision 8). The first commits hold `src/deviceBinding/` and its unit tests, with no caller. The later commits hold the wiring, so a reviewer reads the module alone and then only call order.

## The module

Per RFC §Contracts, without `android.ts`, `cloud.ts`, `reap.ts` and `ownCloudIdsAsync`. The let-go rule and `releaseWorktreeDevicesAsync` ship here, because a failed boot needs them; their only caller in 3a is the failed boot. The reap step of `acquireDeviceAsync` is a no-op until [[0033-device-lifecycle]]. `createSimulatorAsync` runs `simctl create` under the lock per RFC §Lock. Two tests guard the shape: the boundary test (Contract 10) and a subprocess-count test (one subprocess per binding a read verb inspects).

## How `dev` uses it

- `resolveStartPlanAsync` serves `dev`, `smoke` and `status`. It gains an optional `acquireDevice(draft) → Promise<AcquireResult | null>` callback that only `dev` passes, and returns `{ plan, acquired }`; `smoke` and `status` take `.plan`.
- Non-building draft for a native platform without `--eas`. On main the resolver exits early through two draft fields, `awaitsADevice` (the plan needs a device before it can decide the install step) and `opensOn` (the platform the open targets, null under `--no-open`). The resolver's exits, main against new:

| Main                                                                                                                        | New                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1. exit when `awaitsADevice` is false, `opensOn` is null, the requested platform is not native, or `deviceBackend` is `eas` | 1. exit for `web` and `none` drafts, a non-native requested platform, or `deviceBackend` `eas` |
|                                                                                                                             | 2. the callback, for `expo-go`, `dev-client` and `bare` drafts                                 |
|                                                                                                                             | 3. exit for an `expo-go` draft, unprobed                                                       |
|                                                                                                                             | 4. the `--no-open` exit; `opensOn` no longer drops out under `--no-open`                       |
| 2. exit when the build backend is `eas`                                                                                     | 5. the same                                                                                    |
| 3. the app-presence probe                                                                                                   | 6. the probe, on the acquired device                                                           |
| 4. the toolchain exit                                                                                                       | 7. the same                                                                                    |

- `dev`'s callback first runs main's `--port` bindability check (`resolvePlannedPortAsync`, then `portDemandedError`, outside `--plan`) when the draft serves, and only refuses; main's later port block stays and still sets the port. Then it calls `acquireDeviceAsync`. Both skip under `AGENT_CLI_NO_DEVICE`, read through one helper in `src/deviceBinding/index.ts` that `smoke` uses too.
- The probe becomes `probeAppPresenceAsync(root, platform, { device, action }, injections)`: the device context is a new third parameter and main's injections move to the fourth; `ResolveStartPlanOptions.probeAppPresence` gains the parameter. With a device it answers `missing` without asking when `action` is `created`, even when no app id resolves, because a fresh device never has the app and the install step needs no id. On iOS a `Shutdown` simulator's apps are read off its disk. With null on iOS it answers main's `UNPROBED`. With null on Android it keeps main's first-device lookup until 3b; the `probeDevice` injection takes the root.
- Building draft: the resolver decides fully with no probe. `devAsync`'s order after `withForwardedExpoArgs` is: the port block, which sets the port and stays before the `--plan` return because the plan prints the port; the `--plan` return; the refusals (`implicitEasRouteError` and the EAS project check); `acquireDeviceAsync`; `withDevice`. So no simulator is created for a run that then refuses, and `--plan` never acquires. The named `--port` refusal runs in the callback before `acquireDeviceAsync`, for a serving draft and a building one alike.
- Decided while building, where the RFC left it open:
  - The detached child's log carries one row, `Error code      <code> exit <n> data <json>`, written by `logCmdError` only under `__EXPO_AGENT_CLI_DETACHED=1`, which `devDetachAsync` sets on the spawn. The parent reads the row, the `Try:` line right above it, and nothing else, and rebuilds the error with its code, exit, `data` and `suggestedCommand`.
  - A boot that fails lets go of the binding and refuses `DEVICE_UNAVAILABLE` with reason `boot-failed` (RFC §Output and errors). An inventory read that times out refuses `create-timeout`.
  - `src/deviceBinding/` has `ios.ts` (the iOS `simctl` calls), `errors.ts`, `events.ts` and `tools.ts` (`defaultTools`) beside the RFC's files; `DeviceTools` holds `simctl`, `now` and `isPidAlive` until [[0032-android-instance]] adds the Android members, and `inspectBindingAsync` takes `local-ios` and `cloud` only.
  - `findBoundDeviceAsync` takes no `eas` option; `resolveDeviceAsync` keeps its `cloud: 'required'` short-circuit. Main's Android rung is injected as `android?: AndroidRung`, because Contract 10 keeps `navigate` out of the module. The EAS fallback asks the service only when the dotenv names a session.
  - The `--plan` reason "will reuse or create a simulator" is added only for `--ios` without `--eas` and with devices on, so a stubbed harness's plans are unchanged.
  - `smoke`'s iOS boot skips under `AGENT_CLI_NO_DEVICE` and reports a failed boot phase; its install phase honours the boot's `installNeeded`, because a created simulator's disk holds nothing to read.
- `withDevice(plan, device)` runs after `withForwardedExpoArgs` and before the `--port` block. It sets `--device <udid>` on every `run` and `install` step and replaces any `--device` there; on a plan with neither it is a no-op. `AppPresenceProbe.installDevice` goes for iOS. `devAsync` passes `acquired.device` through `executePlanAsync` to `openAppForRunAsync`'s local branch, which hands it to `openAppOnDeviceAsync`; its iOS probe and boot go, and it passes the device to `openRouteAsync` through a new `device?: BoundDevice` option, which skips `resolveDeviceAsync`, so the open inspects nothing twice. `report.booted` is `acquired.justBooted`.
- The callback runs for iOS only, and on macOS only; on another host `dev --ios` binds nothing and the plan is unprobed, which is what the live-cloud suite's Linux worker relies on. Android keeps main's probe-and-boot path, its first-adb rung, its `probeLocalDeviceAsync` branch and its `installDevice` until 3b. `acquire` is skipped for `--eas`.
- `dev --plan` passes a callback that inspects the own binding and returns it as `reused` with `justBooted: false` when the state is `up` or `not-up`; otherwise null. For a building draft `devAsync` calls that same callback itself and pins the plan, with no probe. When the callback returned null, `devAsync` leaves the step unpinned and adds the reason "will reuse or create a simulator" to the plan, building or not.
- `dev --detach`: the child acquires and never releases on exit. `devDetachAsync` gains an option `reuseBoundDevice`, default false, that `devAsync` passes as true and `smoke` leaves unset. With it, when the server is already running, `devDetachAsync` calls `acquireDeviceAsync` with `reuseOnly` before `reportDetached` prints, for `--ios` without `--eas` and without `AGENT_CLI_NO_DEVICE`. A parked own simulator is booted, the boot is waited for, and the `action` line is printed on stderr before the report. Any other choice refuses `not-reusable` (exit 20), because a device created here would carry no app. The child's `DEVICE_*` and `NO_BOUND_DEVICE` errors are written to the child verdict and the parent rethrows them unchanged, per RFC §Output and errors; `detachFailureError` keeps `DEV_DETACH_DIED` for everything else.

## Readers

- `resolveDeviceAsync` makes `context.projectRoot` required and calls `findBoundDeviceAsync` per RFC §Readers; its callers in `runtime/stopAsync.ts`, `runtime/reload/reloadAsync.ts`, `runtime/reload/cloudReload.ts` and `navigate/openRoute.ts` already pass it. Until 3b, main's Android rung counts as `none` when it finds nothing, and its tool error follows the `unknown` row.
- `probeLocalDeviceAsync` takes `projectRoot` in its options, keys its cache by it, and reads `inspectBindingAsync` on iOS; its callers in `status/statusAsync.ts`, `start/followUps.ts`, `deferred/dev-wait/waitAsync.ts` and `appPresence.ts` pass the root. Its `devices` lists each `up` binding as a `NavigateDevice`, then main's Android probe device until 3b, because `status`'s sections and `askDeviceAsync` read it. `noLocalDeviceAction` is unchanged: it runs only while a server is up. `status`'s next action names the `dev` command of RFC §Output and errors where it names `dev` today, with the platform of the first binding whose state is not `up`.
- The installed readers take `projectRoot` and call `findBoundDeviceAsync` with `extend: false`; `status --device` keeps its filter through `listBootedIosSimulatorsAsync`. `probeIosSimulatorAsync`'s callers in `dev/openApp.ts` and `device/localDevice.ts` move to the binding in this PR. Their `no-device` result keeps its name; its `hint` carries the read verb's How line first and main's connected-phone hint after it.

## smoke

In bootstrap mode `smoke` starts its own `dev --detach --no-open` child through `devDetachAsync`, which acquires. Smoke's `probeDevice` phase then finds the bound device, so smoke boots nothing itself. When that phase finds no device, after a reused dev server or a child that reported the server already running, the shared boot phase in `smoke/phases.ts` branches on the platform: iOS calls `acquireDeviceAsync` without `reuseOnly`, maps `action` to `installNeeded` (`created`) and the device's name to `choice`, registers no shutdown cleanup, and drops "and shut it down again afterwards" from its reason; Android keeps `bootDeviceAsync` and its shutdown until 3b. The device stays bound after smoke until [[0033-device-lifecycle]]. The `boot.refused` branch of the phase goes; `SmokeDeviceDisposition` `'absent'` stays, because it is also the start value. The smoke e2e boot cases that assert `pickSimulator`'s choice and the shutdown after the run are rewritten to assert the binding.

## Deletions

`bootSimulatorAsync`, `pickSimulator`, the iOS branch of `bootDeviceAsync` (the Android branch and `BOOT_DEVICE_TIMEOUT_MS` stay), `probeIosSimulatorAsync`, `parseBootedIosSimulator` (the plural `parseBootedIosSimulators` stays for `status --device`), the iOS `installDevice`, `NO_DEVICE` and `NO_IOS_DEVICE`. Help texts: the iOS lines that `git grep -i 'booted'` finds over `src/**/index.ts` and `runtime/stopAsync.ts`; the Android lines wait for 3b.

## Docs

The agent guide per RFC §Output and errors. The RFC's §Readers and §Entry points are what this PR implements; first-booted sentences in llp/0004, 0005, 0022, 0025, 0026 change to the bound device.

## Tests

- Unit, named: `boot-always-runs`, `failed-boot-lets-go`, `only-create-and-spawn-under-lock`, `agent-cli-name-needs-binding`, `expo-go-and-bare-drafts-acquire`, `created-device-missing-without-app-id`, `withDevice-after-forwarded-args`, `already-running-reuses-only`, `smoke-never-reaches-already-running-reuse`, `smoke-acquires-without-bootDevice`, `smoke-registers-no-shutdown`, `created-device-plans-install`, `null-device-ios-unprobed`, `inspect-state-order`, `any-up-wins-across-platforms`, `bootstatus-b-not-boot`, `detached-device-error-relayed`, `fallback-eas-rung-dotenv-only`, `expired-is-gone`, `platform-flag-throws-tool-error-first`, `read-verb-one-subprocess-per-binding`, `rung-refusal-reports-first-state`, `probe-local-combines-platforms`, `deviceBinding-imports-nothing-from-verbs`, `exit-codes-per-reason`.
- E2E: `bindingFixture` (`created`, `expiresAt` 60 min ahead, canonical root, macOS only) seeded in the cases that hand a verb a booted simulator. A two-worktree case asserts each `run:ios --device` equals its registry id and the two ids are distinct `E2E-CREATED-*` udids, and set equality of `simctl bootstatus -b` calls.
- Live: `navigate` wall time before and after on a machine with ten simulators, warm and cold, with `simctl list devices -j` and the booted-only list timed side by side. A cold `simctl create` is timed to confirm the 20 s timeout (RFC Risk 5).

About 800 source lines; the module within its budgets.
