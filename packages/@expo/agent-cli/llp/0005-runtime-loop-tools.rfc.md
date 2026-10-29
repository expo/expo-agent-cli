# 0005: Runtime loop tools

**Type:** RFC
**Status:** Active
**Systems:** `@expo/agent-cli` runtime commands (`src/runtime/`, `src/runtime/preflight.ts`, `src/navigate/`, `src/runtime/reload/`, `src/project/routes.ts`); `@expo/agent-cli smoke` (`src/smoke/`, `src/device/screenshot.ts`, `src/device/bootDevice.ts`, `src/device/installedApps.ts`); the cloud device layer (`src/device/cloudSimulator.ts`); the Android device layer (`src/device/adb.ts`, `src/navigate/adbReverse.ts`, `src/runtime/targetPlatform.ts`, `src/runtime/targetLiveness.ts`, `src/dev/logErrors.ts`); `@expo/cli` CDP debugging layer and dev-server message socket; `expo-router` link handling; LogBox
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-20 · finalized 2026-08-28
**Revised:** 2026-08-30 · 2026-09-08
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0008-guardrails]], [[0010-agent-conventions]], [[0016-v1-scope]], [[0017-deferred-commands]], [[0018-interaction-commands]], [[0021-honest-reports]], [[0022-live-tier]]

## Summary

Tools that let a driving agent observe and drive the running app. They ship as self-serve `@expo/agent-cli` commands [confirmed, Kudo, 2026-08-22]. `expo-mcp` is not a dependency.

App output is fenced with untrusted-content markers, including marker-forgery neutralization ([[0008-guardrails]]). Driving the app by testID is [[0018-interaction-commands]].

Two loops these close. Log triage: a red screen, then `runtime:errors`, then a symbolicated source location, then the agent's fix, then verification. Verified UI changes: edit, `runtime:reload`, screenshot, compare, iterate.

## What ships

Colon names: `runtime:eval`, `runtime:errors`, `runtime:reload`, `runtime:stop`, `navigate`, `smoke`. Space forms of the runtime verbs still resolve.

`runtime:network` is not in v1. See [[0017-deferred-commands]].

Every CDP path sends a same-origin `Origin` header. Metro's inspector proxy rejects the handshake without it (401).

## runtime:eval

`CdpClient.evaluateAsync` speaks `Runtime.evaluate` with `returnByValue`. An app exception exits 1.

CDP `awaitPromise` is inert on React Native [observed, SDK 57 / RN 0.86.2 in Expo Go on iOS, 2026-08-23]. CDP only awaits a result tagged `subtype: "promise"`. React Native replaces the engine `Promise` with `@react-native/js-polyfills`, which the inspector sees as an ordinary `Object`. `Runtime.evaluate("Promise.resolve(42)")` answers an ordinary object, or the polyfill's internal state (`_A`, `_x`, `_y`, `_z`). `--no-await-promise` printed the same thing.

Promises settle in the app (`src/runtime/promiseSettling.ts`). The wrapper tests `typeof v.then === 'function'`, parks `{state, type, value | reason}` on a global under a per-run nonce, and returns a marker. The CLI polls that global over the same debugger connection until it settles or `--timeout` runs out.

Five properties:

- A non-thenable returns unchanged. One round trip. The runtime's own `type`.
- The settled value carries the type the app read off it. CDP never sees the value on its own.
- A rejection is `promise.state`. It is not a `threw`. It exits 1.
- A promise still pending at the deadline is `RUNTIME_PROMISE_PENDING`. The app is told to drop the hold.
- `--no-await-promise` parks nothing and reports the pending promise at exit 0.

The wrapper puts the expression in an assignment. A statement such as `var x = 1` stops compiling. The fallback re-runs the source exactly as written.

Hermes does not raise a `SyntaxError` for that. It answers `Compiling JS failed: … invalid expression, sourceURL:`. Matching only `SyntaxError` left the fallback unreachable on the one runtime this command talks to.

Expo Go for Android has no CDP debugger. `runtime:eval` explains it with `RUNTIME_EVALUATE_UNSUPPORTED`. See §Android.

## runtime:errors

`CdpRuntimeErrorCollector` captures `Runtime.exceptionThrown` and `console.error` over a window. Both capture sources are required. React Native reports a thrown error through the console path as one string holding the message and the error's own frames. The CDP `stackTrace` beside it describes the console machinery (`console.js`, `backend.js`, `ExceptionsManager.js`). The frames that name the project are lifted out of the message and symbolicated.

Metro applies source maps to what it prints. It does not apply them to what it sends over CDP. Frames arrive as offsets into the bundle, with transform options attached. The project file is nowhere in them.

Symbolication is `POST /symbolicate` with `{stack: [{file, lineNumber, column, methodName}]}`. The server answers one frame per frame, in order, with `file` an absolute path on disk.

Three details are load-bearing:

- `lineNumber` is 1-based and `column` is 0-based both ways. CDP is 0-based in both. Rendered output is 1-based in both.
- `file` must carry the whole bundle URL, including the query string. Metro's lookup is exact string equality. The query selects the bundle's options.
- A frame it cannot map comes back unchanged rather than null. Expo's `customizeFrame` hook nulls its line and column and sets `collapse: true`. Failure of any kind falls back to the frames that were sent, with the query string trimmed. Symbolication improves a report. It is not a precondition for one.

The command exits 0 whatever it collects. An empty window means nothing happened while I watched. It does not mean the app is healthy. `--fail-on-error` exits 20 on a non-empty window. Only `errors` has that flag. A command that reports on the app does not gate on what it reported ([[0010-agent-conventions]]).

On a runtime that cannot answer, and where no dev-server log could be read, `--fail-on-error` exits 22. Nothing was shown to be wrong and nothing was proved right. When a log was read, the window is a real observation and 0 stands. Without the flag the command still exits 0 and prints the caveat.

When the runtime announces it cannot answer, `runtime:errors` falls back to the detached dev server's log (`src/dev/logErrors.ts`). The window is bounded by a line mark taken before it opens. Records are labelled `source: 'dev-server-log'`. The caveat sits above the count. The log does not name a platform, and there is no structured stack behind a record. Errors that were in the log before the window are counted and named rather than reported as this window's. `devServerLog.otherPlatformsConnected` names the platforms whose app writes to the same log.

`runtime:errors` retries target selection for `APP_RECONNECT_GRACE_MS` (3 s). Once around the "is any app connected" probe, which re-reads only while the list is empty. Once around target selection inside `CdpClient`, where a dying target is skipped. Bounded at three seconds so an app that is genuinely closed is still reported quickly.

## navigate

A device-side deep link (`simctl openurl` or `adb am start`). Scheme from the app config: a static file as written, a dynamic `app.config.js`/`.ts` as `@expo/config` evaluates it after the project's env files are loaded, the way `expo config` reads it. An explicit `--scheme` override wins and skips the evaluation. The route is percent-encoded once before it joins the scheme: spaces and non-ASCII become escapes, and URL delimiters and existing escapes stay. A full URL gets the same encoding after its `scheme://`, and an IPv6 host keeps its `[` `]`, so `exp://[::1]:8081` stays a host; escapes the caller wrote, `%5B` included, stay as written (`deepLink-test.ts`, "should percent-encode"). agent-device refuses a target with whitespace [observed — dogfood N2-12, 2026-10]. Expo Router decodes each segment [observed — dogfood N2-12, 2026-10].

Expo Go uses `exp://<host>/--/<route>`. `navigate /` opens `exp://<host>/--/?` [confirmed, Kudo, 2026-08-23]. expo-router's Expo Go listener (`parseExpoGoUrlFromListener`) replaces a link whose path is empty or `/` with `getRootURL() + queryString`. `getRootURL()` in Expo Go is the empty string. The listener then ends in `if (href) listener(href)`, so the root link is dropped before the router sees it. A bare `?` is the smallest thing that survives that guard: `href` becomes `"?"`, which is truthy, and a path of `""` with an empty query resolves to the index route. A development build already treats `<scheme>://` as the index route. A reload is not the fix: Expo Go re-loads the URL it was launched with.

### The route table

The route is checked against the project's files before anything opens [confirmed, Kudo, 2026-08-23]. A route the project has not got is exit 1. An unmatched route is a screen the router renders on purpose. No runtime gate can catch it.

The table is read from disk against expo-router's conventions (`src/project/routes.ts`, `expo-router/src/matchers.tsx`, `getRoutesCore.ts`). The dev server cannot answer this for a native target. `GET /status` reports the bundler. `GET /json/list` reports debugger targets. `@expo/router-server`'s `createRoutesManifest` describes web and API routes and is served over HTTP nowhere. Reaching it means importing internals that [[0001-agentic-cli-on-expo-cli]] constraint 5 forbids. `_sitemap` is a screen the app renders. `.expo/types/router.d.ts` is generated only when `experiments.typedRoutes` is on.

The router root is `extra.router.root`, else `src/app`, else `app`. Group segments are stripped from the URL and accepted in it. `index` collapses onto its parent. `_layout` and any file with a `+` in its last segment are left out. `_sitemap` is added because the router generates it. `+not-found` is left out: counting it as a destination would make every route resolve.

Patterns, not literals. `/users/42` matches `app/users/[id].tsx`. `/users/42/edit` does not: a dynamic segment does not swallow a slash. `[...rest]` matches the rest of the path. A literal route wins over a dynamic one that also matches.

It fails open. `--no-route-check`, a route that is already a full URL, and a project with no router directory are reported `checked: false, ok: null` with a reason, and opened. A close miss lands in `Try:`. Nothing close enough falls back to `navigate /`.

The check answers whether the project has a route. It does not answer whether the app's navigator can display it.

### Verifying the route

The route table is the check. A route the project has not got is exit 1. An unmatched route the project does have is opened.

### Launcher-first on a development build

`exp://<host>` is the Expo Go form and nothing else. A development build gets its own scheme. The connect URL, pinned against the launcher that parses it [observed, `packages/expo-dev-launcher`]:

```
<scheme>://?__expo_url=<url-encoded dev server origin>
```

The reserved `__expo_url` query parameter carries the dev server origin. It uses `https` when the host type is a tunnel, because a tunnel terminates TLS, and `http` otherwise. The scheme is `--scheme`, then the `scheme` field of the app config, then the `exp+<slug>` default a managed development build registers. A dynamic config is evaluated with `@expo/config` after the env files the app would see are loaded through `@expo/env` in `development` mode, and with `__DEV__` set to true, which is what `expo config` and `@expo/fingerprint` do; the env and `__DEV__` are put back afterwards, the config's writes to stdout go to stderr, and nothing is kept across runs ([[0011-impact-and-freshness]] says why). The evaluation runs in this process, and a passed `--scheme` wins over its answer. When the evaluation fails the static read stands, the `exp+<slug>` fallback is still offered because a development build registers it, and the resolution says the file could not be evaluated and why [observed — issue #84, 2026-09-16: a project with only `app.config.ts` got `exp+<package name>://` with "no scheme field was found"]. A project that declares none of them gets no development-build URL.

A connect URL is not a route link. `navigate --print-url` keeps the route URL as its `URL` line and adds a `Connect` line, plus a `connect` array in `--json`.

Development-build connect URLs generated by `navigate` and `smoke` suppress onboarding, the floating Tools button, and automatic dev-menu opening with `__expo_disable_onboarding=1`, `__expo_disable_fab=1`, and `__expo_disable_auto_launch=1`. The FAB and auto-launch overrides last only for the process; onboarding is marked completed. All generated development-build links use the reserved `__expo_url` convention, including links printed by `status` and `start`. There is no version lookup or legacy protocol fallback. [Reference: Expo's automation guidance](https://docs.expo.dev/develop/development-builds/development-workflows/#using-launch-urls-in-automation-scenarios).

`EXPO_NO_DEV_MENU=0` omits the three suppression parameters while keeping the `__expo_url` launch parameter. App-specific route links and caller-supplied full URLs stay unchanged, as do Expo Go links. An already attached development build receives only the route link, so this does not close a menu that is already open. The existing local iOS onboarding preference write is independent of these URL parameters.

On a development build with nothing attached, the launcher URL is opened first [confirmed, 2026-08-28]. The existing attach budget waits for the app. Then the route link is opened. Both opens are reported (`launch` in `--json`, a `Launch` line above `App`). When an app is already attached, only the route link is opened.

Four conditions gate it. The target is a development build. Nothing is attached. A launcher URL exists (`buildConnectUrls` returns none without a dev server and a scheme). There is a budget to wait with. `--no-wait-attach` keeps the old behaviour. `smoke` now passes the attach budget, so a cold development-build run opens the launcher URL first rather than a route link into an empty app. Expo Go is unchanged: `exp://<host>/--/<route>` already carries the dev server, so the ladder does not fire.

The second open is not skipped for the root route. The launcher loads whatever the app last had. That is not necessarily `/`.

On Android the launcher URL goes to `MainActivity` by component (`am start -f 0x20000000 -n <package>/.MainActivity -d <url>`). A BROWSABLE `ACTION_VIEW` intent into a stopped app throws in `DevLauncherController.handleIntent` (`createAppIntent`) and leaves `DevLauncherErrorActivity` while `am start` exits 0. That is what `expo start --dev-client --android` does. The activity is `<app id>/.MainActivity` from `--app-id` or the app config. A project whose application id cannot be read falls back to the link.

When the target app cannot be told apart (nothing connected, no `--app-id`, no `expo-dev-client` dependency, a native directory checked in), both forms print, labelled, Expo Go first. `certain` is false in that one branch. `status.next` names `@expo/agent-cli navigate / --print-url` rather than guessing.

`--print-url` resolves everything and opens nothing, exit 0 [confirmed, Kudo, 2026-08-25]. `resolveRouteUrlAsync` is `openRouteAsync` with the device half removed. `--json` carries the URL, `hostType`, and the four device keys as `null`. `navigate` without the flag, on a machine with no device, names that URL in its failure and names the flag.

### Pointing an app at this dev server

Device-facing URLs prefer a current tunnel host over the listen address. See the next section.

App kind, route URL, launcher choice, and attachment use the same concrete device scope. Project and route validation precede device selection; URL finalization follows it. URL-only consumers (`--print-url`, `dev --eas`) read the worktree's binding and open no device, so they count the same attached apps `navigate` does; beside a twin of the bound emulator they ask `adb reverse` about the dev server's port as `navigate` does; an unreadable binding refuses them. Whether the app is attached is a fact about the device the run opens. A `navigate` run reads the attached apps of that device's scope, with or without a platform flag: its platform; on a local simulator only that simulator's app; on an EAS Simulator session the session's app and no app on a booted local simulator; on a local Android device the app of its model, read with `adb reverse` before the launcher decision and again after this run's own reverse, when another attached device has that model ([[0035-one-device-per-worktree]] §Readers). Each wait asks the device tools again for a changed list within its own budget, so an app that attaches after the accepted Expo Go dialog or the Android recovery counts. An app of another platform on the same dev server does not count, and an app that cannot be placed on the device neither counts as attached nor holds back the launcher. When none is attached, the launcher URL opens first, then the route link. An attached app gets the route link alone, so `--ios` that falls back to an iOS session does not reload its app. `smoke` hands its own device choice to the open, so the open and the waits after it are about one device; the open then extends no lease, because the choice already did. Tests: e2e `navigate-target-selection-test.ts`, covering bound local devices, the three Android twin rows, EAS fallback with and without a platform flag, an empty first probe, the Android recovery that stops the app, opens the link again and then sees it attach, `--print-url` on an EAS session beside an iOS Expo Go app, and `--print-url` on a bound emulator beside a twin; e2e cloud-simulator-test "counts the app that attaches after the dialog is accepted".

### Where a device reaches the dev server

Device-facing URLs prefer a current tunnel host over the listen address [confirmed, Kudo, 2026-08-25]. The lock records `http://127.0.0.1:<port>`. That is the right answer for every command that talks to the dev server over HTTP. It is the wrong one for a link a device opens.

`src/dev/advertisedUrl.ts` reads the `Waiting on <url>` line the dev server prints. That URL is the tunnel origin whenever an `AsyncWsTunnel` is running. A detached run captures it in `.expo/dev/logs/dev-detached.log`. A dev server started attached writes that line to a terminal, so it is reported as unknown rather than guessed at.

The log has to belong to the dev server that is up. `dev --detach` truncates the log per run. The comparison is the log's mtime against the lock's `startedAt`. This document owns which URL `@expo/agent-cli` prints. A tunnel whose transport has died still advertises the tunnel host.

`--wait-ready` returning is not the tunnel being up. The bundler answers `/status` first. `dev --detach` waits for the host when the run asked for a tunnel, for up to 20 s, and reports it (`tunnelUrl` in `--json` and on `cli:dev_detach`). A run with no `--tunnel` waits for nothing.

`hostType` describes the URL that was printed, classified from that URL. A `127.0.0.1` URL under `tunnel` is an instruction to open a local address on a device somewhere else.

A cloud run against a `localhost` or `lan` URL is refused before anything opens, naming `dev --detach --tunnel`. Opening it would land the app on an error screen with the device tool reporting success. A development build's `<scheme>://<route>` carries no host (`hostType: null`) and is allowed: it reaches whatever dev server the app was launched against.

### adb reverse

`adb reverse tcp:<port> tcp:<port>` is this CLI's job (`src/navigate/adbReverse.ts`). `exp://127.0.0.1:<port>` names the loopback of whatever resolves it. On an emulator that is the emulator. `adb shell am start` still exits 0, because it delivered the intent.

The reverse runs before the link, and only for a loopback host. A LAN or tunnel host is already reachable. Reversing its port would point the device at itself. A refusal is reported rather than fatal. The link that follows is what turns "the reverse failed" into a failure a reader can see.

On the launcher-first path the reverse reads the dev server's origin. The launcher URL has no host of its own; the dev server origin is inside its `__expo_url` query parameter.

`navigate` waits for an app on this platform to register a debugger target, and reports `App attached` or exits 22. `--no-wait-attach` reports `attached: null`. A stuck Expo Go on Android is force-stopped and the link opened once more. `ErrorActivity` does not retry the manifest fetch. A second intent into a stuck instance changes nothing. The stopped app is `--app-id`, else the app config's, else Expo Go: no app of this device is attached at that point, and an app another device runs on the same dev server is never the one stopped. Test: e2e navigate-target-selection-test "$name" (no flag, bound Android emulator, only an iOS app and another model's Android app attached).

