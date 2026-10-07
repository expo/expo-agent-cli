# 0030: One device per platform per agent — each worktree binds its own devices, local or on EAS

**Type:** RFC
**Status:** Draft
**Systems:** local device selection and boot (`src/device/bootDevice.ts` §pickSimulator, §EMULATOR_SERIAL; `src/navigate/device.ts` §parseBootedIosSimulator); the local open (`src/dev/openApp.ts`); EAS session selection (`src/device/cloudSimulator.ts` §selectCloudSession, §CLOUD_SESSION_ENV_FILE); the EAS open (`src/dev/openAppEas.ts`); dev-server discovery (`src/runtime/devServer.ts` §discoverDevServerAsync); dev-server lock (`src/devLock/`); `dev:stop` (`src/dev/stopAsync.ts`); `smoke`'s device cleanup (`src/smoke/smokeAsync.ts`)
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-09-30
**Related:** [[0004-smart-start-and-project-state]] §Discovery ladder, [[0005-runtime-loop-tools]] §Cloud simulator, [[0015-backend-selection-and-config]], [[0026-dev-owns-the-open]], [[0027-everything-on-eas]]

## Summary

Developers run several agents on one Expo app in parallel, usually one agent per git worktree. The agents can run on one Mac, on several machines, or on Windows with the device on EAS. Today the agents collide on devices:

- **Local.** Every verb uses the first booted simulator or the first `adb` device. All agents therefore drive the same device, and each agent replaces the app of the others.
- **Local.** When no device is booted, each agent boots one. Nothing records which device belongs to which agent, so the machine collects extra simulators.
- **Local.** The emulator always boots with `-ports 5554,5555` (`bootDevice.ts` §EMULATOR_SERIAL). A second concurrent boot collides.
- **EAS.** `dev --eas` reuses an in-progress session of the platform (`openAppEas.ts` step 1). `selectCloudSession` prefers the id in `.env.eas-simulator`, which `eas simulator` writes when this worktree starts a session (`cloudSimulator.ts` §CLOUD_SESSION_ENV_FILE). A worktree that has not started one falls through to the newest session on the platform, which another worktree or a CI job may own. [[0027-everything-on-eas]] §Testing observed this live: `dev --eas` reused a session of a concurrent CI job, and that session refused the deep link.

Decision [confirmed — Vojtech, 2026-09-30]: **each agent gets its own device on each platform.** A worktree binds one device per platform, so a React Native app run by one agent has one iOS simulator and one Android emulator, and no other worktree uses either. Two agents never share a device. The device is a local simulator, a local emulator or an EAS Simulator session. Every verb for that worktree uses the bound device, and never "the first booted" device or "the newest session". A shared device is rejected: all worktrees install the same bundle ID, so agents fight over the foreground app and UI automation.

Metro is already mostly separate: the dev-server lock is per project root (`src/devLock/address.ts`), and a busy port moves to a free one (`src/dev/portCollision.ts`). This RFC fixes the remaining Metro gap in §Discovery.

## Prior art

- **Detox** keeps `device.registry.json` under an exclusive file lock. Each entry is `{deviceId, busy, sessionId, pid}`, and entries with dead PIDs are removed (`DeviceRegistry.js`, `unregisterZombieDevices`). [observed — wix/Detox master]
- **Callstack simlock** is a daemon that gives out TTL leases. It creates devices in its own `simctl --set` directory, runs a private adb server, queues requests at capacity, and deletes only devices it created. A gateway mode puts one queue in front of several machines. [observed — callstackincubator/simlock README, ADR 0001, ADR 0004, ADR 0005]
- **Expo CLI** `run:ios` uses the first booted simulator (`getBestBootedSimulatorAsync`). `adb reverse` runs on every attached device. [observed — expo/expo `packages/@expo/cli`]

## Where exclusivity comes from

The claimants of a device decide where its ownership record must live:

- **A local device** is claimed only by processes on the same machine. A machine-wide file registry sees all of them. This is the Detox model.
- **An EAS session** is claimed by agents on any machine, in CI, and by other clients such as MCP. Only the EAS service sees all of them. A local file cannot.

So this RFC has no daemon. For local devices, a file registry is enough. For remote devices, the EAS service has the role that simlock's gateway has: it is the one place that sees every claimant. A local daemon would duplicate it. A simlock backend can still replace the local registry later, behind the same interface, if queueing is needed.

## The registry

One store: a machine-wide registry with one JSON file per claimed device, at `~/.expo/agent-cli/devices/<backend>-<id>.json`. A worktree's devices are the claims in that directory that name its project root. There is no second per-worktree file, so nothing can disagree with the registry.

```json
{
  "backend": "local-ios",
  "platform": "ios",
  "id": "<udid | adb serial | EAS session id>",
  "projectRoot": "/…/worktree",
  "pid": 1234,
  "claimedAt": "…",
  "created": true,
  "booted": true
}
```

- `backend` is `local-ios`, `local-android` or `eas`. `platform` is `ios` or `android`; an `eas` claim needs both.
- `projectRoot` is resolved through symlinks, as the dev-server lock is.
- `pid` is the process that wrote the claim, for a report that names the owner. It is not used for liveness: the operating system reuses PIDs.
- The touch of a claim is the mtime of its file, and the JSON does not hold it. A claim is written with its touch as its mtime. Every verb that claims a usable device refreshes the mtime with `utimes` (a peek touches nothing), and a verb that cannot use the device (a read of a shut-down simulator) does not. The touch runs outside the registry lock, so it never removes or rewrites the file: every reader sees the claim all the time, and two touches of one worktree never disturb each other. After the touch, the verb reads the file again. It goes on only while the file still names this claim (the same `projectRoot` and `claimedAt`). Otherwise it refuses the device and releases nothing. A touch can refresh a claim that replaced this one after the verb read it. That claim is newer than the read, so it is live already.
- `booted: true` means this CLI booted the device or created it, so `dev:stop` may shut it down. It and `reaping` are the only fields that change after the claim is written, and `booted` only from false to true. A change runs under the registry lock: the CLI reads the claim again, and only while the file still names this claim does it write a new file and rename it over the claim. A reader never finds the claim missing. A claim that says `booted: true` already (a created device, or a device this CLI booted before) is not written again, and takes no lock.
- `reaping: true` means a reaper shuts the device down (§Release and cleanup). Such a claim is live within the grace period although its worktree is deleted, so no allocation takes the device during the shutdown. The field is absent on every other claim.
- `created: true` means this CLI created the device. Only such devices are ever deleted. A simulator whose name starts with `agent-cli ` (the name this CLI gives at creation) is `created: true` whenever it is claimed, because `dev:stop` deletes the claim and a crash between `simctl create` and the claim write leaves none.
- One file per device, so two agents never write the same file. A claim is created with `O_EXCL` (`wx`).

**Liveness.** A claim is live while the dev-server lock of its `projectRoot` answers, or while its touch is younger than a grace period (10 minutes). A record alone is not proof ([[0004-smart-start-and-project-state]]: liveness through a socket, not a state file), so the socket is the primary check. The grace period covers a worktree whose `dev` has stopped but whose agent still runs `navigate` or screenshots. A touch more than 60 seconds in the future comes from a wrong clock or a hand edit, and does not count. A claim that fails both checks is stale. A claim of a deleted worktree (§Release and cleanup) is stale whatever its touch: a claim reaps it before it chooses, and a peek, which reaps nothing, does not count it. The allocation reads the clock after it gets the registry lock, so a touch made while it waited for the lock is not in the future, and reads it again for each re-read of a claim (below), so a touch made during a slow inventory or device delete is not in the future either.

