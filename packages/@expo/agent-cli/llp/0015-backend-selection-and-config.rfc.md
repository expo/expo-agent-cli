# 0015: Backend selection and the developer config

**Type:** RFC
**Status:** Active
**Systems:** the plan engine (`src/plan/decide.ts`, `src/plan/resolveAsync.ts`, `src/plan/runTarget.ts`); the toolchain probe (`src/toolchain/`); the developer config (`src/settings/`); EAS CLI resolution (`src/utils/easCli.ts`, `src/utils/packageRunner.ts`, `src/utils/processGroup.ts`); project-local bin resolution (`src/utils/projectBin.ts`); `@expo/agent-cli dev`; `@expo/agent-cli status`; `@expo/agent-cli smoke`
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-26
**Revised:** 2026-08-30 · 2026-09-08 · 2026-10-21 · 2026-11-12
**Related:** [[0004-smart-start-and-project-state]], [[0005-runtime-loop-tools]], [[0008-guardrails]], [[0009-smart-followups]], [[0010-agent-conventions]], [[0011-impact-and-freshness]], [[0027-everything-on-eas]]

## Summary

This RFC decides where a build runs, where the app runs, and where a developer writes down a preference.

1. Where a build runs is part of the plan. The plan engine selects it before it prints the plan, so a host with no Xcode gets `eas build` in the steps.
2. The developer config is `package.json` › `expo` › `agent-cli`.
3. The build backend and the device backend are two choices. Only a person can choose EAS for either one, because EAS costs credits.

[[0004-smart-start-and-project-state]] forbids a change of steps between the printed plan and the run. Selection happens before the plan is printed, so it keeps that rule.

| Question             | Config key      | Flags                    | Default                             |
| -------------------- | --------------- | ------------------------ | ----------------------------------- |
| Which app runs       | `target`        | `--go`, `--dev-client`   | the decision table                  |
| Where the build runs | `buildBackend`  | `--eas`, `--local`       | here; EAS is described, never taken |
| Where the app runs   | `deviceBackend` | `--eas`, `--local` (dev) | `local`                             |

## Impossible is not missing

The toolchain probe answers `present`, `missing` or `unknown`. `missing` covers two states with opposite advice: a Mac without Xcode can install it, a Linux host never can.

`ToolchainProbe` has `impossible: boolean`, not a fourth status. Every reader of `missing` already means "the tool is not here"; `impossible` adds "and the host is the reason". It is true for Xcode on a host that is not `darwin`, and that check spawns nothing.

## The selection

The build backend is a pure function of four facts. The precedence is the contract:

| Rank | Input                                                               | Wins because                             |
| ---- | ------------------------------------------------------------------- | ---------------------------------------- |
| 1    | A flag on this command line (`--eas`, `--local`)                    | It is the most recent thing anyone said. |
| 2    | The config: `buildBackend`, else `eas` for a `deviceBackend: "eas"` | The developer wrote it down on purpose.  |
| 3    | The host cannot have the toolchain (`impossible`)                   | No install here would change it.         |
| 4    | The probe found the toolchain missing                               | This machine cannot, and could.          |
| 5    | Nothing                                                             | Builds run here.                         |

Rules of the table:

- **Detection only pushes a build to EAS.** No row moves a build back to this machine against the caller's choice.
- **Detection names the route; it does not take it** [Kudo, 2026-09-09]. Rows 3 and 4 are `implicit`. An implicit EAS route is described and stopped:
  - `dev --plan` prints the plan with a reason that it will not run as is;
  - a bare `dev` exits 1 with `EAS_ROUTE_NOT_CHOSEN` and names `--eas` and `--local`;
  - `smoke` fails its `start-dev-server` phase with the same reason, before it spawns anything;
  - `status` and the `--plan` follow-ups offer `dev --<platform> --eas`.

  Rows 1 and 2 are a person's choice and run with no stop.

- **`unknown` keeps the build here.** A probe that could not run proves nothing.
- **An explicit choice that cannot work still runs, and is marked `doomed`.** The `Build:` line is red, and a reason says the build step will fail. The caller may know something this CLI cannot see.
- Each choice has a `why` (`Building <where>: <because>`) for the plan and a `because` for the `status` line.

## One flag for EAS

[decided, Kudo, 2026-09-08] `--eas` is the one flag that puts a command on EAS. On `dev` it means **everything this command does runs on EAS**: the build on EAS Build, the device on EAS Simulator, and the dev server through a tunnel. [[0027-everything-on-eas]] defines that route. On `smoke`, `navigate`, `runtime:reload` and `runtime:stop` it names the device ([[0005-runtime-loop-tools]] §Cloud simulator).

There is no `--cloud` and no alias; it gets the usual unknown-option error. Every printed command line says `--eas`.

## Who may spend EAS credits