## One preflight for the runtime family

Kudo's directive: if there is no connected app, exit early [confirmed, Kudo, 2026-08-27]. `src/runtime/preflight.ts` is the one place that asks, and the one refusal they all print.

| Command                                                                         | Needs             |
| ------------------------------------------------------------------------------- | ----------------- |
| `runtime:eval`, `runtime:errors`, `runtime:tree`, `runtime:tap`, `runtime:type` | a debugger target |
| `runtime:reload`                                                                | a dev server      |
| `runtime:stop`                                                                  | a device          |

`runtime:stop` requires a device. An app that was already stopped is success ([[0010-agent-conventions]]). Refusing there would fail the run that convention exists to make boring. `stop` reads the connection with `need: 'optional'` and requires only what it acts on. A machine with no device is told so by `resolveDeviceAsync`, with `xcrun simctl list devices booted` or `adb devices` to look with.

Two refusals, both exit 1. Reclassification never renames a code ([[0010-agent-conventions]]):

- `NO_DEV_SERVER`: nothing answered `GET /json/list` on the dev server this command was going to use. The dev server is probed first. "No dev server on `<url>`" and "no app on a running dev server" stay two facts.
- `NO_APP_CONNECTED`: the dev server is running and its debugger target list is empty, or holds no app on the platform the caller named.

Each carries what, why, and how. The how is one ladder, in one order: `npx @expo/agent-cli dev --detach`, then `npx @expo/agent-cli navigate /`, then `npx @expo/agent-cli smoke`. `reachTheAppLadder` is that sentence as a function.

`--cloud` is carried onto every command in the ladder that takes it. `dev --detach` becomes `dev --detach --tunnel` there. A caller who passed `--cloud` is on a machine whose device is in a datacenter. Only `reload` and `stop` have the flag to pass. The reading commands talk to a dev server over HTTP.

`error.data` on the `--json` error envelope holds what the refusal observed: `devServerUrl`, `devServerReachable`, `debuggerTargets`, `commandSocketClients`, `platform`. Always present. `null` for a failure with nothing to count. `commandSocketClients` is null for every command that never opens `/message` (all of them but `runtime:reload`). The alternative is a caller regexing English.

The connection is asked before the bundle gate. With nothing connected the exit is 1, whatever the code on disk would have compiled to. Nothing can be read off a screen that is not there. The other runtime commands already gave 1 for this. The bundle gate's budget is twenty seconds. The connection answer takes a millisecond.

The preflight reads the target list once and hands back the populated connection: the URL, how it was found, the targets, the platform-scoped subset a command may read, the run scope, the device facts and the classified targets. Every runtime read, `smoke` and `navigate` resolve their scope the same way. Tests: e2e runtime-bound-selection-test; e2e smoke-binding-test "smoke evaluates the selected app with $name"; e2e smoke-target-selection-test "smoke reloads only its own app beside $name"; e2e navigate-target-selection-test (local devices and EAS sessions).

Both refusals are exit 1 in every command, including under a gate-shaped flag. `runtime:errors --fail-on-error` with no app is 1, never 0. `1` is "fix the call". The fix is to start a dev server or open the app.

Every command whose `need` is `debugger-target` waits out `APP_RECONNECT_GRACE_MS` (3 s) by default. `reload` can start the app it finds nothing of. `stop` calls an app that is not running a success. After that window, an empty list is exit 22 ([[0010-agent-conventions]] §An empty target list is inconclusive). No-dev-server and wrong-platform stay 1.

Every command of this group takes `--port <n>` as sugar for `--dev-server-url http://127.0.0.1:<n>`. `runtime:reload` and `runtime:stop` take `--platform ios|android` alongside `--ios`/`--android`. Passing both `--dev-server-url` and `--port` is `BAD_ARGS`. `--ios` and `--platform ios` together are fine. `--ios --platform android` is refused. A "no dev server" error names the URL that was tried when the caller already named one (`howToNameTheDevServer`).

## Which app a run reads

A run reads only the apps in its scope. The scope comes from the caller's flags, from the device the run opens, and from the device bound to this worktree ([[0035-one-device-per-worktree]] §Readers). A bound Android device's model is compared with the target's in one spelling: every character that is not a letter or a digit is `_`, because `adb devices -l` replaces some of them. A target's own fields and the facts this machine's device tools report place it (§Android). A target that nothing places is undetermined: it is never read, and it never earns a platform's verdict.

| Scope source                    | Target                                                                                                                   | Result                 | Test                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none                            | any                                                                                                                      | read                   | e2e runtime-reload-test "checks the bundle on both platforms when no platform is named"                                                                                                                                                                                 |
| flag only                       | platform evidence matches                                                                                                | read                   | e2e runtime-preflight-test "reads the app it places on that platform, not the other platform's"                                                                                                                                                                         |
| flag only                       | other platform                                                                                                           | skip as other-platform | e2e runtime-preflight-test "reads the app it places on that platform, not the other platform's"                                                                                                                                                                         |
| flag only                       | no platform evidence                                                                                                     | undetermined           | e2e runtime-preflight-test "does not read an app nothing places"                                                                                                                                                                                                        |
| EAS session                     | name of a booted local simulator, or the model of an attached Android device                                             | skip as other-device   | e2e runtime-bound-selection-test "eval with" (ios-cloud, flag none, reads cloud; android-cloud with the emulator attached, reads androidSession)                                                                                                                        |
| EAS session                     | an unclaimed target placed on the session's platform, when the scope's device tools answered or the host cannot run them | read                   | e2e cloud-simulator-test "counts the app that attaches after the dialog is accepted"; runtime targetInventory-test "reads an Android session on a host with no adb and no simctl"                                                                                       |
| EAS session, iOS or no platform | the one target nothing places, when the scope's device tools answered or the host cannot run them                        | read                   | e2e runtime-bound-selection-test "eval with" (ios-cloud, flag ios, reads cloud); runtime targetInventory-test "allows cloud attribution without local iOS support on %s"; e2e cloud-simulator-test "reloads the session's app, not the app on a booted local simulator" |
| EAS session, iOS or no platform | two targets nothing places                                                                                               | undetermined           | e2e cloud-simulator-test "reads neither unclaimed app with $name"                                                                                                                                                                                                       |
| EAS session, no platform        | the one target nothing places, beside a target read on Android                                                           | undetermined           | runtime targetSelection-test "reads no unclaimed target beside an Android session app, with no platform"                                                                                                                                                                |
| EAS session, iOS or no platform | an Android-shaped target, when `adb` gave no answer                                                                      | undetermined           | runtime targetInventory-test "holds an Android-shaped target beside the session app"                                                                                                                                                                                    |
| EAS session                     | any unclaimed target, when a device tool of the scope's platform gave no answer                                          | undetermined           | runtime targetSelection-test "reads no Expo Go target while the local simulators are unknown", "an Android session holds every target when adb was not asked"; runtime targetInventory-test "cloud attribution after $name"                                             |
| any                             | name of a booted simulator that only other worktrees bind                                                                | skip as other-worktree | e2e runtime-preflight-test "%s exits 1 with NO_APP_CONNECTED and names that worktree"                                                                                                                                                                                   |
| any                             | name of a simulator this worktree binds, or that nobody binds                                                            | read by the rows above | e2e runtime-bound-selection-test "eval with" (simulator, flag none, reads a); e2e runtime-target-selection-test "reads the right app beside $name"                                                                                                                      |
| any                             | name no booted simulator has                                                                                             | read by the rows above | e2e runtime-target-selection-test "reads the right app beside $name"                                                                                                                                                                                                    |
| any                             | simulator list unknown, and the name only other worktrees' bindings hold                                                 | skip as other-worktree | runtime targetSelection-test "skips a target with a foreign binding's name when the simulator list could not be read"                                                                                                                                                   |
| bound simulator                 | its name                                                                                                                 | read                   | e2e runtime-bound-selection-test "eval with" (simulator, flag none, reads a)                                                                                                                                                                                            |
| bound simulator                 | another name                                                                                                             | skip as other-device   | same                                                                                                                                                                                                                                                                    |
| bound Android device            | its model, which no other attached device has                                                                            | read                   | runtime targetSelection-test "classifyTargets on a bound phone whose model adb spells differently"; e2e runtime-bound-selection-test "eval with" (emulator, flag none, reads android)                                                                                   |
| bound Android device            | its model, shared with another attached device, and only the bound device reverses this port                             | read                   | e2e runtime-bound-selection-test "eval reads the bound emulator beside a twin when only the bound one reverses the port"                                                                                                                                                |
| bound Android device            | its model, shared, and the reverse answer is another one, none or unknown                                                | undetermined           | e2e runtime-bound-selection-test "eval refusal" (two emulators of one model that both reverse the port, and that neither reverses the port)                                                                                                                             |
| bound Android device            | another model, or the bound device is not attached                                                                       | skip as other-device   | e2e runtime-bound-selection-test "eval refusal" (a bound emulator that is not attached)                                                                                                                                                                                 |

An EAS Simulator session's app registers the project's own app id and the cloud simulator's model name, which no local tool reports. So a cloud scope reads no target that a local device tool claims, and the one target that nothing claims is the session's. A device tool that gave no answer cannot show that a target is off this machine. Only the tool of the scope's platform counts. When the run names no platform, a silent simctl holds every unclaimed target, and a silent `adb` holds only the Android-shaped ones, so a lone iOS session app is still read. An Android session's own target has React Native Android's name shape, so only an iOS or a platform-less session reads the one target nothing places. Known limit: an Android session's target whose model is the model of an attached emulator is skipped beside it. An EAS Android image is `sdk_gphone64_x86_64` and a local emulator on Apple Silicon is `sdk_gphone64_arm64`, so they meet only on an x86 host. `--eas` with no platform flag is a cloud scope: the session names one device, so the rule places its app on either platform. Test: runtime targetSelection-test "resolveTargetSelectionAsync with --eas and no platform". When such a scope holds no app, the refusal names the apps nothing places and says to close the apps that are not the session's. A platform flag only chooses which device tool has to answer; it does not choose between two unclaimed apps. Test: runtime preflight-test "should refuse two apps nothing places, and say how to name the session's platform". Rejected: refusing `--eas` with no platform. It makes the user name a platform the session already has.

Three rules hold for every caller of the scope:

- A classification belongs to one target list and the device facts read for it. A later list is classified again, even when it names the same target ids. Test: smoke targetSelection-test "reclassifies an unchanged target after a failed inventory read recovers".
- A connection with no platform scope gives bundle inference every platform it can identify. Test: e2e runtime-reload-test "checks the bundle on both platforms when no platform is named".
- An attachment wait keeps its device facts while the target list is unchanged, and reads them again for a changed list, within the wait's budget. So an empty first list cannot keep a later development build from being placed, and a target that nothing places costs one read of the device tools, not one per poll. A device tool of the scope's platform that gave no answer is asked again, at most once a second, because a local simulator can boot during the wait. A read that loses a tool's answer keeps the facts it gave before, so one failed read cannot un-place an app that an earlier read placed, and the wait reads that list again. The read the wait starts from counts as the first. Tests: smoke targetSelection-test "asks the device tools once for a list that does not change", "refreshes failed local exclusion evidence before counting a cloud attachment" "asks a failing simctl again at most once a second while the wait polls"; e2e smoke-test "reports the app connected only after the deep link produced a target"; runtime waitReady-test "keeps the facts that placed the last list when a device tool gives no answer" and "reads a changed list again after a device tool gave no answer on it".

### Target owner

The dev server on a port takes a debugger connection from every app that loads its JavaScript from that port. A simulator that another worktree bound, and that is still booted, loads from the same port. A runtime read then read that app as this worktree's app [observed — night-1 dogfood, N2-06; night-3, N3-01].

A debugger target names its device by name only. A booted simulator has a name and a udid, and a binding in the registry ([[0035-one-device-per-worktree]]) records both. So a target is matched to the booted simulators by name, and each simulator to the bindings by udid.

A connection with live foreign iOS bindings acquires the current simulator inventory even when its first target list contains no matching names or is empty. The stored binding name is not an acquisition condition: a simulator may have been renamed, and Metro can list a different target before the debugger opens. This is one observation for the connection, not a guarantee against later changes to device state or leases. Tests: ownershipSelection-test "refuses a foreign app listed after %s before opening its debugger"; e2e runtime-target-selection-test "runtime:eval skips a renamed foreign simulator and names its worktree".

Rules:

