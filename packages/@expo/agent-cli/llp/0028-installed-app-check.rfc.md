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

## Proof

Unit, `src/installedApp/__tests__/`: the verdict table over every reason; the aggregate outcome; the Android reader over a stubbed `adb` (ranged read, pull fallback, not installed, no file); the simulator reader over both bundle paths; ranking across several devices.

`src/status/__tests__/installed-test.ts`: that no device is read without `--explain`, that every platform this host can reach is asked, and the shape of the section.

E2E, `e2e/__tests__/status-installed-test.ts`: a stub `adb` that serves a fixture APK byte range by byte range, with the stub `fingerprint` set to the embedded hash and then to another one; the `installed` section of `status --explain --json` in both cases, that a default `status` reads no device at all, and that `--device` without `--explain` is refused.
