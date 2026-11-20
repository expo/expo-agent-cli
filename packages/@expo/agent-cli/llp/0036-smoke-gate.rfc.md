# 0036: Smoke gate

**Type:** RFC
**Status:** Active
**Systems:** `@expo/agent-cli smoke` (`src/smoke/`, `src/device/screenshot.ts`, `src/device/bootDevice.ts`, `src/device/installedApps.ts`, `src/device/installExpoGo.ts`, `src/device/expoGoVersion.ts`, `src/device/approveScheme.ts`)
**Related:** [[0005-runtime-loop-tools]], [[0016-v1-scope]], [[0021-honest-reports]], [[0022-live-tier]], [[0027-everything-on-eas]], [[0035-one-device-per-worktree]]

`smoke` asks the questions of the runtime commands in one process. The runtime commands, the scope rules and the reload proof that it reuses are [[0005-runtime-loop-tools]].

## The smoke gate

`@expo/agent-cli smoke` answers "does this app still boot". It asks the questions of the other runtime commands in one process, and it adds a picture of the screen ([[0016-v1-scope]]). Rejected: a `smoke` built from subprocesses of this CLI. Each subprocess would discover the dev server again, and on a machine with two projects the answers can disagree.

The run has 13 phases, in this order. A conditional phase is in the report only when the run performed it (§The run brings its own environment). Any other phase that did not run is `skipped`, with a reason.

| #   | phase              | question                                                   | conditional       | budget                                                                                                                    | effect on the verdict                                                                                                                                                  |
| --- | ------------------ | ---------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `start-dev-server` | Did this run start a dev server?                           | yes               | 2 min; 30 min when the plan builds (§It builds what the app needs, and says so first)                                     | failed start: `failed`                                                                                                                                                 |
| 2   | `dev-server`       | Is a dev server answering?                                 | no                | an 800 ms look, again after a start                                                                                       | none: `failed`                                                                                                                                                         |
| 3   | `bundler-ready`    | Is the bundler ready, and does it serve this project?      | no                | 3 min on a dev server this run started, else `--timeout`                                                                  | another project, or an answer that is not ready (non-2xx, a body that is not `packager-status:running`, a TLS failure, `ENOTFOUND`): `failed`; expired: `inconclusive` |
| 4   | `bundle`           | Does this project's entry bundle compile for the platform? | no                | as `bundler-ready`                                                                                                        | broken: `failed`; expired: `inconclusive`; no answer: `inconclusive`, and the run goes on                                                                              |
| 5   | `start-session`    | Is an EAS session up for this run?                         | yes, `--eas` only | 15 min                                                                                                                    | no session: `failed`                                                                                                                                                   |
| 6   | `boot-device`      | Did this run boot a simulator or an emulator?              | yes               | 2 min on iOS, 4 min on Android                                                                                            | no device: `failed`                                                                                                                                                    |
| 7   | `install-app`      | Did this run put the app on the device?                    | yes               | 30 min                                                                                                                    | failed: `failed`                                                                                                                                                       |
| 8   | `app`              | Is an app attached, or does one attach when opened?        | no                | a 2 s look; then one budget for the open and the attach wait: 2 min on a cold environment this run made, else `--timeout` | link refused: `failed`; nothing attached, no device to open an app on, or app mismatch: `inconclusive` (§Two mismatches, two next actions)                             |
| 9   | `reload`           | Is the app running the code on disk?                       | no                | 10 s, out of `--timeout`                                                                                                  | `unproved`: `inconclusive`                                                                                                                                             |
| 10  | `route`            | Did the named route open?                                  | no                | as the `app` open                                                                                                         | link refused: `failed`                                                                                                                                                 |
| 11  | `runtime`          | Does the runtime evaluate `1`?                             | no                | one read; up to 15 s for an app this run opened or reloaded                                                               | no answer: `inconclusive`                                                                                                                                              |
| 12  | `errors`           | Did the app report an error in the window?                 | no                | `--window`, default 3 s                                                                                                   | an error: `failed`, over every other row                                                                                                                               |
| 13  | `screenshot`       | Is there a picture of the screen?                          | no                | 20 s local, 2 min on EAS                                                                                                  | none                                                                                                                                                                   |

`--timeout` defaults to 3 min, or 1 min with `--no-start`, and bounds the reads. The conditional phases and the cold waits that this run caused have their own budgets. `AGENT_CLI_COLD_ATTACH_MS` replaces the 2 min cold attach budget.