- A target is another worktree's app only when every booted simulator with its device name has a udid that only other worktrees bind. A simulator that this worktree also binds, a simulator that nobody binds, and a name that no booted simulator has keep the target. Of two booted simulators with one name, one bound elsewhere does not make the target another worktree's. Test: targetSelection-test "classifyTargets and the worktree that bound the simulator".
- When the simulator list could not be read, a binding's stored name stands in for the booted simulator: a target whose name only other worktrees' bindings hold is skipped. A stored name can be stale, so this only skips more, never reads more. Test: targetSelection-test "skips a target with a foreign binding's name when the simulator list could not be read".
- Only a live binding is an owner: its lease has not expired, and its project root exists. A release keeps the file with an expired lease, so a released binding is not an owner. Tests: e2e runtime-bound-selection-test "eval with" (simulator, flag none, reads a); e2e runtime-target-selection-test "reads the right app beside $name".
- Another worktree's app is out of every scope. It is not read with a platform flag or without one, and it does not take the one unplaced slot of an EAS Simulator session. Test: e2e runtime-target-selection-test "runtime:eval skips a renamed foreign simulator and names its worktree", "refuses with --ios when only another worktree has an app on the simulator" and "runtime:reload reads only the app of its EAS Simulator session beside a foreign simulator".
- A read that skips an app says so on stderr, in one sentence that names each device and the worktree that bound it. Test: e2e runtime-target-selection-test "runtime:eval skips a renamed foreign simulator and names its worktree".
- When only other worktrees' apps are connected, a command that needs a runtime refuses with `NO_APP_CONNECTED`, exit 1, and names each device and worktree. Its How line opens the app on this worktree's device. The debugger client refuses the same way when the list changes after the preflight: an empty list throws the preflight's `noAppConnectedError` (exit 22), and a list with no app in scope throws its `emptyScopeError`, and `runtime:eval` and `runtime:tree` let it through. Tests: e2e runtime-target-selection-test "%s refuses with NO_APP_CONNECTED when only a foreign app is listed after the preflight" and "runtime:eval %j refuses like the preflight when the list is empty after the preflight"; e2e runtime-preflight-test "a dev server whose only app runs on another worktree's simulator"; cdpClient-test "should refuse when only another worktree's app is listed, and name that worktree".
- `runtime:reload` lists these apps in `skippedApps`, and its bundle check does not build for their platform. Test: e2e runtime-target-selection-test "runtime:reload checks only its own Android bundle beside a foreign iOS app".
- `runtime:reload` and `smoke` do not reload a skipped app (§How it reloads).
- Nothing of an app outside the run's `read` group proves this worktree's reload, on the broadcast rung too: a fresh target, `appsConnected` and the relaunch id count only the `read` group of the whole list. When a listed app is outside `read`, peer churn alone proves nothing, because the churn may be that app's; the reload then needs a fresh own target or a bundle, and a failure says why the churn did not count. Tests: e2e runtime-target-selection-test "sends Page.reload to its own app only, and a page of the skipped app proves nothing ($pageReload)" and "runtime:reload does not take another platform's churn as its proof". A served bundle proves the reload only for a platform that no skipped app is on, so beside another worktree's iOS app an iOS bundle proves nothing, and an Android bundle still proves an own Android app. Tests: rungOne-test "an Android bundle proves, with own iOS and Android apps beside a skipped iOS app"; e2e runtime-target-selection-test "sends Page.reload to its own app only, and a page of the skipped app proves nothing ($pageReload)".
- A broadcast that reaches an app nothing places leaves no bundle that proves it: that app could have fetched any platform's bundle. An app shown to be on the other platform fetches that platform's bundle, so the scope's bundle still proves. Tests: rungOne-test "a broadcast beside an app nothing places: no bundle proves it" and "broadcasts beside Expo Go on the other platform, and the scope's bundle proves".
- The mechanism the run settled on, the last attempt that reloaded or reached the app, says whether the app comes back under the page id it had: `Page.reload` and a relaunch, local or cloud, do; a broadcast and `--method runtime` do not. When it does, the own app was listed before the run, and no bundle may count, nothing can arrive to prove the reload. Nothing is watched, and the failure says so. An app that the relaunch starts gets a new page id, so that wait still runs. A relaunch whose wait saw nothing does not call the listed runtime the old one: it kept its page id. Tests: evidence-test "whether the shared observations are watched after the mechanism that settled" (one row per ladder path); reloadAsync-test "does not call the listed runtime the old one after a relaunch that nothing confirmed"; e2e runtime-target-selection-test "sends Page.reload to its own app only, and a page of the skipped app proves nothing ($pageReload)" and "does not wait out --timeout after a relaunch that nothing can prove".
- Only a run in a project reads the bindings: without a project root there is no "this worktree". `navigate` reads no other worktree's binding: it scopes to the device it resolved, which is the bound device when one is bound. `dev:wait` reads no bindings and uses its flags only. `smoke` runs in a project, and its reads skip that app as the runtime reads do. It lists the skipped apps in `skippedApps` in its JSON, says them on stderr when it reads its own app beside one, and appends the same sentence to the `app` phase's reason when no app is left. Tests: smokeDeps-test "evaluate beside an app of another worktree"; e2e smoke-test "an app on another worktree's simulator" and "an app beside another worktree's app".

A local device's app can also stand beside this worktree's own EAS session ([[0035-one-device-per-worktree]] §Readers), on the same port and with the session app's app id. So every cloud scope, on either platform, skips it by the "EAS session" rows in §Which app a run reads [observed — N2-33: `runtime:tree` read a local simulator's app with the session's app id, and the scope line named the session]. With only such apps connected, a command that needs a runtime refuses with `NO_APP_CONNECTED`, exit 1, names each app and the session, and prints no scope line. Tests: e2e runtime-bound-selection-test (binding/flag selection and refusal tables); e2e runtime-preflight-test "runtime:tree refuses with NO_APP_CONNECTED and does not name the session as read".

The trade-off of the lease: a lease lasts 60 minutes and is renewed by use (llp/0035 §Lease). A runtime read does not renew it, because a renewal takes the registry lock, and reads are the most frequent calls. So when a worktree runs only `runtime:*` reads for 60 minutes, its binding is no longer live, and another worktree reads that app again. Test: e2e runtime-target-selection-test "reads the right app beside $name".

The keys are names, and that sets the limits. React Native Android's device name is the model, and a local Android binding records a serial only, so a local Android app is never skipped. An EAS Simulator session's target carries the cloud device's model, so a cloud binding has no name to match.

## Reloading the app

`@expo/agent-cli runtime:reload` puts the running app back on the code that is on disk, and reports a reload only when one was observed [confirmed, Kudo, 2026-08-23]. It is a `runtime` action, not a top-level verb. Reloading is driving the running app. It keeps a module and a `--help` block of its own.

An error window is a property of the app's session, and the session outlives the fix. The debugger replays what the app reported to every new connection. A reload cleared it. `runtime:errors` cannot be believed about a fix until the app has been reloaded. That is why the reload leads the follow-ups of a non-empty error window.

### How it reloads

The mechanism is the interactive `r` keypress, spoken from outside the CLI process [observed, `packages/@expo/cli/src/start/server/metro/dev-server/createMessageSocket.ts`]. The dev server mounts a WebSocket on `/message`. A frame carrying a `method` and neither an `id` nor a `target` is a broadcast, relayed verbatim to every other connected client. The sender must be trusted (`isLocalSocket && isMatchingOrigin`: a loopback connection that sends no `Origin` header is trusted, the opposite of the inspector proxy). The method must be one of `reload` and `devMenu`.

Every frame needs `version: 2` [observed, `dev-server/utils/socketMessages.ts` `parseRawMessage`]. A frame without it, or with another number, is dropped with no answer and no error.

This is preferred over the device path. It needs no platform tooling, no application id, and no knowledge of which device the app is on. It is the same code path on iOS and Android. It does not restart the process. App state that is not JavaScript survives.

`getpeers` (`{"version":2,"target":"server","method":"getpeers","id":…}`) is the protocol handshake. It is answered with the connected clients as `socket id -> upgrade query`. An answer proves the dev server speaks this version, so a broadcast on the same socket will be relayed rather than discarded, and whether there is an app to reload. Silence is "does not speak this protocol version". It is never "no peers". The two lead to different next actions.

`--method auto` is one ladder, keyed on whether the command socket holds a client [confirmed, Kudo's delegate, 2026-08-27]:

| rung | mechanism               | reached when                                                             |
| ---- | ----------------------- | ------------------------------------------------------------------------ |
| 1    | broadcast on `/message` | the socket holds a client                                                |
| 2    | relaunch the app        | the socket holds none, or the broadcast was delivered and proved nothing |

While the scope skips an app (§Target owner), rung 1 is not the broadcast. The dev server relays a broadcast to every app on its port, so it would reload the skipped app too. Rung 1 is then CDP `Page.reload` to each own target that has the `nativePageReloads` capability, and its proof is the new JavaScript context on that target (§What proves a reload). The `smoke` gate's reload is the same rung 1, and it ends on the same shared observations: after a rung 1 that reached an app and did not prove itself, `smoke` watches for a fresh target or a bundle that may count, as `runtime:reload` does, and it never relaunches. Test: e2e smoke-target-selection-test "smoke takes an Android bundle as proof when Page.reload kept the context beside an iOS app". Tests: rungOne-test "what rung 1 does, and which bundle proves it"; e2e runtime-preflight-test "runtime:reload sends no broadcast and reloads only the session app"; e2e smoke-target-selection-test "smoke reloads only its own app beside $name".

Rung 1 is decided on one observation made after the bundle gate: a fresh target list and the device facts that place it. An app that connected during the gate is placed before anything is sent. The scope, the inventory and the classified list of that observation serve the rest of the run: dispatch, the evidence, the counts and the relaunch. Its probe and its device-tool reads share one deadline, the run's remaining budget. A probe that fails, or a device tool that does not answer where the preflight read had its answer, keeps the preflight observation; rung 1 then sends no broadcast, because the dev server relays it to every app and this run could not see which apps those are. `Page.reload` to the preflight's own targets still runs. In `smoke`, the preflight observation is the last target list its own reads placed, the `app` phase's at the latest. Tests: e2e runtime-target-selection-test "keeps the first placement and sends no broadcast when the target list read after the bundle gate fails"; e2e runtime-target-selection-test "runtime:reload keeps the first placement when simctl fails after the bundle gate"; smokeDeps-test "keeps the placement the app phase made when simctl fails on the read before rung 1". `Page.reload` targets share one absolute deadline: the run's remaining budget, and at most 8 s, so a proof that does not come leaves the rest of `--timeout` to the relaunch, as the broadcast's 8 s churn window does. Each target keeps its own outcome in the attempt (`outcomes`): `unsupported`, `unmarkable`, `not-delivered`, `delivered-unproved`, `context-replaced`, or `stopped`. One replaced context proves the reload and stops the other targets' checks; each stopped check is `stopped` and still removes its marker. The word differs from smoke's `reload.disposition: 'not-needed'`, which says the run opened the app itself. Tests: rungOneTargets-test; e2e runtime-target-selection-test "relaunches within --timeout when its own app keeps its context after Page.reload"; e2e runtime-target-selection-test "reads the target list again after the bundle gate, and does not broadcast to a new app"; e2e smoke-target-selection-test "smoke reloads only its own app beside $name".

When nothing is skipped, rung 1 stays the broadcast, also beside an app outside the run's scope (another platform's app, or one no rule places). The dev server relays it to that app too, so the peer churn may be that app's. The attempt is then not `ok`: it is delivered, and says "the broadcast also reached N apps outside this run's scope, so the churn is not this app's proof". A fresh own target or a bundle decides. The failure text names no `--eas` or tunnel on a local run. Test: e2e runtime-target-selection-test "runtime:reload does not take another platform's churn as its proof".

In `auto`, a rung 1 that did not prove the reload climbs to rung 2: no own target answered, an answer came with no new context, or no own target could keep the marker. In the last case no `Page.reload` is sent, and under a pinned `--method dev-server` the failure says so and names `--method device`. Test: e2e runtime-target-selection-test "sends no Page.reload when its own app cannot keep the marker". The relaunch takes the application id from the run's `read` targets only. Test: e2e runtime-target-selection-test "relaunches its own app on its own simulator when the dev server reaches none".

On `--cloud`, rung 2 is the two controller verbs in §Cloud simulator. Otherwise it is `simctl terminate` / `am force-stop`, then the deep link. A `terminate` that reports the app was not running is success: that is the state the step was reaching for. The application id comes from the debugger target (`appId`) and falls back to Expo Go per platform.

`--method` pins a rung and skips the rest. `--method runtime` calls `expo.reloadAppAsync()` over the debugger, at the target `runtime:eval` reads. `auto` never picks it. On Expo Go the same call closes the app [observed, Expo Go SDK 57, iOS, 2026-08-27]. One runtime reloads and another quits. The difference is not something this command can read off a target. The `expo` global is the door. Hermes has no `require`, no `import()`, no `process`. A module the app did not already load is unreachable. An app whose `expo` global has no `reloadAppAsync` is reported as exactly that.

The entry-bundle check runs before any rung [confirmed, Kudo, 2026-08-24]. A reload makes the app fetch the served bundle again. A bundle that does not compile is exit 20 with `attempts: []`. `--no-bundle-check` exists. `unknown` passes. A check that ran out of budget is 22. The `bundle` object is the one `smoke` prints, same keys, produced by the same function. `appsConnected` on a run that refuses is the count the dev server gave, not `0`.

Known limit: `method` names the rung, so a `Page.reload` rung 1 reports `method: dev-server`, also under a pinned `--method dev-server`; only the attempt says `page-reload`.

A broadcast that was delivered is a mechanism that ran. An attempt carries `delivered` beside `ok`. Delivery is whether the action reached the app. It is not whether it worked. A delivered-and-unproved broadcast is exit 22, and `auto` climbs to rung 2. A pinned `--method` never climbs. A broadcast whose churn was observed is a reload, and nothing follows it. The attempt says which of the two states it was reached for.

Rung 2 replaces the app's process, so the JavaScript state is gone. The attempt carries the cost, and only when there was an app to lose state. A relaunch that started an app cost nothing and says nothing.

Android Expo Go holds a client on `/message`. Local Android takes rung 1. `runtime:reload` is the one runtime command that works on Expo Go for Android while five others refuse, because neither proof is a CDP read.

### What proves a reload

A broadcast has no reply. Trusting the send would ship the same false green this command exists to remove. `reloaded: true` with exit 0 requires an observation. Name a verifying signal only when that signal's own evidence is in the payload and non-empty ([[0021-honest-reports]]).

Four observations. The first three are watched on one budget, and the first to answer ends the watches:

1. Message-socket peers. Socket ids never repeat (`createSocketMap.ts` `createSocketIdFactory`). A peer under a new id is a new connection. This proves the app _acted_. On its own it is `reloaded: true` with exit 22. A churn wait that returns as soon as `peersChanged` is true reads a list that changes in two directions. An app that had dropped its connection would satisfy it. It waits for an id the dev server had not listed before, and reports `commandSocketChurn.reconnected`.
2. A debugger target the dev server had not listed before the reload (`waitForFreshAppConnectionAsync`). Metro's page ids come from a counter it does not rewind. This proves the app _came back_. The old wait returned on the first non-empty list, which was the pre-reload target on its way out.
3. A `Bundled` line in the dev server's captured output that was not there before (`src/runtime/reload/bundleSignal.ts`). Fast Refresh produces no `Bundled` line. A relaunched app re-registers under the same debugger page id, because Metro's per-device counter restarts with the app. This is how a cloud reload can exit 0. `verifiedBy: dev-server-bundle` says the dev server served a bundle after this command acted. It does not say which client asked for it.

