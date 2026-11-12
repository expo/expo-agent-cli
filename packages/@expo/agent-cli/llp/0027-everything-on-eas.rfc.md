# 0027: Everything on EAS — `dev --eas` puts the device there too

**Type:** RFC
**Status:** Draft
**Systems:** `smoke`'s bootstrap (`src/smoke/walk/device.ts`, `src/smoke/deps/device.ts`); `dev:stop --eas` (`src/dev/stopAsync.ts`); `dev`'s option resolver (`src/dev/resolveOptions.ts`); the plan engine (`src/plan/decide.ts`, `src/plan/types.ts`, `src/plan/resolveAsync.ts`, `src/plan/easBuildLookup.ts`); the EAS open (`src/dev/openAppEas.ts`); `eas.json` (`src/utils/easJson.ts`); the build lookup (`src/impact/buildCache.ts`); EAS failure text (`src/utils/easFailure.ts`); the run follow-ups (`src/followups/start.ts`); the stub `eas` of the e2e tier (`e2e/stubs/eas.js`)
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-09-08
**Revised:** 2026-11-13
**Related:** [[0015-backend-selection-and-config]] §One flag for EAS, [[0005-runtime-loop-tools]] §Cloud simulator, [[0026-dev-owns-the-open]], [[0004-smart-start-and-project-state]], [[0035-one-device-per-worktree]]

## Summary

Kudo's rule [2026-09-08]: **when `--eas` is passed, everything runs on EAS — the build, the simulator, the lot.** For iOS and Android, `deviceBackend: "eas"` in the developer config takes the same route on `dev` without the flag ([[0015-backend-selection-and-config]] §The device backend).

`dev --ios --eas` ends with the app on an EAS Simulator session:

| Part       | Local device ([[0026-dev-owns-the-open]]) | EAS device (this RFC)                                                         |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| Dev server | LAN or loopback                           | Tunnel, because the session is in a datacenter                                |
| Build      | `development` profile (a device build)    | `development-simulator` profile; skipped when EAS has one of this fingerprint |
| Open       | `dev` opens the app on the local device   | `dev` reuses this project's session, or starts one with the app and the URL   |
| Stop       | `dev:stop`                                | `dev:stop --eas` also ends the session, by id                                 |

`--eas` on `navigate`, `runtime:reload` and `runtime:stop` still names only the device.

## Check the EAS project before starting the environment

[confirmed — Kudo, 2026-09-09] `dev --eas` (also with `--detach`), `smoke --eas`, and a config-selected EAS build read `expo config --json` before they start anything. `--plan` needs no setup.

- A missing or empty `extra.eas.projectId` stops with `EAS_PROJECT_NOT_LINKED`, exit 7, and the `eas init --id` / `--account` handoff.
- A failed evaluation, a timeout (30 s) or an unreadable answer stops with `EAS_PROJECT_CONFIG_UNREADABLE`. It never claims the project is unlinked.
- The project ID comes from the evaluated config, so dynamic config and environment variables count. An `eas.json` alone is not enough. A linked project without `eas.json` runs; the profile is written when a build needs it.
- The check proves local linkage only, not server access. `eas project:info` is not the gate, because it can create or link a project [observed — eas-cli 23.2.0].
- Cleanup is not gated on the config, so a broken config never blocks a stop.

## The dev server is tunnelled

`exp://127.0.0.1:8081` names the loopback of the device that reads it ([[0005-runtime-loop-tools]] §Cloud simulator). So with `--eas`:

- `dev` adds `--tunnel` to the `expo start` options, unless a tunnel is already asked for (`--tunnel`, `--host tunnel`). A detached child re-resolves its argv, so it gets the tunnel too.
- `--lan`, `--localhost` and `--host lan|localhost` are refused: the session cannot reach those addresses, and the run would report success with an app on an error screen.
- `--web` is refused: EAS Simulator has no browser, and `deploy` is the EAS command for the web.

[confirmed — Kudo, 2026-09-09] The launcher sets `EXPO_UNSTABLE_TUNNEL_V2=1` for every child, detached ones too, unless the variable is already set. `=0` opts out. It never turns on a tunnel that nobody asked for.

## The build is a simulator build

The `development` profile that `eas build:configure` writes is a signed device build; no simulator can install it [observed — eas-cli 23.2]. The EAS device route builds the `development-simulator` profile instead, with the three keys that `eas build:dev` uses: `developmentClient: true`, `distribution: "internal"`, `ios.simulator: true`.

- When `eas.json` lacks the profile, `dev` adds exactly those keys right before the build step and changes nothing else. When `eas.json` is missing, `dev` writes it with that one profile. The plan's reasons name the write first, because it is a project write outside a step.
- There is no `eas build:configure` on this route [Kudo, 2026-09-09]: its other output is unused, and it can prompt. It stays only on the route that builds on EAS for a local device.
- Only `ENOENT` means "no `eas.json`". A file that cannot be read or parsed, or whose root or `build` is not an object, stops the run before the build and stays as it was.
- Open question: should a local-device plan on a Mac also build for the simulator? It is out of scope here.