**Takeover.** Taking over a stale claim, creating a device, and counting capacity all run under one registry lock, `~/.expo/agent-cli/devices/.lock`, taken with `mkdir` (atomic on every platform). A lock older than 60 seconds is stale: the one waiter that holds a second `mkdir` guard, `.lock.takeover`, checks the age again, renames the lock aside and removes it. The holder writes a token into the lock and removes only a lock that still holds its token. A holder that pauses for more than 60 seconds (a laptop asleep, a stopped process) looks dead, and another process can take its lock over. So the holder reads the token again before each change it makes under the lock: a claim written, released or removed, or a device created or deleted. When the token is not its own, the holder stops with `DEVICE_REGISTRY_LOCK_LOST` and changes nothing. A claim file that does not parse and is older than 60 seconds is a crash mid-write, and is removed under the lock. Without the lock, two agents can both see a claim as stale, both remove it and both write their own. The inventory under the lock is slow, and a touch runs outside it, so the allocation reads and classifies each claim again immediately before it removes or releases the claim or deletes its device. A claim that changed or is live now is left, and a takeover chooses again. A claim write that finds a file there already (`EEXIST`) also chooses again: the device was claimed after the registry was read, or a claim file that does not parse yet holds it. Such a file counts as a live claim whose holder is named by the file's path, so the device stays in the inventory: `--device` reports it claimed, and the capacity counts it.

`bindDeviceAsync({ platform, backend, projectRoot })` returns the device for the worktree, or a refusal. Every verb calls it. The choice itself is a pure function of the claims, the device inventory and the capacity; the file and socket work sits around it.

**Allocation**, in order:

1. The live claim of this worktree.
2. A stale claim of this worktree (the same agent, restarted), if the device still exists.
3. A booted device with no live claim.
4. A shut-down device with no live claim. `pickSimulator` keeps its current ranking inside this set.
5. A new device, created from the newest runtime and device type, if the capacity allows it. Never for a caller that needs an installed app and may not install it: a new device has no app. A device created for a caller that may install the app counts as one without it.
6. Stop with `DEVICES_ALL_CLAIMED`. The message names each holder by project root. The CLI never takes a live claim from another worktree.

Step 3 takes a device a human may have booted. That is today's behaviour, and the alternative doubles the simulators on a machine where a human keeps one booted. `--device` is the override. [decided — Vojtech, 2026-09-30]

**Capacity.** The default limit is `max(1, floor(cpus / 2))` iOS simulators and `max(1, min(floor(cpus / 4), floor(totalRamGb / 8)))` emulators. These are simlock's defaults, which budget about 1.5 GiB per simulator and 4 GiB per emulator [read — simlock CONFIGURATION.md, not measured]. `EXPO_AGENT_MAX_DEVICES` overrides both.

**Device set.** New simulators go into the default `simctl` device set. A private `--set` would hide them from Simulator.app, but Expo CLI has no `--set` support, so `expo run:ios` could not build for them. [decided — 2026-09-30]

**No local iOS backend.** On Windows and Linux, `simctl` does not exist. `bindDeviceAsync` for `local-ios` then refuses and names `--eas`. Android can run locally or on EAS on every host.

## EAS backend: sessions this worktree started

**Selection**, in order:

1. The session named by this worktree's `eas` claim, if `eas simulator:list --status new --status in-progress` lists it in progress on this platform.
2. The session named by `.env.eas-simulator` in this worktree, if it is in progress. `eas simulator` writes that file when a start is run from this worktree, with or without this CLI, so it is a claim made by another tool for the same worktree.
3. A new session, started by this worktree. Its id is written as an `eas` claim.

