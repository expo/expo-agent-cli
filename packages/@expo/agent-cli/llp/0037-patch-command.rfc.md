# 0037: The `patch` command

**Type:** RFC
**Status:** Draft
**Systems:** a new top-level `patch` command (`src/patch/`); package-manager detection (`src/utils/packageManager.ts`, new; the deferred `doctor-fix` keeps its own); `expo.autolinking.*.buildFromSource` in the project `package.json`; the follow-up block (`src/followups/patch.ts`); `gh` and `git` as subprocesses
**Author:** Kudo (drafted with Claude agent)
**Date:** 2026-11-17
**Related:** [[0006-agent-native-cli-surface]], [[0008-guardrails]], [[0009-smart-followups]], [[0010-agent-conventions]], [[0011-impact-and-freshness]], [[0017-deferred-commands.reference]]

## Summary

An agent that finds a bug in a dependency has two bad options today. It edits `node_modules` and the fix is lost on the next install. Or it gives up. This RFC adds one `patch` command. It keeps a fix to a dependency, makes the native build use it, and offers to send the fix upstream to `expo/expo`.

Three requirements:

1. Use the patch feature of the package manager when it has one (bun, pnpm, yarn berry). Otherwise use `patch-package`.
2. When the patched package is an Expo module with native changes, build it from source instead of the precompiled binary.
3. When the patched package comes from `expo/expo`, the follow-up offers a PR with a repro. The user decides if the PR is opened.

## Command surface

One top-level command, `patch`, and one stage for the agent:

1. The agent edits the files in `node_modules/<pkg>` directly.
2. The agent runs `patch <pkg>`. The CLI saves the edits as a patch with the package manager's own patch feature, and registers it.

| Invocation                                     | What it does                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `patch <pkg>`                                  | Saves the edits in `node_modules/<pkg>` as a patch. Updates `buildFromSource` when needed. Prints follow-ups. |
| `patch <pkg> --upstream-plan [--repro <file>]` | Prints a plan for a PR to `expo/expo` from the saved patch. Opens nothing.                                    |

Both support `--json`. There is no list command: the patches are already in `package.json` and `patches/`. There is no prepare step and no state file. If the CLI finds no edits, it reports that and does nothing.

## Package-manager backends

Detection reuses the lockfile table in `src/deferred/doctor-fix/packageManager.ts`. Move it to `src/utils/` and make it live code. It already walks up to the workspace root.

The CLI always writes the patch through the package manager's own commands, so the format and the registration are the ones the package manager expects. Where the package manager needs its own edit directory, the CLI makes that directory and copies the agent's edits into it.

| Package manager   | What `patch <pkg>` runs                                                                                                                                                      | Where the patch is recorded                                                                 | Tested                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| bun               | `bun patch --commit node_modules/<pkg>`                                                                                                                                      | `patches/`, `patchedDependencies` in `package.json`                                         | yes, bun 1.4.4, macOS (2026-11-17)            |
| pnpm              | `pnpm patch <pkg>@<version> --edit-dir <tmp>`, copy the edited files into `<tmp>`, then `pnpm patch-commit <tmp>`                                                            | `patches/`, `patchedDependencies` in `pnpm-workspace.yaml`                                  | yes, pnpm 12.2.1, macOS (2026-11-17)          |
| yarn berry        | `yarn patch <pkg>`, copy the edited files into the printed directory, then `yarn patch-commit -s <dir>`                                                                      | `.yarn/patches/`, a `patch:` resolution                                                     | yes, yarn 4.18.1, macOS (2026-11-18)          |
| npm, yarn classic | The CLI writes the patch itself in patch-package's format (`patches/<pkg>+<version>.patch`, paths from `node_modules/<pkg>/`), from a clean copy made with `npm pack <spec>` | `patches/`, plus a `postinstall: patch-package` script and a `patch-package` dev dependency | yes, npm and yarn 1.22.22, macOS (2026-11-18) |

