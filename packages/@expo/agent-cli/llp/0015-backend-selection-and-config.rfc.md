# 0015: Backend selection and the developer config

**Type:** RFC
**Status:** Active
**Systems:** the plan engine (`src/plan/`); the toolchain probe (`src/toolchain/`); the developer config (`src/settings/`); EAS CLI resolution (`src/utils/easCli.ts`, `src/utils/packageRunner.ts`, `src/utils/processGroup.ts`); project-local bin resolution (`src/utils/projectBin.ts`); `@expo/agent-cli dev`; `@expo/agent-cli status`; `@expo/agent-cli smoke`
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-26
**Revised:** 2026-08-30 · 2026-09-08 · 2026-10-21 · 2026-11-13
**Related:** [[0004-smart-start-and-project-state]], [[0005-runtime-loop-tools]], [[0008-guardrails]], [[0009-smart-followups]], [[0010-agent-conventions]], [[0011-impact-and-freshness]], [[0027-everything-on-eas]]

## Summary

This RFC decides where a build runs, where the app runs, and where a developer writes down a preference. Each is its own question:

| Question             | Config key      | Flags                    | Default                    |
| -------------------- | --------------- | ------------------------ | -------------------------- |
| Which app runs       | `target`        | `--go`, `--dev-client`   | the decision table         |
| Where the build runs | `buildBackend`  | `--eas`, `--local`       | here (§The selection)      |
| Where the app runs   | `deviceBackend` | `--eas`, `--local` (dev) | here (§The device backend) |

Where a build runs is part of the plan: it is selected before the plan is printed, so a host with no Xcode sees `eas build` in the steps. [[0004-smart-start-and-project-state]] forbids a change of steps between the printed plan and the run, and selection happens before that point. EAS costs credits, so only a person can choose it (§Who may spend EAS credits).

## Impossible is not missing

The toolchain probe answers `present`, `missing` or `unknown`. `missing` covers two states with opposite advice: a Mac without Xcode can install it, a Linux host never can. So the probe also says `impossible`, true when the host is the reason (Xcode on a host that is not macOS). It is a flag beside the status, not a fourth status, because every reader of `missing` already means "the tool is not here".

## The selection

The build backend is a pure function of four facts. The precedence is the contract:

| Rank | Input                                                               | Wins because                             |
| ---- | ------------------------------------------------------------------- | ---------------------------------------- |
| 1    | A flag on this command line (`--eas`, `--local`)                    | It is the most recent thing anyone said. |
| 2    | The config: `buildBackend`, else `eas` for a `deviceBackend: "eas"` | The developer wrote it down on purpose.  |
| 3    | The host cannot have the toolchain (`impossible`)                   | No install here would change it.         |
| 4    | The probe found the toolchain missing                               | This machine cannot, and could.          |
| 5    | Nothing                                                             | Builds run here.                         |

- **Detection only pushes a build to EAS.** No row moves a build back to this machine against the caller's choice.
- **Detection names the route; it does not take it** [Kudo, 2026-09-09]. Rows 3 and 4 are implicit, and an implicit EAS route never runs. `dev --plan` prints it with a reason that it will not run as is. A bare `dev` exits 1 with `EAS_ROUTE_NOT_CHOSEN` and names `--eas` and `--local`. `smoke` fails before it spawns anything, and its reason names `--eas`. `status` and the follow-ups offer `dev --<platform> --eas`.
- **`unknown` keeps the build here.** A probe that could not run proves nothing.
- **An explicit choice that cannot work still runs, and is marked doomed.** The `Build:` line is red, and a reason says the build step will fail. The caller may know something this CLI cannot see.

## One flag for EAS

[decided, Kudo, 2026-09-08] `--eas` is the one flag that puts a command on EAS. On `dev` it means **everything this command does runs on EAS**: the build, the device and a tunnelled dev server ([[0027-everything-on-eas]]). On `smoke`, `navigate`, `runtime:reload` and `runtime:stop` it names the device ([[0005-runtime-loop-tools]] §Cloud simulator). There is no `--cloud` and no alias. Every printed command line says `--eas`.

## Who may spend EAS credits

[confirmed, Kudo, 2026-10-21] One rule for every command:

> A command starts a billed EAS action only when a person chose EAS for it. An EAS build needs `--eas`, `buildBackend: "eas"` or `deviceBackend: "eas"`. An EAS Simulator session needs `--eas` or `deviceBackend: "eas"`. A finding about this host never starts either.

A billed action is starting an EAS build or an EAS Simulator session; both bill from the moment they start. The rule is about **starting**: a command may drive a session that is already up without a flag.

## The device backend

[confirmed, Kudo, 2026-10-21] `deviceBackend` says where the app runs: `local`, or `eas` (an EAS Simulator session). Resolution per platform, highest first:

1. A flag. `--eas` sets both backends to `eas`. On `dev`, `--local` sets both to `local`.
2. The platform's `deviceBackend` (`ios`, `android`).
3. The top-level `deviceBackend`.
4. `local`. Detection never puts a device on EAS.

A session installs only Expo Go or a build that EAS made. So `deviceBackend: "eas"` with no `buildBackend` builds on EAS (rank 2 above), and `buildBackend: "local"` beside `deviceBackend: "eas"` on one platform is the error `BAD_AGENT_CLI_CONFIG`. `buildBackend: "eas"` alone starts no session.

**Only the commands that start an environment read it** [Kudo, 2026-10-22], so a printed command never depends on the flags of the run that printed it:

- `dev` takes the `--eas` route ([[0027-everything-on-eas]]), with its refusals; a refusal names the config and `--local`. `dev --web` ignores the key.
- `smoke` reads it only when it starts its own dev server. Beside a running dev server, it uses what runs.
- `status` reads it to report the plan `dev` would run, and starts nothing.
- `navigate`, `runtime:reload`, `runtime:stop` and `dev:stop` do not read it. They act on the device this worktree has bound ([[0035-one-device-per-worktree]]).

When a run's device is on EAS, `dev`'s follow-ups add `--eas` to the device commands they suggest.

The config is in `package.json`, so the team shares it, and one `deviceBackend: "eas"` makes a teammate's `dev` start a billed session. So `dev` says when the session comes from the config, and how to stop it. A per-machine override is not designed yet.

## The plan approved is the plan run

`dev --plan` prints exactly the plan `dev` runs. The run never reads the probe again. The probe can add caveats to a plan that stays local, but it never changes the steps. The probe is skipped when the choice is already EAS.

### What the EAS route is made of

For a build on EAS with a local device, the native build becomes at most:

1. `eas build:configure`, only when the project has no `eas.json`.
2. `eas build` with the `development` profile.
3. `expo start --dev-client`.

There is no prebuild, because EAS Build generates the native project. The install is guidance, not a step: a step that cannot run on this host is worse than a sentence, so the reason names `eas build:run`. The last-build record ignores EAS builds, because no device runs them yet. With the device on EAS too, the route is [[0027-everything-on-eas]].

### Running an `eas` step

A plan that chose EAS cannot work without the EAS CLI, so a missing CLI fails the step. A failure names the CLI the step ran, and the needs-human classifier treats it as an EAS failure.

## Resolving the EAS CLI

[confirmed, Kudo, 2026-08-26 · 2026-10-16] This CLI does not expect an installed `eas-cli`, but uses one that is installed and recent:

| Rung | Condition                                        | Runs                   |
| ---- | ------------------------------------------------ | ---------------------- |
| 1    | The project declares `eas-cli` in `package.json` | the runner, on the pin |
| 2    | The first `eas` on `PATH` is a recent `eas-cli`  | that `eas`             |
| 3    | Otherwise                                        | the runner             |

The runner is `bunx` for a bun project, else `npx --yes`.

