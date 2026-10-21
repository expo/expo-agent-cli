# 0015: Backend selection and the developer config

**Type:** RFC
**Status:** Active
**Systems:** the plan engine (`src/plan/decide.ts`, `src/plan/resolveAsync.ts`, `src/plan/runTarget.ts`); the toolchain probe (`src/toolchain/`); the developer config (`src/settings/`); EAS CLI resolution (`src/utils/easCli.ts`, `src/utils/packageRunner.ts`, `src/utils/processGroup.ts`); project-local bin resolution (`src/utils/projectBin.ts`); `@expo/agent-cli dev`; `@expo/agent-cli status`; the device commands that take `--eas` (`smoke`, `navigate`, `runtime:reload`, `runtime:stop`, `dev:stop`)
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-26
**Revised:** 2026-08-30 · 2026-09-08 · 2026-10-21
**Related:** [[0004-smart-start-and-project-state]], [[0005-runtime-loop-tools]], [[0008-guardrails]], [[0009-smart-followups]], [[0010-agent-conventions]], [[0011-impact-and-freshness]]

## Summary

Three decisions about where things run, and one place to record what a developer wants.

1. Where a build runs is part of the plan, not a footnote under it. On a host that cannot build for the target platform at all, a plan nobody should approve used to print as though they should. The selection now happens while the plan is decided, so a machine with no Xcode gets `eas build` in the steps.
2. The developer may disagree, and there has to be somewhere to say so. One config, five keys, in `package.json` under `expo.agent-cli`.
3. Where the build runs and where the device runs are two choices. The config can make each one, and only a person can choose EAS for either (§Who may spend EAS credits).

[[0004-smart-start-and-project-state]]'s old claim that the plan "does not act" on where a build runs is superseded. What that document forbids is a swap of steps between the moment a plan is printed and the moment it runs. Selection happens strictly earlier than that.

## Impossible is not missing

The probe answered `present`, `missing`, or `unknown`. `missing` covered two states that want opposite advice. A Mac without Xcode is missing something a person can install in an hour. A Linux box is missing something that does not exist for it.

`ToolchainProbe` gains `impossible: boolean` rather than a fourth `ToolchainStatus`. A fourth status would have to be handled by every existing reader. Each of them already means the right thing by `missing`: the tool is not here. What `impossible` adds is whether the host is the reason. Today it is true in exactly one place: `detectXcodeAsync` on a `process.platform` that is not `darwin`, which is settled before anything is spawned.

## The selection

`selectBuildBackend` (`src/toolchain/selectBackend.ts`) is a pure function of four facts. The precedence is the contract:

| Rank | Input                                                                                           | Wins because                             |
| ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1    | A flag on this command line (`--eas`, `--local`)                                                | It is the most recent thing anyone said. |
| 2    | The project's `@expo/agent-cli` config: `buildBackend`, else `eas` for a `deviceBackend: "eas"` | The developer wrote it down on purpose.  |
| 3    | The host cannot have the toolchain (`impossible`)                                               | No install here would change it.         |
| 4    | The probe found the toolchain missing                                                           | This machine cannot, and could.          |
| 5    | Nothing                                                                                         | Builds run here.                         |

Three properties of that table are load-bearing.

Detection only ever pushes a build to the cloud. There is no row that moves a build back to this machine, because "this machine has Xcode" is not a reason to prefer a local build over one the caller asked for in the cloud.

**Detection names the route; it does not take it** [Kudo, 2026-09-09]. Rows 3 and 4 mark their choice `implicit`. A build on EAS and an EAS Simulator session use EAS credits, and a finding about this host is not a person deciding to spend them — on a Windows machine, `dev --ios` used to queue a cloud build with nothing but the host's inability behind it. So an implicit EAS route is _described_ and _stopped_: `dev` prints the plan under `--plan` with a reason saying it will not run as is, and a bare `dev` exits 1 with `EAS_ROUTE_NOT_CHOSEN`, naming `--eas` (which also puts the app on an EAS Simulator session, [[0027-everything-on-eas]]) and `--local`; `smoke` fails its `start-dev-server` phase with the same reason before spawning anything; `status` and the `--plan` follow-ups offer `dev --<platform> --eas`, a line that runs. Rows 1 and 2 — the flag, and `buildBackend` or `deviceBackend: "eas"` in the package.json config — are a person's own choice and run with no stop.