4. A new JavaScript context on the own target after `Page.reload`, the rung 1 of a run whose scope skips an app. One own target proved is enough, and it is an app that came back, so no wait follows (below).

A `Page.reload` keeps the target's page id [observed — SDK 58 development build, React Native 0.88, iOS 27 simulator, 2026-10-21], so a fresh target cannot prove it. The proof for one target is a context replacement (`src/runtime/contextReplaced.ts`): set a global with a per-check name on the target, take the action, and read the global on the same target id until it is gone. One debugger session owns the marker, the action, the reads and the cleanup, because a second debugger evicts the first on a single-debugger page. Marking sets the global and checks its stored value in one evaluate; a context that answers and does not keep it is `unmarkable`, and the action is not taken (Expo Go for Android answers `-32601`). A mark that gets no answer (an abort, the spent deadline, a lost connection) throws, and its target is `not-delivered`: the reload reached no app, which is not the same as an app that cannot keep a marker. A `Page.reload` whose answer was lost is `not-delivered` too, even when the marker read after it still finds the old context: nothing shows the app received it, so it is not counted as answered. Test: runtime rungOneTargets-test "reports a Page.reload whose answer was lost as not delivered, not as answered". Test: rungOneTargets-test "reports a mark the spent budget stopped as not delivered, not as unprovable". A session that closes during the reads is opened again by target id. An action whose answer is lost (the socket drops, its time runs out, or its phase is aborted) may have run, so the marker is read anyway; no proof is then `answer-lost`, never an error, and its reason names the lost answer beside the last read. Any other failure of the action, such as a CDP error, is thrown. Each phase has its own bound:

| Phase                 | Bound                                                                |
| --------------------- | -------------------------------------------------------------------- |
| Discovery and marking | 1 s                                                                  |
| Action                | 5 s, or the request's shorter limit                                  |
| Reads of the marker   | The caller's budget, with a fresh abort after an action that ran out |
| The whole proof       | The caller's absolute deadline, when given, cleanup included         |

The marker is read every 250 ms; when less than that is left, it is read once more at once, with no sleep. Cleanup uses only time that is left. A check that its caller stops (`signal`) ends in the phase it is in, and still removes its marker, on a new session when the stop closed the old one, within the deadline. Tests: rungOneTargets-test "sends Page.reload to every own target at once, and the first proof stops the others"; contextReplaced-test "the proof of a Page.reload" (replacement, a socket that drops before `Page.reload` answers, a lost answer, a context that outlived the action, unreadable contexts, unmarkable, with each reason), "throws an action that failed before its answer could be lost", "reads once more without sleeping when less than a poll interval is left" and "does not mistake another concurrent check for a replaced context"; contextReplacedTransport-test "owns and bounds the debugger transport: %s" (a refused action, an unwritable global, held HTTP headers and bodies). These are protocol fakes. Real runtimes answer the proof the same way: `Page.reload` beside a skipped app was proved by `context-replaced` on an SDK 58 development build on a local iOS simulator, on Expo Go on an EAS Simulator iOS session, and on Expo Go on a local Android emulator and an EAS Simulator Android session [observed — live, 2026-10-29].

Known ids are read after the bundle gate and immediately before the broadcast. Never reused from discovery. A save the watcher picked up in between would otherwise be credited to this command.

`appsConnected` and `appsReconnected` are both reported. One connected and zero reconnected is an app that never re-registered. Zero of both is an app that went. `appsReconnected: 0` is also "the bundle proof answered first, so this watch stopped asking". `appsReconnectedReason` names which one.

`/json/list` is the answer to "is anyone there". It is the list the rest of this CLI uses. The peer list is a property of a mechanism. An empty peer list with a populated debugger list reports `no client is registered on the dev server's command socket, while its debugger target list names N connected app(s)`.

The last read of the wait is the re-read of the target list. A success is a runtime that was observed after the reload.

A proved reload whose last target read was zero asks once more for the reconnect window (`countConnectedAppsAsync`). That is not a wait for a fresh target. Whether it is new was already answered. The question here is the one every command after this reload will ask: is there a runtime on this dev server now. A zero that survives the window keeps its meaning. A cloud session can sit with `/json/list` empty while the app runs.

`verifiedBy` keeps the mechanism's own observation as its label when it has one: `message-socket-peers` for peer churn, `app-relaunch` for a local relaunch, `fresh-debugger-target` for `--method runtime`, `dev-server-bundle` for the Bundled line, `debugger-context-replaced` for `Page.reload`. The top-level `method` of a `Page.reload` run is `dev-server`; its attempt is `page-reload`, with each target's outcome in `outcomes`. The exit code is decided by the observations alone: `0` with a fresh target, a bundle line, or a new context, `22` with none of them, `20` when no rung ran at all. Peer churn alone is still `reloaded: true` at exit 22.

On a project with no captured dev server log, rung 2 has nothing left to observe when the page id repeats, and exits 22 after `--timeout`. When no bundle may count either (§Target owner), nothing is watched: a local relaunch exits 22 at once, with `reloaded: true` and `verifiedBy: app-relaunch`, and a cloud relaunch exits 22 at once with nothing verified. Test: e2e cloud-simulator-test "does not wait out --timeout after a cloud relaunch that nothing can prove". The fix is the first rung of the preflight's own ladder: `npx @expo/agent-cli dev --detach` captures the output that makes the second observation possible.

| Code | Meaning                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| `0`  | happened, and was observed                                                                                        |
| `20` | did not happen: broken bundle, or no rung reached the app                                                         |
| `22` | a mechanism ran and neither observation was made when `--timeout` expired, or the entry bundle was still building |
| `1`  | not attempted: no dev server, or a bad argument                                                                   |

Nothing connected plus `--method auto` starts the app on the device and can exit 0. `--method dev-server` in that state exits 20. No dev server is 1. A reload makes the app fetch its bundle again. With no dev server that fetch has nowhere to go. Stopping the app would replace a stale screen with no screen.

Follow-ups keep the platform flag the run had. `--cloud` is carried alone when that is the device.

## Loading the app is not navigating it

`<scheme>://<route>` navigates an app already running against a dev server.
`<scheme>://?__expo_url=<origin>` — and `exp://<host>` for Expo Go — **loads** one:
the launcher fetches the bundle the link names, and only then is there an app to navigate. A cold
device given the navigation link shows the dev launcher's own screen and loads nothing [observed —
2026-08-30, Kudo's DailyWords-Grok run: the smoke screenshot was the launcher].

So `openRouteAsync`'s ladder is launcher-first on a development build, and it is **gated on an
attach budget**: the open and the wait for the loaded app to register a debugger target share one
bound. A caller that passes no budget gets the navigation-only behaviour, which is right only for
an app somebody else already loaded — the mistake `smoke` made once it began booting its own
devices, fixed by passing one.

Two consequences the code cites here:

- **There is no launcher runtime to misread.** With the launcher on screen the dev server lists no
  debugger target at all, so the reading phases count zero and are never asked. The e2e pins that
  consequence; target metadata could not pin the cause, because the launcher and the project are
  one application.
- **A picture says what it is a picture of.** Three cases, all plausible to a reader who will not
  check: the project's screen, the dev launcher's screen (a loading link that never produced a
  loaded app), and a device with neither. Read from the open's own report, never guessed.

## The smoke gate

`@expo/agent-cli smoke` answers "does this app still boot" by asking the questions of existing commands in this process, plus a picture of the screen [confirmed, Kudo, 2026-08-24]. Graduated 2026-08-28 ([[0016-v1-scope]]). One process. Every dependency is injected (`src/smoke/phases.ts`). A `smoke` built out of subprocesses would do dev-server discovery eight times, and eight discoveries on a machine running two projects can answer eight different things.

Nine phases:

| phase           | the function                                       |
| --------------- | -------------------------------------------------- |
| `dev-server`    | `discoverDevServerAsync`                           |
| `bundler-ready` | `waitForBundlerReadyAsync`                         |
| `bundle`        | `checkEntryBundleAsync`                            |
| `app`           | `waitForAppConnectionAsync`, then `openRouteAsync` |
| `reload`        | `reloadOverDevServerAsync`, then its proofs        |
| `route`         | `openRouteAsync` (route-checked)                   |
| `runtime`       | `CdpClient.evaluateAsync('1')`                     |
| `errors`        | `CdpRuntimeErrorCollector`                         |
| `screenshot`    | `captureScreenshotAsync`                           |

The URL the first phase settled on is threaded into every phase after it. A gate whose phases talk to two dev servers is a gate whose phases are about two different things.

The device is chosen once per run too. A device that a boot or a session start supplies is the choice for the phases after it, with no second lookup, and a failed lookup is asked again by a later phase. Tests: smoke targetSelection-test "retries a failed device lookup, shares concurrent discovery, and retains the successful choice" and "publishes an acquired device to subsequent phases without another lookup"; smokeDeps-test "keeps the session returned by ensure for subsequent device reads".

`--start` must not name a platform. `expo start --ios` drives Simulator.app through AppleScript. On a Mac that has granted no Automation grant the Expo CLI does not catch the refusal and the dev server exits with it. The recovery is the one this command performs: start the dev server without opening anything, then open the app with `navigate`. `START_DEV_SERVER_ARGV` is pinned by a test. `--start` also carries `--port` through when the caller named a loopback one.

| Code | Outcome        | Meaning                                                                                                                                   |
| ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `passed`       | every deciding phase answered yes, and the runtime answered at all                                                                        |
| `20` | `failed`       | an error in the window, a broken bundle, another project's dev server, a device that refused the link, or no dev server with `--no-start` |
| `22` | `inconclusive` | a wait expired, no app could be opened, or the runtime cannot be read                                                                     |
| `1`  |                | a route the project has not got, or a bad flag                                                                                            |

`passed` requires the runtime to evaluate `1`. A `-32601` there means the window that follows proves nothing. Expo Go for Android cannot, so `smoke --android` against Expo Go exits 22 on a working app. `dev-server`, `bundler-ready`, `bundle` (for android), `app`, and `screenshot` can still be `ok`. `runtime` and `errors` are `inconclusive` with the reason naming the engine. A broken Android bundle is still exit 20 with the later phases skipped.

A development build can pass. The `runtime` phase measures. Live runs have exited 0 with all eight phases `ok`. Evidence is in [[0022-live-tier]].

`smoke --platform web` is `BAD_ARGS`, exit 1. `/json/list` is the inspector proxy's list of React Native runtimes. A browser registers nothing in it. `passed` would be a bundler check wearing a name that promises a runtime check. `22` says "look again", and no amount of looking makes a browser answer a debugger.

The gate fails on `isError || source === 'exception'`. React Native reports an Error through the console path as one string holding the message and its frames. `splitTextStack` lifts them out. `RuntimeErrorRecord` gains `isError` for it. `source === 'exception'` is kept because a runtime that does use the exception channel exists. A logged `Error` and an uncaught one are the same bytes here, so `console.error(new Error(…))` fails the gate too. Plain `console.error` text does not.

The screenshot primitive writes a PNG (`src/device/screenshot.ts`). `simctl` is given the path and writes the file. `adb exec-out screencap -p` writes the PNG to stdout. Never through `adb shell`, which rewrites `\n` as `\r\n` and corrupts every image. Never through a JavaScript string. Success is the first eight bytes matching the PNG signature. `adb exec-out` answers a device that is not ready by writing a sentence to stdout and exiting 0. A missing screenshot degrades. It never decides the run. When no app of this project was connected, `screenshot.ok` says the picture is of the device's screen.

### Which platform is the caller's to say

`--ios` or `--android` is **required**, and it is the one flag of this command with no default [confirmed, Kudo, 2026-09-03].

It used to default from the host: iOS on a Mac, Android everywhere else. That is a fact about the machine the CLI is running on, and every question this command answers is about a _device_ — which bundle is built, which debugger targets are counted (§The smoke gate scopes them by platform), which tool takes the picture. The two come apart on an ordinary machine: a Mac with only an Android emulator running got an iOS run, produced a real verdict about a platform nobody had asked about, and the guess was invisible in the report.

The refusal is `BAD_ARGS`, exit 1, with `suggestedCommand: smoke --ios` — the same band as `--platform web`, because a caller who named no device has not asked a question this command can answer, and no amount of looking again supplies one.

**One line**, in the shape §navigate already uses for a missing route: `Missing platform. Usage: … smoke --ios|--android, for example: … smoke --ios`. The first cut put the paragraph above into the error itself and it was rightly called noisy [Kudo, 2026-09-04]. The three-part What/Why/How form of [[0006-agent-native-cli-surface]] §Errors are prompts earns its length when the cause is not visible on the command line; a required flag that was not passed is visible, and the reasoning belongs in this document and in the source rather than in front of somebody who needs to add five characters.

The test tiers stopped depending on the host: every `smoke` invocation in them now names a platform, so a case that asserts platform-specific text says so out loud rather than passing on macOS and failing on the Linux runner — a failure this repo's CI had already produced once.

**Making a flag required breaks every surface that teaches the command**, and the first sweep missed most of them [found by the tier-0 evals, 2026-09-04]. The follow-ups were already fine (F58 made them carry the platform), which is what made the rest look done. What was not:

| surface                                           | was                        | now                                              |
| ------------------------------------------------- | -------------------------- | ------------------------------------------------ |
| `evals/scenarios/smoke-no-dev-server.json`        | `smoke --dev-server-url …` | the golden argv names `--ios`                    |
| §The smoke gate's `status.next` (`verifyCommand`) | `smoke`                    | the booted device's platform, else the project's |
| `routeNotFoundError`'s `Try:` for `smoke`         | `smoke --route /notes`     | the caller's platform, kept                      |
| `notReadyError`'s `suggestedCommand`              | `smoke`                    | `dev:logs`                                       |
| the stray-argument hint                           | `smoke --route <word>`     | the named platform, or `--ios                    | --android` |
| the workflow ladder and the README                | `smoke`                    | `smoke --ios                                     | --android` |

Two of those are worth more than a table row. `suggestedCommand` is the field a driving agent runs **verbatim**, so a value that is refused for a second reason is worse than none — and `notReadyError` cannot name a platform at all, because it is a failure about a dev server and a dev server has not got one. It names `dev:logs`, which answers the same question and is runnable as written; `smoke` stays in its prose with the flags shown.

And `status.next` is read as "run this", so it states a platform rather than leaving one to be defaulted. It is chosen from the strongest evidence at hand — a device this machine has **booted**, which is the fact the gate would otherwise go looking for, so a Mac with an Android emulator running gets `--android` — and otherwise from `resolveDefaultPlatform`, which reads the project's own checked-in native directories before it falls back to the host. That is the same answer the report's `dev` plan prints, so two lines of one report cannot name two platforms. A stated platform in a suggestion is not the guess this section removed: it is text the caller reads and can change, where the default inside `smoke` was invisible.

