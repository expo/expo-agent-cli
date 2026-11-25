# 0004: Smart start and the project-state engine

**Type:** RFC
**Status:** Active
**Systems:** project-state probe (`src/project/`); plan engine (`src/plan/`); smart `dev` (`src/dev/`); app presence on a device (`src/device/appPresence.ts`); `@expo/agent-cli status` (`src/status/`); `@expo/fingerprint`
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-20 · finalized 2026-08-28
**Revised:** 2026-11-16
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0002-testing-and-evals]], [[0005-runtime-loop-tools]], [[0008-guardrails]], [[0010-agent-conventions]], [[0011-impact-and-freshness]], [[0015-backend-selection-and-config]], [[0021-honest-reports]], [[0023-fingerprint-caching]], [[0026-dev-owns-the-open]], [[0027-everything-on-eas]], [[0035-one-device-per-worktree]], [[0037-dev-server-lock]]

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
| 2   | this project's lock says `building` or `finishing`                                     | the Next command of that phase ([[0037-dev-server-lock]] §Dev-server lock)                                        |
| 3   | the dev server's owner ended (below), and this worktree has a `started` cloud binding  | `dev:stop --eas`                                                                                                  |
| 4a  | a usable dev server answers; an EAS session is on record; no local device is `present` | `smoke --<platform> --eas` with an app connected, else `navigate / --<platform> --eas`                            |
| 4b  | a usable dev server answers; an app is connected                                       | `smoke`                                                                                                           |
| 4c  | a usable dev server answers; no app is connected; the local device is `absent`         | the one URL that opens the app on a device elsewhere, or `navigate / --print-url` when no single URL can be named |
| 4d  | a usable dev server answers; no app is connected                                       | `navigate /`                                                                                                      |
| 5   | no usable dev server                                                                   | `dev`, with the smart-start rule that would fire                                                                  |

A usable dev server is one that runs and does not answer for another project. A device probe that could not run (`unknown`) never turns `navigate /` into a URL. Two device states then replace rows ([[0035-one-device-per-worktree]] §Lifecycle output). An expired lease on this worktree's EAS session replaces rows 4 and 5 with `dev --<platform> --eas --detach --wait-ready`. A worktree with no live binding and no cloud binding replaces rows 4c, 4d and 5 with the `dev` that binds a device, after `dev:stop` when a running server must restart; this needs a host that can bind the platform. Beside this project's own EAS dev server for the platform it also replaces row 4b, on any host, and the command adds no `--port`.

**A server with no owner.** When `status` finds the untracked dev server a killed run left ([[0037-dev-server-lock]] §Daemonization; `status` only reads), the dev-server line says its CLI process ended (`ownerEnded: true`). With no lock, `status` takes the tunnel from the server's manifest, not from the captured log. When the log names a tunnel the manifest does not, the line says `tunnel unknown`, `tunnelUrl` is null, and no open link is built.

## Discovery ladder

Every command that needs the dev server finds it by one ladder. Every step probes; none trusts. The result names its step as `source`.

| #   | Step                                           | `source`  | Proves                                                       |
| --- | ---------------------------------------------- | --------- | ------------------------------------------------------------ |
| 0   | An explicit `--dev-server-url` or `--port`     | `flag`    | the caller named it; nothing else is tried                   |
| 1   | The project's dev-server lock                  | `lock`    | an `@expo/agent-cli` wrapper is alive, and its URL answered  |
| 2   | The port `.expo/dev/logs/start.log` last named | `log`     | this project started a server there once, and it answers now |
| 3   | 8081                                           | `default` | Metro's default answered                                     |
| 4   | 8082-8085, in parallel                         | `scan`    | a Metro answered; not that it is this project's              |

- Steps 1 to 4 read the project root that `/status` names, by the rule in [[0037-dev-server-lock]] §A busy port. A server of another project is skipped; a lock whose port another project answers is a miss, and the ladder goes on.
- A `/status` that does not answer within 3 s proves nothing and is not accepted; a socket error gets one retry.
- The lock proves a live server of this project, so the probe of its URL gets the same 3 s. The port steps probe with 800 ms by default.
- The scan prefers a server with listed debugger targets, then port order. A server with no targets is still a running server.
- No step is skipped for speed: an `expo start` run by hand holds no lock, and a cleaned `.expo` names no port. `default` is also the source when nothing answered, because the error still needs a URL.
- An explicit URL gets no timeout of its own, because a tunnel may be slow; the caller's signal stops it.
- Every probe timer is cleared, so a finished command exits at once.