`unknown` leaves the build here. A probe that could not run has established nothing, and routing a caller into a build queue over a toolchain nobody could reach is worse than the local plan they would otherwise have got.

An explicit choice is honoured even where it cannot work, and is marked `doomed`. The caller may know something this CLI cannot see. What the plan does instead of overriding them is say so. The `Build:` line is red, and a reason reads "the plan above is the plan that runs, and its build step will fail".

Every choice carries two spellings of the same sentence: `why`, as `Building <where>: <because>`, for the plan's reason list; and `because` on its own for the `status` line.

## One flag for EAS

[decided, Kudo, 2026-09-08] `--eas` is the one flag that puts a command on EAS. On `dev` it has always named the build backend. The device commands — `smoke`, `navigate`, `runtime:reload`, `runtime:stop` — named the same service `--cloud` for the device backend, an EAS Simulator session ([[0005-runtime-loop-tools]] §Cloud simulator). Two spellings for one place: `dev --cloud` and `smoke --eas` were both refused as unknown options [observed — 1.0.9].

`--eas` wins because it names the service rather than a place, matches `buildBackend: "eas"` in the developer config, and pairs with `--local`. The meaning is one sentence: **everything this command does runs on EAS** — the build on EAS Build, the device on EAS Simulator, and the dev server through a tunnel so that device can reach it.

What "everything on EAS" is made of on `dev` — the tunnel, the simulator profile, the session — is [[0027-everything-on-eas]].

`--cloud` is removed outright, with no alias [Kudo, 2026-09-08]: a `--cloud` on any command line is the ordinary unknown-option error, which names `--help`. The surface is young enough that one name from now on is worth more than a release of two. Every printed command line — follow-ups, `Try:` lines, the `--help` — says `--eas`.

## Who may spend EAS credits

[confirmed, Kudo, 2026-10-21] One rule for every command:

> A command starts a billed EAS action only when a person chose EAS for it. An EAS build needs `--eas`, `buildBackend: "eas"` or `deviceBackend: "eas"`. An EAS Simulator session needs `--eas` or `deviceBackend: "eas"`. A finding about this host never starts either.

A billed action is one of two things: starting an EAS build (`eas build`, or a verb that queues one, `eas build:dev` and `eas workflow:run`), or starting an EAS Simulator session (`eas simulator`, `eas simulator:start`). Each one costs credits from the moment it starts.

The rule is about **starting**. Using a session that is already running starts nothing new. So the `fallback` rung of `navigate` and `smoke` is allowed: with no local device, they may drive the session that `.env.eas-simulator` names ([[0005-runtime-loop-tools]] §Cloud simulator, [[0035-one-device-per-worktree]]). They never start one without `--eas` or `deviceBackend: "eas"`.

Where each command stands:

| Command                                      | Billed action it can start                                                | Who chose it                                           |
| -------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| `dev`                                        | an EAS build                                                              | `--eas`, `buildBackend: "eas"`, `deviceBackend: "eas"` |
| `dev`                                        | an EAS Simulator session                                                  | `--eas`, `deviceBackend: "eas"`                        |
| `smoke`                                      | an EAS build, through the `dev --detach` child that starts its dev server | `--eas`, `buildBackend: "eas"`, `deviceBackend: "eas"` |
| `smoke`                                      | an EAS Simulator session, in `start-session`, which itself never builds   | `--eas`, `deviceBackend: "eas"`                        |
| `navigate`, `runtime:reload`, `runtime:stop` | none. They use a running session or refuse.                               | —                                                      |
| `dev:stop`                                   | none. It ends sessions.                                                   | —                                                      |
| every other command                          | none                                                                      | —                                                      |