Why the npm backend does not run `patch-package` to make the patch: patch-package 8.0.1 makes its clean copy by installing `<name>@<version>` from the registry, so it failed (exit 254) on a package installed from a `file:` tarball [observed — 2026-11-17]. `npm pack` of the spec in `package-lock.json` (npm) or the `resolved` field of `yarn.lock` (yarn classic) works for registry, tarball and git dependencies. patch-package still applies the patch at `postinstall`.

Observed: `bun patch --commit` works without a prior `bun patch <pkg>`. `pnpm patch-commit node_modules/<pkg>` fails with "is not a valid patch directory", so pnpm needs the edit directory step above.

Rules:

- Yarn classic and yarn berry both have `yarn.lock`. Tell them apart by `.yarnrc.yml` or a `packageManager` field of `yarn@2` or later.
- Copy only the files that differ from the clean package. Do not copy the whole package, because build output in `node_modules` can differ for other reasons.
- Linked files: on macOS, bun and pnpm gave each file in `node_modules` a link count of 1 (observed). On Linux they can use hard links to a global store, where an edit in place also changes the store (not tested). If a package file has a link count above 1, do not save the patch. Report that the store is linked and give the steps to reinstall the package and edit again.
- The `patch-package` path changes `package.json` (a `postinstall` script and a dev dependency). That is a project change the caller did not ask for, so it needs consent: without `--yes`, `patch <pkg>` prints the plan and the re-run line (llp/0008 §Consent is a re-run, never a prompt).
- Never fall back silently. If bun is the manager but `bun patch` fails, report the failure. Do not switch to `patch-package`, because two patch systems in one project apply the same diff twice.

## Expo modules: build from source

Since SDK 53 (Android) and SDK 56 (iOS), Expo modules link precompiled binaries. A patch to their native code has no effect, because the binary does not contain it.

**Correction to the request.** The request says "exclude autolinking". `expo.autolinking.<platform>.exclude` removes the module from the app completely, and the app then fails at runtime. The correct key is `buildFromSource` (docs: `guides/prebuilt-expo-modules.mdx`, `modules/autolinking.mdx`). It keeps the module linked and compiles it from source.

On `patch <pkg>`:

1. The package is an Expo module if it has `expo-module.config.json`.
2. Classify the diff. Native files are under `ios/`, `android/`, or have a native extension (`.swift`, `.m`, `.mm`, `.h`, `.kt`, `.java`, `.cpp`, `.podspec`, `build.gradle`).
3. If the diff has native files, add the package to `expo.autolinking.ios.buildFromSource` and `expo.autolinking.android.buildFromSource`. Add only the platform that the diff touches. Keep the existing entries. Do nothing when an existing regex such as `".*"` already matches.
4. Pairs that must move together: `react-native-reanimated` and `react-native-worklets`. The docs say a mixed linkage fails at runtime. Keep the pair table in one place.
5. A JS-only patch changes nothing in autolinking.

Open: whether `buildFromSource` is needed for third-party (non-Expo) modules that EAS downloads precompiled (reanimated, worklets). The docs say EAS uses precompiled XCFrameworks for these. Treat them the same as Expo modules.

## Impact and follow-ups

The patch changes the fingerprint when it has native files or when `buildFromSource` changed. Reuse the impact classifier (llp/0011). Follow-ups for `patch <pkg>`, at most three (llp/0009):

1. **Native change:** `dev`, because the running build does not contain the patch. If the project targets Expo Go, say that Expo Go cannot load a patched native module, and that a development build is required. **JS-only change:** `runtime:reload`.
2. **Package from `expo/expo`:** `patch <pkg> --upstream-plan`. The `why` text says the fix can go upstream, that the plan opens nothing, and to ask the user before following it. Detect the source from `repository.url` in the package `package.json`.
3. `typecheck`, as for `install`.

## `patch --upstream-plan`: a brief for the PR to `expo/expo`