**The first sweep still missed a handful, and a second one found them — F151.** All were the same kind: a surface that names the platform from the _project_ rather than from a device, which the first pass, aimed at the report surfaces, did not look at. `dev --detach`'s and `dev:logs`'s `smoke` follow-ups, the own-dev-server `PORT_IN_USE` how-line, `typecheck`'s two follow-ups, the interact commands' bundle-not-ready refusal, `runtime:reload`'s and `runtime:eval`'s recovery lines, `navigate`'s cloud look-command — and the worst of them, the `AGENTS.md` this CLI **writes into the user's project** (`src/agents/content.ts`), where an agent reads the block and runs the command verbatim. The rule now lives in one place (`src/smoke/suggest.ts`): a `smokeCommand(platform)` and the project-default it needs, so the two copies of that default collapse into one.

**The device facts that place a target must not be an answer about an empty list — F152.** Scoping by platform needs the device facts whenever the target's own fields name none, which is every development build: its app id is the project's own, and its device name is a simulator's. Reading them costs two subprocesses, so they are read only when a target actually needs placing — and `smoke` asked that question **before the app it was waiting for existed**. The first probe of a run finds nothing attached, "nothing to place" is cached, and the app that attaches a moment later can never be placed by it. Every wait after that counted zero: `smoke --ios` against a development build spent its whole budget and reported "no app had attached" about an app that was listed in `/json/list` the entire time [observed — 55.8 s of a 60 s budget, 2026-09-06]. The device facts belong to the target list they were read for, and a changed list is read again (§Which app a run reads). An empty list costs nothing, because it places vacuously.

What made both sweeps necessary is that nothing counted the surface. So the countable-flags trick that already pins the flags this CLI writes onto other CLIs ([[0002-testing-and-evals]] §A flag is not shipped) now has a second instance: `src/lint/checkCommandMentions.ts` gained a **required-option** rule, `REQUIRED_OPTION_GROUPS`, that fails on any printed `smoke` with no platform. The next command that grows a required flag is one row of a table, not a wave of exit-1 suggestions a person finds one at a time.

### The gate says what it is doing while it does it

The gate is the slowest command in this CLI by a wide margin, and until now it said **nothing at all** until the last of its phases was over [confirmed, Kudo, 2026-09-03]. One run can start a dev server, wait out a cold first bundle, boot a simulator, download a few hundred megabytes and then wait two minutes for the app to attach. A caller watching three minutes of silence cannot tell a run that is working from one that has hung, and the only thing that resolves that is a line naming the phase being spent.

One line per phase, said **before** the phase runs (`src/smoke/progress.ts`). On `stderr`, because `stdout` carries one JSON object and nothing else ([[0006-agent-native-cli-surface]] §Output contract) — a progress line there would break `JSON.parse(stdout)` for every `--json` caller. And on the event stream as `cli:smoke_phase`, because the reader this CLI is for is an agent, and an agent watching events sees the same walk without matching English.

Said before rather than after, because a line's only job is to name the wait the caller is in: one printed on the way out would arrive at the moment it stopped being needed, and the final report already says what every phase came to, with its duration.

Three details the wording carries:

- **The question, not the code.** `bundle` is not "check the entry bundle", it is "does this project's own code compile for ios" — the thing the wait is buying an answer to.
- **A budget only where there is one.** `(up to 2m)` is printed when the walk knows the bound, and nothing is printed when it does not. `start-dev-server` passes none, because a plan that compiles gets the build budget and one that does not gets the start budget, and that is decided inside the phase; a stated bound the run then sails past would be worse than no bound (see [[0021-honest-reports]] §The rules). Under five seconds nothing is printed either: a bound nobody would plan around is noise dressed as information.
- **Two lines for `app`, one for everything else.** That phase is two things of very different sizes — a two-second look for an app that is already attached, and, only when there is none, an open plus the longest wait this command ever performs. One line would either overstate the look or say nothing about the wait.

The phases that are pushed onto the report rather than performed — a `route` the `app` phase already opened, a `reload` the caller declined — say nothing. They are rows about work that did not happen, and a progress line for one would report a wait the caller is not in. The same holds for the three conditional acts: a machine that already had a dev server, a device and the app narrates none of them.

### The app under test is the code on disk

The phase that makes the four below it mean something [confirmed, 2026-09-03]. `runtime`, `errors` and `screenshot` all read _the running app_, and an app that was already attached when the run arrived is running whatever it last loaded. At the moment this command is for — after an edit, before saying "done" — that is the bundle from before the edit.

Without it the gate passed a broken app. On a plain Expo Go project with a bare `throw new Error(...)` at the top of the entry component, `smoke --platform ios --no-start` reported `smoke passed` with `errors` `ok` at 3.1 s and exited 0, and its own screenshot showed the _previous_ screen [observed — iOS 26.5 simulator, Expo Go SDK 57, 2026-09-03]. Killing the app first made the identical run fail with the throw in the error window, which is what proved it was staleness rather than the error reader. §Reloading the app had already written the rule — "an error window is a property of the app's session, and the session outlives the fix" — and named `runtime:errors` as the command that must not be believed without a reload. `smoke` reads that window and was not applying it.

The phase is `runtime:reload`'s **rung 1 only**, asked through the same functions in the same process. The rungs above it stop the app and start it again, and a gate is not allowed to take the caller's app away in order to answer a question about it. An app the broadcast cannot reach is a fact this phase reports.

Four dispositions, and the report carries the evidence rather than a summary of it:

| disposition  | when                                                                   | the verdict                     |
| ------------ | ---------------------------------------------------------------------- | ------------------------------- |
| `not-needed` | this run opened the app, so it fetched the served bundle on its way up | unaffected                      |
| `reloaded`   | it was already attached, and the reload was observed                   | unaffected                      |
| `unproved`   | the reload was attempted and nothing came of it                        | never `passed`                  |
| `declined`   | `--no-reload`                                                          | unaffected, and the row says so |

`unproved` is `inconclusive` rather than `failed`: nothing has been shown to be wrong with the app, and what is unknown is _which session_ the phases below are about. `passed` is a claim about the app the caller has on disk, so a run that cannot say which session it read must not make it (llp/0021 §The rules band). A real error still wins over all of it — an app that reported one has been shown to be broken, and which session it was is no longer the open question.

`verifiedBy` reuses §What proves a reload's four labels and its one rule: a label may be named only where its own evidence is in the payload and non-empty. `--json` carries `knownTargetIds`, `freshTargets`, `commandSocketReconnected` and `bundleServed` beside it.

Before `route`, not after. A reload sends the app back to its initial route, so a run that opened the route first would reload out of the screen it had just asked for. A proved reload also leaves the app re-registering exactly the way a cold launch does, so it owes the same settle and the same runtime-ready poll (§APP*SETTLE_MS, §RUNTIME_READY_TIMEOUT_MS) — and one that was \_not* proved owes neither, because an app that never acted is not coming up.

`--no-reload` is the opt-out, and it exists for the one question a reload destroys: "is the app throwing right now, where I navigated it to by hand". That is a real question and the caller has to be able to ask it, so the verdict is left alone and the `reload` row says out loud which of the two questions the run answered. The narrow claim this phase makes is that the app fetched the bundle the dev server is serving _after_ this run arrived. It says nothing about the dev server's own freshness, which is the `bundle` phase's question.

Cost: one broadcast on a socket that is already open, plus the reconnect. Measured at ~260 ms across six consecutive break-detect-fix-verify runs, all six correct [observed — iOS 26.5 simulator, Expo Go SDK 57, 2026-09-03].

### Expo Go is only a target for a project that fits in it

`decideExpoGoTarget` decided from four facts — `--app-id`, the app ids on the dev server, `expo-dev-client`, and checked-in native directories — and none of them was "can this project run in Expo Go" [confirmed, 2026-09-03]. Its last branch therefore answered `isExpoGo: true` with `certain: true` for a project `status` and the plan engine already called `needs-dev-client`. One question, two answers, and the wrong one won where it mattered: on a CNG project with a podspec-shipping dependency `smoke` opened `exp://…`, Expo Go answered the debugger, and the gate reported `passed` at exit 0 — a run that proved Expo Go can boot the bundle and called it the app working [observed — iOS 26.5 simulator, 2026-09-03].

Compatibility is now a fifth input, below the two observations and above the native-directory guess. `--app-id` and an app already on the dev server still win: those are facts about _what will open the link_, and answering `<scheme>://` for a session that is demonstrably Expo Go would send the link to an app that is not there.

`ExpoGoCompatibility.compatible` could not be used directly, and that is the part worth writing down. It is `false` for all five reason kinds and only two of them rule Expo Go out. `unbundled-native-module` and `config-plugin` do. `unknown-sdk` does not — it is the check saying it could not read the project, which is the ordinary state of a fresh clone with no `node_modules`. `unknown-app-config` does not either: a dynamic config that threw has declared no plugins anyone can read, and the static file is not its list. Nor does `custom-native-code`, whose own `detail` says a checked-in native directory _can_ contain code the runtime lacks: a bare project with no unbundled module still runs in Expo Go, which is exactly the uncertainty `ExpoGoDecision.certain` carries. `decidesAgainstExpoGo` is the three-valued answer, and the suites that run against a virtual filesystem caught both mistakes before they shipped.

Choosing the right app is half of it. Expo Go can already be attached because somebody ran `expo start --ios`, so the `app` phase also asks whether the app that answered is one this project can run. A mismatch is `inconclusive` with the build command named, never `failed` — nothing is wrong with the code — and never `passed`. The window is still opened and the screen still photographed, the same rule §Android sets for a runtime with no debugger. An error outranks all of it: Expo Go throwing on this project's bundle is a fact about the code, whichever app was holding it. `appMismatch` is on `--json` so nothing has to match English, and the follow-ups lead with `dev --<platform>` rather than a re-run of a gate that will answer the same way for ever.

### Putting Expo Go on a simulator that has not got it

§The device that can open the app refused a machine with no Expo Go and named `npx expo start --ios`. That is a correct instruction and a dead end for the caller this CLI is for: an agent cannot take it without leaving its loop, and the loop is the thing being served. So the app is installed [confirmed, Kudo, 2026-09-03].

**Only Expo Go, and only on the plan's `expo-go` rule.** That rule already is the pair of conditions this turns on — the project fits in Expo Go, and nothing in `agent-cli` config overrode it to a development build (`src/plan/decide.ts`) — so the target reads the plan's answer rather than forming a third opinion. Everything else is a development build: a published binary is something to download, and a development build is this project's own artefact to compile.

`install-app` is a **conditional** phase, like the start and the boot, because installing is an act: a machine that already had the app never had an install to do, and a `skipped` row there would read as work that was owed. It is bootstrap, not charged to `--timeout`, for the same reason the boot is — a 423 MB download is cold this run caused. It registers **no cleanup**, and that is the one deliberate exception to "stop only what you started": that rule is about resources this run is _holding_, and an installed app is not held but given. Uninstalling it on the way out would take away what the next run needs and make it download the whole thing again.

It is driven off the **device**, not off the boot. Hanging it on the boot was the first cut and it missed the ordinary case — a simulator somebody left running without Expo Go, where this run boots nothing and the deep link comes back `115` [observed, 2026-09-03]. `installNeededOnDevice` asks of whichever device the run settled on.

Two subprocesses, and neither is `@expo/cli`'s: `expo-go download <platform> <sdk> --json` for the binary, and the platform's own installer for the device. The download goes to a temporary directory rather than the project, because `expo-go download` writes into the working directory. **The device has to be running first**: `simctl install` on a shut simulator answers `Unable to lookup in current state: Shutdown` (code 405), and `adb install` needs a device `adb` lists at all.

The download is the _same_ subprocess on both platforms, with the same contract — an `.app` on iOS, a 186 MB `.apk` on Android, `{"path":…}` either way [observed, 2026-09-03]. Only the installer differs:

| platform | installer                             | why those flags                                                                                                                                                                                                  |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ios      | `xcrun simctl install <udid> <path>`  | on a simulator that is already booted                                                                                                                                                                            |
| android  | `adb -s <serial> install -r -d <apk>` | `-r` reinstalls and keeps the app's data, which is what makes a replacement an install rather than an uninstall; **`-d` is not optional** — without it a downgrade fails with `INSTALL_FAILED_VERSION_DOWNGRADE` |

A downgrade is an ordinary case here rather than an odd one: a project on an older SDK than the emulator's Expo Go wants the _older_ release, because the release this SDK ships is the one under test (§The Expo Go on the device is not the Expo Go the SDK wants).

`adb install` is also the one of the two that can **exit 0 and fail**: it prints `Failure [INSTALL_FAILED_…]` and returns 0 for a device that refused the package [observed, 2026-09-03]. So on Android the output decides and on iOS the exit code does. A caller reading only the exit code would report that install as a success, which is the class of false green this whole gate exists to remove.

#### An install is not finished until the link works

Two obstacles sit between a fresh install and an unattended run, and both were found by running it [observed — a fresh iOS 26.5 simulator, 2026-09-03].

A freshly installed app has no approved URL schemes, so `simctl openurl exp://…` raises `Open in "Expo Go"?` and waits. Nobody presses Open, and the run reports — correctly and uselessly — that no app attached inside its budget. `@expo/cli` pre-writes the scheme-approval plist with a bplist library (`updateSimulatorLinkingPermissionsAsync`). The same key written **through the simulator's own `defaults`** needs no library and no plist parsing, and it is the version that works on a device that is already booted: the file written from outside is ignored, because the running preferences daemon has already read it.

Then a first-ever Expo Go launch puts its developer-menu onboarding sheet over the app. The link works, the runtime attaches, the window reads — and the screenshot is a picture of the sheet, which §The smoke gate calls evidence and which is evidence of nothing, exactly as a splash screen is. The key is `expo-dev-menu`'s own, read out of this monorepo rather than guessed (`packages/expo-dev-menu/ios/Modules/DevMenuPreferences.swift` §isOnboardingFinishedKey), and it is written only for an Expo Go **this run just installed** — never for one the caller already had, whose preferences are theirs.

Neither write can fail the install. Expo Go is on the device either way, and the worst case is the dialog or the sheet they exist to remove.

**Both are iOS's**, and Android needs neither: Expo Go's `exp://` intent filter is in its manifest, so the link works the moment the package is there and there is no dialog to approve away [observed — emulator-5554, Android 36, 2026-09-03]. Nothing that only iOS needs is written to somebody's emulator.

End to end on a simulator created for the purpose: `install-app 15.2s`, `app 7.2s`, and a screenshot of the app itself [observed, 2026-09-03].

### The Expo Go on the device is not the Expo Go the SDK wants

Expo Go being _installed_ is not Expo Go being the _right_ Expo Go [confirmed, Kudo, 2026-09-03]. Its native runtime is versioned with the SDK, and §The device that can open the app chose a simulator by asking which one _has_ `host.exp.Exponent` and then trusted whatever was there. A simulator nobody has opened for a while holds a build of something else, and it cannot load this project's bundle: live, the deep link opened and no app attached for the whole 120 s budget.

Two questions, two sources, and neither is `@expo/cli`'s. What is installed comes from the device, with each platform's own reader. What the SDK wants comes from the `expo-go` CLI as a subprocess: `npx expo-go url <platform> <sdk> --json` answers `{"url":…}` at exit 0 and `{"error":…}` at exit 1, and the release URL carries the version. `@expo/cli` answers this in `ExpoGoInstaller`, which is precisely the internal llp/0001 constraint 5 forbids importing. It resolves per release line: 54 → 54.0.7, 55 → 55.0.34, 56 → 56.0.4, 57 → 57.0.9 [observed, 2026-09-03]. Android URLs carry the version in the same shape, so one parser answers for both.