The `dev-server` phase's URL goes to every later phase. The run also chooses one device: a device that a boot or a session start supplies serves every later phase with no second lookup, and a failed lookup is asked again later.

When no dev server answers, `smoke` runs `dev --<platform> --detach --wait-ready --no-open`, plus `--eas` on an EAS run and `--port <n>` for a loopback port the caller named. `--no-open` keeps the open in the `app` phase, which owns its budget and verdict ([[0026-dev-owns-the-open]]). `--no-start` reads only what is already running.

| Code | Outcome        | Meaning                                                                                                                                                                              |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | `passed`       | every deciding phase answered yes, the runtime answered, the reload is not `unproved`, and the app fits the project                                                                  |
| `20` | `failed`       | an error in the window, a broken bundle, another project's dev server, a bundler that answered not ready, no dev server, a refused link, or a failed start, boot, session or install |
| `22` | `inconclusive` | a wait expired, no app attached, no device to open one on, an unreadable runtime, an `unproved` reload, or an app that cannot run this project                                       |
| `1`  |                | a bad flag, or a route the project has not got ([[0005-runtime-loop-tools]] §Verifying the route)                                                                                    |

Each row's `status` in `--json` is `ok`, `failed`, `inconclusive` or `skipped`; the human report prints `unknown` for `inconclusive`. A phase before `runtime` that gets `failed` or `inconclusive` in the last column ends the run with that outcome. An app mismatch, an `unproved` reload and a `bundle` with no answer do not end the run: the reads still run, and the `bundle` row does not block `passed` (`phases-test.ts` "is inconclusive for a bundle the dev server said nothing about"). A run that reaches the reads is `failed` on an error in the window. Else it is `passed` when the runtime evaluated `1`, the error window was read, the reload is not `unproved` and the app fits the project. Else it is `inconclusive` ([[0005-runtime-loop-tools]] §Android).

`smoke --platform web` is `BAD_ARGS`, exit 1, with `suggestedCommand` set to `typecheck`. The later phases read the inspector's list of React Native runtimes, and a browser never registers in it. Rejected: exit 22 for web, because looking again never makes a browser answer.

The `errors` phase fails on a record with `isError: true` or `source: "exception"`. React Native reports an uncaught error through the console path as one string with its stack frames, and the collector sets `isError` when it finds frames. So `console.error(new Error(…))` fails the gate too, and plain `console.error` text does not.

The screenshot is a PNG. On iOS `simctl` writes the file. On Android `adb exec-out screencap -p` writes it to stdout. Rejected: `adb shell`, which rewrites `\n` as `\r\n` and corrupts the image. Success is the first eight bytes matching the PNG signature, because `adb exec-out` can exit 0 with a sentence on stdout. A missing screenshot never decides the run. With no app attached, the `screenshot` row says what the picture shows ([[0005-runtime-loop-tools]] §Loading the app is not navigating it).

### Which platform is the caller's to say

`smoke` requires `--ios`, `--android` or `--platform ios|android`, with no default. Each question of the gate is about a device: which bundle is built, which debugger targets count, which tool takes the picture. Rejected: a default from the host. A Mac with only an Android emulator would get an iOS run, and the report would hide the guess.

A missing platform is `BAD_ARGS`, exit 1, with `suggestedCommand` set to `smoke --ios` and one line: `Missing platform. Usage: … smoke --ios|--android, for example: … smoke --ios`. Rejected: the What/Why/How form ([[0006-agent-native-cli-surface]] §Errors are prompts) for a flag that is visibly missing. Two platform flags that disagree are `BAD_ARGS` too.

Every command this CLI prints that runs `smoke` names a platform:

- `smoke` follow-ups keep the run's platform, and its `--route`, `--eas` and `--port` where the row repeats the run. One row changes the platform on purpose: after a runtime with no debugger, off `--eas`, `smoke --<other platform>` names the platform whose Expo Go answers the debugger.
- `status.next` names the platform of a booted local device, else of a recorded EAS session (with `--eas`), else of the project's only checked-in native directory, else of the host (iOS on macOS). The last two steps are the rule of the `dev` plan in `status`.
- An error that is not about a device does not suggest `smoke`. The dev-server not-ready error suggests `dev:logs`.
- The `AGENTS.md` block this CLI writes names a platform.

A lint rule fails on any printed `smoke` with no platform flag ([[0002-testing-and-evals]] §A flag is not shipped until it has run against the published binary).