**Decision (2026-11-17, Kudo): the CLI plans the PR and never opens it.** An earlier draft had `--upstream --yes` fork, clone, commit and run `gh pr create`. It was dropped for three reasons:

- The hard part of an upstream fix is not the fork and the `gh` call. It is moving the fix to `main`, building it and testing it in the monorepo. A patch made against a published version can fail to apply on `main`, and this CLI cannot test that.
- Agents already use `git` and `gh` well. A command that hides those steps leaves the agent with less to work with when one of them fails.
- A one-command PR makes it easy to send fixes nobody tested, and that costs the maintainers of `expo/expo`.

What only this CLI knows is the mapping from the installed package to the repository. So `--upstream-plan` prints that and the steps, and exits 7 (needs human, llp/0010). The name says that the run opens nothing, and it takes no `--yes` (`BAD_ARGS` if given). The output can be long, because a caller asks for a plan on purpose and it is not printed on every `patch` run.

The plan (`--json`: one `upstream` object):

| Field                                   | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patchFile`, `files`                    | The saved patch, and each changed file with its path in `expo/expo`. A `build/` file has no target and a `portTo` source file instead, because `build/` is not in the repository (expo/expo `CONTRIBUTING.md`).                                                                                                                                                                                                                                    |
| `base`                                  | `gitHead` of the installed package, or `main` when it has none.                                                                                                                                                                                                                                                                                                                                                                                    |
| `platforms`                             | The `[iOS]` / `[Android]` tags of the diff.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `repro`, `missing`                      | The URL of the repro repository from `--repro <url>` (a `https://github.com/<owner>/<repo>` URL, else `BAD_ARGS`), and what is still missing (the repro, a `build/` change to port).                                                                                                                                                                                                                                                               |
| `reproGuide`                            | How to make a minimal repro and upload it. See below.                                                                                                                                                                                                                                                                                                                                                                                              |
| `gh`                                    | Whether `gh` is on `PATH`. The CLI only looks it up and never runs it. Without `gh`, the steps use `git` and github.com pages, and the user does the fork, the repository and the pull request in a browser.                                                                                                                                                                                                                                       |
| `applyCommand`                          | `git apply` for the saved patch, from the root of an `expo/expo` clone. It strips patch-package's `node_modules/<pkg>/` prefix and excludes `build/`.                                                                                                                                                                                                                                                                                              |
| `steps`                                 | In order: ask the user (a PR, an issue with the repro, or nothing); read and follow `AGENTS.md` and `CONTRIBUTING.md` of `expo/expo`; make the repro, or check the one given; fork and clone; switch to `base`; apply; port `build/` changes; rebase on `main`, and stop if `main` already fixes it; check and record the change as `AGENTS.md` says; write the body from the PR template, push, and `gh pr create --draft`, or `gh issue create`. |
| `guides`, `prTemplate`, `issueTemplate` | Links to `AGENTS.md`, `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE` and `.github/ISSUE_TEMPLATE/0-bug_report.yml` on `expo/expo` `main`.                                                                                                                                                                                                                                                                                                      |

**Decision (2026-11-18, Kudo): link the `expo/expo` guides, do not copy them.** The first version copied the PR template and wrote a `CHANGELOG.md` line. On 2026-11-18 `expo/expo` already had a different template (with `Screenshots` and a changeset item), and its `AGENTS.md` says not to edit `CHANGELOG.md`. So the plan keeps only what this CLI computes, and step 2 tells the agent to read and follow the repository's own rules. Where they differ from the plan, they win.

**Decision (2026-11-18, Kudo): the repro is a public GitHub repository.** `expo/expo` bug reports ask for a link to a minimal repository, made from a new blank app, and say that an issue without one can be closed. So `--repro` takes a URL, not a text file. The repro guide follows the usual rules for a minimal reproducible example:

- Read the `expo/expo` bug report form (`.github/ISSUE_TEMPLATE/0-bug_report.yml`). The repro fills its "Minimal reproducible example" field, and the README fills its other fields: "Steps to reproduce", "Environment" (`npx expo-env-info`) and "Expo Doctor Diagnostics" (`npx expo-doctor@latest`). An issue made instead of a pull request uses the same fields.
- Name it for the bug, not for the package alone: the package and what fails, e.g. `expo-image-crash-on-rotate`. A name like `<package>-repro` says nothing about the bug.
- Start from a new app on the project's SDK (`npx create-expo-app@latest <name> --template blank@sdk-<N>`), not from the user's app, which can hold private code, keys and assets.
- Minimal: only the package and the fewest lines that show the bug. Remove one thing at a time, and check that the bug stays. If the bug needs a library that Expo does not maintain, try to show it without that library (the form asks for this).
- It shows the bug, so it has no patch.
- Complete: it runs from a fresh clone, with no private packages, `.env` files, keys or local paths.
- Reproducible: clone it, run it, see the bug. `npx expo-doctor@latest` shows no errors.
- A README with the steps, platforms, environment, package manager, expected and actual result, and `npx expo-env-info`.
- Upload it to a public repository, after the user says yes (`gh repo create --public`, or https://github.com/new without `gh`).

The repro repository is public too, so step 1 asks the user about it with the pull request.

## Where the detail lives

| What                                  | Where                                                  |
| ------------------------------------- | ------------------------------------------------------ |
| The command, its flags and its checks | `src/patch/index.ts`                                   |
| Saving with each package manager      | `src/patch/backends.ts`, `src/utils/packageManager.ts` |
| The link guard and the tree diff      | `src/patch/tree.ts`                                    |
| `buildFromSource`                     | `src/patch/buildFromSource.ts`                         |
| The follow-ups                        | `src/followups/patch.ts`                               |
| The upstream plan                     | `src/patch/upstream.ts`                                |

Not built yet: the `dev` follow-up names Expo Go in its text, but does not read the project's target.

## Testing (llp/0002)

`e2e/__tests__/patch-test.ts` runs the real package managers against two fake packages, packed from `e2e/fixtures/patch-packages/` into local tarballs. The test installs pnpm, yarn 1 and yarn 4 from the npm registry at pinned versions, so no manager is skipped, on CI or on a machine that does not have it. Each saved patch is checked by deleting `node_modules` and installing again.

| Rule                                                                                                                          | Test                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| bun, pnpm, yarn 4, npm and yarn 1 save a patch that a fresh install applies                                                   | `patch — bun`, `patch — pnpm`, `patch — yarn4`, `patch — npm`, `patch — yarn1` |
| npm and yarn 1 write nothing to `package.json` without `--yes`                                                                | `patch — npm`, `patch — yarn1`                                                 |
| A native patch to a precompiled module adds `buildFromSource` for that platform only, and keeps an entry that already matches | `patch — bun`                                                                  |
| No edits and hard-linked files are refused                                                                                    | `patch — bun`                                                                  |
| `--upstream-plan` opens nothing, exits 7, and refuses `--yes` and a package not from `expo/expo`                              | `patch --upstream-plan`                                                        |
| `applyCommand` applies both patch formats inside an `expo/expo` clone, without `build/`                                       | `patch --upstream-plan` (a stand-in git repository)                            |
| `--repro` takes only a GitHub repository URL; the steps work without `gh`                                                     | `patch --upstream-plan`                                                        |

## Open questions

1. Is `patch` a v1 command, or does it go in as `unstable`? Decided for now: `unstable`, until the e2e covers yarn berry and pnpm runs on CI.
2. Should `patch <pkg>` remove the `buildFromSource` entry when the last native patch for a package is removed? Recommendation: yes, but only entries that the CLI added. Record them in `.expo/agent-cli-patch.json`.
3. Should `--upstream-plan` also support third-party repos (from `repository.url`)? Recommendation: not in the first version. Start with `expo/expo` only.