`status` is a report with a deadline: 1.5 s per request and 3 s for the ladder. At the deadline it keeps the best server accepted so far, cancels the rest, and accepts nothing later. When the last `dev` request recorded a port, `status` asks the lock or that port directly and reports `lock` or `last-request`. `dev:stop` reads the lock and never enters the ladder.

## Dev-server lock

Moved to [[0037-dev-server-lock]]: the dev-server lock, daemonization, and a busy port.

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
3. A later run can write over an orphan's run record; that server then needs `dev:stop --force` ([[0037-dev-server-lock]] §Daemonization).
4. A port can be taken between the bind test and Metro's bind twice in a row; the run then stops with `PORT_TAKEN_AFTER_RETRY`.
5. An event log this process cannot read back gives no port report, so the lock confirms its port only after 20 s.
6. The How of `DEV_DETACH_STILL_BUILDING` says the same command follows the run. That holds for an EAS run; a local re-run stops with `DEV_SERVER_RUNNING`.
7. Beside a lock that is `starting`, `status` reads the lock's `serving` and can name a `dev --port <n>`. That `dev` stops and names `status`.
8. In `status`, the probe's fingerprint run and the `expo config` of the OTA verdict have no deadline, so a hung one hangs `status`.

## Open questions

None. The installed-app verdict stays a report (§Reported by status), and the local plan stays on the last-build record (Risk 1).

## Testing

The decision table is pure, so it is unit-tested with no model and no device (tier 0 in [[0002-testing-and-evals]]). The probe and the run paths have e2e tests against fixtures and stub tools.

| Section                                  | Tests                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §Decision table                          | `src/plan/__tests__/decide-test.ts` (every row, no project or device); `e2e/__tests__/dev-test.ts`, `plan-test.ts`                                                                                                                  |
| §A current build is not an installed app | `src/device/__tests__/appPresence-test.ts`; `src/plan/__tests__/resolveAsync-test.ts`, `resolveDevice-test.ts`, `decide-test.ts`; `e2e/__tests__/dev-test.ts`                                                                       |
| §A stale build is two questions          | `src/impact/__tests__/classify-test.ts`, `fromRecord-test.ts`; `src/plan/__tests__/decide-test.ts`; `e2e/__tests__/dev-test.ts`                                                                                                     |
| §Not an Expo app                         | `e2e/__tests__/project-shapes-test.ts`; `src/project/__tests__/expoApp-test.ts`                                                                                                                                                     |
| §Dependencies not installed              | `e2e/__tests__/project-shapes-test.ts` ("an Expo app whose dependencies are not installed"), `install-bootstrap-test.ts`                                                                                                            |
| §Plan contract                           | `src/plan/__tests__/decide-test.ts`, `resolveDevice-test.ts`                                                                                                                                                                        |
| §Sub-features                            | `src/project/__tests__/expoGo-test.ts`, `expoGoModules-test.ts`, `impact-test.ts`; `src/install/__tests__/impactReport-test.ts`                                                                                                     |
| §Status                                  | `e2e/__tests__/status-test.ts`, `dev-eas-test.ts` ("after a SIGKILL, status names dev:stop --eas"); `src/status/__tests__/sections-test.ts`, `nextAction-test.ts`, `statusAsync-test.ts`; `src/dev/__tests__/advertisedUrl-test.ts` |
| §Discovery ladder                        | `src/runtime/__tests__/devServerDiscovery-test.ts`, `devServerLockDiscovery-test.ts`; `src/status/__tests__/statusAsync-test.ts`; `e2e/__tests__/runtime-reload-test.ts` (the lock's budget)                                        |
| §What the answer is                      | `src/installedApp/__tests__/installedAppAsync-test.ts`; `src/project/__tests__/sourceDiff-test.ts`; `src/status/__tests__/installed-test.ts`; `e2e/__tests__/status-installed-test.ts`, `status-unbound-simulators-test.ts`         |
| §Reported by status                      | `e2e/__tests__/status-installed-test.ts`, `status-unbound-simulators-test.ts`, `subprocess-deadline-test.ts`                                                                                                                        |
| §What this cannot see                    | `src/installedApp/__tests__/embedSupport-test.ts`, `installedAppAsync-test.ts`; `e2e/__tests__/status-installed-test.ts`                                                                                                            |
