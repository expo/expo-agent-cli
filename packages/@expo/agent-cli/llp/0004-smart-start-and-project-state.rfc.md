# 0004: Smart start and the project-state engine

**Type:** RFC
**Status:** Active
**Systems:** project-state probe (`src/project/`); plan engine (`src/plan/`); smart `dev` (`src/dev/`); app presence on a device (`src/device/appPresence.ts`); `@expo/agent-cli status` (`src/status/`); dev-server lock (`src/devLock/`); `@expo/fingerprint`
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-20 · finalized 2026-08-28
**Revised:** 2026-11-16
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0002-testing-and-evals]], [[0005-runtime-loop-tools]], [[0008-guardrails]], [[0010-agent-conventions]], [[0011-impact-and-freshness]], [[0015-backend-selection-and-config]], [[0021-honest-reports]], [[0023-fingerprint-caching]], [[0026-dev-owns-the-open]], [[0027-everything-on-eas]], [[0035-one-device-per-worktree]]

## Summary

An agent that wants the app on a device must not decide when to prebuild, rebuild, install, or only start Metro. One engine answers "what must run to get this app on a device?". The smart `dev` runs the answer, `status` reports it, and `install` reports what a new package costs. `@expo/agent-cli start` is plain `expo start`.

The probe reads the project: is it an Expo app, are its dependencies installed, checked-in native directories versus CNG, `expo-dev-client`, Expo Go compatibility, and the `@expo/fingerprint` hash. The plan compares the hash with the build this CLI recorded (`.expo/agent-cli-last-build.json`). Per [[0001-agentic-cli-on-expo-cli]] §Constraints, the engine spawns `expo prebuild`, `expo run:*` and `expo start`; it never imports `@expo/cli`.

Decisions:

1. **One pure table.** The plan is a pure function of probed state. I/O (the toolchain, the device, EAS) happens before it, and its answers arrive as inputs.
2. **The plan is printed, then run unchanged.** `--plan` stops after the print; a plan with build steps still runs without a prompt ([[0008-guardrails]] §The plan is announced, not negotiated). The one exception is an EAS route that nothing asked for, which stops with `EAS_ROUTE_NOT_CHOSEN` ([[0015-backend-selection-and-config]] §The selection).
3. **One dev server per project, held by a lock.** The lock is a listening socket, so it cannot outlive its owner.
4. **A probe that cannot answer changes nothing.** An `unknown` device answer keeps the serve-only plan; an undecided fingerprint diff keeps the prebuild.

## Decision table

The first row that matches decides. `rule` is the plan's `rule` in `--json`.

| #   | `rule`                       | State                                                                                      | Steps                                                              |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 1   | `not-expo-app`               | `package.json` declares no `expo` (§Not an Expo app)                                       | none; `target: none`                                               |
| 2   | `dependencies-not-installed` | `expo` is declared, and no installed `expo` resolves (§Dependencies not installed)         | none; `target: none`                                               |
| 3   | `web`                        | `--web`                                                                                    | `expo start --web`                                                 |
| 4   | `bare-fresh`                 | a checked-in `ios/` or `android/`; the fingerprint matches the recorded build              | `expo start --dev-client`                                          |
| 5   | `bare-install`               | as 4, and the device answered `missing`                                                    | `expo run:<platform> --no-bundler`, then `expo start --dev-client` |
| 6   | `bare-stale`                 | a checked-in native directory; the fingerprint does not match                              | build: `expo run:<platform>`, or the EAS route                     |
| 7   | `dev-client-fresh`           | CNG with `expo-dev-client`; the fingerprint matches                                        | `expo start --dev-client`                                          |
| 8   | `dev-client-install`         | as 7, and the device answered `missing`                                                    | `expo run:<platform> --no-bundler`, then `expo start --dev-client` |
| 9   | `dev-client-stale`           | as 7, the fingerprint moved, and a source `prebuild` writes from moved, or nobody can tell | prebuild, then build                                               |
| 10  | `dev-client-rebuild`         | as 7, the fingerprint moved, and nothing `prebuild` writes from moved                      | build, no prebuild                                                 |
| 11  | `expo-go`                    | no `expo-dev-client`; Expo Go compatible; the run target is not `dev-build`                | `expo start --go`                                                  |
| 12  | `needs-dev-client`           | everything else                                                                            | `expo install expo-dev-client`, prebuild, build                    |

On an EAS device, a stale row whose fingerprint EAS already has a finished simulator build for plans `*-fresh` instead, and the session installs that build ([[0027-everything-on-eas]] §Reuse). The local route builds with `expo run:<platform>`; the EAS route is `eas build` then `expo start --dev-client`, with no prebuild, and with `eas build:configure` first when the project has no `eas.json` and the device is not on EAS ([[0015-backend-selection-and-config]]).

"Checked-in" means present and not gitignored: `expo prebuild` writes `ios/` and `android/` that the template `.gitignore` covers, and those are still CNG. Freshness is the probe's fingerprint against `.expo/agent-cli-last-build.json`, per platform. A build is recorded when the app reaches the device (the `› Installing` line of `@expo/cli`), whatever the launch then does; the recorded hash is the probe's hash from before the build. An unrecorded project is stale, so the table over-plans a build at worst.

### A current build is not an installed app

A fingerprint that matches the recorded build proves the build is current. It does not say the device has it: the simulator may have been wiped, or EAS made the build. So rows 5 and 8 ask the device. The install step is `expo run:<platform> --no-bundler`, the command `smoke` installs a development build with; the Expo CLI owns "compile what is missing, install, launch" ([[0001-agentic-cli-on-expo-cli]] constraint 4). `--no-bundler` because the dev server is the next step.

The answer is `present`, `missing` or `unknown`. **Only `missing` moves a plan.** `unknown` is what a machine with no bound device answers, and a config with no app id, a platform tool that would not run, and an 8 s deadline that expired; all of them plan what the table planned without the question. A device this run just created or spawned is `missing` without asking. `AGENT_CLI_NO_DEVICE` answers `unknown` without spawning. A false `missing` costs an install; a false `present` leaves a dev server with no app.

The question is asked only where the answer is acted on:

- Only a serving draft: a plan that builds ends in `expo run:*`, which installs what it built. `expo-go`, `web` and the two empty rows have no development build to look for.
- Only a run that opens the app: a typed `--ios` or `--android`, and not `--no-open`. `smoke` spawns `dev --no-open` and installs in its own phase. `status` passes no typed platform, so it never asks.
- Only a local device and a local build backend: a caller who routed builds to EAS did not ask for a local compile. On `missing`, a machine without the platform toolchain keeps the serve-only plan.