A claim whose session is not on that one page (25 sessions) is not proof that the session ended: a session just started, or one kept after a failed start, is often not on it. The CLI looks the id up with `simulator:list --status new --status in-progress --status stopped --status errored`, a page of 100 at a time with `--after`, for at most 10 pages. `STOPPED` or `ERRORED` releases the claim. A session that is `NEW` keeps its claim, so `dev:stop --eas` stops it by id. A session that the lookup does not find keeps its claim too, while the claim is younger than the longest a session runs: 115 minutes, the cap for high-priority accounts (§Answers from the EAS code, item 2). An older claim names a session that is over, so it is released. Without that limit, the claim of a purged session, or of a session of another EAS account, would stay forever, and every probe would read 10 pages for it. A stop that fails releases the claim only when a lookup then reports the session over by the same rule. While the claimed session is `NEW`, `dev --eas` starts no second session beside it. eas-cli 24.10 adds `queued` and `starting`, which 24.7 refuses, so they are not sent, and a session in either keeps its claim. [read — eas-cli 24.7.0 `commands/simulator/list.ts`; `npx eas-cli@latest simulator:list --help`, 24.10.0, 2026-10-05]

All four verbs that resolve a session go through `probeCloudSessionAsync` → `selectCloudSession` (`smoke/smokeAsync.ts`, `navigate/device.ts`, `dev/openAppEas.ts`, `dev/stopAsync.ts`) [observed — 2026-09-30], so the rule changes in one place.

The CLI never picks an in-progress session that this worktree did not start or bind. "The newest session on the platform" is removed as a selection rule. A session that is listed but not bound is reported, as `selectCloudSession` reports `wrongType` sessions today, so the agent knows that it exists.

The dotenv rung is skipped when the registry holds a live `eas` claim of another project root on that session (a copied `.env.eas-simulator`), the probe reports the session as not this worktree's and names the holder, and a claim write that loses to another worktree is a refusal, not a bind.

**Cross-machine protection.** When each worktree uses only its own bound session, two agents with this CLI cannot take the same session, on one machine or on many. Other clients are not covered: an older CLI version, MCP, or a human with `eas simulator` can still take a session. Full protection needs an owner mark on the server (§Open questions).

**Stale sessions.** A session outlives its worktree when the agent crashes, and it keeps using account minutes. `dev:stop --eas` already stops the session by id. A session whose worktree is gone needs a cleanup rule on the server or an expiry (§Open questions).

## Explicit device

`--device <udid|serial|name>` on `dev` and `navigate` (`status` has the flag already) skips allocation steps 1 to 5 and writes the claim, so other agents skip that device. It names a simulator, an emulator or a device on this machine, so `dev` and `navigate` refuse it with `--eas` (`BAD_ARGS`). An EAS session is bound only by the session this worktree started or the one its `.env.eas-simulator` names (§EAS backend).

For a local device, `--device` is step 0 of the allocation, under the same registry lock. Devices that another live worktree holds are dropped before the name is matched, because two emulators of one AVD share a name. The worktree's other claims on the platform are released only after the named device is claimed and usable, so a `--device` that fails keeps the device that works. They are released under the registry lock, as `dev:stop` releases them: a device this CLI booted or created is shut down first. A claim whose shutdown fails is released too, and the verb says on stderr that the device is still up, because the named device must be the only device this worktree holds on the platform.

## Every verb uses the claim

