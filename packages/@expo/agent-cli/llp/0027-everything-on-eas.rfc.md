# 0027: Everything on EAS — `dev --eas` puts the device there too

**Type:** RFC
**Status:** Draft
**Systems:** `smoke`'s bootstrap (`src/smoke/phases.ts` §start-session, `src/smoke/smokeAsync.ts` §ensureEasSession); `dev:stop --eas` (`src/dev/stopAsync.ts` §stopProjectEasSessionAsync); `dev`'s option resolver (`src/dev/resolveOptions.ts` §assertEasRunFits, §namesTunnel); the plan engine (`src/plan/decide.ts` §easRouteSteps, §easBuildPlan; `src/plan/types.ts` §DeviceBackend; `src/plan/resolveAsync.ts`; `src/plan/easBuildLookup.ts`); the EAS open (`src/dev/openAppEas.ts`); `eas.json` (`src/utils/easJson.ts`); the build lookup (`src/impact/buildCache.ts` §buildCacheArgs); the run follow-ups (`src/followups/start.ts` §onEas); the stub `eas` of the e2e tier (`e2e/stubs/eas.js`)
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

## Check the EAS project before starting the environment

`dev --eas` (including `--detach`) and `smoke --eas` read `expo config --json` before starting the environment. A config-selected EAS build gets the same check after the plan resolves. A missing or empty `extra.eas.projectId` stops with `EAS_PROJECT_NOT_LINKED`, exit 7, and the existing `eas init --id` / `--account` handoff. `--plan` remains available without setup. [confirmed — Kudo, 2026-09-09]

The project ID comes from the evaluated config, including dynamic configuration and environment variables. A failed evaluation, timeout, or unreadable response stops with `EAS_PROJECT_CONFIG_UNREADABLE`, not a claim that the project is unlinked. The check has a 30-second budget. It establishes local linkage configuration, not server-side access or account permissions; the EAS commands retain their own checks. `eas project:info` is not used as a read-only gate because its project context may create/link a project. [observed — eas-cli 23.2.0 `getProjectIdAsync`]

An `eas.json` without a project ID is insufficient. A linked project without `eas.json` can still run: the simulator profile is generated when a build needs it. Other `--eas` device commands already query the project's EAS session before acting; cleanup is not gated on config evaluation, so a broken config does not prevent stopping Metro.

## The dev server is tunnelled

`exp://127.0.0.1:8081` names the loopback of whatever resolves it (llp/0005 §Cloud simulator). `resolveDevOptions` appends `--tunnel` to the forwarded `expo start` options when `--eas` is passed and no tunnel was asked for already (`--tunnel` or `--host tunnel`). `--lan`, `--localhost` and `--host lan|localhost` are refused with `--eas`: they name an address the session cannot reach, and a run that accepted them would end with an app on an error screen and a report of success. `--web` is refused too — EAS Simulator has no browser to offer, and `deploy` is the EAS command for the web app.

The detached child re-resolves its own argv, so `dev --detach --eas` implies the tunnel in the child and the parent's tunnel wait (`waitForTunnelUrlAsync`) already knows to expect one.

The launcher defaults `EXPO_UNSTABLE_TUNNEL_V2` to `1` for every child, including detached servers, so `--tunnel` dogfoods tunnel v2. An explicit value is preserved; `EXPO_UNSTABLE_TUNNEL_V2=0` opts out. This does not turn a tunnel on for runs that did not request one. [confirmed — Kudo, 2026-09-09]

## The build is a simulator build

`eas build:configure` writes `development` as `developmentClient: true, distribution: 'internal'` [observed — eas-cli 23.2 `build/configure.ts`]. That is a **device** build: signed, for a phone. No simulator installs it — not the EAS Simulator, not the one on this desk — so the old `dev --eas` plan built something its own `build:run` sentence could not install on a Mac's simulator either. A finding of this work, not only of the cloud device.

`eas build:dev` (hidden) solves it upstream with a profile named `development-simulator`: `developmentClient`, `internal`, `ios.simulator: true` [observed — eas-cli 23.2 `commands/build/dev.ts`]. `EAS_SIMULATOR_PROFILE` is that name, and the plan for the EAS device builds it. When `eas.json` has no such profile, `dev` adds one — exactly those three keys, nothing else in the file touched (`ensureSimulatorProfileSync`) — **right before the build step**, and the plan's reasons say so first. It is a project write done outside a plan step; the honest form was to name it in the plan (`easSimulatorProfile: false` → a reason) rather than hide it in the step. There is **no `eas build:configure`** on this route [Kudo, 2026-09-09]: when `eas.json` is missing, `dev` writes it with the one profile the build needs — the configure step's other output (device profiles, a submit section, `cli.version`) is nothing this plan reads, and the step can prompt. The configure step survives only for a build routed to EAS by config with the device kept local, where the `development` profile it writes is the one that build names.