### The gate says what it is doing while it does it

A caller who sees no output cannot tell a working run from a hung one. So `smoke` names each phase before it runs:

- one line on stderr, because stdout holds one JSON object ([[0006-agent-native-cli-surface]] §Output contract);
- one `cli:smoke_phase` event, with `phase`, `platform` and `budgetMs`.

The line names the current wait; the final report gives each result. The wording follows three rules:

- **The question, not the code.** `bundle` says "Checking that this project's own code compiles for ios".
- **A budget only where the walk knows one**, and only when it is 5 s or more: `(up to 2m)`. `start-dev-server` gives none, because the phase itself picks the start or the build budget ([[0021-honest-reports]] §The rules).
- **Two lines for `app`**: the short look, then, only when the run opens the app, the attach wait with its budget.

A row written without running a phase prints no line: a `route` the `app` phase already opened, or a skipped or declined `reload`.

### The app under test is the code on disk

`runtime`, `errors` and `screenshot` read the running app. An app that was attached before the run runs the bundle it last loaded, which after an edit is the old code, and its error window outlives the fix ([[0005-runtime-loop-tools]] §Reloading the app). So the `reload` phase puts an attached app back on the bundle the dev server serves.

The phase is the first rung of `runtime:reload` only, in the same process ([[0005-runtime-loop-tools]] §How it reloads). Rejected: the higher rungs, which stop and start the app. A gate does not take the caller's app away to answer a question about it.

`reload.disposition` in `--json`:

| `disposition` | when                                                                              | `reload` row   | effect on the verdict |
| ------------- | --------------------------------------------------------------------------------- | -------------- | --------------------- |
| `not-needed`  | this run opened the app, so it has no older bundle to replace                     | `skipped`      | none                  |
| `reloaded`    | the app was attached, and `verifiedBy` names a signal                             | `ok`           | none                  |
| `unproved`    | the reload was not proved: nothing took it, or nothing showed that it took effect | `inconclusive` | `inconclusive`        |
| `declined`    | `--no-reload`                                                                     | `skipped`      | none; the row says so |

`unproved` is not `failed`: nothing shows a fault in the app, only that the session read is unknown ([[0021-honest-reports]] §The rules).

`reload.verifiedBy` follows [[0005-runtime-loop-tools]] §What proves a reload, and it is never `app-relaunch`. `reload` also carries `knownTargetIds`, `freshTargets`, `commandSocketReconnected`, `targetOutcomes` and `bundleServed`.

`reload` runs before `route`, because a reload sends the app back to its initial route. A `reloaded` disposition means the app acted (`reloaded: true` in [[0005-runtime-loop-tools]] §What proves a reload), not that it came back. Such a reload owes the settle and the runtime poll of a fresh launch (§The device that can open the app). An `unproved` reload owes neither.

`--no-reload` reads the app where it is, for the question "is the app throwing now, on this screen". The verdict is not changed, and the `reload` row says which question the run answered. The phase claims only that the app fetched the served bundle after the run started. The dev server's own freshness is the `bundle` phase's question.

### Expo Go is only a target for a project that fits in it

The open picks Expo Go or a development build. The first row that matches decides. `navigate`, `runtime:reload`, `status` and `smoke` use the same decision.

| #   | input                                              | target                                                    | `certain` |
| --- | -------------------------------------------------- | --------------------------------------------------------- | --------- |
| 1   | `--app-id`                                         | Expo Go if it names an Expo Go id, else development build | true      |
| 2   | an Expo Go app id among the apps on the dev server | Expo Go                                                   | true      |
| 3   | another app id on the dev server                   | development build                                         | true      |
| 4   | the project depends on `expo-dev-client`           | development build                                         | true      |
| 5   | the Expo Go compatibility check rules Expo Go out  | development build                                         | true      |
| 6   | a checked-in native directory                      | development build                                         | false     |
| 7   | none of the above                                  | Expo Go                                                   | true      |

Rows 1 to 3 observe what will open the link, so they rank above facts about the project. Only `unbundled-native-module` and `config-plugin` rule Expo Go out. `unknown-sdk` (a fresh clone with no `node_modules`), `unknown-app-config` and `custom-native-code` do not decide. Rejected: the two-valued `compatible` field, which is `false` for all five reasons.