**Both platforms, and Android was missing** [confirmed, Kudo, 2026-09-03]. The first cut of this check only ever read a simulator's disk, which made `smoke --android` the exact false green the section was written against: an emulator holding an Expo Go from another SDK found no version to compare, reported `unknown`, and `unknown` says nothing and blocks nothing.

| platform | is it installed                                                                    | which version                                                                |
| -------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ios      | the app bundle's `CFBundleIdentifier` on the simulator's disk (`installedApps.ts`) | `plutil -extract CFBundleShortVersionString` from that bundle's `Info.plist` |
| android  | `adb shell pm path <id>`                                                           | `adb shell dumpsys package <id>` → `versionName=`                            |

The iOS pair is a filesystem read because both `simctl` tools that would answer refuse on a device that is not booted, and every device the _boot choice_ asks about is shut. Android is the opposite: a device `adb` lists is a device that is up, so the question goes to the package manager, which is the thing that actually knows.

Each Android command was chosen by measuring it, not by preference [both observed — emulator-5554, Android 36, 2026-09-03]. `pm path` exits **1** for a package the device has not got, which is the only exit code in this area that means anything; `pm list packages <id>` was the obvious alternative and is worse twice over — it exits 0 either way, so the answer has to be parsed out of an empty string, and its argument is a _substring_ filter, so `host.exp.exponent` also matches `host.exp.exponent.debug`. `dumpsys package` exits **0 even for a package that is not installed**, printing `Unable to find package`, so there the exit code decides nothing and the absence of a `versionName` line is the whole answer.

**Exact equality, and the wrong version is installed rather than graded.** This is the part a first cut got wrong. It split a different release line from an older patch of the same one so it could fail the run for the first and merely mention the second — and that distinction is the wrong tool, because the answer to a wrong version is not a better sentence about it. `@expo/cli` compares with `semver.eq` and, when it cannot prompt, installs the recommended release: _"better to have the correct version than not have Expo Go work at all"_. An agent loop is exactly the caller that cannot be prompted, so this check feeds §Putting Expo Go on a simulator that has not got it rather than the verdict. Newer than expected is a mismatch too, for the same reason it is there: the release this SDK ships is the one under test.

Three verdicts:

| verdict    | what it means                                          | what the run does         |
| ---------- | ------------------------------------------------------ | ------------------------- |
| `match`    | exactly the release this SDK ships                     | nothing                   |
| `mismatch` | any other version — older, newer, any release line     | installs the right one    |
| `unknown`  | offline, no `expo-go`, or a version nothing could read | nothing, and says nothing |

`unknown` installing nothing is the same rule as `unknown` saying nothing: a machine with no route out has shown no reason to spend 423 MB, and a check that could not run must not become an action or a refusal. The install report names what it replaced — an addition and a replacement are different things to do to somebody's machine.

What is left for the verdict is the run that was told to change nothing. Under `--no-start` nothing is installed, so a mismatched Expo Go is reported and blocks the pass: the runtime that answered is not the release this SDK ships, so the window is not about the app the caller would ship. Asked of the app that actually answered, on a local device — a development build is this project's own app and its version is the project's own business, and a cloud session's device is not this machine's.

#### Nothing attached is a symptom, and the device holds the cause

The above asks about an Expo Go among the dev server's debugger targets, which leaves the worst case of the whole section unanswered: **a stale Expo Go registers no target at all.** It takes the deep link, fails to load a bundle its runtime cannot run, and never appears in the list — so the check that looks in the list finds nothing to have an opinion about, and the run waits out its budget and reports the symptom.

Measured at full price: an emulator on Expo Go 54.0.8 against an SDK 57 project, `--no-start`, **119 seconds** to report `exp://…/--/? was opened on the device and no app had attached when the budget ran out` — while the reason sat on the device the entire time. The follow-ups then suggested `navigate / --android`, which fails identically for ever, and a re-run of the gate. That is the exact mistake [[0009-smart-followups]] was written against, and it happened because the run did not know why [observed — emulator-5554, 2026-09-04].

So on that path the same version question is asked of the **device** instead of the dev server (`SmokeDeps.explainSilentApp`). It costs nothing on the healthy path: the branch is only reached by a run that already has nothing to read. `unknown` explains nothing, and a sentence saying "the version could not be checked" beside a wait that expired would add words without adding a fact. The `app` row then carries both — the open succeeded and nothing came of it, _and_ why — because the second without the first would not say that the link was accepted.

#### Two mismatches, two next actions

The finding is carried as a value, not only as a sentence: `appMismatchKind` in the report and in `--json`. There are two kinds and their answers are opposite, and before the discriminator existed both got the advice for the first one:

| kind                   | what it means                                                        | what fixes it                                                                               |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `expo-go-incompatible` | this project's native code is not in Expo Go's runtime, ever         | a development build — `dev --<platform>`                                                    |
| `expo-go-version`      | the project fits in Expo Go; the copy on the device is another SDK's | the right copy, which the gate installs itself — `smoke --<platform>`, without `--no-start` |

Sending the second caller to a native build would cost them twenty minutes to fix something a re-run fixes in seconds. The suggestion deliberately drops `--no-start` whether or not the caller passed it, because that flag is precisely what forbids the fix. And a consumer picks between the two actions from the kind rather than by matching English, which is [[0021-honest-reports]] §The rules: a follow-up that read the sentence would be one wording edit away from wrong advice.

End to end, after the fix: the same emulator and project reported `the Expo Go on the device is 54.0.8, and this project's SDK ships 57.0.9 … registers no debugger target, which is what this wait was waiting for`, led with `smoke --android`, and that command installed 57.0.9 and had the app attached in 3.6 s [observed, 2026-09-04].

The local read gates the network one. Reading the device's plist is a file read; resolving the release is a subprocess and a request. With nothing installed to compare there is nothing the second answer could be compared _to_, so it is not spent — which is also what keeps the e2e tier off the network, since its fixture plists carry no version key. `EXPO_OFFLINE` skips the lookup outright, the same courtesy `@expo/cli` extends. Measured at ~290 ms warm.

End to end: a simulator carrying Expo Go 56.0.4 against an SDK 57 project got `install-app 2.3s · installed 57.0.9 …, replacing 56.0.4`, and the run passed [observed, 2026-09-03]. Before it, the same simulator produced a 120 s wait and exit 22.

### The gate installs the app, whichever app it is

`smoke` installs the app under test, and there is no longer a kind of app it will not install [confirmed, Kudo, 2026-09-04: _"smoke should be self-served without running dev first"_, _"if the app isn't installed, smoke should install it?"_].

§Putting Expo Go on a simulator that has not got it did half of this and drew a boundary at the other half: Expo Go is a published binary to _download onto a device_, and a development build is this project's own artefact to _compile_, so the compile belonged to `dev`. The distinction is real. It is also not the caller's problem — an agent told `npx @expo/agent-cli dev --ios` cannot take that instruction without leaving the loop this command exists to serve, which is exactly the dead end that section was written against. The boundary was ours to keep, so we kept it in the wrong place.

Both are installs now, and the plan says which kind (`SmokeTarget.installWithKind`):

| kind           | what runs                                               | budget |
| -------------- | ------------------------------------------------------- | ------ |
| `expo-go`      | `expo-go download`, then `simctl install`/`adb install` | 30 min |
| `native-build` | `expo run:<platform> --no-bundler --device <id>`        | 30 min |

`--no-bundler` because this run already has a dev server, and a second Metro would be a second answer to "which bundle is the app under test running". `--device` so the app lands on the device the rest of the run is looking at. Both flags were read off the published binary and then run against it, per llp/0002. It is **not** `@expo/agent-cli dev`, which plans _and starts a dev server_ — the thing this run has already done.

The phase keeps the build-sized budget for both, because the larger of the two is a native compile and a download that finishes in twenty seconds is not made slower by a bound it never reaches. `install-app` stays a **conditional** phase and still registers no cleanup: an installed app is given, not held (§Putting Expo Go on a simulator that has not got it).

**The exit code is not the judge of a native build.** `expo run:ios` finishes by activating the Simulator window through AppleScript, and on a Mac that has granted no Automation permission it throws — _after_ the build has compiled and the app has been installed. Measured: non-zero exit with an `osascript` stack, and the app on the simulator [observed — live, 2026-09-04]. The window is nothing this run needs, because `smoke` opens the app itself with `simctl openurl`, which needs no grant — the same fact that keeps `--start` from carrying a platform flag (§The smoke gate). So the question is "is the app there", the device answers it, and the command's complaint is reported beside the success rather than instead of it.

What is left of the refusal is the run that was told to change nothing. Under `--no-start` a device without the app is reported, and the report names the run that would install it — not `dev`.

#### Android needs an application id the app config does not have

The install fires only for an app this CLI can _name_, and on Android it usually could not [observed — Kudo, local run, 2026-09-04]. `readConfiguredAppId` read the static app config, where iOS finds `ios.bundleIdentifier` and Android finds `android.package` — which a great many projects never declare. So the same project answered an id for iOS and `null` for Android, and with no id there was nothing to check for, nothing to install, and nothing to explain: `smoke --ios` installed the development build and passed, while `smoke --android` booted an emulator, installed nothing, and reported only that the device had refused the deep link.

`expo prebuild` writes the id into `android/app/build.gradle` whether or not it was declared, so that file is the second source, consulted when the config names none (`readPrebuiltAndroidApplicationId`). The declaration still wins, because a project that declares `android.package` has said what it wants. Still a static file read: no `app.config.js` is evaluated and no Gradle is run.

#### An app that cannot be named still has to be installed

**No app id is not "no app".** The install decision needs an application id to ask "is it already there", and for a native build the absence of one is the ordinary state of a project that has never been prebuilt for that platform: `android.package` is undeclared and there is no `android/app/build.gradle`, because `expo prebuild` is the thing that writes both. Treating that as "nothing to install" is the bug that outlived two attempts at fixing it — an emulator booted, nothing installed, the deep link refused, three runs in a row [observed — Kudo, 2026-09-04].

The id is only needed for the _check_. `expo run:<platform>` needs none: it resolves the package itself, from the config it is about to write. So a run that cannot see whether the app is installed installs it — and after that first build the package **is** declared, so every later run resolves it and checks properly. One build, then normal.

Expo Go is excluded, and the asymmetry is the point: its application ids are constants, so an Expo Go run that cannot name its app has a plan this could not read at all, and spending 423 MB of somebody's bandwidth on that basis would be a guess rather than an inference.

#### A build changes the project it was read from

The start phase can compile, and a compile rewrites the app config: `expo prebuild` writes `android.package` and `ios.bundleIdentifier` into it when they were not declared. So "which app is this run about" has two answers on a run that builds, and the gate was reading the first one.

The target is resolved once and memoized, deliberately — a run that fails at the dev-server phase must not spawn a plan read (§It builds what the app needs, and says so first). Its **first** reader, though, is the start phase itself, which asks for `buildLocation` before it runs the plan. Everything after it then saw the project as it was before the build. On an Android project whose package the prebuild was about to write, that reading was `null`: no app id, so nothing to check for, nothing to install, and nothing to explain — the emulator booted, the install phase never fired, and the deep link was refused [observed — Kudo, local run, 2026-09-04].

So a start that built forgets the target, and the next reader re-reads the project the build left behind. The memo still holds for every run that compiles nothing, which is almost all of them.

The general shape is the one this document keeps meeting: **a fact captured before the thing it describes existed.** The pre-install app probe (§Putting Expo Go on a simulator that has not got it), the device facts, and this. Each was a value read at the cheapest moment rather than at the moment it was needed.

#### `--device` takes the bound device's id on both platforms

iOS takes a _"Device name, UDID, or generic"_ and gets the bound simulator's udid. Android takes a _"Device name"_, which on SDK 57 matched the AVD name only: an `adb` serial was answered `CommandError: Could not find device with name: emulator-5554` [observed — live, 2026-09-04], which cost a whole run to find, and this CLI translated the serial to the AVD name first. SDK 58, the floor, matches a serial too, and the bound device of [[0035-one-device-per-worktree]] is a read-only emulator instance whose AVD name several instances share, so the install passes the serial and no translation runs. `androidDeviceNameAsync` stays for display: an emulator is its **AVD name**, from `adb -s <serial> emu avd name`, and a physical device is the `model:` field of `adb devices -l`, the two names `@expo/cli`'s own device list builds [reference — `src/start/platforms/android/adb.ts` §getAttachedDevicesAsync].

### A link nobody can approve is a link that never opens

Two obstacles sit between an unattended `simctl openurl` and a readable app, and **both were fixed for Expo Go and left in place for every development build** [observed — Kudo, local run, 2026-09-04].

**The dialog.** A scheme iOS has not seen approved raises `Open in "<app>"?` with Cancel and Open — and `simctl openurl` **exits 0** while that alert is up. The link was delivered; the alert is the app's front door; there is nobody in this loop to press Open. The run then waits out its whole attach budget and reports, correctly and uselessly, that no app attached. Worse, the alert is **sticky**: it survives `simctl terminate`, `uninstall` and `install`, because it belongs to SpringBoard rather than to the app, so one unanswered dialog poisons every later run on that simulator until something restarts SpringBoard.

**The sheet.** A first-ever launch of any app that ships `expo-dev-menu` then puts its onboarding sheet over the screen — "This is the developer menu… Continue" — and there is nobody to press Continue either. §The smoke gate calls the picture evidence, and a picture of an onboarding sheet is evidence of nothing.

§Putting Expo Go on a simulator that has not got it solved both, and scoped the fix to an app **this run had just installed** — on the reasoning that a preference belonging to an app the caller already had is theirs and not ours. That reasoning was wrong twice over:

- `@expo/cli` settles the first half. `openUrlAsync` calls `updateSimulatorLinkingPermissionsAsync` before **every** `simctl openurl` for any `appId`, Expo Go or not [reference — `src/start/platforms/ios/simctl.ts`]. So writing it is parity, not a policy of ours.
- The live run settles the second. With the approval fixed, a development build the caller had built themselves launched and sat behind the onboarding sheet for the whole 120-second budget. A first-run onboarding nobody has seen is not a preference anybody chose, and without it the loop cannot get past it.

So both writes now happen for **every local iOS open**, for whichever app the link belongs to (`src/device/approveScheme.ts`), memoized per device and app so one `navigate` — which opens the launcher URL and then the route link — writes each once.

The app id is what makes this work, and its absence is what made the first cut a silent no-op. An `appId` reached an open in this CLI from `--app-id` and from nothing else, because until now only Android needed one — there it scopes the intent. So the write was skipped on every ordinary run. It is resolved now: `--app-id`, then Expo Go for Expo Go's own two schemes, then `ios.bundleIdentifier` from the app config. **And `projectRoot` had to be threaded to the local branch of the open**, which had only ever passed it on the cloud path — three layers of the same shape in one fix, each one a seam that existed with nothing feeding it.

Measured end to end on iOS 26.5 against a development build with `react-native-pdf`: before, `Open in "pdfbuild"?` and exit 22 after 120 s; after, no dialog, no sheet, and the app's own screen in the screenshot [observed, 2026-09-04].

### The run brings its own environment

Start what is missing, stop only what you started, leave what you found [confirmed, Kudo, 2026-08-29]. `--start` is the default. `--no-start` is the opt-out. A dev server that was already up is used and still running afterwards. One this run started is stopped in a cleanup. The same for the device. The run tracks "I started this" explicitly. It never infers it at cleanup time.

