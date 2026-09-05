# 0025: `dev` requires a platform, and acts on it

**Type:** RFC
**Status:** Draft
**Systems:** the `dev` resolver and run (`src/dev/resolveOptions.ts`, `src/dev/devAsync.ts`, `src/dev/detachAsync.ts`); the plan engine's open switch (`src/plan/decide.ts`, `src/plan/types.ts`, `src/plan/platformFlags.ts`); the stated-platform helpers (`src/smoke/suggest.ts`); smoke's dev-server start (`src/smoke/smokeAsync.ts`); every surface that prints a `dev` command line
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-09-05
**Related:** [[0004-smart-start-and-project-state]], [[0005-runtime-loop-tools]], [[0015-backend-selection-and-config]]

## Summary

`dev` is meant to work like a web framework's dev command: one command you always run, and it decides the rest [asked — Kudo, 2026-09-04]. `next dev` needs no thought about what to compile; `dev --ios` should need no thought about when to prebuild, when to build, and how the simulator comes up.

Two changes get it there.

1. **The platform flag is required**: `--ios`, `--android`, or `--web`. Same rule, same one-line refusal, and same reasoning as `smoke`'s ([[0005-runtime-loop-tools]] §Which platform is the caller's to say). The old host-based default had a worse cost here than in `smoke`: the guessed platform never reached `expo start`, so a bare `dev` served a bundle and put nothing on any device.
2. **The plan always acts on the platform.** A fresh plan runs `expo start --<platform>`, which boots a simulator or an emulator when none is up, installs Expo Go when it has to, and opens the app — the Expo CLI's own openers do all of this (`AppleDeviceManager`, `AndroidDeviceManager.startAsync` [observed — `@expo/cli` source, 2026-09-04]). A stale plan prebuilds and builds through `expo run:<platform>`, which does the same and installs the build. So `dev --ios` ends with the app running, whichever route the plan took, and no separate boot step was needed.

## What required breaks

The same trap [[0005-runtime-loop-tools]] documents for `smoke`: every surface that teaches the command now prints a refused command line. The sweep covered about sixty sites — follow-ups, `Try:` lines, `status.next`, help examples, the agents cheat sheet, the README, the eval scenarios. Two rules from 0005 carry over unchanged:

- A `suggestedCommand` runs verbatim, so it always states a platform. The platform comes from the strongest evidence at hand: the caller's own flag, then the run's platform, then the project's native directories, then the host (`hostPlatform` in `src/smoke/suggest.ts`). A stated platform in a suggestion is text the caller reads and can change; the default inside a run was an invisible guess.
- The suggested-commands lint is what catches the stragglers. It did, nine times, on the first pass of this change.

Error ordering also carries over: a more specific mistake is reported before the missing platform, and conflict errors quote command lines that keep whatever platform the caller typed, so following one never walks into the missing-platform refusal.

## `--no-open`

Requiring the platform collided with a fact this repo had already paid for: `expo start --ios` drives Simulator.app through AppleScript, macOS refuses that without an Automation grant, and the Expo CLI does not catch the refusal — the dev server dies with it [observed live — 2026-08-24]. `smoke` avoided this by running `dev` with **no** platform flag, which the required flag makes impossible.

`--no-open` is the resolution. The platform still names what the plan builds and serves for; the flag strips it from what reaches `expo start`, so nothing is opened and the AppleScript path is never entered. The step's own reason says so, and points at `navigate /` as the open that needs no grant.

Two callers:

- `smoke` starts its dev server with it (`START_DEV_SERVER_ARGV`), and now also passes its real platform — before this, the detached child planned for the host's default, which could differ from the platform the gate was about.
- The macOS Automation refusal names it as the recovery. The old recovery was "drop `--ios`", which stopped existing the moment the flag became required.

`--detach` carries it through: the flag rides `detachArgv`, so the child run honors it too.

## What did not change

- `status` keeps its own platform default (native directories, then host). It only describes; nothing it runs acts on the guess.
- The EAS route is untouched: the build happens in the cloud, and installing the artifact stays guidance rather than a step.
- The fingerprint rules that decide _whether_ to build ([[0023-fingerprint-caching]]) are unchanged. The flag decides _for what_, not _whether_.

## Evidence

- Unit: 3948 pass, including the new resolver, `--no-open`, and stated-platform cases.
- E2E: 625 pass, including the refusal, the forwarded platform flag, and the smoke start.
- The suggested-commands lint passes, which is the sweep's own gate.