A build key never starts a session: `buildBackend: "eas"` alone builds on EAS and installs on a local device. A device key can start both, because `deviceBackend: "eas"` also sends the build to EAS. An implicit route starts neither: `dev` stops with `EAS_ROUTE_NOT_CHOSEN` (§The selection), and `smoke` fails `start-dev-server`.

The rule is tested by what a run does, end to end. `plan-test.ts` and `smoke-test.ts` check that an implicit route stops with the credits reason before any step runs. `cloud-simulator-test.ts` checks the argv the stub `eas` records: a device command without `--eas` or `deviceBackend: "eas"` starts no session and no build (`simulator`, `simulator:start`, `build`). The `fallback` rung may still spawn `simulator:list` and `simulator:exec`, to drive a session that is up.

## The device backend

[confirmed, Kudo, 2026-10-21] `buildBackend` says where a build runs. `deviceBackend` says where the app runs: a simulator, an emulator or a device on this machine (`local`), or an EAS Simulator session (`eas`). The two are separate choices, so they are separate keys. `buildBackend: "eas"` alone builds on EAS and installs the build on a local device.

Resolution, per platform, highest first:

1. A flag. `--eas` sets both backends to `eas`. `--local` sets both to `local`. Each flag means "everything in one place", and `--local` is always a run that spends nothing.
2. The platform's own `deviceBackend` (`ios`, `android`).
3. The top-level `deviceBackend`.
4. `local`. Detection never puts a device on EAS. There is no implicit device route.

`deviceBackend: "eas"` makes the build go to EAS too. A session installs Expo Go or a build that EAS has (`--expo-go` or `--build-id`), never a build made on this machine. So for a platform whose `deviceBackend` is `eas` and whose `buildBackend` is unset, §The selection reads rank 2 as `eas`: an explicit config choice that runs, never an implicit route. A platform whose config names `buildBackend: "local"` beside `deviceBackend: "eas"` is `BAD_AGENT_CLI_CONFIG`, because no run of it could open a development build. The rank-5 default is not that case.

With `deviceBackend: "eas"`, a command does what it does with `--eas`:

- `dev` tunnels the dev server, builds with the simulator profile when it must build, and opens the app on a session ([[0027-everything-on-eas]]). It refuses `--device`, `--lan`, `--localhost` and `--host lan|localhost` with `BAD_ARGS`, as `--eas` does. The message names the config key, and its How line names `--local`. `dev --web` reads no `deviceBackend`, because the web has no device.
- `smoke`, `navigate`, `runtime:reload` and `runtime:stop` take the session as their device (`cloud: 'required'`) for a platform that resolves to `eas`. `navigate` and the runtime commands may omit the platform. Then they require the session only when both platforms resolve to `eas`. With one platform on `eas`, each stays on its own ladder, so a local device of the other platform is not skipped: `navigate` keeps its `fallback` rung, and `runtime:reload` and `runtime:stop` stay at `off` ([[0005-runtime-loop-tools]] §Cloud simulator).
- `dev:stop` ends this project's session, as `dev:stop --eas` does, when the config puts either platform's device on EAS. Stopping spends nothing, so "either" is the safe side here. It also does the binding release of `dev:stop --eas` ([[0035-one-device-per-worktree]] §EAS session binding), so no binding outlives its session.

These commands also take `--local`. With `--local`, they use only local devices (`cloud: 'off'`), whatever the config says. When `deviceBackend` is unset, the device side of `--local` matches no flag, except that `navigate` and `smoke` drop their `fallback` rung. The build side does not: `dev --local`, and the `dev` child of `smoke --local`, choose a local build at rank 1 and run it, where a bare run on a host that cannot build stops with `EAS_ROUTE_NOT_CHOSEN`. `dev:stop --local` leaves every session running.

The config is in `package.json`, so it is shared by everyone who checks out the repository. One `deviceBackend: "eas"` makes every teammate's `dev` start a billed session. `buildBackend: "eas"` does the same for builds, and a session costs more, because a session bills by the minute. So the plan's reasons and the `dev` output say that the session comes from the config, name the file, and say how to stop it. A per-machine override is left for later.

