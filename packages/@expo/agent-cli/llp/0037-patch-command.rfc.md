# 0037: The `patch` command

**Type:** RFC
**Status:** Draft
**Systems:** a new top-level `patch` command (`src/patch/`); package-manager detection (`src/utils/packageManager.ts`, new, on top of `@expo/package-manager`); `expo.autolinking.*.buildFromSource` in the project `package.json`; the follow-up block (`src/followups/patch.ts`); `gh` and `git` as subprocesses
**Author:** Kudo (drafted with Claude agent)
**Date:** 2026-11-17
**Related:** [[0006-agent-native-cli-surface]], [[0008-guardrails]], [[0009-smart-followups]], [[0010-agent-conventions]], [[0011-impact-and-freshness]], [[0017-deferred-commands.reference]]

## Summary

An agent that finds a bug in a dependency has two bad options today. It edits `node_modules` and the fix is lost on the next install. Or it gives up. This RFC adds one `patch` command. It keeps a fix to a dependency, makes the native build use it, and offers to send the fix upstream to `expo/expo`.

Three requirements:

1. Use the patch feature of the package manager when it has one (bun, pnpm, yarn berry, npm 12). Otherwise use `patch-package`.
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

Detection uses `@expo/package-manager` (`resolvePackageManager` and `resolveWorkspaceRoot`), as `install` does, so the CLI and `expo install` pick the same package manager. That package has one `yarn`; the CLI splits it into yarn classic and yarn berry, because only berry has a patch command. A package manager that `patch` does not support (nub) gets an error.

The CLI always writes the patch through the package manager's own commands, so the format and the registration are the ones the package manager expects. Where the package manager needs its own edit directory, the CLI makes that directory and copies the agent's edits into it.

| Package manager                                        | What `patch <pkg>` runs                                                                                                                                                                                                         | Where the patch is recorded                                                                                                                                | Tested                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| bun                                                    | Copy the edited package aside, `bun patch <pkg>` (a clean, unlinked copy), copy the edited files back, then `bun patch --commit node_modules/<pkg>`                                                                             | `patches/`, `patchedDependencies` in `package.json`                                                                                                        | yes, bun 1.4.4, macOS (2026-11-18)                                                                                  |
| pnpm                                                   | `pnpm patch <pkg>@<version> --edit-dir <tmp>`, copy the edited files into `<tmp>`, then `pnpm patch-commit <tmp>`                                                                                                               | `patches/`, `patchedDependencies` in `pnpm-workspace.yaml`                                                                                                 | yes, pnpm 12.2.1, macOS (2026-11-17)                                                                                |
| yarn berry                                             | `yarn patch <pkg> --json`, copy the edited files into its `path` (the text output colors the path), then `yarn patch-commit -s <path>`                                                                                          | `.yarn/patches/`, a `patch:` resolution                                                                                                                    | yes, yarn 4.18.1, macOS (2026-11-18)                                                                                |
| npm 12                                                 | `npm patch add <pkg>@<version> --edit-dir <tmp>`, copy the edited files into `<tmp>`, then `npm patch commit <tmp>`. npm refuses a package that is not from the registry (`EPATCHNONREGISTRY`); that package takes the next row | `patches/`, `patchedDependencies` in `package.json`; applied by `npm install`                                                                              | yes, npm 12.2.3, macOS (2026-11-18)                                                                                 |
| npm without `npm patch` or refused by it, yarn classic | The CLI writes the patch itself in patch-package's format (`patches/<pkg>+<version>.patch`, with `/` in a scoped name as `+`, paths from `node_modules/<pkg>/`), from a clean copy made with `npm pack <spec>`                  | `patches/`, plus a `postinstall` of `patch-package --error-on-fail` and a `patch-package` dev dependency; yarn classic also gets `postinstall-postinstall` | yes, npm 11.20.0, npm 12.2.3 (refused package) and yarn 1.22.22, patch-package 8.0.1 applies it, macOS (2026-11-19) |

Why the patch-package path does not run `patch-package` to make the patch: patch-package 8.0.1 makes its clean copy by installing `<name>@<version>` from the registry, so it failed (exit 254) on a package installed from a `file:` tarball [observed — 2026-11-17]. `npm pack` of the spec in `package-lock.json` (npm) or the `resolved` field of `yarn.lock` (yarn classic, with the commit of a git URL kept) works for registry, tarball and git dependencies. patch-package still applies the patch at `postinstall`.

