# 0005: Runtime loop tools

**Type:** RFC
**Status:** Active
**Systems:** `@expo/agent-cli` runtime commands (`src/runtime/`, `src/runtime/preflight.ts`, `src/navigate/`, `src/runtime/reload/`, `src/project/routes.ts`); `@expo/agent-cli smoke` (`src/smoke/`, `src/device/screenshot.ts`, `src/device/bootDevice.ts`, `src/device/installedApps.ts`, `src/device/installExpoGo.ts`, `src/device/expoGoVersion.ts`, `src/device/approveScheme.ts`); the cloud device layer (`src/device/cloudSimulator.ts`); the Android device layer (`src/device/adb.ts`, `src/device/androidApps.ts`, `src/navigate/adbReverse.ts`, `src/runtime/targetPlatform.ts`, `src/runtime/targetLiveness.ts`, `src/dev/logErrors.ts`); installed-app readers (`src/installedApp/`); `@expo/cli` CDP debugging layer and dev-server message socket; `expo-router` link handling; LogBox
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-20 · finalized 2026-08-28
**Revised:** 2026-08-30 · 2026-09-08 · 2026-11-16
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0002-testing-and-evals]], [[0004-smart-start-and-project-state]], [[0006-agent-native-cli-surface]], [[0008-guardrails]], [[0010-agent-conventions]], [[0015-backend-selection-and-config]], [[0016-v1-scope]], [[0017-deferred-commands]], [[0018-interaction-commands]], [[0021-honest-reports]], [[0022-live-tier]], [[0026-dev-owns-the-open]], [[0027-everything-on-eas]], [[0035-one-device-per-worktree]]

## Summary

An agent that changes an app must see the running app and drive it. Two loops need this. Log triage: a red screen, `runtime:errors`, a symbolicated source location, a fix, then a check. A verified UI change: an edit, `runtime:reload`, a screenshot, a compare. Every report in these loops claims only what the CLI observed.

Decisions:

1. The tools are self-serve `@expo/agent-cli` commands. `expo-mcp` is not a dependency.
2. One preflight and one scope rule serve every command that reads the app (§One preflight for the runtime family, §Which app a run reads). A run never reads another worktree's app (§Target owner).
3. A report claims only what an observation shows ([[0021-honest-reports]] §The rules). A reload is reported only when the CLI saw the app come back (§What proves a reload).
4. `smoke` asks the other commands' questions in one process, and brings its own environment: it starts, boots and installs what is missing, and stops only what it started (§The smoke gate, §The run brings its own environment).
5. An EAS Simulator session (below: an EAS session) is a third device backend, reached through `eas` subprocesses (§Cloud simulator).

| Command          | Question                                      | Rules              |
| ---------------- | --------------------------------------------- | ------------------ |
| `runtime:eval`   | What does this expression give in the app?    | §runtime:eval      |
| `runtime:errors` | What errors did the app report in the window? | §runtime:errors    |
| `runtime:reload` | Does the app run the code on disk?            | §Reloading the app |
| `runtime:stop`   | Is the app stopped?                           | §Stopping the app  |
| `navigate`       | Is the app on this route?                     | §navigate          |
| `smoke`          | Does the app on disk build, load and render?  | §The smoke gate    |

App output is fenced as untrusted ([[0008-guardrails]] §Untrusted-content marking). Driving the app by testID is [[0018-interaction-commands]].

## What ships

The space forms (`runtime eval`) are the same commands as the Summary's colon forms. `runtime:network` is deferred ([[0017-deferred-commands]] §runtime:network).

Every CDP connection sends a same-origin `Origin` header. Metro's inspector proxy refuses the handshake without it (HTTP 401).

## runtime:eval

`runtime:eval` sends `Runtime.evaluate` with `returnByValue`. An exception in the app exits 1.

The app settles promises. The CLI wraps the expression, the app parks a thenable's outcome on a global under a per-run nonce, and the CLI polls it until it settles or `--timeout` ends:

- A value that is not a thenable comes back unchanged in one round trip.
- A settled value carries the `type` the app read.
- A rejection is `promise.state: rejected`, not `threw`. It exits 1.
- A promise pending at the deadline, or lost to a reload, is `RUNTIME_PROMISE_PENDING` (exit 1).
- `--no-await-promise` parks nothing and reports the pending promise at exit 0.

A statement such as `var x = 1` does not compile inside the wrapper; the CLI then runs the source as written. Hermes reports that as `Compiling JS failed`, not `SyntaxError`, so the CLI matches both.

Rejected: the CDP `awaitPromise` flag. React Native's `Promise` polyfill looks like an ordinary object to CDP, so CDP does not wait.

Expo Go for Android has no CDP debugger: `RUNTIME_EVALUATE_UNSUPPORTED` (§Android).

## runtime:errors

`runtime:errors` collects `Runtime.exceptionThrown` and `console.error` over a window. Both are required: React Native reports a thrown error through the console path, as one string with the error's own frames. The CLI takes the project's frames from that string and symbolicates them through the dev server's `POST /symbolicate`. Symbolication is not a precondition: a frame it cannot map keeps its bundle location, printed without the query string.

| Case                                                                    | Exit |
| ----------------------------------------------------------------------- | ---- |
| No `--fail-on-error`                                                    | 0    |
| `--fail-on-error`, one error or more                                    | 20   |
| `--fail-on-error`, a runtime that cannot answer, no dev-server log read | 22   |

An empty window means that nothing happened while the CLI watched, not that the app is healthy. Only `runtime:errors` has `--fail-on-error`; a report on the app does not gate on itself ([[0010-agent-conventions]] §Exit codes).

When the runtime cannot answer, `runtime:errors` reads the detached dev server's log, from a line mark taken before the window. Records carry `source: 'dev-server-log'`, and a caveat sits above the count. `devServerLog` holds `read`, `logFile`, `count`, `older` (errors from before the window, counted and not reported), `reason` and `otherPlatformsConnected`. The log names no platform, so `otherPlatformsConnected` names the other platforms whose app writes to it. `smoke`'s `errors` phase has no log fallback.

Beside the preflight's wait, the command waits up to 3 s more when target selection meets a dying target.

## navigate

`navigate <route>` opens a deep link on a device. The URL is the first that applies:

1. A full URL, only percent-encoded.
2. `--scheme`: `<scheme>://<route>`.
3. Expo Go: `exp://<host>/--/<route>`.
4. The app config's `scheme`.
5. `exp+<slug>`, which a development build registers.

The app config is read as `expo config` reads it: a dynamic config is evaluated after the project's env files load. When the evaluation fails, the static read stands and `resolution` says why. `--scheme` skips the evaluation. No usable URL is `DEEP_LINK_UNRESOLVED`.

The route is percent-encoded once. Delimiters, escapes the caller wrote, and IPv6 brackets (`exp://[::1]:8081`) stay.

`navigate /` on Expo Go opens `exp://<host>/--/?`: expo-router's Expo Go handler drops an empty path, and a bare `?` survives it as the index route. Rejected: a reload to reach `/`, because Expo Go loads its launch URL again.

`--print-url` resolves the URL and opens nothing, at exit 0. Its `--json` has `url`, `hostType`, `connect` and `printUrl: true`; `deviceBackend`, `platform`, `deviceId`, `command`, `exitCode` and `launch` are `null`. With `--eas` it is `BAD_ARGS`: one flag asks for a device and the other for none. `navigate` with no device names the URL and `--print-url` in its failure.

Exit codes: 0 when the link opened and an app attached; 1 for usage, `ROUTE_NOT_FOUND`, `DEEP_LINK_UNRESOLVED`, `CLOUD_SIMULATOR_UNREACHABLE_DEV_SERVER`, or a refused link; 22 when no app attached (§Loading the app is not navigating it).

### The route table

The route table comes from the project's files, by expo-router's conventions:

- The router root is `extra.router.root`, else the `expo-router` plugin's `root`, else `src/app`, else `app`.
- Group segments are stripped, and accepted in a URL. `index` collapses onto its parent.
- `_layout` and files with `+` in the last segment are left out. `+not-found` would make every route match.
- `/_sitemap` is added; the router generates it.
- `[id]` matches one segment. `[...rest]` matches the rest. A literal route wins over a dynamic one.

The check fails open. `--no-route-check`, a full URL, no router directory, and a config that cannot be evaluated give `routeCheck` `checked: false, ok: null` with a `reason`, and the link opens. The check says whether the project has the route, not whether the navigator can show it.

Rejected: asking the dev server. No endpoint serves native routes, and the routes manifest needs internals that [[0001-agentic-cli-on-expo-cli]] §Constraints forbids.

### Verifying the route

A route that the project has not got is `ROUTE_NOT_FOUND`, exit 1, and nothing opens; the router would show its unmatched screen, which no runtime check catches. The message lists the routes. `Try:` is the caller's command with the nearest route, else `/`: `navigate`, `runtime:reload --route`, or `smoke --<platform> --route`.

### Pointing an app at this dev server

`exp://<host>` is the Expo Go form only. A development build takes:

```
<scheme>://?__expo_url=<url-encoded dev server origin>
```

The origin is `https` for a tunnel host, else `http`. The scheme is `--scheme`, then the config's `scheme`, then `exp+<slug>`; with none, there is no development-build URL. `status` and `start` print the same form. Rejected: a version lookup or a legacy protocol fallback.

A connect URL loads an app; a route link navigates a loaded one (§Loading the app is not navigating it). `navigate` prints a `Connect` line beside `URL`, and `connect` in `--json`. When the app kind cannot be told (no app attached, no `--app-id`, no `expo-dev-client`, a native directory checked in), both forms print, Expo Go first.

`navigate` and `smoke` add `__expo_disable_onboarding=1`, `__expo_disable_fab=1` and `__expo_disable_auto_launch=1` to the connect URL. `EXPO_NO_DEV_MENU=0` drops them. Route links, full URLs and Expo Go links do not get them.