- `openApp`, install, `navigate`, `status`, screenshot and interaction verbs get the device from the claim. `simctl` receives the UDID, `adb` receives `-s <serial>`, and `eas simulator:*` receives the session id. No code path passes `booted`.
- A verb that only reads peeks instead of claiming: `status` and `dev --plan`. The resolver takes `mode: 'claim' | 'peek'`, and every caller names one. A peek reads the claims and the inventory without the registry lock and runs the allocation's own choice on them (`peekDeviceAsync` beside `allocateDeviceAsync`, both through `chooseDevice`; the peek is given whether a claim may create a device, and no function that creates or deletes one), so a peek and the next claim agree unless another worktree claims in between. It answers with the device and the action a claim would take: `reuse` this worktree's claim, `take` a free booted device, `boot` a free shut-down one, or `create` a simulator. It gives the refusals a claim gives. It reaps nothing, writes, touches and releases no claim, boots and creates nothing, and stops no EAS session. `navigate` opens a link on the device, so it claims. `status` reads a booted device only: the one this worktree claims, or the free one a claim would take.
- `expo run:ios` and `expo run:android` get `--device <id>`, so Expo CLI does not choose the first booted device. A run claims the device first, booting or creating it when none is free and up. `dev --plan` peeks at the same answer with boot allowed, so its `expo run:*` step carries the `--device` the run passes, and the plan's `device` (`action`, `id`, `name`, `state`, and a `Device:` line in the table) says when the run boots or creates the device. A simulator the run creates has no UDID yet, so that step is unpinned in the plan. A run boots the device `--device` names before it asks whether the device has the app ([[0004-smart-start-and-project-state]] §A current build is not an installed app). `dev --plan` boots nothing: it reads a shut-down simulator's apps off its disk, so it plans the install the run makes, and for an emulator that is not running it says in its reasons that it could not ask. `dev` never runs `expo run:*` without `--device`, because the Expo CLI then takes the first device it finds, which may be another worktree's. Every refusal of the claim stops `dev` and `dev --plan`: a tool or a registry that fails (`simctl` or `adb` exits non-zero, the registry cannot be written) is `DEVICE_UNAVAILABLE`, and a machine with no device to boot is `NO_DEVICE`. A machine whose only Android device is on USB names it with `--device <serial>`. When other live worktrees hold every device the capacity allows, `dev` and `dev --plan` stop with `DEVICES_ALL_CLAIMED` and name the holders. `navigate` boots nothing, so it stops with the same refusal when other live worktrees hold every booted device. `run:ios --device` matches a UDID or a name (`run/ios/options/resolveDevice.ts`) [observed — expo/expo 2026-09-30], and @expo/cli 58 matches `run:android --device` against the serial before the name [observed — @expo/cli 58.0.9 `AndroidDeviceManager.resolveFromNameAsync`]. The CLI targets SDK 58 and later, so `expo run:android` always gets the adb serial. A name would not do: two running emulators of one AVD (a read-only second instance) share it. An older Expo CLI matches by name only, and fails the step on the serial.
- The local call sites that pick a device today, all to be routed through the claim: `navigate/device.ts` (booted simulator, first adb device), `installedApp/iosSimulator.ts` and `installedApp/android.ts`, `runtime/targetPlatform.ts`, `device/bootDevice.ts` §pickSimulator, `device/installDevBuild.ts`, `dev/openApp.ts` [observed — 2026-09-30].
- `adb reverse` runs only on the claimed serial. Expo CLI's `startAdbReverseAsync` still reverses on every attached device (`start/platforms/android/adbReverse.ts`) [observed — expo/expo 2026-09-30]. This causes no failure, because each app connects only to its own port.

## Android boot

- The console port is the first free even port in 5554–5584, found with a bind test. The serial is `emulator-<port>`. The adb server scans only 5555–5585, so this range allows 16 emulators. [observed — developer.android.com/tools/adb]
- `EMULATOR_SERIAL` becomes a value returned from the boot, not a constant.
- If the AVD is already running for another claim, the new instance boots with `-read-only`. Detox does the same for parallel workers. [observed — Detox devices.mdx]
- Another process can take the console port after the registry lock is released. Then the spawned emulator exits, and another emulator answers on the serial. So a boot trusts `sys.boot_completed` only while the process it spawned has not exited with an error, and only when `adb -s <serial> emu avd name` names the AVD it started. An exit with code 0 is not a failure, because a launcher can hand off to the emulator process; the AVD name still decides. A boot that fails these checks shuts down nothing by serial, because the emulator there is another process's, and releases the claim, even one the worktree held before.

## Release and cleanup