## The plan approved is the plan run

What the old "does not act" constraint forbids is a swap: steps changing between the moment a plan is printed and the moment it runs. `decideStartPlan` is handed a resolved `BuildBackendChoice` and produces the plan. `dev --plan` prints exactly the plan `dev` would execute. Nothing about the run reads the probe again.

`applyToolchainProbe` still folds a probe into a plan without touching its steps. It is what carries the probe's caveats into a plan that stayed local.

`resolveStartPlanAsync` (`src/plan/resolveAsync.ts`) runs the decision table twice, on purpose. The first pass establishes whether this project needs a native build at all and for which platform. The second is decided with the answer. Both passes are pure and free. The probe is skipped entirely when the effective choice is already `eas`.

### What the EAS route is made of

`prebuild` + `run:<platform>` becomes, at most:

1. `eas build:configure`. Only when the project has no `eas.json`.
2. `eas build --platform <p> --profile development`. `runsOn: 'eas'`, `many-minutes`.
3. `expo start --dev-client`. `runsOn: null`.

No prebuild. EAS Build generates the native project itself for a CNG app. The dev server is its own step, because `eas build` builds and stops where `expo run:*` builds, installs, and starts.

Installing is guidance. The cloud route ends with an artifact. `eas build:run --platform <p> --latest` is named in the build step's `reason` and in the plan's `Why`. It is not a step. A step that cannot run on the host it was planned for is worse than a sentence.

The last-build record ignores `eas` steps. That record answers "does the app installed on a device match this project". A cloud build that nothing installed would mark the next plan fresh against an app no device is running.

### Running an `eas` step

`@expo/agent-cli dev` accepts `expo` and `eas`, resolved through `resolveEasCliOrThrow`, the throwing resolver. A plan that chose the cloud cannot do its job without the CLI. Failure messages name the CLI the step actually ran. The needs-human classifier is given `tool: 'eas'`.

## Resolving the EAS CLI

An installed `eas-cli` is not something this CLI may expect. [confirmed, Kudo, 2026-08-26] When one is installed and recent enough, it is the fastest answer, so it is used. [confirmed, Kudo, 2026-10-16] Three rungs, in order:

```
project declares eas-cli                       ->  <runner> eas-cli   (the pin wins)
first `eas` on PATH is eas-cli >= 25.0.0       ->  eas                (spawned directly)
otherwise                                      ->  <runner> eas-cli
runner                                         ->  bunx, when the project uses bun; else npx --yes
```

`@latest` is gone from the spec. `bunx eas-cli@latest` asked the registry and reinstalled on every run (14–31 s warm). `bunx eas-cli` ran its cached copy with no request (2.6–5.8 s). npx revalidates the packument for either spec (~110 ms). [observed — bun 1.3.14, npm 11.17.0, 2026-10-16]

**What is printed is what is spawned** [Kudo, 2026-09-09]. Every EAS command line this CLI hands a reader — a `Try:`, a follow-up, a needs-human `Ask the user`, a `How:` — is written with `easCommandPrefix()` (`src/utils/easCli.ts`): the same invocation the resolver above would spawn for this project, so a machine with a recent global install reads `eas`, a bun project `bunx eas-cli`, everyone else `npx --yes eas-cli`. Seventy-one lines used to say `npx eas …`, which runs nothing — there is no package called `eas`. A lint (`src/lint/__tests__/easCommandSpelling-test.ts`) fails on the bare form.

The runners already prefer the project's own copy, so a "project bin first" rung was doing nothing the runner does not do. The global rung is the one place a file on `PATH` is spawned, and only after the file resolves (through its symlink) to a package named `eas-cli` at 25.0.0 or newer. Only the first `eas` on `PATH` is read, because that is the one the reader's shell runs. A shell wrapper or a Volta or pnpm shim does not resolve to the package, so the runner answers instead. On Windows the rung is off: npm installs an `eas.cmd` shim there, and Windows cannot spawn an extensionless script. The impostor guards stay (`utils/wrapperCrash.ts`) as a safety net.