**Every `eas` argv is non-interactive** when the command accepts `--non-interactive`. Without it, `eas build` in a directory with no git repository asked to run `git init` on a stdin nobody reads, and stopped [observed — live, 2026-10-05]. `build:configure`, `simulator:exec` and `build:view` do not accept the flag [observed — eas-cli 24.10.0 manifest]. A device-profile build that needs credentials is expected to stop on the flag; that path has not run live.

## Reuse

A session installs a build by id, so a finished simulator build of this fingerprint on EAS is a build the run does not make. The lookup asks what `eas build:dev` asks: the **per-platform** fingerprint, profile `development-simulator`, status `finished`.

- Found: the plan is `dev-client-fresh` (or `bare-fresh`) on that build, with one step (the tunnelled dev server) and a reason that names the build.
- Not found, or not askable (no fingerprint tool, no runner, a refusal): the plan builds.
- Skipped when the project has not installed `expo-dev-client` yet, because that install changes the fingerprint.
- The last-build record and the app-presence probe of [[0004-smart-start-and-project-state]] §A current build is not an installed app are not used. Both are about a local device; a session started with `--build-id` has the app by construction.

`status` keeps its lookup for any finished build.

## The open is a session

The EAS open is armed on the `expo start` step like the local open ([[0026-dev-owns-the-open]]). The dev server owns the foreground; a failed open is a warning that names `navigate / --eas`. In order:

1. **A session this project already has** on this platform, in progress, is the device. It is asked first, so a running session needs no tunnel wait. `dev` opens the app on it the way `navigate --eas` does. The deep link waits until the dev server advertises its tunnel host; a link sent earlier names the loopback. A reused development client gets the launch URL of step 3, so a session kept across a Metro restart connects to the new tunnel. A session of this worktree on the other platform refuses the start, because a worktree owns one EAS session: the open starts and stops nothing and names `dev:stop --eas` ([[0035-one-device-per-worktree]] §One session per worktree).
2. **The tunnel.** `dev` asks the dev server's manifest for its advertised origin until it names a tunnel host, or the wait runs out. The manifest is the dev server's own account ([[0021-honest-reports]]).
3. **The launch URL**, from the same resolver `navigate` uses: `exp://<tunnel host>` for Expo Go, `<scheme>://?__expo_url=<origin>` for a development build.
4. **The session starts**: `eas simulator --platform <p> --type agent-device (--expo-go | --build-id <id>) --open-url <url> --non-interactive --name "<dir> — agent-cli dev"`.
   - `--open-url` prevents the "Open in Expo Go?" dialog on a device nobody is at.
   - No `--json`, so the EAS CLI writes `.env.eas-simulator`, and later `--eas` commands find the session.
   - The id is read from `Simulator session created (id: …)`, which prints before the readiness wait. A start that fails later still names the session it billed, and the warning says how to stop it.

A development build with no id is refused with the `eas build` that makes one. "The latest build" could be a device build or another person's build.

The `eas build` step runs with inherited output so its progress shows. After it, `dev` reads the build id from `build:list --build-profile development-simulator --status finished --limit 1`. When that names nothing, `dev` warns with the re-run; the next plan's lookup finds the build.

## Follow-ups

A `--eas` run's follow-ups aim at the session: `navigate / --eas`, `runtime:errors`, and `dev:stop --eas`. There is no phone rung and no cloud-build rung.

## smoke

`smoke --eas` brings its own environment on EAS, as it boots a simulator locally ([[0005-runtime-loop-tools]] §The run brings its own environment):

- The dev server starts through `dev --<platform> --detach --wait-ready --no-open --eas`. `--no-open` keeps the session start smoke's own act.
- The plan resolves with `deviceBackend: 'eas'`, so the build it names and its `installWith` match `dev --eas`.
- The **`start-session`** phase runs where the boot would. Expo Go starts with `--expo-go`. A development build needs a finished `development-simulator` build of this fingerprint on EAS; **smoke never compiles one**. It looks the build up only when no session is up, before the tunnel wait. No build fails the phase with a reason that names `dev --<platform> --eas`, and the run stops where a run with no device stops.
- The device probe finds the session by [[0035-one-device-per-worktree]] §Session binding, and the `app`, `reload`, `route` and `screenshot` phases drive it.

Session ownership [observed — regression tests, 2026-09-09]:

- Only the creation message identifies a new session. An overwrite warning that names an older session never selects the cleanup target.
- A session that smoke created belongs to the run, also when its readiness wait failed. The run ends it by id at the end. A session that was already up stays running.
- The `start-session` phase reports only creation. The environment summary reports the cleanup result.

### Attach the controller after a smoke session starts

[observed — SDK 57 on EAS iOS, 2026-09-09] `--open-url` launches the app but creates no `agent-device` controller session. Without one, a screenshot fails with `SESSION_NOT_FOUND`.

- A smoke run that started the session still does its normal app open, even when Metro already lists a debugger target. That open binds the controller. An app this run opened needs no extra reload.
- A reused session with an attached app keeps the usual reload check.
- When the cloud screenshot fails with `SESSION_NOT_FOUND`, smoke runs `agent-device open <app-id> --platform <p>` through `simulator:exec` and retries once. There is no `--relaunch`, so the app is not terminated. [not observed: whether that open keeps the current screen.]
- A skipped screenshot quotes the controller's `Error (CODE)` line and its `Hint`, never the EAS CLI update banner.