Observed: `pnpm patch-commit node_modules/<pkg>` fails with "is not a valid patch directory", so pnpm needs the edit directory step above. `bun patch --commit` records every difference between `node_modules/<pkg>` and bun's cache, and `bun patch <pkg>` replaces an edited folder with a clean copy, so bun needs the copy-aside step. npm 11 has no `npm patch`; npm 12 answers `npm patch --help` with exit 0.

yarn classic needs `postinstall-postinstall` because `yarn remove` replaces `node_modules` and does not run the root `postinstall`, which drops the patches (patch-package README).

Rules:

- Yarn classic and yarn berry both have `yarn.lock`. Tell them apart by `.yarnrc.yml` or a `packageManager` field of `yarn@2` or later.
- The patch is the whole difference from the clean package, also generated files that already differed before the agent's edit: with no state file, the CLI cannot tell the two apart. Copy only the files that differ into the clean tree, so the clean tree is not replaced as a whole.
- bun: after `bun patch <pkg>`, the copy aside is the only copy of the edits. If any later step fails, put it back into `node_modules/<pkg>` before the error is reported.
- npm with `npm patch` uses it, unless the project already has patch-package (a `postinstall` or a dependency): two patch systems would apply the same patches twice.
- The patch-package path makes the patch with git, in a scratch repository: one tree of the clean files and one of the edits, both at `node_modules/<pkg>/`. So every header, also of an added or a removed file, has the real path, and no line is rewritten afterwards. The user's git config is not read (`core.autocrlf`, `diff.noprefix` and `core.quotepath` change the bytes). A binary edit is refused (patch-package cannot apply one), and the saved bytes are checked with `git apply` against the clean tree.
- Linked files: on macOS, bun and pnpm gave each file in `node_modules` a link count of 1 (observed). On Linux they can use hard links to a global store, where an edit in place also changes the store (not tested). If a package file has a link count above 1, do not save the patch. Report that the store is linked and give the steps to reinstall the package and edit again.
- The `patch-package` path changes `package.json` (a `postinstall` script and dev dependencies). That is work the caller did not ask for (llp/0008 §The plan is announced, not negotiated, the `doctor:fix` line), so without `--yes`, `patch <pkg>` writes nothing and exits 1 (`PATCH_NEEDS_CONSENT`), with the changes in the message and `error.data`, and the same command plus `--yes` as `Try:`. It is exit 1 and not 0, because the agent reads the exit code first, and the fix is in the call. An existing `postinstall` is kept, and `&& patch-package --error-on-fail` is added after it.
- Never fall back silently. If bun is the manager but `bun patch` fails, report the failure. Do not switch to `patch-package`, because two patch systems in one project apply the same diff twice. The one fallback is npm 12 for a package `npm patch` refuses: npm cannot hold a patch for that package, so no diff is applied twice. The consent message names the reason, and it needs `--yes` as the patch-package path always does.

## Expo modules: build from source

Since SDK 53 (Android) and SDK 56 (iOS), Expo modules link precompiled binaries. A patch to their native code has no effect, because the binary does not contain it.

**Correction to the request.** The request says "exclude autolinking". `expo.autolinking.<platform>.exclude` removes the module from the app completely, and the app then fails at runtime. The correct key is `buildFromSource` (docs: `guides/prebuilt-expo-modules.mdx`, `modules/autolinking.mdx`). It keeps the module linked and compiles it from source.

On `patch <pkg>`:

1. The package is an Expo module if it has `expo-module.config.json`.
2. Classify the diff by file. The top directory decides first: `ios/`, `apple/` and `macos/` are iOS, `android/` is Android. Outside them, `.swift`, `.m`, `.mm` and `.podspec` are iOS, `.kt`, `.java`, `.gradle` and `CMakeLists.txt` are Android, and C and C++ sources and headers (`.c`, `.cpp`, `.h`, `.hpp`) are both, because a shared directory is compiled into both.
3. For each platform the diff touches, add the package to `expo.autolinking.<platform>.buildFromSource`. Keep the existing entries. Do nothing when an existing regex such as `".*"` already matches.
4. A JS-only patch changes nothing in autolinking.

**Decision (2026-11-18): third-party precompiled XCFrameworks are an iOS rule.** EAS downloads XCFrameworks for `react-native-reanimated` and `react-native-worklets`, and building only one of them from source fails at runtime (`guides/prebuilt-expo-modules.mdx`). The guide names `ios.buildFromSource` only, and a local build already compiles them from source. So an iOS patch to either one adds both to `ios.buildFromSource`, and an Android patch to them adds nothing. Keep the pair table in one place.

