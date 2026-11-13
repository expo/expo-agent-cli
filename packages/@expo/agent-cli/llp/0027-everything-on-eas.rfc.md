# 0027: Everything on EAS — `dev --eas` puts the device there too

**Type:** RFC
**Status:** Draft
**Systems:** `smoke`'s bootstrap (`src/smoke/walk/device.ts`, `src/smoke/deps/device.ts`); `dev:stop --eas` (`src/dev/stopAsync.ts`); `dev`'s option resolver (`src/dev/resolveOptions.ts`); the plan engine (`src/plan/`); the EAS open (`src/dev/openAppEas.ts`, `src/dev/easSession.ts`); `eas.json` (`src/utils/easJson.ts`); the build lookup (`src/impact/buildCache.ts`); EAS failure text (`src/utils/easFailure.ts`); the run follow-ups (`src/followups/start.ts`); the stub `eas` of the e2e tier (`e2e/stubs/eas.js`)
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-09-08
**Revised:** 2026-11-13
**Related:** [[0015-backend-selection-and-config]] §One flag for EAS, [[0005-runtime-loop-tools]] §Cloud simulator, [[0026-dev-owns-the-open]], [[0035-one-device-per-worktree]] §EAS session binding

## Summary

Kudo's rule [2026-09-08]: **when `--eas` is passed, everything runs on EAS — the build, the simulator, the lot.** `deviceBackend: "eas"` takes the same route on `dev` for iOS and Android ([[0015-backend-selection-and-config]] §The device backend).

`dev --ios --eas` ends with the app on an EAS Simulator session:

| Part       | Local device ([[0026-dev-owns-the-open]]) | EAS device (this RFC)                                         |
| ---------- | ----------------------------------------- | ------------------------------------------------------------- |
| Dev server | LAN or loopback                           | Tunnel, because the session is in a datacenter                |
| Build      | a device build                            | a simulator build; none when EAS has one of this fingerprint  |
| Open       | `dev` opens the app on the local device   | `dev` opens the app on this worktree's session, or starts one |
| Stop       | `dev:stop`                                | `dev:stop --eas` also ends this worktree's sessions           |

Which session belongs to this worktree, and who stops it, is [[0035-one-device-per-worktree]] §EAS session binding. This RFC does not repeat those rules.

## Check the EAS project before starting the environment

[confirmed — Kudo, 2026-09-09] Before `dev --eas`, `smoke --eas` or a config-selected EAS build starts anything, it reads the evaluated app config. `--plan` needs no setup.

- No EAS project ID stops with `EAS_PROJECT_NOT_LINKED`, exit 7, and the `eas init` handoff.
- A config that cannot be evaluated or read stops with `EAS_PROJECT_CONFIG_UNREADABLE`. It never claims that the project is unlinked.
- The ID comes from the evaluated config, so dynamic config and environment variables count. An `eas.json` alone is not enough. A linked project without `eas.json` runs.
- The check proves local linkage only. `eas project:info` is not the gate, because it can create or link a project.
- Cleanup is not gated on the config, so a broken config never blocks a stop.

## The dev server is tunnelled

A loopback URL names the loopback of the device that reads it ([[0005-runtime-loop-tools]] §Cloud simulator). With `--eas`:

- `dev` adds a tunnel to the `expo start` options when none is asked for. A detached child gets it too.
- A LAN or localhost host is refused. The session cannot reach it, and the run would report success with an app on an error screen.
- `--web` is refused. EAS Simulator has no browser, and `deploy` is the EAS command for the web.

[confirmed — Kudo, 2026-09-09] Every child runs tunnel v2 (`EXPO_UNSTABLE_TUNNEL_V2=1`) unless the variable is set. `=0` opts out. This never turns on a tunnel that nobody asked for.

## The build is a simulator build

The `development` profile that `eas build:configure` writes is a signed device build, and no simulator can install it. The EAS device route builds `development-simulator`, the profile that `eas build:dev` uses.