`start-dev-server` and `boot-device` appear in the phase list only when the run did them. Every other phase is a question of every run, so a run that never reached one owes the reader a `skipped` row. These two are acts. A machine that already had a dev server did not skip a start. Their failures are the ordinary 20-band. The cleanup still runs.

Cleanup is registered before the resource is started, newest-first. A start that got halfway is still a resource this run is holding. Newest-first because the dev server is started before the device is booted, and leaving an app talking to a bundler that has gone is a worse state than the reverse. A cleanup that fails is reported and never folded into the outcome. It lands in `environment.cleanup`, as a `left behind` line, and on `cli:smoke` as `leftBehind`.

### It builds what the app needs, and says so first

This section used to be called "This command does not build", and it was the boundary: the start phase asked `StartPlan.buildLocation` first and refused with `npx @expo/agent-cli dev` when the plan would compile. That refusal is a correct instruction and a dead end for the caller this CLI is for [confirmed, Kudo, 2026-09-03] — an agent cannot take it without leaving its loop, and the loop is the thing being served. So the plan runs, whatever it contains.

**And the run says so before it waits.** A command that blocks silently for twenty minutes is indistinguishable from one that has hung, so the single thing the caller needs is the sentence that tells them which it is. It goes to stderr, because stdout carries one JSON object and nothing else (llp/0006 §Output contract) — `Log.progress` exists for exactly this and is neither `log`, which would break that contract, nor `warn`, which colours yellow for something that is not going wrong. `cli:smoke_building` carries the same fact for a reader of the event stream, emitted before the build rather than after it.

A plan that compiles gets a budget the shape of a compile: `BUILD_DEV_SERVER_TIMEOUT_MS`, thirty minutes, against the two the ordinary start gets. The number is the shape of the work rather than a measurement — a cold `expo run:ios` is a pod install and a full native compile — and the cost of a bound that is too short is the worst failure this command has, twenty minutes spent and then a timeout reported for a build that was going fine.

The follow-ups change with it. "Start one in the foreground and watch it fail" is good advice for a start that took seconds and expensive advice for one that took minutes, so a run that built leads with `dev:logs`: the build already wrote down why it stopped, and reading that costs nothing where another build costs the whole build. This is llp/0009's no-useless-re-run rule met from the other side — a re-run that _can_ change the state, at a price the reader should not have to pay to find out why.

`buildAttempted` is on the run for that decision, and set whether the start succeeded or failed: a build that failed is exactly the case where the cheapest next step differs from the ordinary one.

#### A refused connection is not an answer

**A thirty-minute budget is worth nothing if the wait it bounds returns in ten milliseconds**, and for the first version of this section that is what happened [observed — Kudo, local run, 2026-09-04].

`waitForBundlerReadyAsync` made **one** request and no loop. The reasoning was sound as far as it went: `//status` answers only once the bundler has finished, so the request _is_ the wait, and a poll would be a second mechanism for a thing HTTP already does. That holds exactly while something is listening on the port.

The case it fails in is the expensive one this section is about. `expo run:ios` publishes the dev-server lock at the **start** of its dev-server step — the same F125 fact §Daemonization records for the phase reporting — and the port does not open until Xcode has finished, minutes later. The fetch was refused in about ten milliseconds, `waitForBundlerReadyAsync` returned `ready: false, timedOut: false`, and the run reported `a dev server could not be started (… --wait-ready gave up after 10ms)`. `smoke --ios` on a project that had just gained a native module failed in 23 seconds having compiled nothing, while the build it had announced carried on in the background.

So a **connection-level** failure is retried, once a second, until the budget runs out. Three things are deliberate about the shape:

- **Only a refusal retries.** A server that answered has answered, whatever it said — a 500, a body that is not `packager-status:running`, a TLS failure — and asking again would spend the budget on a settled question. `ENOTFOUND` is specifically not retried: a hostname that does not resolve will not start resolving, and waiting thirty minutes for it would turn a typo into a hang.
- **The codes were measured, not assumed.** `undici` reports every network failure as `TypeError: fetch failed`, so the message says nothing; the syscall code is on `.cause.code`, and `localhost` — which resolves to two addresses — gives an `AggregateError` whose own `errors` carry one code each [observed, 2026-09-04].
- **The timeout says which thing happened.** "The bundler was still working" is false when nothing ever listened: there was no bundler. A budget that expires with no answer at all reports `nothing was listening on … for Nms`, which is a dev server that never finished starting (see [[0021-honest-reports]] §The rules).

The test that should have caught this existed and did not, which is worth more than the fix. `reports an unreachable dev server instead of throwing` pointed at **port 1** — and `undici` rejects port 1 as `bad port` before it opens a socket, so the case never exercised a refused connection at all. It is now four cases against a real server that starts listening a second and a half late: the retry that finds it, the budget that expires without it, the caller's `signal` that ends the loop early, and the hostname that must not be waited out.

The bootstrap is not charged to `--timeout`. A cold simulator takes about a minute. A cold first bundle takes longer. Each act has a budget of its own: 120 s for the dev server, 120 s for an iOS boot, 240 s for an Android one. This run pays for the cold it caused. First compile (`FIRST_BUNDLE_TIMEOUT_MS`, 3 min) when it started that dev server. First launch and attach (`APP_ATTACH_TIMEOUT_MS`, 2 min) when it started the dev server or booted the device. That attach budget is taken once and shared by the open and the `app` phase wait, so a cold run that never attaches answers after two minutes rather than four. First readable runtime (`RUNTIME_READY_TIMEOUT_MS`, 15 s) when it opened the app. `--timeout` bounds the reads.

### The device that can open the app

Which device gets booted: on iOS, the simulator bound to this worktree, reused or created by the device registry ([[0035-one-device-per-worktree]]); a created one has no app, so the install phase puts it there. Android makes no such choice: there is normally one AVD, and the package list needs `adb` on a running emulator. `--eas` boots nothing. A run whose dev server already has an app attached boots nothing.

An attached app is not yet a readable app. Expo Go registers a target, downloads the bundle, and the target goes away and comes back when the JS runtime is created. A single read landing in that gap answers `No target found` about an app that is running. The `runtime` phase asks `Runtime.evaluate('1')` until it answers. An app this run opened or reloaded is asked again for up to 5 s after its first `-32601`, inside the runtime-ready wait (§A reloading runtime answers like one with no debugger). An app that nothing moved is asked once, because polling a runtime with no debugger would turn the refusal into a hang. A wait that ends with no answer reports the runtime's own reason.

`smoke` waits before it photographs. Nothing over this protocol says "rendered". What is waited for is two reads of the target list that name the same ids, bounded, and only for a run that put the app there.

A development-build open that still has the launcher on screen lists no debugger target on this project's dev server [observed, 2026-09-01]. The `app` phase is inconclusive and the reading phases are skipped. The launcher and the project are the same application, so `/json/list` cannot tell them apart. The picture is labelled from the open's own report: the project's screen, the launcher's, or a device with neither.

`smoke`'s error window has no dev-server-log fallback. On Expo Go for Android the `errors` phase is `inconclusive` where `runtime:errors --android` reports a log-backed observation of the same window. The reason names the runtime. The `runtime` phase is inconclusive either way, so the outcome stays 22. On a development build both phases measure.

Live evidence for the eight-phase table, Expo Go Android at 22, and a development build at 0 is [[0022-live-tier]].

## Android

Every refusal below was measured against Expo Go for Android. On a development build of the same project, on the same emulator, `runtime:eval` returns values, `runtime:tree` reads the screen, `runtime:tap` and `runtime:type` drive it, `runtime:errors` reports `runtimeReadable: true`, and `smoke --android` exits 0. The sentences are about an app, not about a platform.

Expo Go for Android now reaches the gate on the same footing as iOS in everything except the debugger: §Which platform is the caller's to say makes `--android` a thing the caller states rather than a thing the host guesses, and the two Expo Go sections above install and version-check through `adb` rather than refusing by name.

Expo Go for Android ships a Hermes without any CDP debugger [observed, `HermesRuntime[RNBridgeless] does not support debugging over the Chrome DevTools Protocol`]. `Runtime.enable`, `Log.enable`, `Network.enable`, and `Debugger.enable` acknowledge. `Runtime.evaluate` answers `-32601`. The ack is what makes an empty window look like a healthy app. Collectors probe the runtime as they open their window, with `Log.enable` for the announcement and one `Runtime.evaluate` of `1` for the code. The verdict is `RuntimeDebuggerCapability`. `RUNTIME_EVALUATE_UNSUPPORTED` is reached by asking, not by knowing the platform.

The target selector skips only on transport failure, and ranks `-32601` targets behind answering ones. It no longer drops such targets. `CdpRuntimeErrorCollector` forwards every `CdpClientOptions` key, including `targetSelection` and `deviceInventory`.

`/json/list` does not name a platform. Two live targets on one dev server differ in `appId` (`host.exp.Exponent` vs `host.exp.exponent`), `deviceName`, and `title`. `description`, `type`, and `reactNative.capabilities` are identical. `src/runtime/targetPlatform.ts` infers the platform, strongest evidence first: a device name this machine's own device tools just reported (`simctl list devices booted`, `adb devices -l`), then React Native Android's `<model> - <release> - API <sdk>` shape, then Expo Go's two app ids. A target none of them place is `null` and is never counted as either.

A run on an EAS Simulator session reads the session's app and skips every app on a local device, by the rows in §Which app a run reads. An Android session's target is placed by its name shape. `navigate`, `smoke` and the runtime reads apply the rule. `smoke` applies it also when a config's EAS device turns on `--eas` after the run started. Tests: smoke targetSelection-test "does not count a local Expo Go app as the cloud session $case"; e2e smoke-target-selection-test "smoke reloads only its own app beside $name"; e2e navigate-target-selection-test "$name" (no flag, iOS session, its app attached; --ios --eas --app-id, iOS session, its app attached).

Scoping reaches every reader of the connected apps for every caller that names a platform: the preflight, the attachment wait, and the debugger client's target choice. Only a command that requires a runtime still refuses on an empty scope. For `reload` an empty scope is a rung of its ladder. For `stop` it is already-stopped success. `resolveAppId` drops the other platform's Expo Go id before it takes the first one. An id it cannot place is kept: a development build's package name says nothing about a platform.

The bundle-check platform is derived from the apps that are actually connected. The run's scope wins: a named `--platform`, or with no flag the device bound to this worktree ([[0035-one-device-per-worktree]] §Readers). One connected platform is that platform. Two are both. Nothing connected leaves the fixed default, and the report says so. A broken bundle decides the run whichever platform it was found on.

`adb` is resolved from `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `PATH`, then this platform's default install location (`src/device/adb.ts`). A tool failure is `ADB_NOT_RUNNABLE`. It names every place that was looked. "No device" is reachable only once `adb` has run and answered.

Which apps a device has, and which version of one, is `src/device/androidApps.ts` — the Android counterpart of the simulator-disk reader, and the source §The Expo Go on the device is not the Expo Go the SDK wants and §Putting Expo Go on a simulator that has not got it now use on this platform. Both of its answers distinguish "has not got it" from "could not look", because the caller that acts on the first downloads a few hundred megabytes.

On Android, `am force-stop` exits 0 whether or not the app was running. `stopAppOnDeviceAsync` asks `adb shell pidof <appId>` before the stop. A pid makes `wasRunning` an observation. Exit 1 with nothing said makes it `false`. A `pidof` that could not run makes `verified` false and `wasRunning` null. The `adb shell` returns as soon as ActivityManager has taken the request, so `stopped: true` means the stop ran. A caller that needs the process gone has to look.

Follow-ups keep the platform flag the run had. `navigate --android`'s screenshot line names `npx @expo/agent-cli smoke --android`. `status` lists every local device (`LocalDeviceStatus.devices`).

On a local iOS simulator, every `simctl openurl` of a development-build scheme raises a springboard confirmation, `Open in "<app>"?`, on every call. The four gates that let `navigate --cloud` answer the dialog start with "only on `--cloud`". Whether that gate should be about the device rather than about the flag is open. With the dialog answered by hand, the iOS development build behaves like the Android one.

### A reloading runtime answers like one with no debugger

A development build on Android also answers `Runtime.evaluate` with `-32601`, for about 1.5 s after a reload, on the same target id, until its new runtime exists [observed — EAS Simulator Android session, SDK 58 development build, a `Page.reload` then one `Runtime.evaluate` of `1` every ~350 ms: four `-32601`, then `ok` at 1.9 s, 2026-10-22]. The target list does not change in that gap, so the settle does not cover it. One `-32601` is therefore not a verdict on an app this run moved. `smoke` asks again for 5 s after the first `-32601` and only then reports a runtime with no debugger. An app that nothing moved is still asked once. The `it.each` `reads a reloaded app that answers …` enforces the grace and that it does not shorten the runtime-ready wait. The `it.each` `asks a runtime with no debugger in …` enforces its end.

Expo Go for Android pays the grace in full. Every run that reloads or opens the app moves it, and a reload is the default, so almost every `smoke --android` on Expo Go pays about 5 s before its verdict.

Rejected: Expo Go for Android's `Log.entryAdded` announcement that the engine "does not support debugging" (§Android) as the discriminator. It could end the wait at once for Expo Go, but the runtime phase asks `Runtime.evaluate` and does not read the log window. A second source for one verdict costs more than about 5 s per run.

## Cloud simulator

_Renamed 2026-09-08:_ the flag this section calls `--cloud` is **`--eas`** now, on every command that has it — `smoke`, `navigate`, `runtime:reload`, `runtime:stop`. `dev` already said `--eas` for the build backend ([[0015-backend-selection-and-config]] §One flag for EAS), and two names for one service meant `dev --cloud` and `smoke --eas` were both refused as unknown options [observed — 1.0.9]. `--cloud` is gone, not aliased [Kudo, 2026-09-08]. The text below keeps the name it was written with; read `--cloud` as `--eas`.

Device resolution has a third backend: a simulator that runs on EAS [confirmed, Kudo, 2026-08-26]. `@expo/agent-cli navigate --cloud` drives it. A machine with no local device reaches for it as a fallback on `navigate` and `smoke`. `runtime:stop` and `runtime:reload` take `--cloud` and reach for it only when named, so a session that happens to be up never quietly bills a run that a local device would have served.

The developer config does not move `navigate`, `runtime:reload` or `runtime:stop` [Kudo, 2026-10-22]. `runtime:stop` and `runtime:reload` still reach a session only when `--eas` names it. `smoke` applies `deviceBackend` only when it starts the dev server itself ([[0015-backend-selection-and-config]] §The device backend).

`NavigateDevice` gains `backend: 'local-ios' | 'local-android' | 'cloud'`. It is reported rather than inferred from `platform`. An EAS session runs iOS too. It rides in `--json` as `deviceBackend`.

The order in `resolveDeviceAsync`:

1. `--cloud` (`cloud: 'required'`): the session is the device. No platform tool is asked.
2. A local device: free, instant, and what a developer at a keyboard is looking at.
3. The session (`cloud: 'fallback'`): only when the local probes found nothing.

`--cloud` is a backend flag. `--cloud --ios` names the platform the session must be. A session that is the other one is refused. `--cloud --print-url` is refused: one asks for a device and the other asks for none.

The backend is `eas simulator:<verb>` subprocesses (`src/device/cloudSimulator.ts`), per [[0001-agentic-cli-on-expo-cli]] constraint 5. Device verbs go through `eas simulator:exec npx agent-device@latest …`. `AGENT_DEVICE_SPEC` is that decision in one constant. `simulator:exec` loads the connection environment and starts its child locally; `agent-device` uses that environment to reach the cloud daemon [observed — installed eas-cli 24.10.0, `build/commands/simulator/exec.js`, 2026-10-09]. The session guard of [[0035-one-device-per-worktree]] §Session guard therefore resolves the controller command for the caller's platform, including Windows batch-file escaping. The logical argv is pinned by a test table (`src/device/__tests__/cloudSimulator-test.ts`). Enum values come back as raw GraphQL enums (`IN_PROGRESS`, `IOS`) while `type` is the flag spelling (`agent-device`). `startedAt` and `finishedAt` are absent rather than null when they do not apply.

A cloud device is a session the service says is running, not a file on disk [confirmed, Kudo, 2026-08-26]. `eas simulator:list`, with the statuses of [[0035-one-device-per-worktree]] §Session discovery, is the probe. MCP need not write `.env.eas-simulator`. `simulator:start --json` and `--out-config-type env` do not write it either. The file outlives the session it names. Direct GraphQL to `api.expo.dev` is rejected: it reads another CLI's credential store. `eas` is the program that owns that token, so `eas` is the program that spends it.

The device ladder (`navigate` and `smoke`) asks the service. The suggestion ladders (`status.next`, the `start` and `dev` banner) read the cloud bindings of this worktree with no network call ([[0035-one-device-per-worktree]] §Session binding). They promise to be instant.

Which session, when there is more than one, is deterministic. The rule is [[0035-one-device-per-worktree]] §Session binding. In short:

1. A candidate is a live `type: agent-device` session whose id is bound to this worktree or is the id in `.env.eas-simulator`. An `argent`, `appium`, or `serve-sim` session has no agent-device daemon. A project whose only live sessions are of another type is told that.
2. The order is the requested platform, then a bound id, then the dotenv id, then the newest `createdAt` (`id` ascending breaks a tie).
3. A live session that is not a candidate is never selected.

The chosen id is reported on the `Device` line, as `deviceId` in `--json`, and on the `cli:navigate` event.

A cloud simulator requires a tunnel. `exp://127.0.0.1:<port>` names the loopback of whatever resolves it, and for a cloud session that is a machine in a datacenter. There is no `adb reverse` that can fix it. A `localhost` or `lan` URL is refused before anything opens (`CLOUD_SIMULATOR_UNREACHABLE_DEV_SERVER`). The check lives in `openRouteAsync`, next to the device. The identical URL is perfectly good for the simulator on this desk.