## Impact and follow-ups

The follow-up comes from the diff, not from the fingerprint. `@expo/fingerprint` hashes the whole `patches/` directory as one source (reason `patchPackage`), and llp/0011 maps that reason to a native rebuild, so every bun, pnpm, npm or patch-package patch moves the fingerprint, also a JS-only one. yarn berry writes `.yarn/patches/`, which that source does not read, so a yarn patch moves the fingerprint only through `buildFromSource`. Follow-ups for `patch <pkg>` (llp/0009):

1. **Native change:** `dev`, because the running build does not contain the patch. If the project targets Expo Go, say that Expo Go cannot load a patched native module, and that a development build is required. **JS-only change:** `runtime:reload`. When the patch is under `patches/`, its `why` says that `status` can still report a native fingerprint change, and that no new build is needed.
2. **Package from `expo/expo`:** `patch <pkg> --upstream-plan`. The `why` text says the fix can go upstream, that the plan opens nothing, and to ask the user before following it. Detect the source from `repository.url` in the package `package.json`.

No `typecheck` follow-up: `install` has one because a new package brings new types, and a patch adds no package.

## `patch --upstream-plan`: a brief for the PR to `expo/expo`

**Decision (2026-11-17, Kudo): the CLI plans the PR and never opens it.** An earlier draft had `--upstream --yes` fork, clone, commit and run `gh pr create`. It was dropped for three reasons:

- The hard part of an upstream fix is not the fork and the `gh` call. It is moving the fix to `main`, building it and testing it in the monorepo. A patch made against a published version can fail to apply on `main`, and this CLI cannot test that.
- Agents already use `git` and `gh` well. A command that hides those steps leaves the agent with less to work with when one of them fails.
- A one-command PR makes it easy to send fixes nobody tested, and that costs the maintainers of `expo/expo`.

What only this CLI knows is the mapping from the installed package to the repository. So `--upstream-plan` prints that and the steps, and exits 0. It is not exit 7: llp/0010 keeps 7 for a step only a person can finish, and these steps are agent work after the user says yes, which step 1 asks for. The name says that the run opens nothing, and it takes no `--yes` (`BAD_ARGS` if given). The output can be long, because a caller asks for a plan on purpose and it is not printed on every `patch` run.

The patch file is the one the package manager registered for this name and version: `patchedDependencies` (bun, npm 12, pnpm in `pnpm-workspace.yaml` or `package.json`), the `patch:` descriptor (yarn berry), or `patches/<name>+<version>.patch` (patch-package). The CLI does not guess from file names, because each manager encodes a scoped name differently, and two versions can have patches. Among the registrations for the name, a spec that is an exact version other than the installed one never matches, also when it is the only one. Of the rest, the CLI takes an exact match of the installed version first, then a semver range that contains it, then a spec that is not a version (yarn's descriptor, a pnpm key with no version, a bun `file:` locator). The patch-package file counts only when nothing is registered. `PATCH_NOT_FOUND` when nothing matches, and `PATCH_AMBIGUOUS` when the best kind has more than one file.

`repository.url` must name `github.com/expo/expo` with a boundary before the host. `repository.directory` must be a relative path with no `..` segment, because it goes into a shell line.

The plan (`--json`: one `upstream` object):

| Field                                   | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patchFile`, `files`                    | The saved patch, and each changed file with its path in `expo/expo`. A file under a `build/` directory at any depth (`build/`, `plugin/build/`) has no target and a `portTo` source file instead, because `expo/expo` ignores `/packages/**/build/` (its `.gitignore`).                                                                                                                                                                                        |
| `base`                                  | `gitHead` of the installed package when it is a 40-character commit sha, else `main`. It goes into a shell line, so nothing else is accepted.                                                                                                                                                                                                                                                                                                                  |
| `platforms`                             | The `[iOS]` / `[Android]` tags of the diff.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `repro`, `missing`                      | The URL of the repro repository from `--repro <url>` (exactly `https://github.com/<owner>/<repo>`, with an optional `.git` or `/`, else `BAD_ARGS`), and what is still missing (the repro, a `build/` change to port).                                                                                                                                                                                                                                         |
| `reproGuide`                            | How to make a minimal repro and upload it. See below.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `gh`                                    | Whether `gh` is on `PATH`. The CLI only looks it up and never runs it. Without `gh`, the steps use `git` and github.com pages, and the user does the fork, the repository and the pull request in a browser.                                                                                                                                                                                                                                                   |
| `applyCommand`                          | `git apply` for the saved patch, run from the root of an `expo/expo` clone. It strips the patch's own prefix (`a/`, or patch-package's `a/node_modules/<pkg>/`), puts the files under `repository.directory` (`--directory`, e.g. `packages/@expo/image`, which need not be the npm name), and excludes every `build/` directory (`--exclude=<dir>/build/**` and `--exclude=<dir>/**/build/**`: git 2.54 does not match a top-level `build/` with the second). |
| `steps`                                 | In order: ask the user (a PR, an issue with the repro, or nothing); read and follow `AGENTS.md` and `CONTRIBUTING.md` of `expo/expo`; make the repro, or check the one given; fork and clone; switch to `base`; apply; port `build/` changes; rebase on `main`, and stop if `main` already fixes it; check and record the change as `AGENTS.md` says; write the body from the PR template, push, and `gh pr create --draft`, or `gh issue create`.             |
| `guides`, `prTemplate`, `issueTemplate` | Links to `AGENTS.md`, `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE` and `.github/ISSUE_TEMPLATE/0-bug_report.yml` on `expo/expo` `main`.                                                                                                                                                                                                                                                                                                                  |

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