- `dev:stop` releases the local claims of its worktree only when the dev server stopped or none was running. While the dev server still runs, the claims stay and the report says why. A device whose shutdown fails keeps its claim too, and the report gives the failure, so the next `dev:stop` tries again.
- A local device is shut down only if the claim has `created: true` or `booted: true`. `booted` is set when this CLI boots the simulator or spawns the emulator, because `dev:stop` runs in a later process than the boot. The claim records it before the CLI waits for the boot, because a boot that times out has still started the device. When a boot fails, the CLI shuts the device down, kills the emulator process it spawned when `adb` cannot see the emulator yet, and releases a claim that this call made (§Android boot has the one exception: a serial another emulator answers on). The shutdown and the claim's release run under one registry lock, so no other worktree takes a device that is still up.
- `dev:stop --eas` stops every EAS session the worktree claims, by id (one per platform). A plain `dev:stop` keeps the `eas` claims and reports each session as still running, with the reason ([[0021-honest-reports]]).
- A created local device is deleted when its claim has been stale for 1 hour. The next `bindDeviceAsync` does this cleanup, because there is no daemon.
- A deleted worktree never runs `dev:stop`. So the next allocation or `dev:stop` of any worktree reaps a claim whose `projectRoot` is gone, whose parent directory still exists, and whose dev-server lock does not answer, without the grace period. A missing parent is an unmounted volume, and its claims stay. Under the registry lock, a local claim with `booted` or `created` is written again with `reaping: true`, which refreshes its touch. It stays the deleted worktree's claim and is live, so no worktree takes the device, not even the live worktree that reaps it, and every other reaper skips it. The device is shut down outside the lock. Then, under the lock, the claim is removed, or, when the shutdown failed, written again without the mark, so the next reap tries again. A reaper that crashes leaves the mark; once its touch is older than the grace period, the claim is stale, and the next allocation takes the device over or removes the claim. Only a simulator named `agent-cli N` is then deleted, and never an AVD; a claim with neither flag is dropped and its device left as it is. An EAS session is stopped with `simulator:stop --id` from the live worktree's cwd, and its claim is dropped only after the stop succeeds. The verb reports each reaped claim (`dev:stop` in its JSON `reaped` and in words, an allocation as a progress line on stderr), and a failed shutdown never fails the verb. (`src/device/reapClaims.ts`)
- The CLI never shuts down or deletes a local device that it did not boot or create.

## Discovery

When no lock answers, `discoverDevServerAsync` probes 8081, then 8082–8085, and the first server that answers wins (`devServer.ts` caveat). With parallel worktrees, that server is often another worktree's server.

Change: a server found by the port scan counts as this project's server only if its project root matches. The source is the `X-React-Native-Project-Root` header of `GET /status`. The Expo CLI dev server sets it to `encodeURI(metroConfig.projectRoot)` (`createMetroStatusMiddleware` in `start/server/metro/dev-server/createMetroMiddleware.js`), and the RN community CLI compares it with its project root (`isDevServerRunning.js`) [observed — `@expo/cli` 57.0.21, `@react-native/community-cli-plugin` 0.86.3]. Decode the value before the comparison, and resolve both paths through symlinks. This is an HTTP check, so it works on Windows. Expo CLI's own port check reads the cwd of the listening process with `lsof`, which does not exist on Windows, so this RFC does not use it. A server that does not match is reported as foreign, the same way `dev:stop` reports it. The port that `.expo/dev/logs/start.log` names gets the same check, because the log outlives its server, and a server whose `/status` does not answer after one retry is not accepted, because it proves nothing.