A plan for a local device keeps the `development` profile it always built. Whether it should also move to a simulator build on a Mac — `expo run:ios` builds for the simulator, and so does a session — is left open here; it is a change to a plan nobody asked about.

The profile writer only treats `ENOENT` as a missing file. If an existing `eas.json` cannot be read or parsed, or its root or `build` section is not an object, it stops with an actionable error before submitting the build and preserves the file. The tolerant read used by planning is not evidence that an existing file is safe to replace. [observed — regression tests in `easJson-test.ts` and `dev-eas-test.ts`, 2026-09-09]

## Reuse

A session installs a build by id. A finished simulator build of this exact fingerprint on EAS is therefore a build the run does not have to make, and a native build is the fifteen minutes everything else in this command is measured against. `lookUpEasSimulatorBuildAsync` asks the same question `eas build:dev` asks: the per-platform fingerprint (an EAS build carries one per platform, so the probe's project hash cannot be handed to the lookup), `--build-profile development-simulator`, `--status finished`. `buildCacheArgs` gained the optional profile filter for it; `status` keeps asking about any finished build.

Found, the plan is `dev-client-fresh` (or `bare-fresh`) resting on `plan.easBuild`, with one step — the tunnelled dev server — and a reason naming the build. Not found, or not askable (no fingerprint tool, no runner, a refusal), the plan builds, which is the plan it always was. The lookup is skipped for a project that has yet to install `expo-dev-client`: that install moves the fingerprint, so a build found now is a build of a project about to change.

The last-build record is not consulted on the EAS device, and neither is the app-presence probe of [[0004-smart-start-and-project-state]] §A current build is not an installed app: the first answers "does the app on a *local* device match", and the second asks a local device. A session started with `--build-id` has the app by construction.

## The open is a session

`openAppOnEasAsync` (`src/dev/openAppEas.ts`) is armed on the `expo start` step the way the local open is (`onDevServer`, [[0026-dev-owns-the-open]]), and runs in the same fire-and-forget shape: the dev server owns the foreground, and a failed open is a warning with `navigate / --eas` in it.

1. **A session this project has**, on this platform and in progress (`probeCloudSessionAsync`), is the device: the app is opened on it through `openRouteAsync` with `cloud: 'required'`, the same verb `navigate --eas` runs, which resolves the link itself. Asked first, so a session that is up costs no wait on a tunnel. A session on the other platform does not count; one is started.
2. **The tunnel**, for a session about to be started. The dev server is asked for its advertised origin (`fetchAdvertisedUrlAsync`, the manifest's `launchAsset.url`) until it names a tunnel host or `EAS_TUNNEL_WAIT_MS` runs out. A foreground run captures no log, and the manifest is the dev server's own account (llp/0021).
3. **The launch URL**, from `resolveRouteUrlAsync`'s `connect` list — `exp://<tunnel host>` for Expo Go, `<scheme>://expo-development-client/?url=<origin>` for a development build — so `dev` and `navigate` never disagree about the link.
4. **Then the session is started**: `eas simulator --platform <p> --type agent-device (--expo-go | --build-id <id>) --open-url <url> --non-interactive --name "<dir> — agent-cli dev"`. `--open-url` is what keeps the first deep link from raising "Open in Expo Go?" on a device nobody is at (llp/0005; `live-cloud-test.ts` fact 4). Without `--json`, so the EAS CLI writes `.env.eas-simulator` itself and every later `--eas` command finds the session (`simulator:exec` loads that file). The id is read from `Simulator session created (id: …)`, which the CLI prints before it waits for readiness — so a start that then fails still names the session it billed, and the warning says how to stop it.

A development build with no id to install — the plan found none and the build step's `build:list` named none — is refused with the `eas build` that makes one. Guessing at "the latest build" would install a device build, or somebody else's.

### Naming the build the run made

The `eas build` step runs in `inherit` mode so its progress reaches the terminal, and a captured `--json` run would take that away from the one step that takes fifteen minutes. So the build id is asked for afterwards: `build:list --build-profile development-simulator --status finished --limit 1` — the newest finished build of the profile, which right after the run's own build finished is that build (`findLatestSimulatorBuildIdAsync`). A list that names nothing is a warning with the re-run in it: the next plan's lookup finds the build and skips straight to the session.

## Follow-ups

A `--eas` run's follow-ups are aimed at the session: `navigate / --eas`, `runtime:errors`, and `npx eas simulator:stop`. The phone rung is left out — the device is in a datacenter — and so is the cloud-build rung, because this run already built there when it had to.

## smoke

`smoke --eas` was the device flag alone: the session was somebody else's to have started, and a run with none reported "no device". The gate now brings its own environment on EAS the way it boots a simulator locally ([[0005-runtime-loop-tools]] §The run brings its own environment):

- Its dev server starts through `dev --<platform> --detach --wait-ready --no-open --eas`, so it is tunnelled and a build the plan needs is the simulator profile on EAS Build. `--no-open` keeps the session this run's own act.
- Its plan is resolved with `deviceBackend: 'eas'`, so the build it names — and the `installWith` it prints — are `dev --eas`'s.
- A new conditional bootstrap phase, **`start-session`**, where the boot would be: `ensureEasSessionAsync` with the app the plan names. Expo Go starts with `--expo-go`; a development build needs a finished `development-simulator` build of this fingerprint on EAS (`lookUpEasSimulatorBuildAsync`) — and **the gate never compiles one**. No build is a failed phase whose reason names `dev --<platform> --eas`, and the run stops where a run with no device stops. A session this run started is a registered cleanup (`resource: 'session'`) and is ended by id when the run ends; one that was already up is left running.
- `probeDevice` then finds the session the way it always did, and the `app`, `reload`, `route` and `screenshot` phases drive it as before.

## dev:stop

`dev:stop --eas` also ends this project's session: the one the listing reports in progress (dotenv as the tiebreaker), stopped **by id** — the bare `eas simulator:stop` ends whatever the dotenv names, which may be a session another run is driving. Reported under `session: { id, stopped, reason }`; `id: null` is a project with none, and exit 20 is a session that would not stop, because it is still billing. Without the flag the session is untouched, as before: a session costs money, and ending one is asked for by name.

## What EAS said

Three surfaces quoted the EAS CLI's refusal by its first line, and for an unlinked project that line is `EAS project not configured. This command cannot configure it in non-interactive mode. Run one of the following, then re-run this command:` — with the following, the two `eas init` forms, cut off [observed — `status --explain`, `runtime:stop --eas`, 2026-09-08]. `deploy` had already solved this for itself (`classifyEasDeployFailure`, F143): read the whole output, recognise the sentence, answer with the fix and the account the CLI listed.

That classifier is `src/utils/easFailure.ts` now, `classifyEasFailure`, with a one-line `summary` beside the `why`/`how`/`command` it had, and it is read wherever this CLI quotes an `eas` refusal: the build lookup of `status --explain` (`describeLookupFailure`), the session listing behind every `--eas` device command (`probeCloudSessionAsync`, and `cloudSessionUnknownError`'s `How:` and `Try:`), and a failed `eas` step of `dev` (`planStepFailedError`, which then names `eas init` rather than the command that just failed). Anything the classifier does not recognise keeps the first line, as before.

It is also a needs-human scenario of its own, `eas-project-unlinked` (`EAS_PROJECT_NOT_LINKED`), placed before the generic `eas-prompt` row: the EAS CLI's explanation contains "cannot configure it in non-interactive mode", and the generic row read that as a question waiting in a terminal — `dev --eas` exited 7 telling the caller to answer a prompt that does not exist [observed — 2026-09-08]. The handoff stays exit 7, because which account a project belongs to is a person's decision ([[0007-deploy-and-headless]] §deploy, F143); the classifier fills the account in when the CLI listed exactly one, and every surface — `deploy`, `dev`, the `--eas` device commands — hands over the same `eas init` line.

`eas init` and `eas *:configure` are not wrapped, on purpose [Kudo, 2026-09-08]: they are one-time, they prompt, and the account is the person's to choose. This CLI names them, with the account filled in when the EAS CLI listed exactly one.

## What did not change

- `--eas` on `navigate`, `runtime:reload`, `runtime:stop` names the device only, as the renamed `--cloud` did ([[0015-backend-selection-and-config]] §One flag for EAS).
- The local device keeps everything of [[0026-dev-owns-the-open]]: same open, same `development` profile on the EAS build backend.

## Testing

- Unit: the plan rows (`decide-test.ts` §the EAS device), the resolver's lookup and profile injection (`resolveAsync-test.ts` §the EAS device), the option refusals and the implied tunnel (`resolveOptions-test.ts`), `eas.json` (`easJson-test.ts`), the open's argv and every stop (`openAppEas-test.ts`), the profile filter on the lookup argv (`compare-test.ts`).
- Unit, `smoke`: the `start-session` phase started / reused / failed / absent (`phases-test.ts`); `dev:stop --eas` ended / none / would not stop / not asked (`stopAsync-test.ts`).
- E2E, against the shared stub `eas` (`e2e/stubs/eas.js`, [[0002-testing-and-evals]]): `smoke --eas` with no session starts one with `--expo-go` and the tunnelled URL, finds it, and ends it by id; `dev:stop --eas` ends the listed session by id and answers `session` for a project with none. For `dev --eas`: the plan, both refusals, a detached run that builds the simulator profile, adds it to `eas.json`, names the build, tunnels the dev server and starts a session with `--build-id` and the dev-launcher URL; the Expo Go form with `--expo-go` and `exp://<tunnel>`; the reuse of a session that is up; the reuse of a finished build of this fingerprint and the miss on another fingerprint. The stub dev server advertises its tunnel host in the manifest once the tunnel "comes up", as the real one does.
- Live, `apps/eas-example` on `expo-ci`, 2026-09-08 (eas-cli 23.2.0, run by hand from this package's `bin/cli.js`):
  - `dev --ios --eas`, first pass: the plan was `dev-client-stale` with `eas build --platform ios --profile development-simulator` then `expo start --dev-client --tunnel`; the profile was added to `eas.json`; the build finished on EAS (`c42fd45f`); the dev server came up on a `*.on.expo.app` tunnel. The open **reused** an iOS session a concurrent CI live-cloud job had just started (`agent-cli-live`), and that session refused the deep link — the reuse rung picks any in-progress session of this project on the platform, and a shared CI account has other runs' sessions on it. On a developer's own account that is the session they started; on a shared account it is a caveat this document records rather than a defect it fixes.
  - `dev --ios --eas`, second pass with no session up: the plan was `dev-client-fresh` resting on `easBuild c42fd45f` ("EAS already has a finished build for this fingerprint") — the reuse of §Reuse, live; `expo start --dev-client --tunnel`; `eas simulator --build-id c42fd45f … --open-url easexample://expo-development-client/?url=https://…on.expo.app`; the dev server bundled 536 modules for the app on the session right after; `dev` reported the session with its expo.dev URL. One finding fixed: the id parser missed the `(id: …, saved to .env.eas-simulator)` form and said "id unknown".
  - `smoke --ios --eas` against that session: `start-session` reported the session as already up; `app` was inconclusive — `easexample://` opened, no debugger target attached within 3 min, and the screenshot was the dev launcher's screen — the same `/json/list`-stays-empty behaviour of a cloud session [[0005-runtime-loop-tools]] §Cloud simulator records. Exit 22, never a pass.
  - `dev:stop --eas`: the dev server stopped and the session ended by id; `simulator:list --status in-progress` then listed nothing.
  - Not yet run live: `dev --android --eas`, and the Expo Go form of the session start (`--expo-go`), which the `live-cloud` suite exercises on its own.

Live check, 2026-09-09: a fresh SDK 57 app created with this CLI (`new <dir> --no-git --json`, dependencies installed) followed by `dev --ios --eas --json` stopped at the project-linkage preflight with exit 7. No Metro or EAS session was started. Separately, `start --tunnel` with `EXPO_UNSTABLE_TUNNEL_V2` unset advertised a `*.on.expo.app` URL; the server was stopped after checking it. [observed]

### Smoke session ownership and cleanup

The creation message identifies a new session. An overwrite warning naming a previous session is not a creation receipt and must never select the cleanup target. A session created before a failed readiness wait still belongs to the smoke run and is registered for cleanup. The start phase reports creation only; the environment summary reports the actual session cleanup result. Reused sessions remain running. [observed — regression tests, 2026-09-09]

### Attach the controller after a smoke session starts

EAS's `--open-url` launches the app, but does not create an `agent-device` controller session. A fresh smoke run must still perform its normal app open even if Metro already lists a debugger target. That open binds the controller before observation and screenshots; it also uses the existing rule that an app opened by this run needs no additional reload. A reused session with an attached app keeps the existing reload check. [observed — SDK 57 on EAS iOS, 2026-09-09: without the controller open, screenshot exited `SESSION_NOT_FOUND: No active session. Run open first.`]
