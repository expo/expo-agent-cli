# 0027: Everything on EAS — `dev --eas` puts the device there too

**Type:** RFC
**Status:** Draft
**Systems:** `dev`'s option resolver (`src/dev/resolveOptions.ts` §assertEasRunFits, §namesTunnel); the plan engine (`src/plan/decide.ts` §easRouteSteps, §easBuildPlan; `src/plan/types.ts` §DeviceBackend; `src/plan/resolveAsync.ts`; `src/plan/easBuildLookup.ts`); the EAS open (`src/dev/openAppEas.ts`); `eas.json` (`src/utils/easJson.ts`); the build lookup (`src/impact/buildCache.ts` §buildCacheArgs); the run follow-ups (`src/followups/start.ts` §onEas); the stub `eas` of the e2e tier (`e2e/stubs/eas.js`)
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-09-08
**Related:** [[0015-backend-selection-and-config]] §One flag for EAS, [[0005-runtime-loop-tools]] §Cloud simulator, [[0026-dev-owns-the-open]], [[0004-smart-start-and-project-state]]

## Summary

`--eas` on `dev` used to mean one thing: the native build runs on EAS Build. The plan ended with an artifact on EAS and a sentence about `eas build:run` — and on an Expo Go project the flag changed nothing at all [observed — 1.0.9, 2026-09-08]. Kudo's rule [2026-09-08]: **when `--eas` is passed, everything runs on EAS — the build, the simulator, the lot.**

So `dev --ios --eas` now ends with the app running on an EAS Simulator session:

- the dev server is tunnelled, because a session is a machine in a datacenter;
- the build, when one is needed, is a **simulator** build (`development-simulator`), which is the one thing a simulator can install — and it is skipped when EAS already has a finished one of this fingerprint;
- the open is a session: the one this project already has, or one started with the app named on its command line (`--expo-go` or `--build-id`) and the tunnelled launch URL in `--open-url`.

[[0026-dev-owns-the-open]] made `dev` open the app on a local device itself. This is the same act for the other device.

## The dev server is tunnelled

`exp://127.0.0.1:8081` names the loopback of whatever resolves it (llp/0005 §Cloud simulator). `resolveDevOptions` appends `--tunnel` to the forwarded `expo start` options when `--eas` is passed and no tunnel was asked for already (`--tunnel` or `--host tunnel`). `--lan`, `--localhost` and `--host lan|localhost` are refused with `--eas`: they name an address the session cannot reach, and a run that accepted them would end with an app on an error screen and a report of success. `--web` is refused too — EAS Simulator has no browser to offer, and `deploy` is the EAS command for the web app.

The detached child re-resolves its own argv, so `dev --detach --eas` implies the tunnel in the child and the parent's tunnel wait (`waitForTunnelUrlAsync`) already knows to expect one.

## The build is a simulator build

`eas build:configure` writes `development` as `developmentClient: true, distribution: 'internal'` [observed — eas-cli 23.2 `build/configure.ts`]. That is a **device** build: signed, for a phone. No simulator installs it — not the EAS Simulator, not the one on this desk — so the old `dev --eas` plan built something its own `build:run` sentence could not install on a Mac's simulator either. A finding of this work, not only of the cloud device.

`eas build:dev` (hidden) solves it upstream with a profile named `development-simulator`: `developmentClient`, `internal`, `ios.simulator: true` [observed — eas-cli 23.2 `commands/build/dev.ts`]. `EAS_SIMULATOR_PROFILE` is that name, and the plan for the EAS device builds it. When `eas.json` has no such profile, `dev` adds one — exactly those three keys, nothing else in the file touched (`ensureSimulatorProfileSync`) — **right before the build step**, and the plan's reasons say so first. It is a project write done outside a plan step; the honest form was to name it in the plan (`easSimulatorProfile: false` → a reason) rather than hide it in the step, and to leave `eas build:configure` as the step that creates the file when there is none.

A plan for a local device keeps the `development` profile it always built. Whether it should also move to a simulator build on a Mac — `expo run:ios` builds for the simulator, and so does a session — is left open here; it is a change to a plan nobody asked about.

## Reuse