- When `eas.json` lacks the profile, `dev` adds it right before the build step and changes nothing else in the file. When `eas.json` is missing, `dev` writes it with that one profile. The plan names the write, because it is a project write outside a step.
- This route has no `eas build:configure` step [Kudo, 2026-09-09]. Its other output is unused, and it can prompt.
- A missing file is the only case `dev` treats as "no `eas.json`". A file that cannot be read or parsed, or has the wrong shape, stops the run before the build and stays as it was.
- Every `eas` command runs non-interactive where it accepts the flag. A prompt on a stdin nobody reads is a hang.
- Open question: should a local-device plan on a Mac also build for the simulator? It is out of scope here.

## Reuse

A session installs a build by id, so a finished simulator build of this fingerprint on EAS is a build the run does not make. The lookup matches the per-platform fingerprint, the simulator profile and a finished status.

- Found: the plan is `dev-client-fresh` (or `bare-fresh`) on that build. Its one step is the tunnelled dev server, and a reason names the build.
- Not found, or the lookup cannot run: the plan builds.
- No lookup while the project has not installed `expo-dev-client`, because that install changes the fingerprint.
- The last-build record and the app-presence probe of [[0004-smart-start-and-project-state]] §A current build is not an installed app are not used. Both describe a local device.

## The open is a session

The EAS open is armed on the `expo start` step like the local open ([[0026-dev-owns-the-open]]). The dev server owns the foreground, and a failed open is a warning that names `navigate / --eas`. In order:

1. **This worktree's session**, if one is up on this platform, is the device. It is checked before the tunnel wait. Which session counts, and the refusal for a session on the other platform, are [[0035-one-device-per-worktree]] §Session binding and §One session per worktree.
2. **The tunnel.** The deep link waits until the dev server's manifest advertises a tunnel host. A link sent earlier names the loopback.
3. **The launch URL** comes from the resolver that `navigate` uses, so the two never disagree. A reused development client gets the URL of the current tunnel ([[0035-one-device-per-worktree]] §Preserved sessions).
4. **A new session** starts with the app named (Expo Go, or the build id) and the launch URL, so no "Open in Expo Go?" dialog waits on a device nobody is at. The start leaves the EAS CLI's connection file in place, so later `--eas` commands reach the session. A start that fails after the session was created still names that session, because it bills.

A development build with no build id is refused with the `eas build` that makes one. "The latest build" could be a device build or another person's build. After its own build step, `dev` asks EAS for the newest finished simulator build; when EAS names none, `dev` warns, and the next plan's lookup finds the build.

## Follow-ups

A `--eas` run's follow-ups aim at the session: `navigate / --eas`, `runtime:errors`, and `dev:stop --eas`. There is no phone rung and no cloud-build rung.

## smoke

`smoke --eas` brings its own environment on EAS, as it boots a simulator locally ([[0005-runtime-loop-tools]] §The run brings its own environment):

- Its dev server starts on the `dev --eas` route without an open, so the session start stays smoke's own act. Its plan names the same build and install as `dev --eas`.
- The **`start-session`** phase runs where the boot would. Expo Go needs no build. A development build needs a finished simulator build of this fingerprint on EAS, looked up only when no session is up. **Smoke never compiles one.** With no build the phase fails with a reason that names `dev --<platform> --eas`.
- A session that smoke started is smoke's to stop at the end of the run, also when its readiness wait failed. A session that was up stays running ([[0035-one-device-per-worktree]] §Session binding).
- Only the EAS CLI's creation message identifies a new session. A warning that names an older session never selects what smoke stops. The `start-session` phase reports the creation; the environment summary reports the cleanup.
- The `app`, `reload`, `route` and `screenshot` phases drive the session.

### Attach the controller after a smoke session starts

[observed — SDK 57 on EAS iOS, 2026-09-09] The launch URL opens the app but gives the device controller no session, and a screenshot then fails with `SESSION_NOT_FOUND`.