One device scope decides the app kind, the URL, the launcher choice and the attachment. An open counts only the apps attached on the device it opens (§Which app a run reads).

- The project and route are checked before the device is chosen. The URL is finalized after.
- Each wait asks the device tools again, so an app that attaches after an accepted dialog or a recovery counts.
- `--print-url` and `dev --eas` read the worktree's binding and count the same apps. An unreadable binding refuses them once the dev server lists an app.
- An attached app gets only the route link.
- `smoke` and `dev` pass their device to the open, which then extends no lease.

### Where a device reaches the dev server

A device-facing URL uses the current tunnel host before the listen address. The lock's `http://127.0.0.1:<port>` serves the CLI's own HTTP calls only.

The host comes from the `Waiting on <url>` line of `.expo/dev/logs/dev-detached.log`. A log older than the lock's `startedAt` belongs to an earlier run. When the log names no tunnel, the dev server's manifest (`launchAsset.url`) may, and its tunnel wins. A tunnel host is used only while its dev server runs; its transport health is not checked.

`--wait-ready` returns before the tunnel is up. `dev --detach --tunnel` waits up to 20 s for the host and reports `tunnelUrl` (`null` when none came) in `--json` and on `cli:dev_detach`.

`hostType` classifies the printed URL: `localhost`, `lan` (an IP literal), or `tunnel` (any other host name).

An EAS run refuses a `localhost` or `lan` URL before anything opens, with `CLOUD_SIMULATOR_UNREACHABLE_DEV_SERVER`, naming `dev --<platform> --detach --tunnel`. `<scheme>://<route>` has no host (`hostType: null`) and passes.

On Android a loopback host needs `adb reverse tcp:<port> tcp:<port>`; `am start` exits 0 either way. The reverse runs before the link, and only for a loopback host: a LAN or tunnel host is reachable, and reversing it would point the device at itself. Before a launcher open, the dev server's port is reversed. A refused reverse is not fatal: the `Port` line gives the reason, `reversedPort` is `null`, and the link shows the failure.

## One preflight for the runtime family

Every runtime command asks one question before it does any work: is a dev server running, and is an app attached to it? One preflight asks it for every command, and every command prints the same refusals.

| Command                                                                         | Needs             | No dev server answers   | The dev server lists no app                             |
| ------------------------------------------------------------------------------- | ----------------- | ----------------------- | ------------------------------------------------------- |
| `runtime:eval`, `runtime:errors`, `runtime:tree`, `runtime:tap`, `runtime:type` | a debugger target | `NO_DEV_SERVER`, exit 1 | `NO_APP_CONNECTED`, exit 22, after a 3 s wait           |
| `runtime:reload`                                                                | a dev server      | `NO_DEV_SERVER`, exit 1 | no refusal: the reload starts the app (§How it reloads) |
| `runtime:stop`                                                                  | a device          | no refusal              | no refusal                                              |

`runtime:stop` acts on a device, and the dev server is only its evidence for which app runs. An app that is already stopped is success ([[0010-agent-conventions]] §Other gates, in brief). With no device, `runtime:stop` refuses `NO_BOUND_DEVICE` ([[0035-one-device-per-worktree]] §Output and errors).

The refusals:

- `NO_DEV_SERVER`, exit 1: nothing answered `GET /json/list` on the dev server the command was going to use. The dev server is probed first, so "no dev server" and "no app on a running dev server" stay two facts.
- `NO_APP_CONNECTED`, exit 22: the target list was still empty after the reconnect wait. A reloading app is absent from the list for a short time, so a command that needs a debugger target polls an empty list for 3 s ([[0010-agent-conventions]] §An empty target list is inconclusive).
- `NO_APP_CONNECTED`, exit 1: the dev server lists apps, and none is in the run's scope (§Which app a run reads). Asking again gives the same answer until the app is opened.

The codes hold under a gate flag: `runtime:errors --fail-on-error` is 1 with no dev server and 22 with an empty list, never 0.

The How line is one ladder in one order: `npx @expo/agent-cli dev --detach --<platform>`, then `navigate / --<platform>`, then `smoke --<platform>`. With no platform flag, the ladder names the host's platform: iOS on macOS, Android elsewhere. When the caller passed `--eas`, `navigate` and `smoke` keep `--eas`, and `dev --detach` gets `--tunnel`, because an EAS session cannot reach this machine's loopback. Of the family, only `runtime:reload` and `runtime:stop` take `--eas`. When the caller named the dev server, `NO_DEV_SERVER` names that URL and says that nothing else was tried; otherwise it names `--dev-server-url` and `--port`.

`error.data` in the `--json` envelope holds what the refusal observed: `devServerUrl`, `devServerReachable`, `debuggerTargets`, `commandSocketClients`, `platform` ([[0010-agent-conventions]] §The `--json` error envelope). Every key is present, and a fact the run does not have is `null`. `commandSocketClients` is `null` except in `runtime:reload`, the only command that opens `/message`. Rejected: a caller that parses the English message for these counts.

The connection is asked before the bundle gate. With nothing attached, `runtime:tree`, `runtime:tap` and `runtime:type` exit 22 whatever the code on disk compiles to, and do not spend the gate's 20 s budget.

Every command of the family takes `--port <n>` as shorthand for `--dev-server-url http://127.0.0.1:<n>`; both together is `BAD_ARGS`. Every command takes `--platform ios|android` beside `--ios` and `--android`. `--ios --platform ios` is accepted; `--ios --platform android` is `BAD_ARGS`.

## Which app a run reads

A run reads only its own apps. An own app is an app that the run's scope reads, and an own target is its debugger target. An app is attached when it has a debugger target on the dev server and it is an own app. The scope comes from the caller's flags, from the device the run opens, and from the device bound to this worktree ([[0035-one-device-per-worktree]] §Readers). Every reader of the dev server's apps applies it: the preflight, the attach wait, and the debugger client's choice of target. The runtime reads and `smoke` resolve the scope by the same rules. An open (`navigate`, and the `app` phase of `smoke`) scopes to the device it opens and reads no other worktree's binding (§Target owner).

The dev server does not name a target's platform. The run places each target by evidence, strongest first:

| #   | Evidence                                                                                                              | Platform        |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | The device name is a booted simulator in `xcrun simctl list devices booted`, or an attached model in `adb devices -l` | iOS, or Android |
| 2   | The device name has React Native Android's shape, `<model> - <release> - API <sdk>`                                   | Android         |
| 3   | The app id is Expo Go's: `host.exp.Exponent` on iOS, `host.exp.exponent` on Android                                   | iOS, or Android |

A target that no evidence places is unplaced. A target's model and an `adb` model are compared in one spelling: every character that is not a letter or a digit is `_`, as `adb devices -l` writes it.

The rows below are in precedence order. The first row that matches a target decides.

| #   | Scope                               | Target                                                                                       | Result                 | Test                                                                                                |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | any                                 | the name of a booted simulator whose every udid only other worktrees bind                    | skip as other-worktree | `runtime-preflight-test` "%s exits 1 with NO_APP_CONNECTED"                                         |
| 2   | any                                 | simulator list unknown, and a name that only other worktrees' bindings hold                  | skip as other-worktree | `targetSelection-test` "skips a target with a foreign binding's name"                               |
| 3   | a platform                          | placed on the other platform                                                                 | skip as other-platform | `runtime-preflight-test` "reads the app it places"                                                  |
| 4   | bound simulator                     | its name                                                                                     | read                   | `runtime-bound-selection-test` "eval with"                                                          |
| 5   | bound simulator                     | another name                                                                                 | skip as other-device   | `runtime-bound-selection-test` "eval with"                                                          |
| 6   | bound Android device                | any, when `adb` gave no answer or no model for the bound device                              | undetermined           | `targetSelection-test` "on the Android device bound"                                                |
| 7   | bound Android device                | any, when the bound device is not attached; or another model                                 | skip as other-device   | `runtime-bound-selection-test` "eval refusal"                                                       |
| 8   | bound Android device                | its model, which no other attached device has                                                | read                   | `targetSelection-test` "on a bound phone"                                                           |
| 9   | bound Android device                | its model, shared with another attached device, and only the bound device reverses this port | read                   | `runtime-bound-selection-test` "eval reads the bound emulator"                                      |
| 10  | bound Android device                | its model, shared, and the reverse answer is another device, none or unknown                 | undetermined           | `runtime-bound-selection-test` "eval refusal"                                                       |
| 11  | EAS session                         | the name of a booted local simulator, or the model of an attached Android device             | skip as other-device   | `runtime-bound-selection-test` "eval with"                                                          |
| 12  | EAS session, iOS or no platform     | any target, when `simctl` gave no answer on macOS                                            | undetermined           | `targetSelection-test` "reads no Expo Go target"                                                    |
| 13  | EAS session, Android or no platform | an Android-shaped target, when `adb` gave no answer                                          | undetermined           | `targetSelection-test` "an Android session holds"; `targetInventory-test` "holds an Android-shaped" |
| 14  | EAS session                         | placed                                                                                       | read                   | `cloud-simulator-test` "counts the app"; `targetInventory-test` "reads an Android session"          |
| 15  | EAS session                         | unplaced                                                                                     | undetermined           | `cloud-simulator-test` "reads neither unclaimed app"                                                |
| 16  | a platform flag only                | placed                                                                                       | read                   | `runtime-preflight-test` "reads the app it places"                                                  |
| 17  | a platform flag only                | unplaced                                                                                     | undetermined           | `runtime-preflight-test` "does not read an app nothing places"                                      |
| 18  | none                                | any                                                                                          | read                   | `runtime-reload-test` "checks the bundle on both platforms"                                         |