The lock never falls back to a `--port` or default port whose `/status` names another project root [observed — live suite, 2026-10-05: a lock on 8081 pointed at another project's Metro]. It keeps reading `start.log` while the dev server runs, and publishes nothing if the server stops first (`dev_lock_skipped`, reason `foreign-port`).

With `--eas`, Metro still binds a local port behind the tunnel, so the per-worktree port handling still applies. Each worktree gets its own tunnel URL.

## Out of scope

- A shared device with one bundle ID per worktree.
- Physical devices. A physical device gets a claim when you name it with `--device`, but the CLI never allocates one on its own.
- A local daemon, a queue, and local device fleets. simlock can provide these later behind the local registry interface.

## Answers from the EAS code

Read on 2026-10-01 in the local clones of `eas-cli` (24.7.0, `packages/eas-cli/src`) and `universe` (`server/www/src/data/entities/device-run-session/`, `server/website/graphql/schema.generated.graphql`). The service calls a session a `DeviceRunSession`.

1. **Owner mark: the service has one.** `eas simulator` accepts `--name` (at most 255 characters) and `--tag` (repeatable, stored lowercased). Both come back in `simulator:list --json`, and the list filters by `--name` (a contains match in SQL, `AppDeviceRunSessionsPagination.ts:71-72`) and `--tag` (a session must carry every listed tag, `DeviceRunSessionFilterInput.tags`). No field carries a client identity: `initiatingActor` exists on the type but the CLI never selects it, and `trackingTags.request_origin` is analytics only. So the mark is a convention this CLI sets: start each session with a tag that names the worktree, for example `agent-cli:<digest of the canonical project root>`, and list with that tag. A session without the tag is never adopted; a session with it can be found again after the local registry is lost. Other clients that ignore the tag are still not kept out, which the service does not offer.
2. **Expiry: opt-in.** `maxIdleTimeMinutes` stops an `agent-device`, `argent` or `appium` session after that many idle minutes; "if omitted, the session has no idle timeout" (`DeviceRunSessionValidator.ts:126-142`). `maxRunTimeMinutes` is capped at 40 minutes for normal-priority accounts and 115 for high-priority ones, and a session that names none gets the account cap (`DeviceRunSessionUtils.ts:858-865`). So a crashed agent's session runs until its max duration unless this CLI passes `--max-idle-time-minutes`. The CLI should pass one by default (a value under the max duration, 30 minutes is a candidate).
3. **Concurrency: no hard limit.** The backend has no session count per account, user or plan; the only gate is the feature flag (`DeviceRunSessionFeatureGateValidator.ts`). Sessions run as turtle jobs and queue behind the plan's job concurrency; the CLI shows "queued or waiting for available concurrency" (`commands/simulator/index.ts:363`). So parallel agents do not fail at start; they wait.

Two facts correct earlier text in this RFC and in llp/0005: at eas-cli 24.7.0 a `--json` start still writes the session id to `.env.eas-simulator` once the session is ready (`commands/simulator/index.ts:401-406`); the empty file was observed on 22.5.0 and that code was not read. And `DEVICE_IN_USE` is not emitted by the backend; it comes from the controller package, which neither clone contains.

## Follow-up work

- Start sessions with `--tag agent-cli:<digest>` and `--max-idle-time-minutes <n>`, list with `--tag`, and prefer the tag over the dotenv rung. `--max-idle-time-minutes` is in eas-cli since v22.5.0 (commit 28f80da6, 2026-08-26 14:39 UTC, ten minutes before the v22.5.0 tag; the changelog lists it under 22.6.0), and `--tag` since v23.2.0 (commit 926887d1, PR #4318, 2026-08-31) [read — eas-cli history and CHANGELOG.md, 2026-10-05]. An older eas-cli refuses the flag, so the CLI must read that refusal and fall back.
- Three review findings left for later: the registry lock is held during inventory work; `status` still reports the first booted device as "the" local device; the project-root comparison exists in three places.

## Open questions

1. Where does the idle check run, and what counts as activity? The backend passes `max_idle_time_minutes` to the job (`DeviceRunSessionUtils.ts:282`); the job code was not read.
2. Should `--device <session-id>` with `--eas` bind an in-progress session that another tool started outside this worktree, which `dev` and `navigate` refuse today?