An Expo Go can already be attached, for example after `expo start --ios`. So the `app` phase also asks whether an attached Expo Go can run this project. An app mismatch alone never makes the row `failed`, because nothing is wrong with the code. The later phases still read the app and take the picture. The rows, the kinds and their follow-ups are in §Two mismatches, two next actions.

### Putting Expo Go on a simulator that has not got it

A run that may bring its own environment installs Expo Go on a device that has not got it. Rejected: a refusal that names `npx expo start --ios`, which an agent cannot take without leaving its loop.

Expo Go is installed only on the plan's `expo-go` rule ([[0004-smart-start-and-project-state]] §Decision table). When the phase installs is the decision table of §The gate installs the app, whichever app it is. The row says `installed <version> on <device>`, with `, replacing <version>` and `, and left it there` where they apply.

The phase reads the device the run settled on, whether or not this run booted it. Rejected: an install tied to the boot, which misses a running simulator without Expo Go.

Two subprocesses do the work, with no `@expo/cli` code. `npx --yes expo-go download <platform> <sdk> --json` (`latest` when the SDK is unknown) runs in a temporary directory, because it writes into its working directory. It answers `{"path": …}` or `{"error": …}` and gets 5 min. The installer gets 2 min:

| platform | installer                             | why                                                                                            |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| ios      | `xcrun simctl install <udid> <path>`  | needs a booted simulator; `current state: Shutdown` gives a reason that names the boot         |
| android  | `adb -s <serial> install -r -d <apk>` | `-r` replaces and keeps data; `-d` allows a downgrade, else `INSTALL_FAILED_VERSION_DOWNGRADE` |

A downgrade is ordinary: a project on an older SDK needs the older release.

`adb install` can print `Failure [INSTALL_FAILED_…]` and exit 0. So on Android a `Failure` or `[INSTALL_FAILED` line fails the install whatever the exit code.

An install replaces the running app, so the `app` phase drops its earlier look and opens the app again. On iOS the install also approves the `exp` and `exps` schemes; a failed approval does not fail the install (§A link nobody can approve is a link that never opens).

### The Expo Go on the device is not the Expo Go the SDK wants

Expo Go's native runtime is versioned with the SDK. A copy from another SDK takes the deep link but cannot load this project's bundle. So `smoke` compares the Expo Go on a **local** device with the release this project's SDK ships. The `app` phase never compares a development build or an EAS session's device. An EAS session that the CLI starts needs no check: the CLI passes `--expo-go` to `eas simulator`, and the service installs the Expo Go of the project's SDK.

Two questions, two sources. Neither is `@expo/cli`'s ([[0001-agentic-cli-on-expo-cli]] §Constraints, constraint 4).

- **What the SDK wants:** `npx --yes expo-go url <platform> <sdk> --json`, a subprocess with a 15 s bound. It answers `{"url":…}` at exit 0 and `{"error":…}` at exit 1. The version is read from the release URL, and one parser serves both platforms. `EXPO_OFFLINE` (set, and not `0`) skips the lookup.
- **What is installed:** each platform's own reader.