An undetermined target is not read. When no target is read and some are undetermined, a command that needs a debugger target refuses `NO_APP_CONNECTED`, exit 1, and says so.

After the table, one pass reads an EAS session on iOS or with no platform. Its one undetermined target is read as the session's app when rows 12 and 13 did not decide it. With no platform flag, that target is read only when no other target is read. Two undetermined targets stay undetermined.

An EAS session's app registers the model of the session's device as its device name, and no local tool reports that name. So an EAS session scope reads no target that a local tool places, and the one target that nothing places is the session's app. A device tool that gave no answer cannot show that a target is off this machine. Only the tool of the scope's platform counts. An Android session's own target has React Native Android's name shape, so only an iOS or platform-less session reads an unplaced target.

`--eas` with no platform flag is an EAS session scope: the session names one device, so the rule places its app on either platform. When such a scope reads no app and some apps are unplaced, the refusal is `NO_APP_CONNECTED`, exit 1. It names the unplaced apps and says to close the apps that are not the session's. A platform flag only chooses which device tool has to answer. It does not choose between two unplaced apps. Rejected: refusing `--eas` with no platform; the user would name a platform that the session already has. `smoke` reads its route at each placement, so the EAS session rule also applies when a config's EAS device turns on `--eas` during the run.

The bundle check builds for the scope's platform when the scope has one: a flag, the device the run opened, or the bound device. Else it builds for the platforms of the own apps: one platform, or both. When no own app is placed, it builds for `ios`, and the report says `bundlePlatformSource: "default"` (Risk 5). A broken bundle decides the run, whichever platform it was found on.

Which Expo Go app id a command acts on belongs to §Stopping the app.

### Target owner

The dev server on a port takes a debugger connection from every app that loads its JavaScript from that port. A simulator that another worktree bound, and that is still booted, loads from the same port. A run must not read that app as this worktree's app.

A debugger target names its device by name only. A booted simulator has a name and a udid, and a binding records both ([[0035-one-device-per-worktree]] §Records). So a target is matched to the booted simulators by name, and each simulator to the bindings by udid.

Rules:

- A target is another worktree's app only when every booted simulator with its device name has a udid that only other worktrees bind. A simulator that this worktree also binds, a simulator that nobody binds, and a name that no booted simulator has keep the target.
- When the simulator list could not be read, a binding's stored name stands in: a target whose name only other worktrees' bindings hold is skipped. A stored name can be stale, so this rule only skips more.
- Only a live binding is an owner: its lease has not expired, and its project root exists. A released binding keeps its file with an expired lease, so it is not an owner.
- Another worktree's app is out of every scope, with a platform flag or without one. It does not take the one unplaced slot of an EAS session.
- A read that skips an app says so on stderr in one sentence, `Skipped <n> app(s): …`, that names each device and the worktree that bound it.
- When only other worktrees' apps are listed, a command that needs a debugger target refuses `NO_APP_CONNECTED`, exit 1, and names each device and worktree. Its How line opens the app on this worktree's device. The debugger client refuses the same way when the list changes after the preflight: an empty list is exit 22, and a list with no app in scope is exit 1.
- `runtime:reload` lists the skipped apps in `skippedApps`, and its bundle check does not build for their platform. `runtime:reload` and `smoke` do not reload a skipped app (§How it reloads).
- An observation of a skipped app never proves this worktree's reload (§What proves a reload).
- Only a run in a project reads the bindings. `dev:wait` reads no bindings. `smoke` skips the app as the runtime reads do and lists it in `skippedApps` in its JSON. When `smoke` reads its own app beside a skipped app, it names the skipped app on stderr. When no app is left, it appends the same sentence to the `app` phase's reason.

A local device's app can stand beside this worktree's own EAS session on the same port, with the session app's app id ([[0035-one-device-per-worktree]] §Readers). Every EAS session scope skips it (§Which app a run reads, row 11). With only such apps listed, a command that needs a debugger target refuses `NO_APP_CONNECTED`, exit 1, names each app and the session, and prints no scope line.

A lease lasts 60 minutes and is renewed by use ([[0035-one-device-per-worktree]] §Lease). A runtime read does not renew it, because a renewal takes the registry lock and reads are the most frequent calls (Risk 2).

## Reloading the app

`runtime:reload` puts the running app back on the code on disk, and reports a reload only when it observed one.

The debugger replays old errors to every new connection, so an error window outlives the fix until a reload. So the follow-ups of a non-empty `runtime:errors` window start with `runtime:reload`.

`runtime:reload` needs a dev server (§One preflight for the runtime family). `--timeout` (default 30 s) bounds the whole run. A `--route` the project has not got is exit 1 before anything reloads (§Verifying the route). The route opens after the app is back, because Expo Go reloads the URL it was launched with.

### How it reloads

The broadcast is the `r` keypress, sent from outside the CLI process: a `reload` frame on the dev server's `/message` socket with no `id` or `target`, which the dev server relays to every other client. The dev server relays only from a trusted client: a loopback connection with no `Origin` header, which is what the CLI sends. Every frame carries `version: 2`; the dev server drops any other frame with no answer.

The broadcast needs no platform tool, app id or device, and keeps state that is not JavaScript.

`getpeers` is the handshake: an answer lists the clients and proves the protocol version. Silence means "does not speak this version", never "no peers".

`--method` takes `auto` (default), `dev-server`, `runtime` or `device`. `auto` is a ladder: rung 1 is the broadcast, or `Page.reload` while the scope skips an app; rung 2 is the relaunch.

| Mechanism                        | Chosen when                                                    | `method` / attempt `method`  | Own `verifiedBy`            | Page id kept | Unproved when pinned                  |
| -------------------------------- | -------------------------------------------------------------- | ---------------------------- | --------------------------- | ------------ | ------------------------------------- |
| Broadcast on `/message`          | `auto` or `dev-server`; the scope skips no app                 | `dev-server` / `dev-server`  | `message-socket-peers`      | no           | exit 22 if delivered, else 20         |
| `Page.reload` to each own target | `auto` or `dev-server`; the scope skips an app (§Target owner) | `dev-server` / `page-reload` | `debugger-context-replaced` | yes          | exit 22 if a target answered, else 20 |
| Local relaunch                   | `device`, or `auto` when rung 1 climbs, without `--eas`        | `device` / `device`          | `app-relaunch`              | yes          | —                                     |
| EAS relaunch                     | the same, with `--eas` (§Cloud simulator)                      | `device` / `device`          | none                        | yes          | —                                     |
| `expo.reloadAppAsync()`          | `runtime` only                                                 | `runtime` / `runtime`        | none                        | no           | exit 22 if called, else 20            |

Rung 1 is decided on one observation after the bundle gate: a fresh target list and the device facts that place it. That observation serves dispatch, evidence, counts and the relaunch. When the read fails, or a device tool stops answering, the run keeps the preflight observation (in `smoke`, the last list its own reads placed).

Rung 1 ends in one of five outcomes. Under `auto`, the outcome decides whether the run climbs to the relaunch. A pinned method never climbs.