An existing project pin is respected, but error recovery does not recommend adding `eas-cli` to the project. A missing or unspawnable runner names the runner and asks for its installation/PATH to be repaired. A download failure suggests retrying or checking registry access; a timeout alone does not prove a download was in progress. [confirmed — review of #127, 2026-10-07]

Load-bearing rules of the rung:

- The pin survives. Local before published, in a monorepo too, and before a global install. A version in the spec (`@latest`) defeats the pin, so the spec is always the bare name.
- The signal is the declaration in `package.json` rather than an installed copy. A package that does not declare it while a sibling workspace does is therefore treated as unpinned.
- The global install is read from its `package.json`, never by spawning `eas --version`. The check is sync and never throws; anything unreadable means "no global install".
- npx still talks to the registry on every run, and stalls for the length of npm's retry ladder when it cannot reach one. Every caller spawns the runner under a deadline.
- `--yes` for npm's exec only. npx prompts before installing a package it has not seen, and a prompt is a hang. `bunx` installs without asking.

`EAS_CLI_MISSING` now means no `npx` and no `bunx` on `PATH`. `npm install -g eas-cli` is gone from its advice.

Subprocesses are spawned in a process group of their own and signalled as a group (`src/utils/processGroup.ts`). Killing the runner otherwise leaves the CLI it started alive, inheriting the pipes, so `'close'` never fires. Stdin is never attached. Windows has no process-group equivalent; `killProcessTree` uses `taskkill /T /F` there.

Who pays the first-run cost, when the project does not declare `eas-cli` and no recent global install answers:

- The auth preflight declines to pay it. It asks the EAS CLI only when the project pins it. Otherwise `status` asks the project's Expo CLI instead.
- `status` widens its budget (`EAS_BUILD_RUNNER_TIMEOUT_MS`, 45 s) when the resolved invocation may download. A pinned project keeps 10 s. It never allows the minutes a cold install or an unreachable registry can take.
- The opportunistic build-cache lookup keeps 20 s. Nobody asked for it, and the report is complete without it.

One spawn of a spec at a time. A runner keeps one scratch directory per package spec and does not queue for it. `src/utils/runnerLock.ts` serializes per spec inside the spawn layer. See [[0021-honest-reports]] §The runner is not the service.

## Resolving a project-local bin

The EAS CLI is the one member of the family this CLI never resolves from `node_modules`; its only file rung is the verified global install above. Every other one (`expo`, `tsc`, `fingerprint`, `expo-doctor`, `create-launch`) walks up from the project. `src/utils/projectBin.ts` is that walk.

The nearest copy wins. That is what a package manager does and what Node does. An ancestor's `node_modules` is where the manager put this package's declared dependencies. A workspace has one tree rather than one per package. A type check and a hash are only comparable at the version the project pinned. A global install is still not consulted for these.

The stop is the filesystem root, not the workspace root. Nothing on disk marks a workspace. A failed search says what it covered: the directory it started in, that it went up, and where it stopped.

What is deliberately still literal: the `node_modules` that deferred `doctor:fix` deletes. It names a directory to remove rather than a tool to run.

## The run target

The second question the developer may have an opinion about is which app, not where: `expo-go` or `dev-build`.

`dev-build` moves exactly one row of the decision table, the `expo-go` row, to `needs-dev-client`. `expo-go` moves nothing. This CLI can honour a preference for Expo Go and cannot enforce one, because no config makes an incompatible project compatible. That case is said out loud: "Expo Go cannot run this project, so the plan is a development build regardless".

No new flag names. `--go` and `--dev-client` are `expo start`'s own, already accepted and forwarded by `@expo/agent-cli dev`. They are now read first, as the run target the plan is decided against. Passing both is refused.

## Where the config lives

`package.json` › `expo` › `agent-cli`. [confirmed, 2026-08-26]

The key was `agentCli` until 2026-09-16. It is spelled like the package now, and like the `expo.install` and `expo.doctor` keys beside it, which read as the tool they configure. An `expo.agentCli` still in a `package.json` is an error naming the new key, not settings quietly read as absent — the silent drop §Validation exists to prevent. [confirmed, Kudo, 2026-09-16]

`app.json` as a top-level `@expo/agent-cli` key is broken by design. `@expo/config`'s `reduceExpoObject` discards every top-level key when an `expo` object is present. `app.json` under `expo.extra` changes the fingerprint. A tooling preference would mark every existing development build stale. `agent-cli.config.js` was rejected for now: this config is a few scalars, and `status` promises to be instant.

`package.json` › `expo.agent-cli` is where this repository already keeps tooling configuration (`expo.install.exclude`, `expo.doctor`, `expo.autolinking`). It is static JSON. Nothing here moves a hash or ships into the app. `package.json`'s `expo` key is not merged into the `ExpoConfig`.

The module is `src/settings/` rather than `src/config/`, because `src/config/` is `@expo/agent-cli inspect:config-plugins`.

```json
{
  "expo": {
    "agent-cli": {
      "target": "expo-go" | "dev-build",
      "buildBackend": "local" | "eas",
      "deviceBackend": "local" | "eas",
      "ios": { "buildBackend": "local" | "eas", "deviceBackend": "local" | "eas" },
      "android": { "buildBackend": "local" | "eas", "deviceBackend": "local" | "eas" }
    }
  }
}
```

Three questions, in separate keys: which app, where the build runs, and where the app runs. The per-platform overrides exist because the detection they override is already per-platform, and because one host can often run one platform's device and not the other's. `target` has no per-platform form.

## Validation

Unknown keys and unknown values are errors, not warnings. A preference that was meant to change a plan and silently did not is a wrong plan approved as a right one. A typo gets a "looks like" line. A `package.json` that is not valid JSON is an error rather than "no config". A project with no `@expo/agent-cli` key is not an error and never warns. A platform whose config names `buildBackend: "local"` beside `deviceBackend: "eas"` is an error (§The device backend).

`status` is the one exception to the fatality. It catches the error, reports every other line, and exits 0, because `status` promises to be information rather than judgment.

## What `status` reports

`status` resolves the plan through `resolveStartPlanAsync`, exactly as `dev` does, so the two commands cannot disagree about what happens next. `NextActionStatus` gains `buildLocation`, and the text report gains a `build` line, printed only when the next plan contains a build. It gets its own line rather than a clause on `next`. Where a build happens decides what the caller needs: a toolchain here, or an account and a queue.

The cost is one probe. On a host that is not macOS the iOS answer is settled without spawning anything. Those are cached per process and bounded at 5 s.

## The follow-ups of a chosen backend

A ladder must not offer a route the plan already took.

- `dev --plan` on an EAS plan leads with `npx eas whoami` instead of `eas-build-instead`. `eas-build-instead` survives for the one case that still produces a local plan on a machine that cannot build: a `--local`, or a config that asked for it.
- A `needs-native-build` keeps `npx @expo/agent-cli dev` first whichever backend was chosen, because it is the command that makes a plan. The sentence now says which route that is and why. The second rung becomes `npx @expo/agent-cli dev --local`.
- Nothing labels a preference it did not act on, and everything labels one it did.

## Testing

`deviceBackend` resolution is a pure function too, tested per flag × top-level key × platform key in `src/settings/__tests__/parse-test.ts`, with the refused combination. Each device command has a unit test for its device backend under each config value and under `--local`. The e2e tier runs `dev`, `navigate`, `runtime:stop` and `dev:stop` with the config instead of `--eas`. The selection is a pure function over four inputs, so its whole matrix of host × toolchain × config × flag is one table in `src/toolchain/__tests__/selectBackend-test.ts`. `hostPlatform` is a parameter rather than `process.platform`. `resolveAsync-test.ts` pins the order the four inputs are read in. `decide-test.ts` pins the steps each backend produces. End to end, `plan-test.ts` drives a stubbed `xcode-select`, an unset `ANDROID_HOME`, and a real `package.json` edit for every config case. The one thing not covered by a test is a live `eas build` step.