- **What is printed is what is spawned** [Kudo, 2026-09-09]. Every EAS command line this CLI prints uses the invocation it would spawn. `npx eas` runs nothing, because no package is called `eas`; a lint fails on it.
- **The package spec has no version.** A version defeats the project pin and makes `bunx` reinstall on every run.
- **The pin is the declaration**, not an installed copy. A package that does not declare it is unpinned, even when a sibling workspace does.
- **The global rung never spawns to check.** It resolves the file to the `eas-cli` package and reads its version. A wrapper or shim that does not resolve falls to the runner. The rung is off on Windows, which cannot spawn npm's shim directly.
- **A runner never prompts and never hangs.** npx gets `--yes`. Every runner spawn has a deadline, because npx asks the registry on each run. One spawn per package spec runs at a time, because the runner shares one scratch directory per spec ([[0021-honest-reports]] §The runner is not the service).
- **A stop kills the whole process tree**, so no child of the runner keeps the pipes open.
- **A read-only caller does not pay for a download it did not ask for.** The auth preflight asks the EAS CLI only when the project pins it. `status` allows a download a longer deadline than a pinned run, but not the minutes of a cold install. An opportunistic lookup has its own deadline, and its report is complete without it.
- **Error advice never says "add `eas-cli` to the project"** [confirmed — review of #127, 2026-10-07]. `EAS_CLI_MISSING` means no runner on `PATH`. A download failure suggests a retry or a registry check; a timeout alone does not prove a download.

## Resolving a project-local bin

Every other tool of the family (`expo`, `tsc`, `fingerprint`, `expo-doctor`) resolves from `node_modules` by a walk up from the project. The EAS CLI never does. The nearest copy wins, as in Node and every package manager. The walk stops at the filesystem root, because nothing on disk marks a workspace root. A failed search names where it started and where it stopped.

## The run target

`target` (`expo-go` | `dev-build`) says which app runs. `dev-build` moves one row of the decision table, `expo-go`, to `needs-dev-client`. `expo-go` moves nothing: no config makes an incompatible project fit Expo Go, so the plan says "Expo Go cannot run this project, so the plan is a development build regardless".

The flags are `expo start`'s own `--go` and `--dev-client`. `dev` reads them first as the run target and still forwards them. Both together are refused.

## Where the config lives

`package.json` › `expo` › `agent-cli` [confirmed, Kudo, 2026-09-16]:

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

Per-platform overrides exist because detection is per platform, and one host often runs one platform's device and not the other's. `target` has no per-platform form. An `expo.agentCli` key is an error that names `expo.agent-cli`.

`package.json`'s `expo` key already holds tooling config (`expo.install`, `expo.doctor`). It is static JSON, it is not part of the app config, and it moves no hash. Rejected places:

- A top-level `app.json` key: `@expo/config` drops every top-level key beside `expo`.
- `app.json` › `expo.extra`: it changes the fingerprint, so a tooling preference would mark every development build stale.
- `agent-cli.config.js`: the config is a few scalars, and `status` must stay instant.

## Validation

Unknown keys and values are errors, not warnings: a preference that silently did nothing gives a wrong plan that looks right. A typo gets a "looks like" line. Invalid JSON in `package.json` is an error. A project with no `agent-cli` key gets no error and no warning.

`status` reports the error, reports every other line, and exits 0, because `status` reports and does not judge.

## What `status` reports

`status` resolves the plan the same way `dev` does, so the two cannot disagree. When the next plan has a build, the report says where it runs: a local build needs a toolchain, an EAS build needs an account and a queue. The probe this costs is cached per process and bounded.

## The follow-ups of a chosen backend

A follow-up never offers a route the plan already took.

- On an EAS plan, `dev --plan` leads with the EAS login check. The EAS-build follow-up appears only for a local plan on a machine that cannot build.
- `needs-native-build` keeps `npx @expo/agent-cli dev` first for every backend, says which route it takes and why, and offers `dev --local` second.
- A preference the plan acted on is labelled. A preference it did not act on is not.

## Testing

| Contract                                                 | Test                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| §The selection: host × toolchain × config × flag         | `src/toolchain/__tests__/selectBackend-test.ts`                                     |
| §The plan approved is the plan run                       | `src/plan/__tests__/resolveAsync-test.ts`, `decide-test.ts`                         |
| §Validation                                              | `src/settings/__tests__/parse-test.ts`, `read-test.ts`                              |
| Every config case and `EAS_ROUTE_NOT_CHOSEN`, end to end | `e2e/__tests__/plan-test.ts`                                                        |
| §Who may spend EAS credits, §The device backend          | `e2e/__tests__/dev-eas-test.ts`, `smoke-test.ts`, `status-test.ts`                  |
| §One flag for EAS                                        | `src/lint/__tests__/easFlagCoverage-test.ts`                                        |
| §Resolving the EAS CLI                                   | `e2e/__tests__/eas-runner-test.ts`, `src/lint/__tests__/easCommandSpelling-test.ts` |
| §Resolving a project-local bin                           | `src/utils/__tests__/projectBin-test.ts`                                            |

No test covers a live `eas build` step.