| Outcome       | When                                                                                                                                                                                 | A mechanism ran | `auto` climbs |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ------------- |
| proved        | the peers churned and the broadcast reached no app outside the scope, or a context was replaced                                                                                      | yes             | no            |
| acted         | the peers churned, and the broadcast also reached an app outside the scope that is not skipped (another platform's, or an unplaced one); the attempt is `ok: false, delivered: true` | yes             | no            |
| delivered     | the action reached an app, and its own proof did not arrive                                                                                                                          | yes             | yes           |
| not delivered | nothing took the action, or the target read failed beside no skipped app, so no broadcast was sent: the run cannot see which apps a broadcast reaches                                | no              | yes           |
| unprovable    | no own target can keep the `Page.reload` marker, so no `Page.reload` was sent                                                                                                        | no              | yes           |

When a mechanism ran, the shared observations of §What proves a reload decide the exit. An `acted` attempt says how many apps outside the scope it reached. Its failure text names no `--eas` and no tunnel on a local run. An `unprovable` run under a pinned `--method dev-server` says so and names `--method device`.

`Page.reload` targets share one deadline: the remaining budget, at most 8 s. The broadcast watches its peers for at most 8 s. So a rung 1 that climbs leaves the rest of `--timeout` to the relaunch.

`smoke` runs rung 1 only (§The app under test is the code on disk).

Rung 2 costs the app's JavaScript state. When an app was attached, the attempt's reason says so and says why rung 1 did not suffice. Off `--eas`, rung 2 is `simctl terminate` or `am force-stop`, then the deep link. A stop that finds the app not running is success. The app id comes from the own targets only, by the ladder in §Stopping the app. A link refused after the stop leaves the app named in `leftAppStopped`.

`--method runtime` calls `expo.reloadAppAsync()` at the target `runtime:eval` reads. An app whose `expo` global has no `reloadAppAsync` is reported as such.

The entry-bundle check runs before any rung (rows 2 and 3 of the exit table in §What proves a reload). `unknown` passes, and `--no-bundle-check` skips it. The `bundle` object is the one `smoke` and `dev:wait` print. `appsConnected` on a refused run is the count of own apps that the preflight read, not `0`.

An attempt carries `delivered` beside `ok`: whether the action reached the app, not whether it worked.

Expo Go for Android holds a `/message` client, so it takes rung 1; it has no CDP debugger, so it cannot keep the `Page.reload` marker (§Android).

Rejected: `--method runtime` in `auto`. On Expo Go the call closes the app, and no target field tells the two runtimes apart.

Rejected: a broadcast beside a skipped app. The dev server relays it to every app on the port.

The top-level `method` names the rung, so a `Page.reload` rung 1 reports `method: dev-server` (Risk 1).

### What proves a reload

A broadcast has no reply. `verifiedBy` names a signal only when its own evidence is in the payload and non-empty ([[0021-honest-reports]] §The rules). `reloaded` is `true` exactly when `verifiedBy` names a signal: the app acted. Exit 0 needs more: an observation that the app came back.

Four observations. The first three share one budget, and the first to answer ends the watches.

1. **Message-socket peers.** The dev server never reuses a socket id. The wait counts client ids it had not listed before (`commandSocketChurn.reconnected`), not a changed list, because a client that left changes the list too. This proves that the app acted, not that it came back.
2. **A fresh debugger target.** The dev server never reuses a page id, so a target it had not listed is an app that came back (`appsReconnected`).
3. **A new `Bundled` line** in the dev server's captured output (`bundlesAfterReload`). It says the dev server served a bundle after this command acted, not which client asked. A relaunched app keeps its page id, so this is how a relaunch can exit 0.
4. **A new JavaScript context on an own target after `Page.reload`.** One own target is enough, and nothing is watched after it.

`Page.reload` keeps the page id, so its proof is a context replacement. The CLI sets a per-check global on the target, sends `Page.reload`, and reads the global on the same target id until it is gone. The whole proof, cleanup of the marker included, ends at the caller's deadline.

Each target keeps its outcome in the attempt's `outcomes`:

| Outcome              | Trigger                                                                                                       | Test                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `unsupported`        | the target cannot take `Page.reload`; nothing is sent                                                         | none                                                                                     |
| `unmarkable`         | the context did not keep the marker, or answered a CDP error (Expo Go for Android: `-32601`); nothing is sent | e2e runtime-target-selection-test "sends no Page.reload…"; contextReplacedTransport-test |
| `not-delivered`      | the mark got no answer, the `Page.reload` answer was lost and no read proved it, or the action failed         | rungOneTargets-test "reports a mark…", "reports a Page.reload whose answer was lost…"    |
| `delivered-unproved` | `Page.reload` answered and the marker stayed                                                                  | rungOneTargets-test "watches an own target…"                                             |
| `context-replaced`   | the marker is gone on the same target id                                                                      | rungOneTargets-test "sends Page.reload to every own target…"                             |
| `stopped`            | another own target proved first; the check still removes its marker                                           | rungOneTargets-test "sends Page.reload to every own target…"                             |

`stopped` is not `smoke`'s `reload.disposition: 'not-needed'`, which says the run opened the app itself.

The known ids are read after the bundle gate, just before the action, so a save picked up earlier does not count.

`appsConnected` and `appsReconnected` are both reported. `appsReconnectedReason` says why a zero is zero: nothing reloaded, the bundle proof ended the watch first, or the watch ran out. An empty peer list beside a populated `/json/list` is reported as exactly that.

A proved reload whose last target read was zero reads again within the 3 s reconnect window. A zero that survives keeps its meaning: an EAS session can list nothing while the app runs.

`verifiedBy` is the first label with evidence, in this order: the mechanism's own, `fresh-debugger-target`, `dev-server-bundle`. `--method runtime` and the EAS relaunch have no label of their own.

Which observations may count:

- An observation of an app that is not an own app never proves this worktree's reload: not a fresh target, not `appsConnected`, not the relaunch id.
- When the dev server lists an app that is not an own app, peer churn proves nothing, because the churn can be that app's. The failure then says why the churn did not count.
- A served bundle counts only for a platform that no other app is on. An unplaced app could fetch either bundle, so beside one, no bundle counts.
- The settled attempt is the last one that reloaded or reached the app. Nothing can prove the reload when all three hold: the settled attempt keeps the page id, the own app was listed before the run, and no bundle may count. Then the run watches nothing and ends at once. A relaunch that nothing confirmed does not call the listed runtime the old one.

A project with no captured dev server log has no bundle observation. The failure names the fix: `npx @expo/agent-cli dev --detach`.

The exit code comes from the observations, not from the label. The first row that matches decides:

| #   | Run                                                                                                                                            | `reloaded` | `verifiedBy`                             | Exit               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------- | ------------------ |
| 1   | not attempted: no dev server, a `--route` the project has not got, or a bad argument                                                           | —          | —                                        | 1                  |
| 2   | the entry bundle does not compile                                                                                                              | `false`    | `null`                                   | 20, `attempts: []` |
| 3   | the entry bundle was still building when its check ran out of budget                                                                           | `false`    | `null`                                   | 22                 |
| 4   | no mechanism reached the app                                                                                                                   | `false`    | `null`                                   | 20                 |
| 5   | a mechanism ran, and a new context on an own target, a fresh own target, or a bundle that may count showed the app back                        | `true`     | the first label with evidence            | 0                  |
| 6   | peer churn or a local relaunch, and nothing showed the app back                                                                                | `true`     | `message-socket-peers` or `app-relaunch` | 22                 |
| 7   | any other mechanism ran (an EAS relaunch, `--method runtime`, a `Page.reload` that did not replace a context), and nothing showed the app back | `false`    | `null`                                   | 22                 |

Rows 6 and 7 end when `--timeout` ends, or at once when nothing can be watched. With nothing attached, `--method auto` starts the app and can exit 0. A pinned `--method dev-server` is then row 4.

## Loading the app is not navigating it

`<scheme>://<route>` navigates an app that already runs against a dev server. The launcher URL `<scheme>://?__expo_url=<origin>`, and `exp://<host>` for Expo Go, **loads** one (§Pointing an app at this dev server owns the URL shapes). A cold development build given the route link shows the dev launcher's screen and loads nothing.

So `navigate` opens the launcher URL first when all four hold:

1. The link targets a development build. Expo Go never fires the ladder: `exp://<host>/--/<route>` already carries the dev server.
2. No app is attached on the device the run opens (§Which app a run reads).
3. A launcher URL exists, which needs a dev server and a scheme.
4. The run has an attach budget (`--attach-timeout`, default 45 s). `--no-wait-attach` gives none.

The open runs these steps in order. A step whose condition does not hold is passed over.

| #   | Step                                         | Runs when                                                  | Wait                                                               | Reports                                                                                          |
| --- | -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | open the launcher URL                        | the four conditions above hold                             | —                                                                  | `launch.url`, `launch.command`, `launch.exitCode`                                                |
| 2   | wait for the app                             | after step 1                                               | `--attach-timeout`                                                 | `launch.attached`, `launch.waitedMs`                                                             |
| 3   | open the route link, also for `/`            | always                                                     | —                                                                  | `command`, `exitCode`                                                                            |
| 4   | wait for the app                             | the device took the link, and the run has an attach budget | the rest of `--attach-timeout`; at least 2 s after a launcher open | `attached`                                                                                       |
| 5   | answer the open dialog                       | an EAS session, and nothing attached                       | step 4's budget again, after an accepted dialog                    | `attachAlert` (§Cloud simulator)                                                                 |
| 6   | stop the app once, open the route link again | Android, local or EAS, and nothing attached                | step 4's budget again, when the second open exits 0                | `attachRecovered`: `false` when the stop failed or `pidof` saw no process, else `true` (Risk 14) |

Step 3 opens the route link also for `/`, because the launcher loads whatever the app last had. A refused launcher open does not fail the run. The human output prints a `Launch` line above `App`. `smoke` passes its attach budget, so it loads a cold development build the same way.

`attached` is `true` when an app attached (`App attached`), and `false` when none did, at exit 22. It is `null` under `--no-wait-attach` and when the device refused the link.

Step 6 exists because Expo Go's error screen does not fetch again, so a second link alone changes nothing. iOS never runs it. The stopped app is `--app-id`, else the app config's id, else Expo Go. This ladder has no dev-server rung, unlike §Stopping the app: the device's own read is empty. A link that targets Expo Go stops Expo Go. An app that another device runs on the same dev server is never stopped. After a failed stop the link does not open again. When `pidof` saw no process, the link opens again, and the reason says the app was not running.

On local Android the launcher URL goes to `<app id>/.MainActivity` by component (`am start -f 0x20000000 -n <app id>/.MainActivity -d <url>`), as `expo start --dev-client --android` does. A BROWSABLE `ACTION_VIEW` intent into a stopped development build leaves an error activity while `am start` exits 0. The app id is `--app-id`, else the app config's, with no dev-server rung. Without one, and on an EAS session, the URL goes as an ordinary link.

`smoke` labels its picture from the open's own report, in the `screenshot` phase's reason. The label is the project's screen when an app is attached. It is the dev launcher's screen when the device took the launcher URL and nothing attached. Else it is the device's screen. A refused launcher open is never labelled the launcher's screen.

## The smoke gate

`@expo/agent-cli smoke` answers "does this app still boot". It asks the questions of the other runtime commands in one process, and it adds a picture of the screen ([[0016-v1-scope]]). Rejected: a `smoke` built from subprocesses of this CLI. Each subprocess would discover the dev server again, and on a machine with two projects the answers can disagree.

The run has 13 phases, in this order. A conditional phase is in the report only when the run performed it (§The run brings its own environment). Any other phase that did not run is `skipped`, with a reason.

| #   | phase              | question                                                   | conditional       | budget                                                                                                                    | effect on the verdict                                                                                                                      |
| --- | ------------------ | ---------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `start-dev-server` | Did this run start a dev server?                           | yes               | 2 min; 30 min when the plan builds (§It builds what the app needs, and says so first)                                     | failed start: `failed`                                                                                                                     |
| 2   | `dev-server`       | Is a dev server answering?                                 | no                | an 800 ms look, again after a start                                                                                       | none: `failed`                                                                                                                             |
| 3   | `bundler-ready`    | Is the bundler ready, and does it serve this project?      | no                | 3 min on a dev server this run started, else `--timeout`                                                                  | another project: `failed`; expired: `inconclusive`                                                                                         |
| 4   | `bundle`           | Does this project's entry bundle compile for the platform? | no                | as `bundler-ready`                                                                                                        | broken: `failed`; expired or no answer: `inconclusive`                                                                                     |
| 5   | `start-session`    | Is an EAS session up for this run?                         | yes, `--eas` only | 15 min                                                                                                                    | no session: `failed`                                                                                                                       |
| 6   | `boot-device`      | Did this run boot a simulator or an emulator?              | yes               | 2 min on iOS, 4 min on Android                                                                                            | no device: `failed`                                                                                                                        |
| 7   | `install-app`      | Did this run put the app on the device?                    | yes               | 30 min                                                                                                                    | failed: `failed`                                                                                                                           |
| 8   | `app`              | Is an app attached, or does one attach when opened?        | no                | a 2 s look; then one budget for the open and the attach wait: 2 min on a cold environment this run made, else `--timeout` | link refused: `failed`; nothing attached, no device to open an app on, or app mismatch: `inconclusive` (§Two mismatches, two next actions) |
| 9   | `reload`           | Is the app running the code on disk?                       | no                | 10 s, out of `--timeout`                                                                                                  | `unproved`: `inconclusive`                                                                                                                 |
| 10  | `route`            | Did the named route open?                                  | no                | as the `app` open                                                                                                         | link refused: `failed`                                                                                                                     |
| 11  | `runtime`          | Does the runtime evaluate `1`?                             | no                | one read; up to 15 s for an app this run opened or reloaded                                                               | no answer: `inconclusive`                                                                                                                  |
| 12  | `errors`           | Did the app report an error in the window?                 | no                | `--window`, default 3 s                                                                                                   | an error: `failed`, over every other row                                                                                                   |
| 13  | `screenshot`       | Is there a picture of the screen?                          | no                | 20 s local, 2 min on EAS                                                                                                  | none                                                                                                                                       |

`--timeout` defaults to 3 min, or 1 min with `--no-start`, and bounds the reads. The conditional phases and the cold waits that this run caused have their own budgets. `AGENT_CLI_COLD_ATTACH_MS` replaces the 2 min cold attach budget.

The `dev-server` phase's URL goes to every later phase. The run also chooses one device: a device that a boot or a session start supplies serves every later phase with no second lookup, and a failed lookup is asked again later.

When no dev server answers, `smoke` runs `dev --<platform> --detach --wait-ready --no-open`, plus `--eas` on an EAS run and `--port <n>` for a loopback port the caller named. `--no-open` keeps the open in the `app` phase, which owns its budget and verdict ([[0026-dev-owns-the-open]]). `--no-start` reads only what is already running.

| Code | Outcome        | Meaning                                                                                                                                           |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | `passed`       | every deciding phase answered yes, the runtime answered, the reload is not `unproved`, and the app fits the project                               |
| `20` | `failed`       | an error in the window, a broken bundle, another project's dev server, no dev server, a refused link, or a failed start, boot, session or install |
| `22` | `inconclusive` | a wait expired, no app attached, no device to open one on, an unreadable runtime, an `unproved` reload, or an app that cannot run this project    |
| `1`  |                | a bad flag, or a route the project has not got (§Verifying the route)                                                                             |

Each row is `ok`, `failed`, `inconclusive` or `skipped`. A phase before `runtime` that gets `failed` or `inconclusive` in the last column ends the run with that outcome. An app mismatch and an `unproved` reload do not end the run: the reads still run. A run that reaches the reads is `failed` on an error in the window. Else it is `passed` when the runtime evaluated `1`, the error window was read, the reload is not `unproved` and the app fits the project. Else it is `inconclusive` (§Android).

`smoke --platform web` is `BAD_ARGS`, exit 1, with `suggestedCommand` set to `typecheck`. The later phases read the inspector's list of React Native runtimes, and a browser never registers in it. Rejected: exit 22 for web, because looking again never makes a browser answer.

The `errors` phase fails on a record with `isError: true` or `source: "exception"`. React Native reports an uncaught error through the console path as one string with its stack frames, and the collector sets `isError` when it finds frames. So `console.error(new Error(…))` fails the gate too, and plain `console.error` text does not.

The screenshot is a PNG. On iOS `simctl` writes the file. On Android `adb exec-out screencap -p` writes it to stdout. Rejected: `adb shell`, which rewrites `\n` as `\r\n` and corrupts the image. Success is the first eight bytes matching the PNG signature, because `adb exec-out` can exit 0 with a sentence on stdout. A missing screenshot never decides the run. With no app attached, the `screenshot` row says what the picture shows (§Loading the app is not navigating it).

### Which platform is the caller's to say

`smoke` requires `--ios`, `--android` or `--platform ios|android`, with no default. Each question of the gate is about a device: which bundle is built, which debugger targets count, which tool takes the picture. Rejected: a default from the host. A Mac with only an Android emulator would get an iOS run, and the report would hide the guess.

A missing platform is `BAD_ARGS`, exit 1, with `suggestedCommand` set to `smoke --ios` and one line: `Missing platform. Usage: … smoke --ios|--android, for example: … smoke --ios`. Rejected: the What/Why/How form ([[0006-agent-native-cli-surface]] §Errors are prompts) for a flag that is visibly missing. Two platform flags that disagree are `BAD_ARGS` too.

Every command this CLI prints that runs `smoke` names a platform:

- `smoke` follow-ups keep the run's platform, and its `--route`, `--eas` and `--port` where the row repeats the run.
- `status.next` names the platform of a recorded EAS session (with `--eas`), else of a booted device, else of the project's only checked-in native directory, else of the host (iOS on macOS). The last two steps are the rule of the `dev` plan in `status`.
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

`runtime`, `errors` and `screenshot` read the running app. An app that was attached before the run runs the bundle it last loaded, which after an edit is the old code, and its error window outlives the fix (§Reloading the app). So the `reload` phase puts an attached app back on the bundle the dev server serves.

The phase is the first rung of `runtime:reload` only, in the same process (§How it reloads). Rejected: the higher rungs, which stop and start the app. A gate does not take the caller's app away to answer a question about it.

`reload.disposition` in `--json`:

| `disposition` | when                                                        | `reload` row   | effect on the verdict |
| ------------- | ----------------------------------------------------------- | -------------- | --------------------- |
| `not-needed`  | this run opened the app, so it loaded the served bundle     | `skipped`      | none                  |
| `reloaded`    | the app was attached, and `verifiedBy` names a signal       | `ok`           | none                  |
| `unproved`    | the reload was sent, and nothing showed that it took effect | `inconclusive` | `inconclusive`        |
| `declined`    | `--no-reload`                                               | `skipped`      | none; the row says so |

`unproved` is not `failed`: nothing shows a fault in the app, only that the session read is unknown ([[0021-honest-reports]] §The rules).

`reload.verifiedBy` follows §What proves a reload, and it is never `app-relaunch`. `reload` also carries `knownTargetIds`, `freshTargets`, `commandSocketReconnected`, `targetOutcomes` and `bundleServed`.

`reload` runs before `route`, because a reload sends the app back to its initial route. A `reloaded` disposition means the app acted (`reloaded: true` in §What proves a reload), not that it came back. Such a reload owes the settle and the runtime poll of a fresh launch (§The device that can open the app). An `unproved` reload owes neither.

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

Expo Go's native runtime is versioned with the SDK. A copy from another SDK takes the deep link but cannot load this project's bundle. So `smoke` compares the Expo Go on a **local** device with the release this project's SDK ships. A development build and an EAS session's device are never compared.

Two questions, two sources. Neither is `@expo/cli`'s ([[0001-agentic-cli-on-expo-cli]] §Constraints, constraint 5).

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

Which verdict installs is row 8 of the install table in §The gate installs the app, whichever app it is.

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

| `appMismatchKind`      | what it means                                                          | first follow-up                            |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| `expo-go-incompatible` | this project's native code is not in Expo Go's runtime, in any version | `dev --<platform>`: a development build    |
| `expo-go-version`      | the project fits in Expo Go; the copy on the device is another SDK's   | `smoke --<platform>`, without `--no-start` |
| `app-not-installed`    | the device has not got the app this project runs, of either kind       | `smoke --<platform>`, without `--no-start` |

The second follow-up of each is `status`. The `smoke` follow-ups drop `--no-start` whether or not the caller passed it, because `--no-start` is the flag that forbids the install. The `expo-go-version` row also changes the inconclusive How line: looking again reads the same wrong runtime, and a run without `--no-start` installs the right one.

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

| #   | Condition                                                                        | Install |
| --- | -------------------------------------------------------------------------------- | ------- |
| 1   | `--no-start`                                                                     | no      |
| 2   | the run has no device                                                            | no      |
| 3   | this run's boot created the device                                               | yes     |
| 4   | no app id, and the kind is `native-build`                                        | yes     |
| 5   | no app id, and the kind is `expo-go`                                             | no      |
| 6   | the device could not be asked: the read failed, or it is an EAS session's device | no      |
| 7   | the device has not got the app                                                   | yes     |
| 8   | the Expo Go on the device is `mismatch`, for either kind (Risk 9)                | yes     |
| 9   | any other case                                                                   | no      |

A failed install stops the run as `failed`, and nothing is opened.

**The device judges a development build, not the exit code.** `expo run:ios` activates the Simulator window through AppleScript after it installs, and that throws on a Mac with no Automation grant. `smoke` does not need the window. After a non-zero exit, the run asks the device whether the app is there: yes is `ok`. When the device cannot be asked, the exit code decides.

#### Android needs an application id the app config does not have

The install check needs the app's id. On iOS it is `ios.bundleIdentifier`; on Android it is `android.package`, which many projects never declare. So on Android a second source is read when the app config names none: the `applicationId` that `expo prebuild` wrote into `android/app/build.gradle`. A declared `android.package` wins over the Gradle file. Gradle never runs; the file is read as text.

#### An app that cannot be named still has to be installed

No app id is not "no app" (row 4). For a development build, a missing id is the normal state of a project that was never prebuilt for the platform: `expo prebuild` writes both `android.package` and `android/app/build.gradle`. The id is needed only to ask "is it already there". `expo run:<platform>` needs none, because it resolves the id from the config it writes. After that first build the id is declared, and later runs check normally.

Expo Go is excluded (row 5): an Expo Go download with no app to look for would be a guess. An Expo Go target always has its constant id, so row 5 is a guard. A plan that cannot be read gives the `native-build` kind with no id, which row 4 installs.

#### A build changes the project it was read from

A start phase that compiles rewrites the app config: `expo prebuild` writes undeclared `android.package` and `ios.bundleIdentifier`. The run's target (which app, which install kind) is read once and kept (§It builds what the app needs, and says so first). When the start phase's plan builds, the run forgets the target before the build, and the next reader reads the project the build left behind.

#### A refused link is a device without the app

When the device refuses the deep link that would open the app (the open exits non-zero), the `app` phase is `failed`. The run then asks the local device whether it has the app this project runs, Expo Go or a development build. When the device answers no, the finding goes into the `app` phase's reason beside the refusal, and into the report as `appMismatchKind: app-not-installed`. The rows of §Two mismatches, two next actions give every other answer. The follow-ups branch on the value. They never lead with `navigate`, which the device refuses in the same way every time.

### A link nobody can approve is a link that never opens

Two obstacles stand between an unattended `simctl openurl` and a readable app. The CLI removes both before **every local iOS open**, for whichever app the link belongs to.

- **The dialog.** An unapproved scheme raises `Open in "<app>"?`, and `simctl openurl` exits 0 while the alert is up, so the attach wait expires. The CLI writes the approval into the simulator's `com.apple.launchservices.schemeapproval` defaults, through `simctl spawn <udid> defaults write`.
- **The sheet.** The first launch of an app that ships `expo-dev-menu` shows its onboarding sheet, and the screenshot is a picture of the sheet. The CLI writes `EXDevMenuIsOnboardingFinished` true into the app's defaults.

The app id for the writes comes from a ladder that differs from §Stopping the app: `--app-id`, then Expo Go's id for Expo Go's own `exp` and `exps` schemes, then `ios.bundleIdentifier` from the app config. With no id, nothing is written, because the approval's value is the app id. Each write is made once per process for each simulator, scheme and app id, so a `navigate` that opens the launcher URL and then the route link writes once. An Expo Go install writes both of Expo Go's schemes at install time. Neither write can fail an open or an install; the worst case is the dialog or the sheet.

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
- **The timeout names what happened.** A budget that ends with no answer at all reports `nothing was listening on <url> for <N>ms …, so no dev server had finished starting`. A budget that ends while the server was answering reports that the dev server was still working ([[0021-honest-reports]] §The rules).
- **The caller's abort ends the loop at once**, and is not called a timeout.

### The device that can open the app

When no app is attached and no device is up, the run boots the device that this worktree binds, on both platforms. That is a simulator the registry reuses or creates, or an emulator instance it spawns ([[0035-one-device-per-worktree]] §Choice; [[0035-one-device-per-worktree]] §Android boot). A created or spawned device has no app, so `install-app` puts the app there. The boot budgets are outside `--timeout` (§The smoke gate). The run boots nothing when an app is already attached, when a device is already up, or with `--eas`, which starts or reuses a session instead ([[0027-everything-on-eas]] §smoke).

An attached app is not yet a readable app: its target goes away and comes back when the JS runtime starts, and a read in that gap answers `No target found`. So for an app this run opened or reloaded, the run first waits, at most 4 s, for two reads of the target list that name the same ids. Then the `runtime` phase asks `Runtime.evaluate('1')` every 500 ms until it answers, inside the runtime-ready budget (§The smoke gate). After the first `-32601`, the run asks again (§A reloading runtime answers like one with no debugger). A wait that ends with no answer reports the runtime's own reason.

A development-build open that still shows the launcher lists no debugger target on this dev server. The `app` phase is `inconclusive`, and the reading phases are `skipped`. The picture's label comes from the open's own report (§Loading the app is not navigating it).

## Android

The rules below are about a runtime with no CDP debugger: Expo Go for Android. A development build on Android answers the debugger, and the runtime commands and `smoke --android` read it as on iOS ([[0022-live-tier]] §live-devclient).

Expo Go for Android acknowledges `Runtime.enable`, `Log.enable`, `Network.enable` and `Debugger.enable`, then sends nothing; `Runtime.evaluate` answers `-32601`. An empty window there is silence, not health. Each collector probes the runtime as it opens its window: `Log.enable` for the engine's announcement that it "does not support debugging", and one `Runtime.evaluate` of `1` for the code. The verdict comes from asking, never from the platform.

On such a runtime:

- `runtime:eval`, `runtime:tree`, `runtime:tap` and `runtime:type` exit 1 with `RUNTIME_EVALUATE_UNSUPPORTED`. The How line names `runtime:errors --android`.
- `runtime:errors` falls back to the dev server's log (§runtime:errors).
- A reload is still proved without the debugger (§How it reloads).
- `smoke --android` ends 22 on a working app, because `passed` needs the runtime to evaluate `1` (Risk 7).

A target is dropped only when its transport fails. A target that answers `-32601` is kept, ranked behind every target that answered.

`/json/list` names no platform. Which evidence places a target, and which targets a run reads, is §Which app a run reads. An app id that names the other platform's Expo Go is dropped from the id ladder (§Stopping the app).

`adb` is resolved from `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `PATH`, then the platform's default SDK location. A spawn that fails is `ADB_NOT_RUNNABLE`; the message names every place that was looked at. "No device" is reported only after `adb` ran and answered.

Whether a device has an app has three answers: installed, not installed, and could not look. A caller that acts on "not installed" downloads a few hundred megabytes, so "could not look" never reads as "not installed". The Expo Go version read gives no version for both of the last two, and the version check reads that as `unknown` (§The Expo Go on the device is not the Expo Go the SDK wants).

`am force-stop` exits 0 whether or not the app was running, so a stop on Android asks `pidof` first (§Stopping the app). `stopped: true` means the stop ran; ActivityManager may still be ending the process.

### A reloading runtime answers like one with no debugger

A development build on Android also answers `Runtime.evaluate` with `-32601` for a short time after a reload, on the same target id, until its new runtime exists. The target list does not change, so the settle wait does not cover the gap. So for an app this run opened or reloaded, `smoke` asks again for 5 s after the first `-32601`, inside the runtime-ready budget, and only then reports a runtime with no debugger. An app that nothing moved is asked once.

Rejected: ending the wait on the `Log.entryAdded` announcement that the engine "does not support debugging". The `runtime` phase does not read the log window, and a second source for one verdict costs more than 5 s per run.

## Cloud simulator

Device resolution has a third backend: an EAS session. `smoke`, `navigate`, `runtime:reload` and `runtime:stop` take `--eas`. `navigate` and `smoke` fall back to this worktree's session when no local device answers. `runtime:stop` and `runtime:reload` reach a session only with `--eas`, so a session never bills a run that a local device could serve. The order is [[0035-one-device-per-worktree]] §Readers. The developer config does not move `navigate` or the `runtime:*` commands; `smoke` reads `deviceBackend` only when it starts its own dev server ([[0015-backend-selection-and-config]] §The device backend).

`--json` reports `deviceBackend`: `local-ios`, `local-android` or `cloud`. A session runs iOS too, so `platform` does not say where the device is. The session id is on the `Device` line, in `deviceId`, and on the `cli:navigate` event. `--eas --ios` names the platform the session must be; a session on the other platform is `CLOUD_SIMULATOR_PLATFORM_MISMATCH`.

Device verbs run as `eas simulator:exec npx agent-device@latest …` ([[0001-agentic-cli-on-expo-cli]] §Constraints, constraint 4; the guard is [[0035-one-device-per-worktree]] §Session guard). The session's device is live when `eas simulator:list` shows the session as live, not a file on disk ([[0035-one-device-per-worktree]] §Session discovery, §Session binding). `navigate` and `smoke` ask the service. `status` and the `start` and `dev` banners read this worktree's EAS session bindings with no network call. Rejected: direct GraphQL to `api.expo.dev`, which reads another CLI's credential store.

A `localhost` or `lan` URL is refused before anything opens; no `adb reverse` reaches an EAS session (§Where a device reaches the dev server).

**What `close` proves.** The controller's `close <app-id>` exits 0 for any id; the answer is about the session, not the app. So `runtime:stop --eas` reports `wasRunning: null`, and the `--app-id` mismatch check never fires on a session. A caller that uses `close` as a step checks the outcome itself. The CLI never passes `close --shutdown`, which stops the billed machine. A `close` that fails with `COMMAND_FAILED` and a timeout sentence ("remained foreground after close", "process that ran before close did not exit", "remained running after close") runs once more. No other refusal is retried.

**When a verb fails.** A controller line `Error (CODE): <sentence>` is `CLOUD_SIMULATOR_DEVICE_REFUSED`: the command reached the device, and the device said no. On `DEVICE_IN_USE` the How line names the holding session and says not to start a second one; `runtime:reload --eas` retries its relaunch once, bound to that session. A signed-out account is the `eas-login` handoff, exit 7. An `eas` that cannot spawn is `CLOUD_SIMULATOR_TOOL_MISSING`. Anything else is `CLOUD_SIMULATOR_COMMAND_FAILED`, and a binary that does not act like `eas` is named as such.

**When there is no session.** `unknown` is a tool that did not answer, and it says nothing about the world.

| Probe state                           | Error                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `inactive` (a bound id is not live)   | `NO_CLOUD_SIMULATOR_SESSION`, naming the id                                            |
| `none`, live sessions of another type | `NO_CLOUD_SIMULATOR_SESSION`, naming the types                                         |
| `none`, feature available             | `NO_CLOUD_SIMULATOR_SESSION`; How: `dev --ios --eas`, then `dev:stop --eas`            |
| `unavailable`                         | `CLOUD_SIMULATOR_UNAVAILABLE`, with the waitlist URL, a local device and `--print-url` |
| `unknown`                             | `CLOUD_SIMULATOR_SESSION_UNKNOWN`; How: `simulator:list`, never a start                |

`eas simulator:availability` runs only when the listing has no usable session. "Start one" for a session the CLI could not rule out starts a second billed session.

**Reload.** On `--eas`, rung 1 runs first, as on a local run. The broadcast does not reach a session: the tunnel carries the bundle, not the command socket. So when rung 1 climbs, the EAS relaunch restarts the app and then opens the link (§How it reloads). The tunnel check runs before the first verb.

**The iOS open dialog.** An `exp://` URL on an iOS session raises "Open in 'Expo Go'?", and nobody is at the screen. `navigate` answers it under four gates: the device is an EAS session; this run's own open exited 0; nothing attached inside the attach budget; and `alert get` names the app the URL was for. Any other alert is reported and left. An empty `alert get` is exit 1, `alert not found`, so a read is safe. `--json` reports `attachAlert` (`checked`, `found`, `accepted`).

**smoke.** The screenshot on an EAS session gets a longer budget (§The smoke gate), for `npx`, the network and the download. Which commands stop a session is [[0035-one-device-per-worktree]] §Session cleanup.

## Stopping the app

`runtime:stop` ends the app on the device. The app id comes from the first rung that answers:

1. `--app-id`;
2. a debugger target's `appId` on the dev server, after the other platform's Expo Go id is dropped;
3. `ios.bundleIdentifier` / `android.package` from the app config (evaluated as §Pointing an app at this dev server says); on Android, else `applicationId` in `android/app/build.gradle`;
4. Expo Go: `host.exp.Exponent` on iOS, `host.exp.exponent` on Android.

The report names the rung (`bundleIdSource`: `flag`, `dev-server`, `app-config`, `expo-go-default`) and why (`bundleIdReason`). The dev server outranks the config: the config names a build, the dev server names what runs.

An app that was not running is success. `wasRunning` says whether this command stopped it: on iOS from the `simctl terminate` refusal, on Android from `adb shell pidof <appId>` before the stop. A pid gives `true`, and exit 1 with no output gives `false`. A `pidof` that could not run or complained, and any session, give `null`.

`--app-id` naming an app that was not running, while the dev server reports at least one debugger target and none with that id, exits 20. An agent reads the exit code before the output. A second run after a good stop exits 0. `--json` has `connectedAppIds` and `appIdMismatch`; the follow-up is the same command with the connected id.

`dev:stop` signals the PID the dev-server lock names and waits for the PID and the lock. PID liveness decides (`EPERM` reads as alive); the port only corroborates, because `127.0.0.1:8081` and `[::1]:8081` are different sockets. `--json` has `processStillRunning` and `portStillAnswering`. A port with no lock is left running, exit 20. `--force` stops it only with two proofs: the port answers `packager-status:running`, and the listener's command line names `node`, `expo`, `metro`, `bun` or `deno`. Nothing running is exit 0. Rejected: defaulting to port 8081, which reports on another project's server; with no lock and no `--port`, the report names `--port`. Windows uses `taskkill /PID <pid> /T /F`, best effort.

`dev:logs` reads the detached log (`.expo/dev/logs/`), strips escape codes, and says whether its dev server runs now. A running dev server with no log was started in a terminal. `--tail` bounds a read (default 100 lines). Lines are fenced as untrusted ([[0008-guardrails]] §Untrusted-content marking). Rejected: `--follow`; an agent polls.

## Installed-app fingerprint check

A debug build carries its fingerprint in a file that `expo-constants` writes at build time (expo/expo#49905): `assets/app.fingerprint` in an APK, `EXConstants.bundle/app.fingerprint` in an app bundle. The readers report what a device holds. What it means is [[0004-smart-start-and-project-state]] §Installed-app fingerprint check.

### How the file is read

**Android.** `adb shell pm path <app id>` names the APK. The reader reads the one entry, not the whole APK. When a ranged read fails, it pulls the APK. A zip it cannot parse is an error, not a reason to pull.

**iOS simulator.** `xcrun simctl get_app_container <udid> <appId>` names the bundle. The reader tries `EXConstants.bundle/app.fingerprint` (static linking), then `Frameworks/EXConstants.framework/EXConstants.bundle/app.fingerprint` (`use_frameworks!`). Only a booted simulator can be read.

**iOS device.** `devicectl` exposes no app container, so the app answers. The reader starts a one-shot HTTP server on the LAN and runs `devicectl device process launch --payload-url` with a nonce and the callback address; the dev-launcher responder posts the fingerprint back (expo/expo#49494). The URL has no host and only `__expo_fingerprint_*` parameters, so it claims no app route. A launch that fails other than "not installed" or "locked" falls back to `openURL` with `expo.scheme`; with no scheme there is no fallback. The nonce is compared in constant time, the body is capped at 4 KB, and the server closes at the first answer. The clock starts after the launch; the default is 15 s (`status --device-timeout`). A timeout is `no-response`, never `up-to-date`. A locked phone is `no-response` with an unlock hint.

**Which iOS device.** With no `--device`, the simulator bound to this worktree ([[0035-one-device-per-worktree]] §Readers). `--device` filters the booted simulators and binds nothing. A phone is probed only when `--device` names it: the probe launches the app, so naming is consent. An unnamed phone is named in a hint. An unreachable phone, or one with Developer Mode off, is named with the fix and not probed.

**Several devices.** The most informative answer wins: a matching app, any app with a hash, an app without one, "not installed", silence. One unreadable device does not hide the others.

The file is `{hash, fingerprintVersion, sources}`. Anything else (absent, empty, an older bare hash) is "no embedded fingerprint", never an error.

### Proof

| Rule                                                                  | Tests                                                                                                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parser and ranking                                                    | `src/installedApp/__tests__/installedFingerprint-test.ts`                                                                                                      |
| Android reader: ranged read, pull fallback, no pull for a bad zip     | `src/installedApp/__tests__/android-test.ts`, `src/utils/__tests__/zipEntry-test.ts`                                                                           |
| Simulator reader: both bundle paths                                   | `src/installedApp/__tests__/iosSimulator-test.ts`                                                                                                              |
| Device choice and hints                                               | `src/installedApp/__tests__/ios-test.ts`, `src/device/__tests__/devicectl-test.ts`                                                                             |
| Phone probe and callback server                                       | `src/installedApp/__tests__/iosDevice-test.ts`, `src/installedApp/__tests__/fingerprintCallbackServer-test.ts`, `src/runtime/__tests__/appId-test.ts` (scheme) |
| All readers across a process boundary, stub `adb`/`xcrun`/`devicectl` | `e2e/__tests__/installed-readers-test.ts` (stubs: `e2e/__tests__/installedAppStubs.ts`)                                                                        |
| `status --device`, `--device-timeout` (macOS)                         | `e2e/__tests__/status-installed-test.ts`                                                                                                                       |

## Risks

1. A `Page.reload` rung 1 reports the top-level `method: dev-server`, also under a pinned `--method dev-server`; only the attempt says `page-reload` (§How it reloads).
2. A runtime read does not renew the binding lease. A worktree that runs only `runtime:*` reads for 60 minutes loses its live binding, and another worktree then reads that app (§Target owner).
3. A local Android binding records a serial only, and React Native Android names the device by its model. So a local Android app is never skipped as another worktree's app. An EAS session's target carries the model of the session's device, so an EAS binding has no name to match either (§Target owner).
4. An EAS Android session's app is skipped beside an attached local emulator of the same model (§Which app a run reads).
5. With no platform in scope and no placed app, the bundle check builds for `ios` only, so an Android-only break is not found; the report says `bundlePlatformSource: "default"` (§Which app a run reads).
6. `hostType` is `tunnel` for any host name that is not loopback and not an IP literal, for example `mymac.local`. Such a URL passes the EAS refusal. A tunnel whose transport has died is still advertised (§Where a device reaches the dev server).
7. Expo Go for Android cannot pass `smoke`: the run ends 22 on a working app. It also pays the 5 s `-32601` grace on almost every run, because a reload is the default and every opened or reloaded app counts as moved (§Android, §A reloading runtime answers like one with no debugger).
8. The Expo Go version check runs only on a local device, and `unknown` says nothing. Offline, a stale Expo Go is not named, and on Android "no Expo Go" and "`adb` could not run" both read as `unknown` (§The Expo Go on the device is not the Expo Go the SDK wants).
9. For a `native-build` target whose app is on the device, the install decision still compares the device's Expo Go version, so a stale Expo Go beside a current development build can start a needless development build (§The gate installs the app, whichever app it is).
10. `smoke --help` says "Nine phases", and its list of JSON keys leaves out `appMismatch` and `appMismatchKind` (§The smoke gate).
11. The three app-mismatch follow-ups drop the run's `--eas` and `--port`, unlike the other `smoke` follow-ups (§Two mismatches, two next actions).
12. `NO_CLOUD_SIMULATOR_SESSION` names `dev --ios --eas`, also to a caller who asked for Android (§Cloud simulator).
13. The deferred `dev:wait` follow-ups print `navigate / --cloud`, a flag the CLI refuses, and a bare `npx eas simulator:stop` with no `--id`.
14. `attachRecovered` is true, and the reason says the app was stopped, when `pidof` could not run and on an EAS session. Steps 5 and 6 of the open each wait step 4's budget again, so one `navigate` can wait up to three budgets (§Loading the app is not navigating it).
15. On `--eas`, row 4 of the install table decides before the session's device is excluded, so `smoke --eas` on a project that was never prebuilt asks for a development build install onto the session (§The gate installs the app, whichever app it is).

## Open questions

- Should a runtime read renew the binding lease (Risk 2)?
- Should the attach recoveries share the one `--attach-timeout` budget (Risk 14)?
- Should the Expo Go version check also run on an EAS session?
- Should `navigate` answer the iOS open dialog on a fallback EAS session that the caller did not name with `--eas`? `navigate` answers it on any EAS session that the run resolved (§Cloud simulator).

## Testing

The route table, the scope rules and the reload evidence are pure decisions, so they have unit tests. The commands have e2e tests against a stub dev server that speaks the `/message` protocol with `version: 2`, `getpeers` and peer churn, and re-registers debugger targets on a reload; stub `xcrun`, `adb` and `eas` stand in for the device tools ([[0002-testing-and-evals]]). Live runs on Expo Go and development builds, iOS and Android, local and EAS, are [[0022-live-tier]].

| Section                                                                                                                    | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §What ships                                                                                                                | `src/__tests__/commandRegistry-test.ts`; `src/runtime/__tests__/cdpClient-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| §runtime:eval                                                                                                              | `src/runtime/__tests__/promiseSettling-test.ts`, `runtimeAsync-test.ts`; `e2e/__tests__/runtime-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| §runtime:errors                                                                                                            | `src/runtime/__tests__/runtimeErrorCollector-test.ts`, `symbolicate-test.ts`, `format-test.ts`; `src/dev/__tests__/logErrors-test.ts`; `e2e/__tests__/runtime-test.ts`, `runtime-preflight-test.ts`                                                                                                                                                                                                                                                                                                                                                                  |
| §navigate, §The route table, §Verifying the route                                                                          | `src/navigate/__tests__/deepLink-test.ts`, `navigateAsync-test.ts`, `resolveOptions-test.ts`, `routeCheck-test.ts`; `src/project/__tests__/routes-test.ts`, `evaluatedConfig-test.ts`; `e2e/__tests__/navigate-test.ts`                                                                                                                                                                                                                                                                                                                                              |
| §Pointing an app at this dev server                                                                                        | `src/navigate/__tests__/connectUrl-test.ts`, `routeResolution-test.ts`, `navigateAsync-test.ts`; `e2e/__tests__/navigate-target-selection-test.ts`, `cloud-simulator-test.ts`                                                                                                                                                                                                                                                                                                                                                                                        |
| §Where a device reaches the dev server                                                                                     | `src/dev/__tests__/advertisedUrl-test.ts`, `detachAsync-test.ts`; `src/navigate/__tests__/adbReverse-test.ts`; `src/device/__tests__/cloudSimulator-test.ts`; `e2e/__tests__/dev-detach-test.ts`, `navigate-test.ts`, `cloud-simulator-test.ts`                                                                                                                                                                                                                                                                                                                      |
| §One preflight for the runtime family                                                                                      | `src/runtime/__tests__/preflight-test.ts`, `devicePlatform-test.ts`; `e2e/__tests__/runtime-preflight-test.ts`, `runtime-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| §Which app a run reads                                                                                                     | the Test column of its table; the EAS session pass: `src/runtime/__tests__/targetSelection-test.ts` "reads no unclaimed target", `targetInventory-test.ts` "allows cloud attribution", `e2e/__tests__/runtime-bound-selection-test.ts` "eval with", `cloud-simulator-test.ts` "reads neither unclaimed app"; `src/runtime/__tests__/targetPlatform-test.ts`, `bundleCheck-test.ts`, `waitReady-test.ts`; `src/smoke/__tests__/targetSelection-test.ts`; `e2e/__tests__/smoke-binding-test.ts`, `smoke-target-selection-test.ts`, `navigate-target-selection-test.ts` |
| §Target owner                                                                                                              | `src/runtime/__tests__/targetSelection-test.ts`, `ownershipSelection-test.ts`, `cdpClient-test.ts`; `src/runtime/reload/__tests__/rungOne-test.ts`, `evidence-test.ts`; `src/smoke/__tests__/smokeDeps-test.ts`; `e2e/__tests__/runtime-target-selection-test.ts`, `runtime-preflight-test.ts`, `smoke-test.ts`                                                                                                                                                                                                                                                      |
| §Reloading the app, §How it reloads                                                                                        | `src/runtime/__tests__/messageSocket-test.ts`, `appProcess-test.ts`; `src/runtime/reload/__tests__/rungOne-test.ts`, `reloadAsync-test.ts`, `resolveOptions-test.ts`; `src/followups/__tests__/commands-test.ts`; `e2e/__tests__/runtime-reload-test.ts`, `runtime-target-selection-test.ts`, `smoke-target-selection-test.ts`                                                                                                                                                                                                                                       |
| §What proves a reload                                                                                                      | the Test column of the outcome table; `src/runtime/__tests__/contextReplaced-test.ts`, `contextReplacedTransport-test.ts`; `src/runtime/reload/__tests__/rungOneTargets-test.ts`, `evidence-test.ts`, `bundleSignal-test.ts`; `e2e/__tests__/runtime-reload-test.ts`, `cloud-simulator-test.ts`                                                                                                                                                                                                                                                                      |
| §Loading the app is not navigating it                                                                                      | `src/navigate/__tests__/navigateAsync-test.ts`, `openUrl-test.ts`; `src/smoke/__tests__/phases-test.ts`; `e2e/__tests__/navigate-target-selection-test.ts`, `smoke-test.ts`                                                                                                                                                                                                                                                                                                                                                                                          |
| §The smoke gate                                                                                                            | `src/smoke/__tests__/phases-test.ts`, `resolveOptions-test.ts`, `targetSelection-test.ts`, `smokeDeps-test.ts`, `format-test.ts`; `src/device/__tests__/screenshot-test.ts`; `e2e/__tests__/smoke-test.ts`                                                                                                                                                                                                                                                                                                                                                           |
| §Which platform is the caller's to say                                                                                     | `src/smoke/__tests__/resolveOptions-test.ts`; `src/lint/__tests__/checkCommandMentions-test.ts`; `src/status/__tests__/sections-test.ts`; `src/followups/__tests__/smoke-test.ts`                                                                                                                                                                                                                                                                                                                                                                                    |
| §The gate says what it is doing while it does it                                                                           | `src/smoke/__tests__/progress-test.ts`; `e2e/__tests__/smoke-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| §The app under test is the code on disk                                                                                    | `src/smoke/__tests__/phases-test.ts` (the `reload` cases); `e2e/__tests__/smoke-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| §Expo Go is only a target for a project that fits in it                                                                    | `src/navigate/__tests__/target-test.ts`; `src/project/__tests__/expoGo-test.ts`; `src/smoke/__tests__/phases-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| §Putting Expo Go on a simulator that has not got it, §The gate installs the app, whichever app it is (and its subsections) | `src/device/__tests__/installExpoGo-test.ts`, `installDevBuild-test.ts`, `installedApps-test.ts`; `src/runtime/__tests__/appId-test.ts`; `src/smoke/__tests__/phases-test.ts`; `e2e/__tests__/smoke-test.ts`                                                                                                                                                                                                                                                                                                                                                         |
| §The Expo Go on the device is not the Expo Go the SDK wants, §Two mismatches, two next actions                             | `src/device/__tests__/expoGoVersion-test.ts`, `androidApps-test.ts`; `src/smoke/__tests__/phases-test.ts`; `src/followups/__tests__/smoke-test.ts`; `e2e/__tests__/smoke-test.ts`                                                                                                                                                                                                                                                                                                                                                                                    |
| §A link nobody can approve is a link that never opens                                                                      | `src/navigate/__tests__/openUrl-test.ts`; `src/device/__tests__/installExpoGo-test.ts`; `e2e-live/__tests__/live-ios-devclient-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| §The run brings its own environment, §It builds what the app needs, and says so first                                      | `src/smoke/__tests__/phases-test.ts`, `format-test.ts`, `resolveOptions-test.ts`; `src/followups/__tests__/smoke-test.ts`; `e2e/__tests__/smoke-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                             |
| §A refused connection is not an answer                                                                                     | `src/runtime/__tests__/waitReady-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| §The device that can open the app, §A reloading runtime answers like one with no debugger                                  | `src/smoke/__tests__/phases-test.ts`; `src/device/__tests__/bootDevice-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §Android                                                                                                                   | `src/runtime/__tests__/runtimeErrorCollector-test.ts`, `runtimeAsync-test.ts`, `cdpClient-test.ts`, `appProcess-test.ts`; `src/runtime/interact/__tests__/interactAsync-test.ts`; `src/device/__tests__/adb-test.ts`, `androidApps-test.ts`; `e2e/__tests__/runtime-test.ts`, `smoke-test.ts`                                                                                                                                                                                                                                                                        |
| §Cloud simulator                                                                                                           | `src/navigate/__tests__/device-test.ts`, `navigateAsync-test.ts`; `src/device/__tests__/cloudSimulator-test.ts`, `cloudErrors-test.ts`; `src/runtime/__tests__/appProcess-test.ts`, `resolveStopOptions-test.ts`; `src/runtime/reload/__tests__/reloadAsync-test.ts`; `e2e/__tests__/cloud-simulator-test.ts`                                                                                                                                                                                                                                                        |
| §Stopping the app                                                                                                          | `src/runtime/__tests__/stopAsync-test.ts`, `appId-test.ts`, `appProcess-test.ts`; `src/dev/__tests__/stopAsync-test.ts`, `stopLifecycle-test.ts`; `e2e/__tests__/stop-test.ts`, `dev-logs-test.ts`                                                                                                                                                                                                                                                                                                                                                                   |
| §Installed-app fingerprint check                                                                                           | §Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