[confirmed, Kudo, 2026-10-21] One rule for every command:

> A command starts a billed EAS action only when a person chose EAS for it. An EAS build needs `--eas`, `buildBackend: "eas"` or `deviceBackend: "eas"`. An EAS Simulator session needs `--eas` or `deviceBackend: "eas"`. A finding about this host never starts either.

A billed action is starting an EAS build or starting an EAS Simulator session. Both bill from the moment they start. The rule is about **starting**: a command may drive a session that is already up without a flag.

## The device backend

[confirmed, Kudo, 2026-10-21] `deviceBackend` says where the app runs: `local`, or `eas` (an EAS Simulator session). Resolution per platform, highest first:

1. A flag. `--eas` sets both backends to `eas`. On `dev`, `--local` sets both to `local`.
2. The platform's `deviceBackend` (`ios`, `android`).
3. The top-level `deviceBackend`.
4. `local`. Detection never puts a device on EAS.

A session installs only Expo Go or a build that EAS made. So `deviceBackend: "eas"` with no `buildBackend` builds on EAS (rank 2 of §The selection). `buildBackend: "local"` beside `deviceBackend: "eas"` on one platform is `BAD_AGENT_CLI_CONFIG`. `buildBackend: "eas"` alone starts no session.

**Only the commands that start an environment read it** [Kudo, 2026-10-22], so a printed command never depends on the flags of the run that printed it:

| Command                                                  | Reads `deviceBackend`                                                                                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`                                                    | Yes. `eas` takes the `--eas` route and refuses `--device` and a LAN or loopback host; the refusal names the config and `--local`. `dev --web` ignores it. |
| `smoke`                                                  | Only when it starts its own dev server. Beside a running dev server, it uses what runs.                                                                   |
| `status`                                                 | Yes, to report the plan `dev` would run. It starts nothing.                                                                                               |
| `navigate`, `runtime:reload`, `runtime:stop`, `dev:stop` | No. See [[0005-runtime-loop-tools]] §Cloud simulator, [[0027-everything-on-eas]] §dev:stop, [[0035-one-device-per-worktree]] §EAS session binding.        |

When a run's device is on EAS, `dev`'s follow-ups add `--eas` to the device commands they suggest. When `dev` stops because the dev server already runs, its How line keeps a plain `dev:stop`, because the same `dev` again reuses the session.

The config is in `package.json`, so the team shares it, and one `deviceBackend: "eas"` makes a teammate's `dev` start a billed session. `dev` therefore says when the session comes from the config, and how to stop it. A per-machine override is not designed yet.

## The plan approved is the plan run

`dev --plan` prints exactly the plan `dev` runs. The plan engine gets a resolved backend choice, and nothing in the run reads the probe again. The probe can add caveats to a plan that stays local, but it never changes the steps.

Resolution runs the decision table twice on purpose. The first pass finds whether a native build is needed and for which platform. The second pass decides with the backend for that answer. Both passes are pure. The probe is skipped when the choice is already `eas`.

### What the EAS route is made of

For a local device, `prebuild` + `run:<platform>` becomes at most:

1. `eas build:configure`, only when the project has no `eas.json`.
2. `eas build --platform <p> --profile development` (`runsOn: 'eas'`, `many-minutes`).
3. `expo start --dev-client`.

There is no prebuild, because EAS Build generates the native project. The install is guidance, not a step: the reason names `eas build:run --platform <p> --latest`. A step that cannot run on this host is worse than a sentence. The last-build record ignores `eas` steps, because no device runs that build yet. With `deviceBackend: "eas"`, the route is [[0027-everything-on-eas]].

### Running an `eas` step

`dev` runs `expo` and `eas` steps. An `eas` step resolves the CLI with the throwing resolver, because a plan that chose EAS cannot work without it. A failure names the CLI the step ran, and the needs-human classifier gets `tool: 'eas'`.

## Resolving the EAS CLI

[confirmed, Kudo, 2026-08-26 · 2026-10-16] This CLI does not expect an installed `eas-cli`, but uses one that is installed and recent:

```
project declares eas-cli                       ->  <runner> eas-cli   (the pin wins)
first `eas` on PATH is eas-cli >= 25.0.0       ->  eas                (spawned directly)
otherwise                                      ->  <runner> eas-cli
runner                                         ->  bunx, when the project uses bun; else npx --yes
```

Rules:

- **What is printed is what is spawned** [Kudo, 2026-09-09]. Every EAS command line in a `Try:`, a follow-up, a needs-human ask or a `How:` uses `easCommandPrefix()`. `npx eas` runs nothing, because no package is called `eas`; a lint fails on it.
- **The spec is the bare name.** `@latest` defeats a project pin and makes `bunx` reinstall on every run (14–31 s, against 2.6–5.8 s cached) [observed — bun 1.3.14, npm 11.17.0, 2026-10-16].
- **The pin is the declaration in `package.json`**, not an installed copy. A package that does not declare it is unpinned, even when a sibling workspace does.
- **The global rung reads files and never spawns.** It follows the first `eas` on `PATH` through its symlink to a package named `eas-cli` at 25.0.0 or newer. A shell wrapper or a Volta or pnpm shim does not resolve, so the runner answers. The rung is off on Windows, which cannot spawn npm's extensionless script. The check is sync and never throws.
- **`--yes` for npx only.** npx prompts before an install, and a prompt is a hang.
- **Every runner spawn has a deadline**, because npx asks the registry on each run and stalls when it cannot reach it.
- **One spawn per spec at a time**, because a runner shares one scratch directory per spec. See [[0021-honest-reports]] §The runner is not the service.
- **Spawn in a process group and signal the group.** Otherwise the runner's child keeps the pipes open and `'close'` never fires. Stdin is never attached. Windows uses `taskkill /T /F`.
- **Error advice never says "add `eas-cli` to the project"** [confirmed — review of #127, 2026-10-07]. `EAS_CLI_MISSING` means no `npx` and no `bunx` on `PATH`. A download failure suggests a retry or a registry check; a timeout alone does not prove a download.

Who pays the first-run download when the project does not pin `eas-cli`:

| Caller                     | Budget                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| Auth preflight             | Does not pay. It asks the EAS CLI only when pinned, else the Expo CLI. |
| `status` build lookup      | 45 s when a download is possible, 10 s when pinned.                    |
| Opportunistic cache lookup | 20 s. The report is complete without it.                               |

## Resolving a project-local bin

Every other tool of the family (`expo`, `tsc`, `fingerprint`, `expo-doctor`, `create-launch`) resolves from `node_modules` by a walk up from the project. The EAS CLI never does; its only file rung is the global install above.

The nearest copy wins, as in Node and every package manager. The walk stops at the filesystem root, because nothing on disk marks a workspace root. A failed search names where it started and where it stopped. A global install is not used for these tools.

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

`package.json`'s `expo` key already holds tooling config (`expo.install`, `expo.doctor`). It is static JSON, it is not merged into `ExpoConfig`, and it moves no hash. Rejected places:

- A top-level `app.json` key: `@expo/config` drops every top-level key beside `expo`.
- `app.json` › `expo.extra`: it changes the fingerprint, so a tooling preference would mark every development build stale.
- `agent-cli.config.js`: the config is a few scalars, and `status` must stay instant.

The module is `src/settings/`, because `src/config/` is `inspect:config-plugins`.

## Validation

Unknown keys and values are errors, not warnings: a preference that silently did nothing gives a wrong plan that looks right. A typo gets a "looks like" line. Invalid JSON in `package.json` is an error. A project with no `agent-cli` key gets no error and no warning. `buildBackend: "local"` with `deviceBackend: "eas"` on one platform is an error.

`status` catches the error, reports every other line, and exits 0, because `status` reports and does not judge.

## What `status` reports

`status` resolves the plan the same way `dev` does, so the two cannot disagree. When the next plan has a build, the report has a `build` line (`buildLocation` in JSON): a local build needs a toolchain, an EAS build needs an account and a queue. The cost is one probe, cached per process and bounded at 5 s.

## The follow-ups of a chosen backend

A follow-up never offers a route the plan already took.

- `dev --plan` on an EAS plan leads with the EAS `whoami`. `eas-build-instead` appears only for a local plan on a machine that cannot build (from `--local` or the config).
- `needs-native-build` keeps `npx @expo/agent-cli dev` first for every backend, says which route it takes and why, and offers `dev --local` second.
- A preference the plan acted on is labelled. A preference it did not act on is not.

## Testing

| Contract                                                         | Test                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| §The selection: host × toolchain × config × flag                 | `src/toolchain/__tests__/selectBackend-test.ts`                                     |
| The order the inputs are read in                                 | `src/plan/__tests__/resolveAsync-test.ts`                                           |
| The steps each backend produces                                  | `src/plan/__tests__/decide-test.ts`                                                 |
| §Validation                                                      | `src/settings/__tests__/parse-test.ts`, `read-test.ts`                              |
| Every config case and `EAS_ROUTE_NOT_CHOSEN`, end to end         | `e2e/__tests__/plan-test.ts`                                                        |
| §Who may spend EAS credits and §The device backend, by what runs | `e2e/__tests__/dev-eas-test.ts`, `smoke-test.ts`, `status-test.ts`                  |
| §Resolving the EAS CLI                                           | `e2e/__tests__/eas-runner-test.ts`, `src/lint/__tests__/easCommandSpelling-test.ts` |
| §Resolving a project-local bin                                   | `src/utils/__tests__/projectBin-test.ts`                                            |

No test covers a live `eas build` step.
