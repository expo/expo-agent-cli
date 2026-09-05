# 0026: `dev` owns the open

**Type:** RFC
**Status:** Draft
**Systems:** the open itself (`src/dev/openApp.ts`); the hook it hangs on (`src/start/startAsync.ts` §runDevServerAsync, `src/dev/devAsync.ts` §executePlanAsync); the plan's argv and reasons (`src/plan/decide.ts`, `src/plan/platformFlags.ts` §isNativePlatformFlag); the grace-window gate (`src/dev/childVerdict.ts` §stepOpensPlatform); the stub tier's device switch (`e2e/utils.ts`, `AGENT_CLI_NO_DEVICE`)
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-09-05
**Related:** [[0025-dev-requires-platform]], [[0005-runtime-loop-tools]], [[0010-agent-conventions]]

## Summary

[[0025-dev-requires-platform]] made `dev --ios` put the app on a device by forwarding the flag to `expo start`. That worked through the Expo CLI's opener, which checks Simulator.app with an osascript that a Mac without the Automation grant refuses — and the refusal is uncaught, so the dev server dies with it [observed live — 2026-08-24]. `smoke` had already routed around this; Kudo asked whether `dev` and `smoke` could share that code [2026-09-05].

Now they do. `dev` opens the app itself, through the same modules `smoke` and `navigate` drive: probe or boot the device (`bootDevice`), put the right Expo Go on it (`installExpoGo`, version-checked like `@expo/cli` does), and deep-link to `/` (`openRouteAsync`, which handles `adb reverse` and the dev-client launcher URL). No AppleScript anywhere, so it works headless and needs no grant.

## How it hangs together

The dev server's port is only knowable after the spawn, and the subprocess does not return until the server stops. So `runDevServerAsync` gained one hook: `onDevServer`, told the moment the project lock resolves the port. `dev` arms it for the `expo start` step of a run — never for `--plan`, `--web`, `--no-open`, or `expo run:*`, which installs and launches itself.

The open is fire-and-forget from the dev server's point of view. It narrates each slow act on stderr (a boot, an Expo Go download), reports the outcome the same way, and a failure is a warning with `navigate /` in it — the dev server is still doing its job, and taking it down over a failed open would invert their importance. `stillWanted` stops the staging when the server dies mid-open.

For a person at a terminal, the Simulator window is surfaced with `open -a Simulator` (DeviceHub on Xcode 27) — LaunchServices, not AppleScript, so still no grant. Headless runs skip it; `simctl openurl` needs no window.

## What it displaced

- **The platform flag never reaches `expo start`** (`isNativePlatformFlag`). `--web` still does: serving the web bundle is that CLI's own job.
- **`--no-open` now means "skip `dev`'s own open"** — same caller intent as in 0025, one mechanism instead of two. `smoke` starts its dev server with it and keeps opening through its own phases, whose budgets and verdicts a gate needs.
- **The F140 grace window narrowed to `expo run:*`** (`stepOpensPlatform`). A `start` step has no outstanding work that can kill it after the bundler answers, because the open is in `dev`'s process now; `run:*` still launches through AppleScript and keeps the grace.
- **The Automation-refusal recovery** is now "run `dev --<platform> --detach` again": the build was recorded (F121), so the re-run starts the dev server and opens through `simctl` — the fifteen-minute walk that recovery used to cost is gone entirely.

## The stub tier and devices

Tier 0 doubles the dev server, never a device ([[0002-testing-and-evals]]). With the open armed on every native run, an e2e on a developer's Mac would boot a real simulator against a stub dev server. `AGENT_CLI_NO_DEVICE=1` turns the open off, and the e2e harness sets it for every spawn. The live tier does not set it, and its local suite is where the whole open runs for real.

## Evidence

- Unit: 3964 pass, including the new `openApp` table and the hook wiring.
- E2E: 629 pass — plan argvs without the flag, the forwarded options intact, the F140 grace on a `run:ios` stub that dies after its bundler answered.
- Live: `dev --ios --detach` on the booted iPhone 17 Pro opens Expo Go on the started dev server (live-local tier).