The install step is pinned to the bound device with `--device` before the plan is printed. A non-zero exit after output that shows the app reached the device is a warning, not a stopped plan: the launch can fail on the macOS Automation grant that the install does not need. The plan runner treats the `--no-bundler` step as a build step, not a dev-server step.

### A stale build is two questions

"Something moved" and "what moved" are two questions; the hash answers only the first. Row 10 exists for a fingerprint that moved without changing anything `prebuild` writes from, such as an `eas.json` edit or a `package.json` `scripts` entry: a prebuild there writes the same `ios/` again.

The split reuses the change classifier of [[0011-impact-and-freshness]]; it is not a second one. Each change kind says whether it needs a prebuild (`src/impact/classify.ts`): a config plugin, the app config, a native-module change, and an unknown kind do; the native project, build config and build scripts do not. The comparison diffs the `sources` on the recorded build against the probe's, in process, with no second fingerprint run.

- **A module that enters or leaves `node_modules` needs no prebuild.** `prebuild` writes from the template, the app config and the config plugins it applies, and a new dependency is none of them. A package that needs generated code ships a config plugin and is named in the app config, and both move their own sources. `expo run:ios` runs `pod install` when the dependency list moved, and Gradle autolinks at configure time.
- **`expo` itself is the exception.** The installed `expo` selects the prebuild template, so an added or removed `expo` plans a prebuild. A `changed` native module (an SDK upgrade moves every module's contents) also plans one.
- **Undecided means prebuild.** A record with no `sources`, a fingerprint run that returned none, and a hash that moved over an empty diff all keep row 9. Being wrong toward prebuild costs a minute; being wrong the other way builds without the change.

Bare rows never prebuild: their native directories are checked in, and a prebuild would overwrite the change.

## Not an Expo app

A directory whose `package.json` declares no `expo` dependency is not an Expo app. No command may plan work that would change it without saying so first. The guard reads the declaration, not `node_modules`, so a fresh clone is still an Expo app (§Dependencies not installed). `react-native` without `expo` gets the same answer.

| Command                                                 | In a directory that is not an Expo app                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `dev`, `start`, `smoke`, `navigate`, `deploy`, `doctor` | stop with `NOT_EXPO_APP`, exit 1, before planning or spawning                  |
| `skills:sync` / `:list` / `:show`                       | stop the same way; they read what the installed Expo packages ship             |
| `agents:setup`                                          | offers the confirmed user-home plugin and skills install; skips project phases |
| `status`                                                | reports `project.isExpoApp: false` and a `next` that says so; never refuses    |
| `typecheck`                                             | unchanged: `checked: false`, "no TypeScript", exit 0                           |
| `install`, `new`                                        | unchanged: they are the two ways out of this state                             |
| `dev:stop`, `dev:logs`, `skills:clean`                  | unchanged: they clean up what is here                                          |
| `runtime:*`                                             | unchanged: they need a live dev server, which the rows above deny              |
| `login` / `logout` / `whoami` / `register`              | unchanged: they act on `~/.expo`                                               |

`status` is how a caller finds out it is in the wrong place, so it reports instead of refusing. `doctor` stops, because `passed: 0, failed: 0` reads as a clean bill of health for a repository nothing checked. The stop's `Try:` line is `npx @expo/agent-cli new my-app`, the recovery that changes nothing here; `install expo` stays in the `How:` prose, because it writes into a repository the caller may only have walked past.

## Dependencies not installed

An Expo app whose `expo` package does not resolve from the project root or any directory above it has no installed dependencies: a fresh clone or a new worktree. Every other row reads `expo-dev-client` and the fingerprint from `node_modules`, and would plan `expo install expo-dev-client` and a native build the project may not need, on `--eas` at EAS cost.

| Command                                                                              | When the dependencies are not installed                                            |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `dev` (also `--plan`), `start`, `smoke`, `deploy`, `doctor`, `skills` except `clean` | stop with `DEPENDENCIES_NOT_INSTALLED`, exit 1, after a bad flag, before any spawn |
| `status`                                                                             | reports; `next` and the one follow-up are the bare install                         |
| `install` with no arguments                                                          | installs the lockfile ([[0010-agent-conventions]] §Forwarded codes)                |
| every other `install`                                                                | stops with `DEPENDENCIES_NOT_INSTALLED`                                            |

A bad flag is named first, because it is wrong on any machine. `navigate` needs a running dev server, and its own stop says there is none. `skills:clean` and `dev:stop` run in this state. The `Try:` line of each stop, and the `next` of `status`, is `npx @expo/agent-cli install`. The `status` project line says `dependencies not installed`, and `next.rule` is `dependencies-not-installed` with no steps and no build location. A directory that is not an Expo app reports `dependenciesInstalled: null`.

## Plan contract

`dev` emits the plan first as a structured event (steps, reasons, time classes), then runs it and streams JSONL progress. `--plan` stops after the plan, so a driving agent can present it ([[0008-guardrails]]). Every other run proceeds, build steps included; the steps never change between the print and the run.

A step's `reason` describes the step, not the goal: it is what a driving agent reads before it acts. The plan takes `requestedPlatform` (the flag the caller typed) apart from `platform` (always resolved). Native platform flags never appear in a step's argv and never reach `expo start`: `dev` opens the app itself ([[0026-dev-owns-the-open]]). With a typed flag the reason says the app is opened on that device; without one it says nothing opens and names `@expo/agent-cli navigate /`. The plan's `reasons` are written per rule, because the honest sentence depends on what the plan does with the platform. A follow-up that opens the app names `navigate /` first.

## Sub-features

**Expo Go compatibility.** "Can this run in Expo Go?", with reasons. Native modules are compared with a vendored autolink dump of `apps/expo-go` per SDK major (`src/project/expoGoNativeModules.json`). An SDK with no dump falls back to the project's `expo/bundledNativeModules.json`, so a new Expo release does not wait on this CLI; on SDK 57 and newer the fallback also accepts `@expo/log-box` and `expo-modules-jsi`, two internal runtime modules the catalog omits. A captured dump always decides membership. Config plugins use the catalog, optimistically for `expo-build-properties`. `custom-native-code` is a checked-in native directory; packages under `./modules` are `unbundled-native-module`. Recapture with `scripts/capture-expo-go-modules.mjs --expo <expo/expo>`.

**Post-install impact.** After `npx expo install <pkg>`, a JS-only package keeps the dev server; a config plugin or native module under CNG needs a prebuild and a new development build; checked-in native directories need a pod install or Gradle sync (`src/project/impact.ts`). The working-tree change classifier is [[0011-impact-and-freshness]].

## Status

`@expo/agent-cli status` is a `git status` for the project: one fast, read-only command that answers "where is this project now, and what happens next". Text sections by default; `--json` for the machine shape, with the raw probe under `probe`. It exits 0, because it reports and does not judge; argument errors exit 1, and `--assert` turns it into a gate ([[0011-impact-and-freshness]]). It starts nothing. Its device reads share one deadline (§Reported by status), and its dev-server probes and EAS calls have their own. The probe's fingerprint run and the `expo config` of the OTA verdict have none (§Risks).

| Section    | Says                                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project    | name or slug, SDK version, CNG or bare, dev-client and web dependencies, `isExpoApp`, `dependenciesInstalled`                                                                      |
| Expo Go    | compatible or not, with a reason count; the reasons are in `probe`                                                                                                                 |
| Freshness  | the fingerprint against the recorded build per platform (`fresh`, `stale`, `unknown`), the impact class of what changed since, and the OTA verdict ([[0011-impact-and-freshness]]) |
| EAS build  | whether EAS has a finished build of this fingerprint per platform (`found`, `none`, `unknown`); a project not linked to EAS is never asked ([[0011-impact-and-freshness]])         |
| Installed  | §Reported by status                                                                                                                                                                |
| Auth       | the EAS login, per `eas whoami`                                                                                                                                                    |
| Dev server | running or not, the connected apps, and `hostType` and `tunnelUrl` in `--json`; the text names a tunnel only                                                                       |
| Skills     | whether the agent selection is cached, and linked against discovered skills; hidden from the text when there is nothing to say, always in `--json`                                 |
| Device     | the bound simulator or an attached device: `present`, `absent` or `unknown`; `unknown` is never rounded down to "none"                                                             |
| Next       | one line: what to run now                                                                                                                                                          |

**Next.** The first row that matches decides. `next` never repeats a follow-up.

| #   | State                                                                                  | `next`                                                                                                            |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | not an Expo app, or the dependencies are not installed                                 | `new my-app`, or the bare `install`                                                                               |
| 2   | this project's lock says `building` or `finishing`                                     | the Next command of that phase (§Dev-server lock)                                                                 |
| 3   | the dev server's owner ended (below), and this worktree has a `started` cloud binding  | `dev:stop --eas`                                                                                                  |
| 4a  | a usable dev server answers; an EAS session is on record; no local device is `present` | `smoke --<platform> --eas` with an app connected, else `navigate / --<platform> --eas`                            |
| 4b  | a usable dev server answers; an app is connected                                       | `smoke`                                                                                                           |
| 4c  | a usable dev server answers; no app is connected; the local device is `absent`         | the one URL that opens the app on a device elsewhere, or `navigate / --print-url` when no single URL can be named |
| 4d  | a usable dev server answers; no app is connected                                       | `navigate /`                                                                                                      |
| 5   | no usable dev server                                                                   | `dev`, with the smart-start rule that would fire                                                                  |

A usable dev server is one that runs and does not answer for another project. A device probe that could not run (`unknown`) never turns `navigate /` into a URL. Two device states then replace rows ([[0035-one-device-per-worktree]] §Lifecycle output). An expired lease on this worktree's EAS session replaces rows 4 and 5 with `dev --<platform> --eas --detach --wait-ready`. A worktree with no live binding and no cloud binding replaces rows 4c, 4d and 5 with the `dev` that binds a device, after `dev:stop` when a running server must restart; this needs a host that can bind the platform. Beside this project's own EAS dev server for the platform it also replaces row 4b, on any host, and the command adds no `--port`.

**A server with no owner.** When `status` finds the untracked dev server a killed run left (§Daemonization; `status` only reads), the dev-server line says its CLI process ended (`ownerEnded: true`). With no lock, `status` takes the tunnel from the server's manifest, not from the captured log. When the log names a tunnel the manifest does not, the line says `tunnel unknown`, `tunnelUrl` is null, and no open link is built.

## Discovery ladder

Every command that needs the dev server finds it by one ladder. Every step probes; none trusts. The result names its step as `source`.

| #   | Step                                           | `source`  | Proves                                                       |
| --- | ---------------------------------------------- | --------- | ------------------------------------------------------------ |
| 0   | An explicit `--dev-server-url` or `--port`     | `flag`    | the caller named it; nothing else is tried                   |
| 1   | The project's dev-server lock                  | `lock`    | an `@expo/agent-cli` wrapper is alive, and its URL answered  |
| 2   | The port `.expo/dev/logs/start.log` last named | `log`     | this project started a server there once, and it answers now |
| 3   | 8081                                           | `default` | Metro's default answered                                     |
| 4   | 8082-8085, in parallel                         | `scan`    | a Metro answered; not that it is this project's              |

- Steps 1 to 4 read the project root that `/status` names, by the rule in §A busy port. A server of another project is skipped; a lock whose port another project answers is a miss, and the ladder goes on.
- A `/status` that does not answer within 3 s proves nothing and is not accepted; a socket error gets one retry.
- The lock proves a live server of this project, so the probe of its URL gets the same 3 s. The port steps probe with 800 ms by default.
- The scan prefers a server with listed debugger targets, then port order. A server with no targets is still a running server.
- No step is skipped for speed: an `expo start` run by hand holds no lock, and a cleaned `.expo` names no port. `default` is also the source when nothing answered, because the error still needs a URL.
- An explicit URL gets no timeout of its own, because a tunnel may be slow; the caller's signal stops it.
- Every probe timer is cleared, so a finished command exits at once.

`status` is a report with a deadline: 1.5 s per request and 3 s for the ladder. At the deadline it keeps the best server accepted so far, cancels the rest, and accepts nothing later. When the last `dev` request recorded a port, `status` asks the lock or that port directly and reports `lock` or `last-request`. `dev:stop` reads the lock and never enters the ladder.

## Dev-server lock

`@expo/agent-cli start` holds the project's lock while its dev server runs. A `dev` run whose plan serves holds one lock from its first step until the run ends. A run with an EAS open lets go earlier: at Metro's exit when the open has returned, or when the open returns after Metro exited. A plan that serves nothing takes no lock.

The lock is a listening socket, not a file. A file outlives its process; a socket answers only while its owner lives.

**Address.** A pure function of the project root: `<projectRoot>/.expo/agent-cli-dev-server.sock` on posix, `\\.\pipe\agent-cli-dev-server-<sha1(lowercase(realpath(projectRoot)))[0:16]>` on Windows. Symlinks are resolved and the path is lowercased before the hash, so one directory has one address. A posix path longer than 100 characters (the kernels cap `sun_path` at 104 or 108) moves to the same digest name under the temporary directory.

**Protocol.** On each connection the server writes one JSON line and ends it: `url`, `port`, `pid`, `startedAt`, `projectRoot`, `easPlatform`, `easOpenFinished`, `phase`, `portReported`. The line is a projection of the one run state of the transition table below: `phase` is its phase, `easOpenFinished` is true when its EAS open is `returned` (bound or failed), and `portReported` is true when the port came from Metro's report. `easPlatform` is the platform of the run's EAS device, or null; only a run with one starts an EAS open. `finishing` never comes with `easOpenFinished: true`. A reader waits up to 2 s and reads the first line; a refused connection or a timeout is "no dev server". A line from an older writer reads `easPlatform` as null, `easOpenFinished` and `portReported` as false, and `phase` as `serving`.

**Phase.** The lock says what its run does now, so a reader does not infer it. A reader adds one name, `starting`, which is never on the wire.

| `phase`     | The run                                                                                                                                 | `url` and `port`                      | Next command         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------- |
| `building`  | runs a step before its dev-server step (`eas build`, an install, a prebuild), or an `expo run:*` step whose `/status` has not answered  | the planned port; nothing listens yet | `dev:logs`           |
| `serving`   | runs its dev-server step: `expo start` from its spawn, `expo run:*` once `/status` answers for this project                             | the dev server                        | `smoke --<platform>` |
| `starting`  | the lock says `serving`, and `/status` does not answer for this project yet: Metro is not up, or another project's Metro holds the port | the dev server's port                 | `status`             |
| `finishing` | its dev-server step exited, and its EAS open has not returned                                                                           | the last port; nothing listens        | `dev:stop --eas`     |

`start` always answers `serving`. `startedAt` is the start of the run, or the spawn of the step that holds the lock, renewed at a port retry. The `DEV_SERVER_RUNNING` refusal (§A busy port) carries this four-value phase as `error.data.phase` and names the Next command in its How; `devServerPort.phase` under `--plan` carries it too. `status` names the Next command for `building` and `finishing` (§Status).

**Transitions.** One writer changes the lock, and one pure table decides each change. The run's state is its phase, `unlocked` (no lock: before the take, after a foreign port, or when the take failed), or `released`, together with its EAS open (`none`, `running`, `returned`). A cell names the state after the event.

| state \ event      | published(p) | foreign port      | Metro reports a port | `/status` answers | EAS open starts   | EAS open returns   | Metro exits        | run ends |
| ------------------ | ------------ | ----------------- | -------------------- | ----------------- | ----------------- | ------------------ | ------------------ | -------- |
| unlocked, none     | p, none      | unchanged         | unchanged            | unchanged         | unlocked, running | illegal            | unchanged          | released |
| unlocked, running  | p, running   | unchanged         | unchanged            | unchanged         | illegal           | unlocked, returned | unchanged          | released |
| unlocked, returned | p, returned  | unchanged         | unchanged            | unchanged         | illegal           | illegal            | unchanged          | released |
| building, none     | p, none      | unlocked, release | new port             | serving, none     | building, running | illegal            | unchanged          | released |
| building, running  | p, running   | unlocked, release | new port             | serving, running  | illegal           | building, returned | finishing, running | released |
| building, returned | p, returned  | unlocked, release | new port             | serving, returned | illegal           | illegal            | released           | released |
| serving, none      | p, none      | unlocked, release | new port             | unchanged         | serving, running  | illegal            | unchanged          | released |
| serving, running   | p, running   | unlocked, release | new port             | unchanged         | illegal           | serving, returned  | finishing, running | released |
| serving, returned  | p, returned  | unlocked, release | new port             | unchanged         | illegal           | illegal            | released           | released |
| finishing, running | illegal      | illegal           | new port             | unchanged         | illegal           | released           | illegal            | released |
| released           | illegal      | unchanged         | unchanged            | unchanged         | unchanged         | unchanged          | unchanged          | released |

`published` is the take before a build step, a dev-server spawn, or a busy-port retry. When Metro exits with no EAS open, the lock keeps its phase, because a busy-port retry may follow on the same lock. A run makes no busy-port retry after any open starts, local or on EAS. An illegal pair changes nothing and emits `cli:dev_lock_illegal_transition`; the lock is never the reason a run fails.

**Readers.**

| Reader                                              | `building`                                                                                                                                                                        | `serving`                                                            | `finishing`                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `dev:stop`                                          | signals the pid; the run stops before its next step                                                                                                                               | signals the pid, waits for it and the lock to go, or for `finishing` | no signal; reports the dev server stopped and the pid alive; its follow-up is `dev:stop --eas` |
| `dev --detach` parent, and an EAS or `smoke` re-run | reports the run at once, `phase: "building"`; with `--wait-ready` waits, and at the deadline exits 22 `DEV_DETACH_STILL_BUILDING`. A local re-run stops with `DEV_SERVER_RUNNING` | §Daemonization                                                       | refuses: the run still binds a session                                                         |
| foreground `dev`                                    | stops with `DEV_SERVER_RUNNING`, worded for the phase                                                                                                                             | same                                                                 | same                                                                                           |

**Acquisition and release.** On posix, `EADDRINUSE` is a live owner or an orphaned socket file; only a connection tells them apart, and an orphan is unlinked before the next listen. On Windows a pipe dies with its process, so `EADDRINUSE` is a live owner. The run releases the lock when it ends and on process exit.

**Never load-bearing.** A lock another process holds emits `cli:dev_lock_skipped` with reason `in-use` and no warning; any other failure to take it warns once with reason `error`. Neither fails the run.

**Which port the lock names.** With `--port` in the arguments, the lock names that port at the spawn: `dev` passes `--port` on every serving step, and the Expo CLI binds it or exits. With none, it names the port the dev server reports, else 8081. The report is Metro's `metro:instantiate` event in this process's `2g` event log (its session, or its `LOG_EVENTS` file); a later report updates the lock and sets `portReported`. A log this process cannot read back (a file descriptor, or a `2g` parent over IPC) gives no report, and the lock keeps its port after the watch's 20 s. A port whose `/status` names another project root is never published (`cli:dev_lock_skipped`, reason `foreign-port`), and a `dev` run releases a `building` lock in that case.

The lock proves the wrapper is alive; only an HTTP probe of its URL proves the dev server is. A dev server started with `expo start` directly holds no lock, so discovery still needs the log and the scan (§Discovery ladder).

## Daemonization

`@expo/agent-cli dev --detach [--wait-ready]` starts the run in a process of its own and gives the terminal back. `dev:logs` reads what it printed.

**The child is this CLI, not `expo start`.** The wrapper takes the lock; a detached server with no lock is a process nothing can find, wait on, or stop. `--detach`, `--wait-ready` and `--json` are stripped from the child's command line. The child gets no `2g` IPC variables, because it outlives the parent; it writes to the parent's `LOG_EVENTS` file when there is one, and opens its own `2g` session otherwise.

**The parent waits for the lock, not for the child.** A detached start is finished when the child's lock answers. With `--wait-ready` the parent also waits until `/status` answers for this project; a port change moves the wait to the new URL within the same budget, and another project's answer never ends it. Without the flag `ready` is `null`. The budget is 120 s (`AGENT_CLI_DETACH_TIMEOUT_MS` overrides it).

A new detached run prints the absolute live log path and resolved plan on stderr. With `--wait-ready`,
it announces native work before the build and reports the Metro readiness wait when Metro reports its
port or starts serving. The iOS and Android cases in `dev-detach-test` observe both messages before
letting Metro answer `/status`.

**One dev server per project.** A local `dev --detach` beside a live lock stops as a foreground `dev` does (§A busy port). A detached run whose device is on EAS goes on to the running server and opens its session there ([[0035-one-device-per-worktree]] §Preserved sessions), and `smoke`'s bootstrap reuses the running server. Reuse adds no wait for the app to open. A lock that another run takes after the parent's read is not the child's: the parent compares the lock's pid with the child's, and relays the child's `DEV_SERVER_RUNNING` refusal.

**A run that builds says so.** A detached run never says "the dev server started" while the plan compiles; the lock's `phase` is the one source ([[0021-honest-reports]]). Without `--wait-ready`, the parent reports its child as soon as the lock says `building`: exit 0, `phase: "building"`, the pid and the URL the dev server will take. With `--wait-ready` it waits, and at the deadline, with the child alive and still `building`, it exits 22 `DEV_DETACH_STILL_BUILDING` with the pid, the log file, and the same command as the next step. An EAS or `smoke` re-run beside a `building` lock spawns nothing: it reports that run, or follows it with the same wait and the same 22. A local re-run stops with `DEV_SERVER_RUNNING`, exit 20, and names `dev:logs`.

| `dev --detach` ends with                                                                                                                                                          | Code                                          | Exit                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------ |
| a first start; an EAS or `smoke` reuse; a build without `--wait-ready`                                                                                                            | none                                          | 0                        |
| a live lock on a local run, or a `finishing` lock on any run                                                                                                                      | `DEV_SERVER_RUNNING`                          | 20                       |
| the child exited, or its dev server stopped answering, after its lock answered                                                                                                    | `DEV_DETACH_DIED`, `DEV_DETACH_NOT_ANSWERING` | 20                       |
| the child stopped at a step only a person can do                                                                                                                                  | `DEV_DETACH_NEEDS_HUMAN`                      | 7; 1 for an unknown step |
| the child never published a lock; a followed run ended in its build (How: `dev:logs`); the dev server exited while the run finishes its EAS session start (How: `dev:stop --eas`) | `DEV_DETACH_FAILED`                           | 1                        |
| `--wait-ready` gave up on a serving dev server, which still runs                                                                                                                  | `DEV_DETACH_NOT_READY`                        | 1                        |
| `--wait-ready` ended while the run builds                                                                                                                                         | `DEV_DETACH_STILL_BUILDING`                   | 22                       |
| `--wait-ready --eas` ended before the session is bound                                                                                                                            | `DEV_DETACH_SESSION_PENDING`                  | 22                       |

A device error of the child is relayed unchanged, and the parent's own session refusals keep their codes ([[0035-one-device-per-worktree]] §Output and errors). The How of a 22 names the same command again, with no `--port` the caller did not type: an EAS re-run finds the run through its log and the lock.

**Stopping.** A run stops on SIGINT or SIGTERM between steps: the running step gets the signal, no later step starts, and the run exits 130 or 143. So a plain `dev:stop` stops a `building` run and no dev server starts after it. An `eas build` already submitted keeps running on EAS; `eas build:cancel` ends it.

**The log.** One file per project, truncated per run: `.expo/dev/logs/dev-detached.log`. Line 1 is `Detached dev run, pid <n>.`; only line 1 is read for the pid, so later output cannot fake it. `dev:logs` has no `--follow`, because a tail that never returns is what `--detach` avoids. It prints the last 100 lines by default, ANSI stripped, fenced as untrusted ([[0008-guardrails]]). It exits 1 `NO_DEV_LOG` when the project has no log; a dev server started attached has none.

**A killed run leaves an untracked dev server.** `SIGKILL` on the run leaves its Metro with no lock. Beside the lock, the holder keeps a run record, `.expo/agent-cli-dev-run.json` (its pid, the port, and the pid listening there). It is written once the dev server reported its port and removed with the lock, or by the `dev:stop` that stops the run through its lock (a Windows stop ends the holder without its cleanup). So it outlives its run only when the run died without cleanup. A dev server is untracked when four things hold: no lock answers, the record's run pid is gone (a zombie counts as gone), the only process listening on the record's port is the one the record names, and its `/status` names this project's root. A pid names one process; a port can be taken again. So a server a person started is never untracked, even on a dead run's port. A run killed before its dev server reported left no record. Reading the record changes nothing; `dev:stop` and a `dev` run (not `--plan`, not `status`) remove a record whose port answers for another process, another project, or not at all. A record whose listener pid still listens is kept, and so is one whose `/status` timed out.

| Server on the port                        | `dev:stop`                                                                          | `dev`                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| a lock answers for it                     | stops it                                                                            | stops on the lock                                       |
| left by a killed run (record + `/status`) | with no `--port` or the record's port: stops it; `untracked: true`, `forced: false` | stops it and takes its port (§A busy port)              |
| any other, this project's root or not     | reports it; `--force` stops it                                                      | moves to the next port; `--port` on it is `PORT_IN_USE` |

There is one record per project. A later run that serves elsewhere without stopping the orphan writes over its record, and that orphan then needs `--force`. One record per port, and refusing to start beside an orphan, were rejected: the case is rare, and losing the proof can only spare a server, never stop the wrong one.

When no lock answers and no untracked server is found, `dev:stop --json` reports `stopped: false`, `reason: 'not-running'`. The text says `Dev server not running` for a `--port` where nothing listens; with no `--port` it says what was checked and to pass `--port`.

## A busy port

**One dev server per project.** A live lock of this project stops a foreground `dev` and a local `dev --detach` with `DEV_SERVER_RUNNING`, exit 20. A second server could not hold the lock, so `status` and `dev:stop` could not see it. The stop runs after the command's own refusals (`BAD_ARGS`, `NOT_EXPO_APP`) and before the project probe, the plan, the port probe and the device: a stopped run binds no device and records no last request ([[0035-one-device-per-worktree]] §Lifecycle output). The error carries `{ port, pid, phase }` as `error.data`. Its wording and its How follow the phase, by the Phase table of §Dev-server lock.

The How never names the `dev` that just stopped; `dev:stop`, then the same command, is the other way out. The smoke platform is a device platform: a `--web` caller gets the project's default. `smoke` reuses the running server and does not rebuild, so after a native change the way out is `dev:stop`, then `dev`.

Under `--plan` the probe and the resolver still run, but the plan lists no steps and a reason says why. `devServerPort` is `{ port, movedFrom: null, state: 'running', phase }`, the plan says nothing about a device, and its one follow-up is the command the error's How names. The plain `start` wrapper allows a second server and reports `cli:dev_lock_skipped`.

**The port is resolved before the plan runs.** It is the named `--port`, or the first port from 8081 (`RCT_METRO_PORT` when set) that binds on the unspecified address and on `127.0.0.1`. The probe is a copy of Expo's own, so this CLI and the dev server agree on which port is free. The port goes as `--port` to `expo start` and to every `expo run:*` that serves, because `expo run:*` left to ask skips its dev server on a busy port, deep-links the app to whatever holds the port, and exits 0. The plan reports it as `devServerPort`, whose `state` is `picked` (with `movedFrom`), `named` (with `taken` when it cannot be bound), or `running`.

**A named `--port` is a requirement.** A busy named port is `PORT_IN_USE`, exit 20; moving would break every URL the caller already wrote. The message names the pid on the port and recovers into `dev:stop --port <n> --force`, or a free port. A busy port with no live lock of this project behind it is busy whoever holds it, an `npx expo start` of this project included: an unnamed port moves to the next free one. This is not a needs-human: no account, permission or click is involved. A foreground run reads the lock once. A server that takes the lock and the port after that read is a holder like any other: the serving step reports `cli:dev_lock_skipped` with reason `in-use`, the retry moves this run, and a named `--port` is `PORT_IN_USE`.

**One retry.** The pre-resolved port is a hint, and the retry is the guarantee: two worktrees can pick the same free port at once. When the serving step's output shows a collision on the step's own port (the Expo CLI's `Use port … instead?` and `Port <n> is …` lines, Metro's `listen EADDRINUSE`, or the `became busy … while the app was compiling` stop), `dev` picks a free port and runs the step once more. The check runs whatever the exit code, because `expo run:*` exits 0 after it skipped its dev server. A bare `Skipping dev server` is the Expo CLI reusing this project's own server, and the step succeeded. A dev server that reported or logged its port bound it, so its output is not scanned. No plan has two dev-server steps, so this is one retry per plan. A collision still present after the retry, or a collision with no free port left to retry on, stops the run with `PORT_TAKEN_AFTER_RETRY`, exit 20. The message names the port the step asked for, the port the retry lost, the pid on it, and the Expo CLI's exit code. Its How is the caller's own command with a free `--port`; with no free port it is `dev:stop --port <n> --force` when the holder answers as an Expo dev server, else the holder to stop.

**The untracked dev server is the one exception** (§Daemonization). A `dev` run whose plan serves stops it by its pid and takes its port, with a warning that names the port and the pid. When its port still answers after the stop, the run does not take that port: it picks again, and a named `--port` on it is `PORT_IN_USE`. Reusing it was rejected: no lock names its pid, so nothing can follow or stop it, and its tunnel is not known. Leaving it was rejected: that is two servers for one project. A run that refuses or serves nothing leaves it serving, and `--plan` stops nothing; a reason names the server. When the stop fails and the run would take that port, the run stops with `UNTRACKED_DEV_SERVER`, exit 20, and recovers into `dev:stop --port <n> --signal SIGKILL`; a run on another `--port` warns and goes on.

**Whose server is on a port.** A server is this project's unless `/status` names another project root in the `X-React-Native-Project-Root` header. No header, or a root that contains this project (a monorepo Metro), is this project's; a sibling is not. A containing root counts only in the same checkout: no directory from the project up to that root, the root excluded, holds a `.git` entry. So the main checkout's Metro never answers for a worktree inside it. Every consumer of `/status` reads this one rule, discovery's lock step included. An open aimed at a named port waits until `/status` answers there for this project; another project's answer does not end the wait.

**A `--detach` run moves in the child.** The lock is published at the spawn, before Metro binds. So the parent reports the port once the lock answers `portReported: true`, or 20 s after the lock's `startedAt`. A lock on a port other than the plan's is `portMoved`. The move message the child prints is for a person and carries no protocol.

## Where a build runs

Every build this CLI plans, suggests, or waits on says where it runs: `local` on this machine, or `eas`. The probe, the vocabulary and the selection live in [[0015-backend-selection-and-config]]. Selection happens while the plan is decided, so a machine that cannot build gets `eas build` in the plan's steps, and the steps never change between the print and the run.

## Implemented in v1

How the engine differs from an ideal table:

1. **The device is asked one question.** The plan asks whether the development build is installed, only as §A current build is not an installed app says. It never asks whether Expo Go is installed; `dev`'s open installs it.
2. **The build cache is consulted only on EAS.** For a local device, freshness is the last-build record alone, so `dev` plans a build even when EAS has one for the fingerprint. For an EAS device, a finished EAS build is reused ([[0027-everything-on-eas]] §Reuse). `status` consults the cache too ([[0011-impact-and-freshness]]).
3. **`web` fires only on an explicit `--web`.** The probe cannot prove "web-only".
4. **One reader for the app config.** Every value the probe, the plan, `dev` and `status` read from the app config (scheme, slug, app id, plugins, router root, EAS project id) comes from one in-process reader: a static file as written, and a dynamic `app.config.js/ts` evaluated with `@expo/config` in `development` mode after the env files are loaded ([[0005-runtime-loop-tools]] §Pointing an app at this dev server). No config plugin runs, so a plugin that is not installed does not fail the read. One command evaluates a dynamic config once per project, and again when the static file changes. A dynamic config that fails to evaluate keeps the static values and reports why; its plugins and router root are unknown, so Expo Go gets an `unknown-app-config` reason and the route check is skipped. Three readers spawn `expo config` instead, because config plugins can change what they read: `runtimeVersion` ([[0011-impact-and-freshness]]), `inspect:config-plugins` (introspect), and the EAS project preflight. The fingerprint's asset sources read the static file only ([[0023-fingerprint-caching]]). `sdkVersion: null` never forces a rule.

<!-- installed-app-check -->

## Installed-app fingerprint check

The freshness record says what the last build this CLI ran was made from. It does not say what is on the device: a build from EAS or Xcode, a wiped simulator, and a phone with last week's build are all invisible to it. The check asks the device. A debug build on SDK 58 or later carries the fingerprint it was built from (`expo-constants` embeds it). The check reads that file from the installed app ([[0005-runtime-loop-tools]] §Installed-app fingerprint check), computes the project fingerprint for the same platform with the wrapper `status` and `dev` use, and compares the hashes. The check lives in this CLI; the embed and the dev-launcher responder live in expo/expo, and `@expo/cli` is not touched.

### What the answer is

One verdict per platform:

| Reason                                                                                                                                                       | Status             | `commands`                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------ |
| `hash-match`                                                                                                                                                 | `up-to-date`       | none                                                                                       |
| `hash-mismatch`                                                                                                                                              | `rebuild-required` | `npx expo run:<platform>`                                                                  |
| `fingerprint-version-mismatch`                                                                                                                               | `unknown`          | none                                                                                       |
| `embed-unsupported`, `no-device`, `app-not-installed`, `no-embedded-fingerprint`, `no-response`, `app-id-unknown`, `fingerprint-unavailable`, `check-failed` | `unknown`          | as the recommendation says                                                                 |
| `cloud-session`                                                                                                                                              | `unknown`          | none for a live binding; `dev --<platform> --eas --detach --wait-ready` for an expired one |

- **Versions.** Equal hashes match, whatever made them. Different hashes compare only when one `@expo/fingerprint` version made both, because hashing changes between versions. Two known, different versions with different hashes are `fingerprint-version-mismatch` with no command: an agent runs what `commands` says, and a native rebuild after every `expo` upgrade is the cost of a wrong answer. A build that embedded no version still compares.
- **Sources.** A `hash-mismatch` names the project sources that moved, when the installed file carries them. Dependency sources are left out.
- **Outcome.** The report's `outcome` is the strongest verdict: `rebuild-required`, then `unknown`, then `up-to-date`. A platform with `no-device` or `app-id-unknown` does not count while another platform produced a verdict.
- **Several devices** are ranked so a stale one cannot hide a match: a matching app, an app with a hash, an app without one, "not installed", then silence.
- **Which app.** The app id comes from the app config (`ios.bundleIdentifier`, `android.package`), and on Android also from the `applicationId` a prebuild wrote. Nothing is read from an Xcode project. Expo Go is never the target. No id for a platform is `app-id-unknown`.
- **No simulator bound here.** Without `--device`, the iOS check reads only the simulator bound to this worktree ([[0035-one-device-per-worktree]]). So iOS `no-device` means "none is bound here". The recommendation never says "boot one"; it names the booted simulators no worktree bound (`unboundSimulators`), and the command that binds one. A simulator another worktree bound is never named or read.

### Reported by status

The verdict is the `installed` section of `status`: one row per platform, the strongest verdict as `outcome`, and the commands that fix a stale one. `freshness` is about the build this machine recorded; `installed` is about the build on the device.

- **On every run.** `AGENT_CLI_NO_DEVICE` turns the section off ([[0002-testing-and-evals]] §Tier 0).
- **Naming the phone is the consent.** `status` starts nothing, and the physical-iPhone probe launches the app. So a phone is asked only when `--device <name>` names it, and the launch is announced on stderr. `--device-timeout <secs>` (15 by default) bounds the phone's answer.
- **One deadline over the whole read.** The fingerprint and every device read share 15 s. A per-call timeout would let an expired read start its fallback and wait again. At the deadline every subprocess under it is killed, none starts, and the section reports the timeout in `errors.installed` while the rest of the report stands. A probe that launches a phone restarts the deadline with its launch and answer budget.
- **A report, not a gate.** `--assert` is about the impact class, not about this. A caller that branches reads `installed.outcome`.
- **Who the connected apps belong to.** An app on a booted local simulator can connect to this dev server by itself, so the dev-server line splits the count, for example "2 apps connected: 1 on this worktree's EAS session, 1 on a local simulator not bound here (iPhone 17 Pro)". The split uses the placement rules of `runtime:eval` ([[0005-runtime-loop-tools]] §Target owner). An app is on this worktree's simulator when it runs on the simulator this worktree bound; when this worktree bound a simulator of that name, the app stays this worktree's. An app is on a local simulator not bound here when a booted simulator has its device name, this worktree bound none of that name, and at least one of them is bound by no worktree. It is on another worktree's simulator when only other worktrees bound every booted simulator of that name. When this worktree has an EAS session and binds no simulator, one app that no other rule placed is the EAS session's; two or more are "N other", because a physical device and another session look the same. `--json` adds `devServer.owners` (`simulatorApps`, `localApps`, `otherWorktreeApps`, `sessionApps`, `otherApps`) only when the split applies: an app is on a local simulator not bound here or on another worktree's simulator. The split costs one `simctl` and one `adb` call, and none under `AGENT_CLI_NO_DEVICE` or on a host that cannot bind iOS.

### What this cannot see

- **`expo-constants` before 58.0.5** embeds nothing, and no rebuild adds it. The check answers `embed-unsupported` before it hashes the project or reads a device, with no command.
- **A release build**, a build with `EXPO_SKIP_FINGERPRINT_EMBED`, and a build that `expo run:ios --unstable-rebundle` changed are `no-embedded-fingerprint`.
- **A phone** answers only when its build has the dev-launcher responder and reaches this machine over the LAN; anything else is `no-response`. The responder sends no sources, so a mismatch on a phone names no input.
- **An asset outside the fingerprint's allowlist** moves no hash.
- **A stale generated `ios/` or `android/`.** On a CNG project the fingerprint hashes the inputs, and `expo run:<platform>` prebuilds only when the directory is missing. A build made outside this CLI after a config change then compiles stale native code and still matches. So a `hash-match` on a generated directory with no last-build record says so and names `prebuild`.
- **The cache of [[0023-fingerprint-caching]]** applies: it answers for up to ten minutes and does not look at `ios/` or `android/`. `--no-fingerprint-cache` turns it off for one run.

## Risks

1. A build made outside this CLI leaves no record, so the local plan builds again (§Implemented in v1, "The build cache is consulted only on EAS").
2. A stale generated native directory can match the installed fingerprint (§What this cannot see).
3. A later run can write over an orphan's run record; that server then needs `dev:stop --force` (§Daemonization).
4. A port can be taken between the bind test and Metro's bind twice in a row; the run then stops with `PORT_TAKEN_AFTER_RETRY`.
5. An event log this process cannot read back gives no port report, so the lock confirms its port only after 20 s.
6. The How of `DEV_DETACH_STILL_BUILDING` says the same command follows the run. That holds for an EAS run; a local re-run stops with `DEV_SERVER_RUNNING`.
7. Beside a lock that is `starting`, `status` reads the lock's `serving` and can name a `dev --port <n>`. That `dev` stops and names `status`.
8. In `status`, the probe's fingerprint run and the `expo config` of the OTA verdict have no deadline, so a hung one hangs `status`.

## Open questions

None. The installed-app verdict stays a report (§Reported by status), and the local plan stays on the last-build record (Risk 1).

## Testing

The decision table is pure, so it is unit-tested with no model and no device (tier 0 in [[0002-testing-and-evals]]). The probe and the run paths have e2e tests against fixtures and stub tools.

| Section                                  | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §Decision table                          | `src/plan/__tests__/decide-test.ts` (every row, no project or device); `e2e/__tests__/dev-test.ts`, `plan-test.ts`                                                                                                                                                                                                                                                                                                                         |
| §A current build is not an installed app | `src/device/__tests__/appPresence-test.ts`; `src/plan/__tests__/resolveAsync-test.ts`, `resolveDevice-test.ts`, `decide-test.ts`; `e2e/__tests__/dev-test.ts`                                                                                                                                                                                                                                                                              |
| §A stale build is two questions          | `src/impact/__tests__/classify-test.ts`, `fromRecord-test.ts`; `src/plan/__tests__/decide-test.ts`; `e2e/__tests__/dev-test.ts`                                                                                                                                                                                                                                                                                                            |
| §Not an Expo app                         | `e2e/__tests__/project-shapes-test.ts`; `src/project/__tests__/expoApp-test.ts`                                                                                                                                                                                                                                                                                                                                                            |
| §Dependencies not installed              | `e2e/__tests__/project-shapes-test.ts` ("an Expo app whose dependencies are not installed"), `install-bootstrap-test.ts`                                                                                                                                                                                                                                                                                                                   |
| §Plan contract                           | `src/plan/__tests__/decide-test.ts`, `resolveDevice-test.ts`                                                                                                                                                                                                                                                                                                                                                                               |
| §Sub-features                            | `src/project/__tests__/expoGo-test.ts`, `expoGoModules-test.ts`, `impact-test.ts`; `src/install/__tests__/impactReport-test.ts`                                                                                                                                                                                                                                                                                                            |
| §Status                                  | `e2e/__tests__/status-test.ts`, `dev-eas-test.ts` ("after a SIGKILL, status names dev:stop --eas"); `src/status/__tests__/sections-test.ts`, `nextAction-test.ts`, `statusAsync-test.ts`; `src/dev/__tests__/advertisedUrl-test.ts`                                                                                                                                                                                                        |
| §Discovery ladder                        | `src/runtime/__tests__/devServerDiscovery-test.ts`, `devServerLockDiscovery-test.ts`; `src/status/__tests__/statusAsync-test.ts`; `e2e/__tests__/runtime-reload-test.ts` (the lock's budget)                                                                                                                                                                                                                                               |
| §Dev-server lock                         | `src/devLock/__tests__/runState-test.ts` (one case per cell of the transition table), `runLock-test.ts`, `lock-test.ts`, `address-test.ts`, `port-test.ts`, `publishPort-test.ts`; `src/dev/__tests__/stopAsync-test.ts`; `e2e/__tests__/wrapper-test.ts` ("answers with the port the dev server reported"), `dev-eas-test.ts`, `dev-detach-test.ts`, `dev-test.ts` (`building` through `expo run:*` on iOS and Android), `status-test.ts` |
| §Daemonization                           | `e2e/__tests__/dev-detach-test.ts`, `dev-eas-test.ts`, `dev-logs-test.ts`, `stop-test.ts` ("after a SIGKILL of a foreground dev"), `dev-test.ts` (signal exits); `src/dev/__tests__/detach-test.ts`, `detachAsync-test.ts`, `detachRunningServer-test.ts`, `childVerdict-test.ts`, `untrackedDevServer-test.ts`; `src/devLock/__tests__/lock-test.ts`, `publishPort-test.ts` (the run record)                                              |
| §A busy port                             | `src/dev/__tests__/runningDevServer-test.ts`, `portCollision-test.ts`, `devAsync-test.ts`, `detachAsync-test.ts`; `src/runtime/__tests__/waitReady-test.ts` (the root rule); `e2e/__tests__/dev-test.ts`, `dev-detach-test.ts`, `stop-test.ts`                                                                                                                                                                                             |
| §What the answer is                      | `src/installedApp/__tests__/installedAppAsync-test.ts`; `src/project/__tests__/sourceDiff-test.ts`; `src/status/__tests__/installed-test.ts`; `e2e/__tests__/status-installed-test.ts`, `status-unbound-simulators-test.ts`                                                                                                                                                                                                                |
| §Reported by status                      | `e2e/__tests__/status-installed-test.ts`, `status-unbound-simulators-test.ts`, `subprocess-deadline-test.ts`                                                                                                                                                                                                                                                                                                                               |
| §What this cannot see                    | `src/installedApp/__tests__/embedSupport-test.ts`, `installedAppAsync-test.ts`; `e2e/__tests__/status-installed-test.ts`                                                                                                                                                                                                                                                                                                                   |