`close` reports success whatever id it is given. The help says "close the named app". What the service does is answer about the session. `runtime:stop --cloud` therefore reports `wasRunning: null` and `verified: false`. The `--app-id` mismatch check is gated on `verified`. The verb is kept. Closing the foreground app is a real act. The claim about which app is removed. `runtime:reload --cloud` and the Android attach recovery consume `close` as a nudge and verify the outcome independently.

A `close` that ran out of time is asked once more. On Android the controller runs `am force-stop` and waits for the app to leave the foreground, for the processes that ran before the close to exit, and for `pidof` to come back empty. Each wait that runs out is `COMMAND_FAILED` with reason `android-app-close-timeout`, in one of three sentences: "remained foreground after close", "process that ran before close did not exit" or "process remained running after close". On an EAS Expo Go session one of these waits runs out in about 1 stop of 3. A second refusal is the answer. Any other refusal is not retried. Test: `appProcess-test.ts` "asks the controller once more only after a close timeout".

`DEVICE_IN_USE` is retried once, bound to the session the controller named. Never a second session. Acting on "start a new one" bills a second machine and leaves the first one held. The `How:` names the session the controller named, points at binding the verb to that session, and says not to start another.

`xcrun simctl openurl` exiting non-zero is the device refusing the link, exit 1. `eas simulator:exec` exiting non-zero is any of five things: a session that ended mid-run, a signed-out account, a controller flag this CLI got wrong, a binary that was never the EAS CLI, or the device refusing after everything worked. `readControllerError` recognises `Error (CODE): <sentence>`. `CLOUD_SIMULATOR_DEVICE_REFUSED` says the command reached the device, and the device is what said no. A signed-out account becomes the `eas-login` handoff and exit 7. `looksLikeWrapperCrash` names the `eas` under that name rather than quoting a Rust backtrace.

The ways there is no session are separate errors. `unknown` is a tool that did not answer and has said nothing about the world.

| State                                   | Error                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `inactive`                              | `NO_CLOUD_SIMULATOR_SESSION`, saying the bound id or the dotenv id is not among the live sessions |
| `none`, live sessions of the wrong type | `NO_CLOUD_SIMULATOR_SESSION`, naming the types that are up                                        |
| `none`, feature available               | `NO_CLOUD_SIMULATOR_SESSION`, naming `simulator:start` and that it bills until stopped            |
| `none`, feature off                     | `CLOUD_SIMULATOR_UNAVAILABLE`, with the waitlist URL, plus the local device and `--print-url`     |
| `unknown`                               | `CLOUD_SIMULATOR_SESSION_UNKNOWN`, naming `simulator:list` and never `simulator:start`            |

Availability is asked only when the listing came back empty of usable sessions. "Start one" for a session that could not be ruled out starts a second billed session.

On `--cloud`, reload rung 2 is the primary mechanism. The tunnel carries the bundle over HTTP. It is not evidence of a client on the command socket. Live there was none. The broadcast reached nobody.

```
eas simulator:exec npx agent-device@latest open <app-id> --platform ios --relaunch
eas simulator:exec npx agent-device@latest open <url>    --platform ios
```

`--relaunch` terminates the app process and launches it again. `close` is the verb that ends the controller's session. Two verbs, not the documented shell-plus-link form. A cold launch of Expo Go with a dev-server URL hits `UNIQUE constraint failed: updates.scope_key, updates.commit_time`. Restart the shell with no URL, then send the link. The URL is `navigate --cloud`'s, resolved by `resolveRouteUrlAsync`. The tunnel precondition is checked before the first verb. A cloud relaunch that nothing observed is exit 22. On a local device the relaunch is an observation, because `simctl terminate` names a process and fails when there is none.

An `exp://` URL handed to the system on an iOS cloud simulator raises "Open in 'Expo Go'?". Nobody is in front of the screen. `navigate --cloud` answers that dialog itself, under four gates: only on `--cloud`, only after this run's own open exited 0, only when nothing attached inside the budget, and only after `alert get` names the app the URL was for. The empty answer from `alert get` is exit 1, `alert not found`, which makes a speculative read safe. `attachAlert` carries three states: answered, some other alert, and none.

`eas simulator … --expo-go --open-url exp://<host>` is the session start that skips the dialog. Every piece of advice that starts a session names `eas simulator … --expo-go` (`CLOUD_SESSION_START_COMMAND`). A session started without it lists only the controller's test runner.

`smoke` takes `--cloud` and resolves its device through `resolveDeviceAsync`. One answer, threaded from the `route` phase into the `screenshot` phase. The screenshot primitive downloads to the path, with a longer budget covering `npx`, a network, and an image coming back. The PNG-signature check is identical. Nothing suggests a platform tool for a cloud device. This CLI never spawns `eas simulator:stop`. It only names it.

`--shutdown` is never passed. The distinction between one app and the whole remote machine is a flag.

## Stopping the app

`runtime:stop` ends the app on the device [confirmed, Kudo, 2026-08-23]. `@expo/agent-cli navigate` starts one. The id is ranked (`src/runtime/appId.ts`): `--app-id`, then the `appId` of a debugger target, then `ios.bundleIdentifier` / `android.package` from the app config, then Expo Go per platform. A dynamic `app.config.js` is evaluated the way §Pointing an app at this dev server describes. The report names the rung that answered (`bundleIdSource`, `bundleIdReason`). The two Expo Go ids differ only in case: `host.exp.Exponent` on iOS, `host.exp.exponent` on Android.

The dev server outranks the app config. The config names a build. The dev server names what is running. A project whose config names a bundle identifier can still be running in Expo Go.

An app that was not running is success, with `wasRunning` saying whether this command produced that state. On Android the distinction is the `pidof` observation above.

When `--app-id` names an app that was not running and the dev server reports a different app that is, the command exits 20 [confirmed, Kudo, 2026-08-24]. An agent reads the exit code before it reads a word of the output. A warning inside a zero is a warning nobody acts on. Three conditions have to hold together: `--app-id` was passed, the device tool found nothing under it, and the dev server reports at least one debugger target none of which is that id. Idempotency holds. After a successful stop nothing is connected, so the second run has no other app to disagree with and exits 0. `--json` gains `connectedAppIds` and `appIdMismatch`. The follow-up is the same command with the connected id on it.

`dev:stop` reads the dev-server lock, signals the PID it names, and waits for the PID and the lock [confirmed, Kudo, 2026-08-23]. The port is reported, never waited on. `127.0.0.1:8081` and `[::1]:8081` are different sockets. A port check is corroboration. PID liveness (`process.kill(pid, 0)`, with `EPERM` read as alive) is the conclusion. `--json` carries `processStillRunning` beside `portStillAnswering`.

A port with no lock behind it is left running, exit 20. `--force` needs two independent proofs: the port answers `packager-status:running`, and the process on the port has a command line naming a program that runs one. Nothing running is exit 0. Without `--port` the report names the flag. Defaulting to 8081 is how a command ends up reporting on another project's server. Windows is `taskkill /PID <pid> /T /F`, best effort.

`dev:logs` reads the detached log (`.expo/dev/logs/`), strips escape codes, and names whether the log belongs to a server that is running now. A project with a running dev server and no log was started in a terminal. No `--follow`. An agent polls. Each read is bounded. Lines are fenced as untrusted ([[0008-guardrails]]).

## Testing

Schema unit tests plus tier-0 e2e against a fixture app ([[0002-testing-and-evals]]). The e2e stub dev server speaks a real `/message` WebSocket with `version: 2`, `getpeers`, peer churn, and debugger targets that re-register under a new page id on a `v2` reload. Four modes: `v2`, `deaf`, `no-churn`, `none`. `reloadTargets` picks `reconnect`, `stale`, or `gone`. It counts broadcasts and `Page.reload`s. The route table is unit-tested against the conventions. E2e asserts that a bogus route reaches the device tool zero times. `dev:stop` signals a real process. `runtime:stop` asserts the exact argv handed to a stub `xcrun`. Live suites in [[0022-live-tier]] are the evidence for Android Expo Go, Android development build, iOS, and cloud.
)

<!-- installed-app-check -->

## Installed-app fingerprint check

A debug build carries the fingerprint it was built from, in a file `expo-constants` writes at build
time (expo/expo#49905): `assets/app.fingerprint` inside an APK, `EXConstants.bundle/app.fingerprint`
inside an app bundle. The readers in `src/installedApp/` get that file off a device and parse it.
They report what a device holds; deciding what it means is [[0004-smart-start-and-project-state]]
§Installed-app fingerprint check.

### How the file is read

**Android.** `adb shell pm path <appId>` names the APK. The file is a zip entry inside it, so the
reader fetches the end-of-central-directory record, the central directory and the one entry through
ranged `dd` reads over `adb exec-out`: a few hundred KB instead of a 100 MB pull. `src/utils/zipEntry.ts`
parses stored and deflated entries and refuses ZIP64. When the device lacks `dd` or `stat`, the whole
APK is pulled to a temporary directory and read there. A zip the parser cannot read is an error, not
a reason to pull.

**iOS simulator.** `xcrun simctl get_app_container <udid> <appId>` names the app bundle, and the file
is read off disk at one of two paths: `EXConstants.bundle/app.fingerprint` for static linking,
`Frameworks/EXConstants.framework/EXConstants.bundle/app.fingerprint` for `use_frameworks!`. Only
the bound simulator is read, and only while it is up; `simctl` cannot look inside a shut-down one.

**iOS device.** `devicectl` exposes no app container, so the app has to answer for itself. The
reader starts a one-shot HTTP server on the LAN, launches the app through `devicectl device process
launch --payload-url` with a URL carrying a one-time nonce and the callback address, and the
dev-launcher responder in the app posts the embedded fingerprint back (expo/expo#49494). The URL is
host-free and carries reserved `__expo_fingerprint_*` query parameters, so it claims no route of the
app's: a host would read as a destination and take a name out of the app's own namespace. A
toolchain whose `launch` refuses a running app falls back to `openURL`, which routes by the
project's static `expo.scheme`; a project without one has no fallback. The nonce is compared in
constant time, the body is capped at 4 KB, and the server closes as soon as it has an answer. The
response clock starts once the trigger was delivered, so a slow launch does not eat the phone's
time; a timeout is `no-response`, never `up-to-date`.

**Which iOS device.** The simulator bound to this worktree ([[0035-one-device-per-worktree]] §Readers); `--device` lists the booted simulators to filter instead. A phone is probed only when `--device` names it:
the probe launches the app, and naming the phone is the consent. A phone that is connected but not
named is mentioned in a hint. A phone that is unreachable, or has Developer Mode off, is named with
what to do about it and not probed.

**Several devices.** Each device answers on its own, and the most informative answer wins: a
matching app, then any app with a hash, then an app without one, then a definite "not installed",
then silence. One device that cannot be read does not hide the others.

The file's shape is `{hash, fingerprintVersion, sources}`. Anything else — absent, empty, the
pre-JSON bare hash — reads as "no embedded fingerprint", never as an error.

### Proof

Unit, `src/installedApp/__tests__/`: the parser over valid, malformed, versionless and legacy input;
the Android reader over a stubbed `adb` (ranged read, the pull fallback after a transport failure,
no pull for an unreadable zip, not installed, no file); the simulator reader over both bundle paths;
ranking across several devices. `src/device/__tests__/devicectl-test.ts` over a trimmed
`list devices` capture. `src/utils/__tests__/zipEntry-test.ts`: both compression methods, a
truncated entry, the EOCD-in-comment case, the ZIP64 refusals, and the ranged sequence over partial
buffers.

E2E, `e2e/__tests__/installed-readers-test.ts`, across a real process boundary and on every CI host:
the Android reader against a stub `adb` that serves the fixture APK byte range by byte range (the
one-argument `exec-out dd`, the bytes back through a pipe, the pull when `stat` is missing) and the
simulator reader against a stub `xcrun` that prints a container path holding a real file. The
stubs live in `e2e/__tests__/installedAppStubs.ts` for the `status` e2e to reuse.

The phone path, `src/installedApp/__tests__/`: the router (simulators first, a phone only when
named, the hints for an unnamed, unreachable or Developer-Mode-off phone); the probe over an
injected launch that posts back (match, mismatch, null and empty fingerprint, not installed, the
locked phone, the `openURL` fallback, no scheme, timeout, stop at the first match); the callback
server over real loopback HTTP (nonce, body cap, the clock armed after launch, close, the version
key). `src/runtime/__tests__/appId-test.ts`: the scheme read, and the refusal of anything that is
not a scheme. E2E on every CI host, `e2e/__tests__/installed-readers-test.ts`: the probe and the
router against a stub `xcrun` whose `devicectl` lists the fixture phones and whose `launch` returns
at once and posts to the callback URL it was handed from a detached child, across a real socket —
the launch argv, the phone named in a hint and left alone, the named phone launched on and read, a
build with no fingerprint, and a phone that answers after its time reading `no-response`. E2E on
the macOS runner, `status-installed-test.ts`: the same through `status --device`, plus
the `--device-timeout` refusals.