`e2e/__tests__/patch-test.ts` runs the real package managers against two fake packages, packed from `e2e/fixtures/patch-packages/` into local tarballs. The test installs bun, pnpm, npm 11, npm 12, yarn 1 and yarn 4 from the npm registry at pinned versions, so no manager is skipped, on CI or on a machine that does not have it. npm 12 patches a small registry package, because it refuses a tarball. Each saved patch is checked by deleting `node_modules` and installing again.

| Rule                                                                                                                             | Test                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| bun, pnpm, yarn 4, npm 12, npm 11 and yarn 1 save a patch that a fresh install applies                                           | `patch — bun`, `patch — pnpm`, `patch — yarn4`, `patch — npm 12`, `patch — npm`, `patch — yarn1` |
| npm 11 and yarn 1 exit 1 with the `--yes` line and write nothing without `--yes`; yarn 1 also gets `postinstall-postinstall`     | `patch — npm`, `patch — yarn1`                                                                   |
| The patch-package path refuses a binary edit; its patch of a changed, an added and a removed file is applied by patch-package    | `patch — npm`, `patch — yarn1`                                                                   |
| npm 12 takes the patch-package path, behind `--yes`, for a package `npm patch` refuses                                           | `patch — npm 12`                                                                                 |
| A symlink is compared by its target; a failed bun save puts the edits back from the copy aside                                   | `tree-test.ts` (the copy and restore, not the bun wiring)                                        |
| The registered patch lookup, the URL checks, `repository.directory`, `gitHead` and the `build/` mapping                          | `upstream-test.ts` (unit tables)                                                                 |
| A native patch to a precompiled module adds `buildFromSource` for that platform only, and keeps an entry that already matches    | `patch — bun`                                                                                    |
| A file's platform comes from its directory first; the reanimated/worklets pair is iOS only; a git `resolved` keeps its commit    | `buildFromSource-test.ts`, `backends-test.ts` (unit tables)                                      |
| No edits and hard-linked files are refused                                                                                       | `patch — bun`                                                                                    |
| `--upstream-plan` opens nothing, exits 0, and refuses `--yes` and a package not from `expo/expo`                                 | `patch --upstream-plan`                                                                          |
| `applyCommand` applies both patch formats inside an `expo/expo` clone, under a folder that is not the npm name, without `build/` | `patch --upstream-plan` (a stand-in git repository)                                              |
| `--repro` takes only a GitHub repository URL; the plan says whether `gh` is installed                                            | `patch --upstream-plan`                                                                          |

## Open questions

1. Is `patch` a v1 command, or does it go in as `unstable`? Decided (2026-11-18): a v1 command, with no `unstable` mark, because the e2e runs bun, pnpm, yarn 4, npm and yarn 1 on CI.
2. Should `patch <pkg>` remove the `buildFromSource` entry when the last native patch for a package is removed? Recommendation: yes, but only entries that the CLI added. Record them in `.expo/agent-cli-patch.json`.
3. Should `--upstream-plan` also support third-party repos (from `repository.url`)? Recommendation: not in the first version. Start with `expo/expo` only.