A session installs a build by id. A finished simulator build of this exact fingerprint on EAS is therefore a build the run does not have to make, and a native build is the fifteen minutes everything else in this command is measured against. `lookUpEasSimulatorBuildAsync` asks the same question `eas build:dev` asks: the per-platform fingerprint (an EAS build carries one per platform, so the probe's project hash cannot be handed to the lookup), `--build-profile development-simulator`, `--status finished`. `buildCacheArgs` gained the optional profile filter for it; `status` keeps asking about any finished build.

Found, the plan is `dev-client-fresh` (or `bare-fresh`) resting on `plan.easBuild`, with one step — the tunnelled dev server — and a reason naming the build. Not found, or not askable (no fingerprint tool, no runner, a refusal), the plan builds, which is the plan it always was. The lookup is skipped for a project that has yet to install `expo-dev-client`: that install moves the fingerprint, so a build found now is a build of a project about to change.

The last-build record is not consulted on the EAS device, and neither is the app-presence probe of [[0004-smart-start-and-project-state]] §A current build is not an installed app: the first answers "does the app on a *local* device match", and the second asks a local device. A session started with `--build-id` has the app by construction.

## The open is a session

`openAppOnEasAsync` (`src/dev/openAppEas.ts`) is armed on the `expo start` step the way the local open is (`onDevServer`, [[0026-dev-owns-the-open]]), and runs in the same fire-and-forget shape: the dev server owns the foreground, and a failed open is a warning with `navigate / --eas` in it.

1. **The tunnel.** The dev server is asked for its advertised origin (`fetchAdvertisedUrlAsync`, the manifest's `launchAsset.url`) until it names a tunnel host or `EAS_TUNNEL_WAIT_MS` runs out. A foreground run captures no log, and the manifest is the dev server's own account (llp/0021).
2. **The launch URL**, from `resolveRouteUrlAsync`'s `connect` list — `exp://<tunnel host>` for Expo Go, `<scheme>://expo-development-client/?url=<origin>` for a development build — so `dev` and `navigate` never disagree about the link.
3. **A session this project has**, on this platform and in progress (`probeCloudSessionAsync`), is the device: the app is opened on it through `openRouteAsync` with `cloud: 'required'`, the same verb `navigate --eas` runs. A session on the other platform does not count; one is started.
4. **Otherwise a session is started**: `eas simulator --platform <p> --type agent-device (--expo-go | --build-id <id>) --open-url <url> --non-interactive --name "<dir> — agent-cli dev"`. `--open-url` is what keeps the first deep link from raising "Open in Expo Go?" on a device nobody is at (llp/0005; `live-cloud-test.ts` fact 4). Without `--json`, so the EAS CLI writes `.env.eas-simulator` itself and every later `--eas` command finds the session (`simulator:exec` loads that file). The id is read from `Simulator session created (id: …)`, which the CLI prints before it waits for readiness — so a start that then fails still names the session it billed, and the warning says how to stop it.

A development build with no id to install — the plan found none and the build step's `build:list` named none — is refused with the `eas build` that makes one. Guessing at "the latest build" would install a device build, or somebody else's.

### Naming the build the run made

The `eas build` step runs in `inherit` mode so its progress reaches the terminal, and a captured `--json` run would take that away from the one step that takes fifteen minutes. So the build id is asked for afterwards: `build:list --build-profile development-simulator --status finished --limit 1` — the newest finished build of the profile, which right after the run's own build finished is that build (`findLatestSimulatorBuildIdAsync`). A list that names nothing is a warning with the re-run in it: the next plan's lookup finds the build and skips straight to the session.

## Follow-ups

A `--eas` run's follow-ups are aimed at the session: `navigate / --eas`, `runtime:errors`, and `npx eas simulator:stop`. The phone rung is left out — the device is in a datacenter — and so is the cloud-build rung, because this run already built there when it had to.

## What did not change

- `--eas` on `smoke`, `navigate`, `runtime:reload`, `runtime:stop` names the device only, as the renamed `--cloud` did ([[0015-backend-selection-and-config]] §One flag for EAS). `smoke --eas` starting its dev server with `--eas` and installing a matching build is the next step of this work, not this one.
- The local device keeps everything of [[0026-dev-owns-the-open]]: same open, same `development` profile on the EAS build backend.
- `dev:stop` stops the dev server and not the session. A session that costs money is ended by name, `npx eas simulator:stop`, which every sentence about a started session prints.

## Testing

- Unit: the plan rows (`decide-test.ts` §the EAS device), the resolver's lookup and profile injection (`resolveAsync-test.ts` §the EAS device), the option refusals and the implied tunnel (`resolveOptions-test.ts`), `eas.json` (`easJson-test.ts`), the open's argv and every stop (`openAppEas-test.ts`), the profile filter on the lookup argv (`compare-test.ts`).
- E2E, against the shared stub `eas` (`e2e/stubs/eas.js`, [[0002-testing-and-evals]]): the plan, both refusals, a detached run that builds the simulator profile, adds it to `eas.json`, names the build, tunnels the dev server and starts a session with `--build-id` and the dev-launcher URL; the Expo Go form with `--expo-go` and `exp://<tunnel>`; the reuse of a session that is up; the reuse of a finished build of this fingerprint and the miss on another fingerprint. The stub dev server advertises its tunnel host in the manifest once the tunnel "comes up", as the real one does.
- Live: not yet run for `dev --eas`. The `live-cloud` suite covers the verbs this reuses (`navigate --eas`, `simulator … --expo-go --open-url`, `--build-id`); a `dev --eas` run against `expo-ci` is the evidence this document still needs before it leaves Draft.