| platform  | is it installed                                                               | which version                                                                |
| --------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ios`     | an app bundle on the simulator's disk whose `CFBundleIdentifier` is Expo Go's | `plutil -extract CFBundleShortVersionString` from that bundle's `Info.plist` |
| `android` | `adb shell pm path <id>`: exit 1 means not installed                          | `adb shell dumpsys package <id>` → the `versionName=` line                   |

The iOS reads are file reads, because the `simctl` tools refuse on a simulator that is not booted. On Android, `dumpsys package` exits 0 for a missing package too, so only the `versionName=` line decides.

Rejected: `pm list packages <id>`. It exits 0 either way, and its argument is a substring filter (`host.exp.exponent` also matches `host.exp.exponent.debug`).

The local read gates the network read. When the device has no Expo Go version to read, no release is looked up.

The comparison is **exact equality** of `major.minor.patch`; older, newer and another release line are all `mismatch`. Rejected: grading the difference (fail on another release line, only mention an older patch). The answer to any wrong version is the right version, as in `@expo/cli`.

| verdict    | what it means                                                         | an Expo Go is attached (`app` phase)                                                    | nothing attached (`app` phase)                                                                                  |
| ---------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `match`    | exactly the release this SDK ships                                    | nothing                                                                                 | nothing                                                                                                         |
| `mismatch` | any other version                                                     | the phase is `inconclusive`, so the run cannot pass; `appMismatchKind: expo-go-version` | for an Expo Go target, the version finding is appended to the wait's reason; `appMismatchKind: expo-go-version` |
| `unknown`  | offline, no `expo-go`, no SDK version, or a version nothing can parse | says nothing                                                                            | says nothing                                                                                                    |

Which verdict installs is row 10 of the install table in §The gate installs the app, whichever app it is.

`unknown` changes nothing and says nothing: a check that could not run must not become an install, a refusal, or a sentence.

A stale Expo Go registers no debugger target, so the attach wait expires with only a symptom. On that path the run asks the **device**, not the dev server, and only after the wait failed, so the healthy path pays nothing. The `app` row keeps both facts: nothing attached, and why. The device first answers whether it has the app at all (§A refused link is a device without the app). Which app is the target is §Expo Go is only a target for a project that fits in it.

#### Two mismatches, two next actions

A mismatch is a value, not only a sentence: `appMismatch` (the sentence) and `appMismatchKind` (the kind), in the report and in `--json`. The follow-ups pick the next action from the kind, never from the English ([[0021-honest-reports]] §The rules).

The `app` phase sets the row and the kind. The first row that matches decides:

| #   | `app` phase observed                                                 | `app` row      | `appMismatchKind`         |
| --- | -------------------------------------------------------------------- | -------------- | ------------------------- |
| 1   | an attached Expo Go, and the project cannot run in Expo Go           | `inconclusive` | `expo-go-incompatible`    |
| 2   | an attached Expo Go on a local device, and its version is `mismatch` | `inconclusive` | `expo-go-version`         |
| 3   | an app attached, any other case                                      | `ok`           | none                      |
| 4   | nothing attached, and no device to open an app on                    | `inconclusive` | none                      |
| 5   | the device refused the link                                          | `failed`       | the device's answer below |
| 6   | the link opened, and nothing attached                                | `inconclusive` | the device's answer below |

On rows 5 and 6 the run asks a local device, first match:

1. The app id is known, and the device has not got that app: `app-not-installed`.
2. The target is Expo Go, and the Expo Go on the device is `mismatch`: `expo-go-version`.
3. Any other answer, an EAS session's device, or a device that could not be asked: none.

| `appMismatchKind`      | what it means                                                          | first follow-up                                       |
| ---------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `expo-go-incompatible` | this project's native code is not in Expo Go's runtime, in any version | `dev --<platform>`: a development build, `--eas` kept |
| `expo-go-version`      | the project fits in Expo Go; the copy on the device is another SDK's   | `smoke --<platform>`, without `--no-start`            |
| `app-not-installed`    | the device has not got the app this project runs, of either kind       | `smoke --<platform>`, without `--no-start`            |

The second follow-up of each is `status`. The `smoke` follow-ups drop `--no-start` whether or not the caller passed it, because `--no-start` is the flag that forbids the install. The `expo-go-version` row also changes the inconclusive How line: looking again reads the same wrong runtime, and a run without `--no-start` installs the right one. On `smoke --eas`, the `expo-go-incompatible` Why line names the same `dev --<platform> --eas` as its follow-up (`src/smoke/__tests__/appFitsProject-test.ts`).

### The gate installs the app, whichever app it is

`smoke` installs the app under test when the device has not got it, whichever kind of app it is: an agent cannot leave the loop to run another command first. The plan's `expo-go` rule installs Expo Go. Every other rule installs a development build.

| kind           | what runs                                                                             |
| -------------- | ------------------------------------------------------------------------------------- |
| `expo-go`      | the download and the installer of §Putting Expo Go on a simulator that has not got it |
| `native-build` | `npx expo run:<platform> --no-bundler --device <id>`                                  |

- `--no-bundler`: the run already has a dev server, and a second dev server would be a second answer to "which bundle is the app under test running".
- `--device`: the app lands on the device the rest of the run reads. iOS gets the bound simulator's udid; Android gets the bound `adb` serial (SDK 58, the floor, matches a serial).
- Rejected: `@expo/agent-cli dev` as the installer. It plans and starts a dev server, which this run has already done.

The `install-app` budget (§The smoke gate) is the same for both kinds, because a development build compiles. The Expo Go download and installer bounds fall inside it. The phase is not charged to `--timeout` (§The run brings its own environment). It runs after the start, session and boot phases. The first row that matches decides whether it installs:

| #   | Condition                                                                               | Install |
| --- | --------------------------------------------------------------------------------------- | ------- |
| 1   | `--no-start`                                                                            | no      |
| 2   | the run has no device                                                                   | no      |
| 3   | the plan could not be read, so the run has no kind; a warning on stderr names the error | no      |
| 4   | this run's boot created the device                                                      | yes     |
| 5   | the device is an EAS session's device                                                   | no      |
| 6   | no app id, and the kind is `native-build`                                               | yes     |
| 7   | no app id, and the kind is `expo-go`                                                    | no      |
| 8   | the device could not be asked                                                           | no      |
| 9   | the device has not got the app                                                          | yes     |
| 10  | the kind is `expo-go`, and the Expo Go on the device is `mismatch`                      | yes     |
| 11  | any other case                                                                          | no      |

Rows 1 and 2 are the walk's: a `--no-start` run never reaches the install decision, and a run with no device does not ask it, so it reads no plan. The decision's table starts at row 3. Tests: `src/smoke/__tests__/phases-test.ts` "asks nothing about an install when there is no device" (row 2); `src/smoke/__tests__/decideInstall-test.ts`, one case per row from 3; `e2e/__tests__/cloud-simulator-test.ts` "installs nothing onto the session for a project with no app id" (row 5); `e2e/__tests__/smoke-test.ts` "a stale Expo Go beside an installed development build" (row 11).

A failed install stops the run as `failed`, and nothing is opened.

**The device judges a development build, not the exit code.** `expo run:ios` activates the Simulator window through AppleScript after it installs, and that throws on a Mac with no Automation grant. `smoke` does not need the window. After a non-zero exit, the run asks the device whether the app is there: yes is `ok`. When the device cannot be asked, the exit code decides.

#### Android needs an application id the app config does not have

The install check needs the app's id. On iOS it is `ios.bundleIdentifier`; on Android it is `android.package`, which many projects never declare. So on Android a second source is read when the app config names none: the `applicationId` that `expo prebuild` wrote into `android/app/build.gradle`. A declared `android.package` wins over the Gradle file. Gradle never runs; the file is read as text.

#### An app that cannot be named still has to be installed

No app id is not "no app" (row 6). For a development build, a missing id is the normal state of a project that was never prebuilt for the platform: `expo prebuild` writes both `android.package` and `android/app/build.gradle`. The id is needed only to ask "is it already there". `expo run:<platform>` needs none, because it resolves the id from the config it writes. After that first build the id is declared, and later runs check normally.

Expo Go is excluded (row 7): an Expo Go download with no app to look for would be a guess. An Expo Go target always has its constant id, so row 7 is a guard. A plan that cannot be read has no kind and installs nothing (row 3): it can be an Expo Go project, so a development build would be a guess too.

#### A build changes the project it was read from

A start phase that compiles rewrites the app config: `expo prebuild` writes undeclared `android.package` and `ios.bundleIdentifier`. The run's target (which app, which install kind) is read once and kept (§It builds what the app needs, and says so first). When the start phase's plan builds, the run forgets the target before the build, and the next reader reads the project the build left behind.

#### A refused link is a device without the app

When the device refuses the deep link that would open the app (the open exits non-zero), the `app` phase is `failed`. The run then asks the local device whether it has the app this project runs, Expo Go or a development build. When the device answers no, the finding goes into the `app` phase's reason beside the refusal, and into the report as `appMismatchKind: app-not-installed`. The rows of §Two mismatches, two next actions give every other answer. The follow-ups branch on the value. On `app-not-installed` they do not lead with `navigate`, which the device refuses in the same way every time. With no finding (`appMismatchKind: null`), the follow-ups name `navigate <route> --<platform>`: first, or after the `dev` restart when the run stopped its dev server or released its device ([[0005-runtime-loop-tools]] Risk 10).

### A link nobody can approve is a link that never opens

Two obstacles stand between an unattended `simctl openurl` and a readable app. The CLI removes both before **every local iOS open**, for whichever app the link belongs to.

- **The dialog.** An unapproved scheme raises `Open in "<app>"?`, and `simctl openurl` exits 0 while the alert is up, so the attach wait expires. The CLI writes the approval into the simulator's `com.apple.launchservices.schemeapproval` defaults, through `simctl spawn <udid> defaults write`.
- **The sheet.** The first launch of an app that ships `expo-dev-menu` shows its onboarding sheet, and the screenshot is a picture of the sheet. The CLI writes `EXDevMenuIsOnboardingFinished` true into the app's defaults.

The app id for the writes comes from a ladder that differs from [[0005-runtime-loop-tools]] §Stopping the app: `--app-id`, then Expo Go's id for Expo Go's own `exp` and `exps` schemes, then `ios.bundleIdentifier` from the app config. With no id, nothing is written, because the approval's value is the app id. Each write is made once per process for each simulator, scheme and app id, so a `navigate` that opens the launcher URL and then the route link writes once. An Expo Go install writes both of Expo Go's schemes at install time. Neither write can fail an open or an install; the worst case is the dialog or the sheet.

The writes are iOS only. Android has no scheme dialog, and its onboarding flag cannot be written without root.

- Rejected: writes only for an app this run installed. `@expo/cli` approves the scheme before every `simctl openurl` for any app id, and a development build the caller built also stops at the sheet.
- Rejected: writing `com.apple.launchservices.schemeapproval.plist` from outside the simulator, as `@expo/cli` does. A booted simulator ignores the file, because its preferences daemon has already read it.

### The run brings its own environment

`smoke` starts what is missing, stops only what it started, and leaves what it found. `--start` is the default. `--no-start` makes the run attach-only: it starts nothing, boots nothing and binds nothing. Passing both flags is exit 1 (`BAD_ARGS`). A dev server or a device that was already up is still up afterwards. The run records what it starts when it starts it, never at cleanup time.

Four phases are acts, not questions: `start-dev-server`, `start-session`, `boot-device` and `install-app`. Each one is in the phase list only when the run did it. A failed act fails the run (exit 20), and the cleanup still runs.

The dev-server cleanup is registered before the start, so a start that got halfway is still stopped. A session or a booted device is registered once it is up. A device that the started dev server bound is released when that dev server stops ([[0035-one-device-per-worktree]] §Lifecycle smoke). `install-app` registers no cleanup: an installed app is given, not held, and the next run needs it.

Cleanup runs newest-first, on every exit path. The dev server starts before the device boots, and an app left talking to a stopped dev server is a worse state than the reverse. A failed cleanup never changes the outcome. It is reported in `environment.cleanup`, as a `left behind` line in the human output, and in `leftBehind` on `cli:smoke`.

### It builds what the app needs, and says so first

When the start plan compiles a development build, `smoke` runs the plan.

Rejected: refusing with "run `dev` first". An agent cannot leave its loop to take that step.

Before the build starts, the run says so. A human line goes to stderr: `Building the <platform> development build first, on this machine` (or `on EAS`). The `cli:smoke_building` event carries the same fact (`platform`, `where`). Stdout keeps its one JSON object ([[0006-agent-native-cli-surface]] §Output contract). A build that would land on EAS because this machine cannot build, and that nobody asked for, stops before anything is spawned; `--eas` takes it ([[0015-backend-selection-and-config]] §The selection).

A start that builds gets the build budget of §The smoke gate. It is bootstrap time, not `--timeout` time. A bound that is too short reports a timeout for a build that was going fine.

When no dev server answered after a start that built, the first follow-up is `npx @expo/agent-cli dev:logs`: the build wrote why it stopped, and a second build costs the whole build again.

#### A refused connection is not an answer

The readiness wait asks the dev server's `/status` until the budget ends, as long as nothing is listening. A development build's start publishes the dev-server lock at the start of its step, and the port opens only when the compile ends ([[0004-smart-start-and-project-state]] §Daemonization). One request would end the wait in milliseconds.

- **Only a connection failure retries.** A refused, reset or unreachable connection is asked again, with a growing gap of at most 1 s.
- **An answer ends the wait.** A non-2xx status, a body that is not `packager-status:running`, a TLS failure: each is returned at once. `ENOTFOUND` is not retried, so a mistyped host does not become a 30-minute hang.
- **The timeout names what happened.** A budget with one refused connection anywhere in it reports `nothing was listening on <url> for <N>ms …, so no dev server had finished starting`, also when the server listened later ([[0005-runtime-loop-tools]] Risk 11). A server that accepts the connection and never answers ends as "the bundler was still working" ([[0021-honest-reports]] §The rules).
- **The caller's abort ends the loop at the next retry**, up to 1 s later ([[0005-runtime-loop-tools]] Risk 11), and is not called a timeout.

### The device that can open the app

When no app is attached and no device is up, the run boots the device that this worktree binds, on both platforms. That is a simulator the registry reuses or creates, or an emulator instance it spawns ([[0035-one-device-per-worktree]] §Choice; [[0035-one-device-per-worktree]] §Android boot). A created or spawned device has no app, so `install-app` puts the app there. The boot budgets are outside `--timeout` (§The smoke gate). The run boots nothing when an app is already attached, when a device is already up, or with `--eas`, which starts or reuses a session instead ([[0027-everything-on-eas]] §smoke).

An attached app is not yet a readable app: its target goes away and comes back when the JS runtime starts, and a read in that gap answers `No target found`. So for an app this run opened or reloaded, the run first waits, at most 4 s, for two reads of the target list that name the same ids. Then the `runtime` phase asks whether a JavaScript bundle ran, every 500 ms, until the runtime answers that one ran ([[0005-runtime-loop-tools]] §A loaded app), inside the runtime-ready budget (§The smoke gate). After the first `-32601`, the run asks again ([[0005-runtime-loop-tools]] §A reloading runtime answers like one with no debugger). A wait that ends with no answer reports the runtime's own reason.

A development-build open that still shows the launcher lists no debugger target on this dev server. The `app` phase is `inconclusive`, and the reading phases are `skipped`. The picture's label comes from the open's own report ([[0005-runtime-loop-tools]] §Loading the app is not navigating it).

## Testing

Unit tests cover the pure decisions. The e2e tests run `smoke` against a stub dev server and stub device tools ([[0002-testing-and-evals]]). Live runs are [[0022-live-tier]].

| Section                                                                                                                    | Tests                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §The smoke gate                                                                                                            | `src/smoke/__tests__/phases-test.ts`, `decideInstall-test.ts`, `resolveOptions-test.ts`, `targetSelection-test.ts`, `smokeDeps-test.ts`, `format-test.ts`; `src/device/__tests__/screenshot-test.ts`; `e2e/__tests__/smoke-test.ts` |
| §Which platform is the caller's to say                                                                                     | `src/smoke/__tests__/resolveOptions-test.ts`; `src/lint/__tests__/checkCommandMentions-test.ts`; `src/status/__tests__/sections-test.ts`; `src/followups/__tests__/smoke-test.ts`                                                   |
| §The gate says what it is doing while it does it                                                                           | `src/smoke/__tests__/progress-test.ts`; `e2e/__tests__/smoke-test.ts`                                                                                                                                                               |
| §The app under test is the code on disk                                                                                    | `src/smoke/__tests__/phases-test.ts` (the `reload` cases); `e2e/__tests__/smoke-test.ts`                                                                                                                                            |
| §Expo Go is only a target for a project that fits in it                                                                    | `src/navigate/__tests__/target-test.ts`; `src/project/__tests__/expoGo-test.ts`; `src/smoke/__tests__/phases-test.ts`                                                                                                               |
| §Putting Expo Go on a simulator that has not got it, §The gate installs the app, whichever app it is (and its subsections) | `src/device/__tests__/installExpoGo-test.ts`, `installDevBuild-test.ts`, `installedApps-test.ts`; `src/runtime/__tests__/appId-test.ts`; `src/smoke/__tests__/phases-test.ts`; `e2e/__tests__/smoke-test.ts`                        |
| §The Expo Go on the device is not the Expo Go the SDK wants, §Two mismatches, two next actions                             | `src/device/__tests__/expoGoVersion-test.ts`, `androidApps-test.ts`; `src/smoke/__tests__/phases-test.ts`; `src/followups/__tests__/smoke-test.ts`; `e2e/__tests__/smoke-test.ts`                                                   |
| §A link nobody can approve is a link that never opens                                                                      | `src/navigate/__tests__/openUrl-test.ts`; `src/device/__tests__/installExpoGo-test.ts`; `e2e-live/__tests__/live-ios-devclient-test.ts`                                                                                             |
| §The run brings its own environment, §It builds what the app needs, and says so first                                      | `src/smoke/__tests__/phases-test.ts`, `format-test.ts`, `resolveOptions-test.ts`; `src/followups/__tests__/smoke-test.ts`; `e2e/__tests__/smoke-test.ts`                                                                            |
| §A refused connection is not an answer                                                                                     | `src/runtime/__tests__/waitReady-test.ts`                                                                                                                                                                                           |
| §The device that can open the app, [[0005-runtime-loop-tools]] §A reloading runtime answers like one with no debugger      | `src/smoke/__tests__/phases-test.ts`; `src/device/__tests__/bootDevice-test.ts`                                                                                                                                                     |