## dev:stop

`dev:stop --eas` also ends this worktree's sessions, chosen by [[0035-one-device-per-worktree]] §Session cleanup, **by id**. A bare `eas simulator:stop` ends the session the dotenv names, which can belong to another run.

- The result has `session: { id, stopped, reason, platform }`. `id: null` means the project has no session.
- Exit 20 means a session did not stop and still bills.
- Without `--eas`, the session is not touched. Ending a billed session is asked for by name.

### Stop hints

[confirmed — Kudo, 2026-09-09] `dev` progress and follow-ups name `agent-cli dev:stop --eas`, which stops the dev server and the session. Smoke says that it stops the sessions it creates after the run. An exact-id `eas simulator:stop --id` fits only a report about one session whose start or cleanup failed.

### The dev run owns sessions it creates

[confirmed — Kudo, 2026-09-09] When Metro exits, also on SIGINT or SIGTERM, `dev --eas` waits for its app open and stops the session it created, by id. A reused session stays running.

- A failed readiness wait that returns a created session gets the same cleanup.
- Signal handling stays installed until cleanup is done.
- An interrupt during creation waits for the bounded start to return a receipt, so no billed session is lost.
- `--detach` gives this lifetime to the child; the parent's return does not stop the session.

## What EAS said

For an unlinked project, the first line of the EAS CLI's refusal ends with "Run one of the following" and cuts off the two `eas init` forms. So every surface that quotes an `eas` refusal reads the whole output through one classifier, which returns a one-line `summary` and a `why`, `how` and `command`:

- the `status` build lookup;
- the session listing behind every `--eas` device command;
- a failed `eas` step of `dev`, which then names `eas init`, not the step that failed;
- `deploy`.

Output the classifier does not recognise keeps its first line.

The needs-human scenario `eas-project-unlinked` (`EAS_PROJECT_NOT_LINKED`) comes before the generic `eas-prompt` row. The refusal contains "cannot configure it in non-interactive mode", and the generic row read that as a waiting prompt. The handoff is exit 7, because the account a project belongs to is a person's decision ([[0007-deploy-and-headless]] §deploy). When the EAS CLI lists exactly one account, the classifier fills it in, and every surface hands over the same `eas init` line.

`eas init` and `eas *:configure` are not wrapped [Kudo, 2026-09-08]: they run once, they prompt, and the account is the person's choice. This CLI names them.

## Testing

| Contract                                               | Test                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Plan rows, profile write, lookup for the EAS device    | `src/plan/__tests__/decide-test.ts`, `resolveAsync-test.ts`, `src/utils/__tests__/easJson-test.ts` |
| Tunnel and the refusals                                | `src/dev/__tests__/resolveOptions-test.ts`                                                         |
| §The open is a session                                 | `src/dev/__tests__/openAppEas-test.ts`                                                             |
| §Check the EAS project before starting the environment | `e2e/__tests__/eas-preflight-test.ts`                                                              |
| `dev --eas` end to end: build, reuse, open, Expo Go    | `e2e/__tests__/dev-eas-test.ts`                                                                    |
| §The dev run owns sessions it creates                  | `e2e/__tests__/dev-eas-foreground-test.ts`                                                         |
| §smoke and session ownership                           | `src/smoke/__tests__/phases-test.ts`, `e2e/__tests__/smoke-test.ts`                                |
| §Attach the controller after a smoke session starts    | `src/device/__tests__/screenshot-test.ts`                                                          |
| §dev:stop                                              | `src/dev/__tests__/stopAsync-test.ts`, `e2e/__tests__/cloud-simulator-test.ts`                     |
| §What EAS said                                         | `src/utils/__tests__/easFailure-test.ts`, `src/needsHuman/__tests__/easProject-test.ts`            |
| On a real session                                      | `e2e-live/__tests__/live-cloud-test.ts`                                                            |

The e2e tier runs against the stub `eas` ([[0002-testing-and-evals]]). Its dev server advertises the tunnel host in the manifest only after the tunnel "comes up", as the real one does.

Live on `apps/eas-example`, `expo-ci` account, 2026-09-08 (eas-cli 23.2.0): `dev --ios --eas` built the simulator profile, then on a second pass reused that build, started a session with `--build-id` and the dev-launcher URL, and the dev server bundled the app. `smoke --ios --eas` against that session was inconclusive (no debugger target, exit 22), as [[0005-runtime-loop-tools]] §Cloud simulator records. `dev:stop --eas` ended the session by id.

One caveat from that run: the reuse rung took an in-progress session that a concurrent CI job had started, and that session refused the deep link. On a shared account, "a session of this project" can be another run's session. [[0035-one-device-per-worktree]] lists this among the problems it solves.

Not run live: `dev --android --eas`, and the `--expo-go` session start from `dev` (the `live-cloud` suite covers `--expo-go` alone).
