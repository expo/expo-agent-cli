# 0028: `status` reads the app on the device

**Type:** RFC
**Status:** Draft
**Systems:** the check (`src/installedApp/`); the `installed` section of `status` (`src/status/installed.ts`); the zip reader (`src/utils/zipEntry.ts`); the adb package-path lookup (`src/device/androidApps.ts` §androidPackagePathsAsync); the fingerprint wrapper (`src/project/fingerprint.ts`); the app-id reader (`src/runtime/appId.ts`)
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-09-08
**Related:** [[0011-impact-and-freshness]], [[0023-fingerprint-caching]], [[0021-honest-reports]], [[0010-agent-conventions]], [[0004-smart-start-and-project-state]]

## Summary

`status` answers "do I need to build again" from a record this CLI wrote after a build it ran ([[0011-impact-and-freshness]]). The record says what the last build was made from. It does not say what is on the device. A build from EAS, a build from Xcode, a simulator that was wiped, a phone that holds last week's build: the record is silent about all of them, and `dev` treats "unrecorded" as stale.

The check asks the device instead. A debug build of an app on SDK 55 or later carries the fingerprint it was built from, in `assets/app.fingerprint` on Android and in `EXConstants.bundle/app.fingerprint` on iOS (the `expo-constants` build phase writes it; expo/expo #49905). It reads that file out of the installed app, computes the project fingerprint for the same platform, and compares the two hashes. The answer is about this project and this device, whoever made the build.

The check lives in this CLI, as a section of `status`. What stays in the expo repository is the producer side only, and only where nothing else can host it: the build-time embed (expo/expo #49905), the `Constants.fingerprint` native read (expo/expo #48922), and the dev-launcher responder (expo/expo #49494). `@expo/cli` itself is untouched. Everything else moved here, under this repository's constraints: the fingerprint comes from the project's own `fingerprint` CLI as a subprocess, and every device tool is spawned ([[0001-agentic-cli-on-expo-cli]] §Constraints item 4).

## What the answer is

One verdict per platform, reported as the `installed` section of `status --explain`:

| Reason                                                                                                                                  | Status             | `commands`                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `hash-match`                                                                                                                            | `up-to-date`       | none                                                              |
| `hash-mismatch`                                                                                                                         | `rebuild-required` | `expo run:<platform>`                                             |
| `prebuild-stale`                                                                                                                        | `rebuild-required` | `agent-cli prebuild -p <platform>`, then `expo run:<platform>`    |
| `no-device`, `app-not-installed`, `no-embedded-fingerprint`, `no-response`, `app-id-unknown`, `fingerprint-unavailable`, `check-failed` | `unknown`          | as the recommendation says                                        |

The section's `outcome` is the strongest per-platform verdict, `rebuild-required` before `unknown`
before `up-to-date`. A platform that had no reachable device does not count while another platform
produced one: a Mac with an Android emulator and no simulator answers for Android.

**This is a report, not a gate.** `status` exits `0` unless `--assert` turned it into one, and
`--assert` is about impact class, not about this. It is a section rather than a command of its own
because the question is one `status` was already answering half of: `freshness` speaks for the
build this machine recorded making, and this speaks for the build on the device. A caller that
wants to branch reads `installed.outcome` out of `--json`. If a gate turns out to be needed,
extending `--assert` is the shape to reach for, and it is a decision for a later revision of this
document.

### Reported by status

Under `--explain` only. Every answer costs a device read, and the default report is built from what
is already on this machine — the same line that keeps the EAS lookup and the OTA verdict out of it.

`status` promises to start nothing, and the physical-iPhone probe *launches the app*. So that probe
happens only when `--device <phone>` names one: naming the phone is the consent. Every other reader
— a booted simulator's container, an APK over `adb` — changes nothing on the device, so those run
under `--explain` on their own.

The section sits below `freshness`, because the two answer the same question from opposite ends.
`freshness` is about the build this machine recorded making; `installed` is about the build that is
actually on the device, whoever made it.

## How the file is read

**Android.** `adb shell pm path <appId>` names the APK on the device. The fingerprint is a zip entry inside it, so the command reads the zip's end-of-central-directory record, the central directory, and the one entry, through ranged `dd` reads over `adb exec-out`: a few hundred KB instead of a 100 MB pull. `src/utils/zipEntry.ts` is the parser. It supports stored and deflated entries and refuses ZIP64. When a device lacks `dd` or `stat`, the whole APK is pulled to a temporary directory and read there.

**iOS simulator.** `xcrun simctl get_app_container <udid> <appId>` names the app bundle, and the file is read off the disk at one of two paths: `EXConstants.bundle/app.fingerprint` for static linking, `Frameworks/EXConstants.framework/EXConstants.bundle/app.fingerprint` for `use_frameworks!`.

## Which app

The app id comes from the static app config (`ios.bundleIdentifier`, `android.package`), then from the prebuilt project (`android/app/build.gradle` `applicationId`, `ios/*.xcodeproj` `PRODUCT_BUNDLE_IDENTIFIER`), then from `--app-id`. Expo Go is never the target: it carries no project fingerprint. A project that names no id for a platform reports `app-id-unknown` for it and asks for the flag.

## Which fingerprint

`generateFingerprintAsync(projectRoot, { platform })`, the same wrapper `status` and `dev` use, so the two answers cannot disagree about the project. The embed side computes `createProjectHashAsync(projectRoot, { platforms: [platform], silent: true })`; the `fingerprint` CLI's `fingerprint:generate --platform <p>` resolves the same defaults through `normalizeOptions`, and both load the project's `.env` files through `@expo/env` before evaluating a dynamic config. A hash that matched at build time matches here.

The cache of [[0023-fingerprint-caching]] applies, with its ten-minute bound and its blindness to `ios/` and `android/`. `--no-fingerprint-cache` turns it off for one run, and the report says which source answered.

## What this cannot see

- A physical iOS device cannot be read at all yet: `devicectl` exposes no app container. Simulators and Android devices only.
- A release build embeds nothing. Only debug builds carry the file, so a release build is `no-embedded-fingerprint`.
- A build made before `expo-constants` learned to embed the file, or with `EXPO_SKIP_FINGERPRINT_EMBED` set, is the same answer.
- `expo run:ios --unstable-rebundle` removes the file rather than refreshing it, because no single fingerprint describes that binary.
- `@expo/fingerprint` hashes an allowlist of asset paths. An asset a plugin reads that is not on that list moves nothing, so a rebuild the app needs for it is not reported.
- The prebuild marker ([[#The prebuild marker]]) is only written by prebuilds this CLI runs.

## The prebuild marker

A stale `android/` or `ios/` directory needs `prebuild` before the build. A plain rebuild would compile the old directories and embed the new hash, and the mismatch would vanish while the problem stayed.

**This CLI records what prebuild generated, from the one place that knows it ran.** `expo prebuild` writes nothing, so the record is made by the `prebuild` passthrough here, after a run that exited 0. One file per platform at `.expo/prebuild/fingerprint-<platform>.json`, holding `{version: 1, platform, hash, sources, fingerprintVersion, createdAt}`. A file is believed only when the version is 1, the platform is the one being asked about, the hash is a string and the sources are an array.

The cost is that a prebuild run as `npx expo prebuild`, outside this CLI, records nothing. That reads as `unknown`, which falls through to the plain rebuild advice — coarser, never wrong. Recording is best effort in every other way too: a hash that cannot be computed or a file that cannot be written leaves no marker and never fails the prebuild. Only a platform whose native directory exists after the run is recorded, so a marker never describes a directory that is not there.

Reading rather than writing is the whole point. Only `expo prebuild` knows that it ran, and `dev` runs it as a subprocess, so the record exists either way — while a prebuild somebody ran by hand now counts too, which a marker of this CLI's own could never see.

The check compares the sources whose `reasons` prebuild owns (`expoConfig`, `expoConfigPlugins`, `expoConfigExternalFile`, `expoCNGPatches`) against the marker. A difference is `prebuild-stale`, and the report names the project sources that moved. A project with a native directory and no marker is `unknown` for staleness and falls through to the plain rebuild advice; a project without the directory is `not-applicable`. A project whose `expo` predates the marker is the same `unknown`.

The marker is advisory, like the last-build record: a missing or unreadable file costs a detail of the verdict, never the command.

## Proof

Unit, `src/installedApp/__tests__/`: the verdict table over every reason; the aggregate outcome; the Android reader over a stubbed `adb` (ranged read, pull fallback, not installed, no file); the simulator reader over both bundle paths; ranking across several devices; the `prebuild-stale` verdict, decided without waiting for the device. `src/project/__tests__/prebuildMarker-test.ts`: the staleness comparison (fresh, stale with named project sources, a dependency-only change, a version mismatch, no marker, no native directory), the reader over a planted marker file, the writer's own round trip, and one rejection per field of its schema. `src/utils/__tests__/zipEntry-test.ts`: both compression methods, the EOCD-in-comment case, the ZIP64 refusals, and the ranged sequence over partial buffers.

`src/status/__tests__/installed-test.ts`: that no device is read without `--explain`, that no phone is named unless the caller named one, and the shape of the section.

E2E, `e2e/__tests__/status-installed-test.ts`: a stub `adb` that serves a fixture APK byte range by byte range, with the stub `fingerprint` set to the embedded hash and then to another one; the `installed` section of `status --explain --json` in both cases, that a default `status` reads no device at all, and that `--device` without `--explain` is refused.