- A smoke run that started the session still does its normal app open, which binds the controller. An app this run opened needs no extra reload. A reused session keeps the usual reload check.
- When the screenshot fails with `SESSION_NOT_FOUND`, smoke opens the app on the controller without a relaunch, and retries once. [not observed: whether that open keeps the current screen.]
- A skipped screenshot quotes the controller's error and hint, never the EAS CLI update banner.

## dev:stop

`dev:stop --eas` also ends this worktree's EAS sessions, by id, as [[0035-one-device-per-worktree]] §Session cleanup defines. A bare `eas simulator:stop` could end another run's session.

- The result names the session; its id is `null` when this worktree has none.
- A session that did not stop exits 20, because it still bills.
- Without `--eas`, `dev:stop` keeps this worktree's sessions: ending a billed session is asked for by name.

### Stop hints

[confirmed — Kudo, 2026-09-09] `dev` progress and follow-ups name `dev:stop --eas`, which stops the dev server and the session. Smoke says that it stops the sessions it starts. An exact-id `eas simulator:stop --id` is only for a report about one session whose start or cleanup failed.

## What EAS said

For an unlinked project, the first line of the EAS CLI's refusal cuts off the `eas init` commands that follow it. So every surface that quotes an `eas` refusal reads the whole output through one classifier, which returns a summary, the cause and the fix: the `status` build lookup, the session listing of every `--eas` device command, a failed `eas` step of `dev`, and `deploy`. Output the classifier does not recognise keeps its first line.

The needs-human scenario `eas-project-unlinked` (`EAS_PROJECT_NOT_LINKED`) comes before the generic `eas-prompt` row, because the refusal says "non-interactive mode" and is not a waiting prompt. The handoff is exit 7, because the account a project belongs to is a person's decision ([[0007-deploy-and-headless]] §deploy). When the EAS CLI lists exactly one account, the handoff names it.

`eas init` and `eas *:configure` are not wrapped [Kudo, 2026-09-08]: they run once, they prompt, and the account is the person's choice. This CLI names them.

## Testing

| Contract                                                 | Test                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The EAS device plan, the profile write, the build lookup | `src/plan/__tests__/decide-test.ts`, `resolveAsync-test.ts`, `src/utils/__tests__/easJson-test.ts` |
| §The dev server is tunnelled                             | `src/dev/__tests__/resolveOptions-test.ts`                                                         |
| §The open is a session                                   | `src/dev/__tests__/openAppEas-test.ts`                                                             |
| §Check the EAS project before starting the environment   | `e2e/__tests__/eas-preflight-test.ts`                                                              |
| `dev --eas` end to end: build, reuse, open, Expo Go      | `e2e/__tests__/dev-eas-test.ts`, `dev-eas-foreground-test.ts`                                      |
| §smoke                                                   | `src/smoke/__tests__/phases-test.ts`, `e2e/__tests__/smoke-test.ts`                                |
| §Attach the controller after a smoke session starts      | `src/device/__tests__/screenshot-test.ts`                                                          |
| §dev:stop                                                | `src/dev/__tests__/stopAsync-test.ts`, `e2e/__tests__/cloud-simulator-test.ts`                     |
| §What EAS said                                           | `src/utils/__tests__/easFailure-test.ts`, `src/needsHuman/__tests__/easProject-test.ts`            |
| On a real session                                        | `e2e-live/__tests__/live-cloud-test.ts`                                                            |

The e2e tier runs against the stub `eas` ([[0002-testing-and-evals]]). A change to the EAS path is proven only on a real session (`AGENTS.md`, "Check the EAS path on EAS"). On a real session, `smoke`'s `app` phase can be inconclusive, as [[0005-runtime-loop-tools]] §Cloud simulator records. A live run on the shared `expo-ci` account [observed — 2026-09-08] showed why a session must be chosen per worktree: `dev --ios --eas` reused a session that a CI job had started, and that session refused the deep link. [[0035-one-device-per-worktree]] lists this among the problems it solves.
