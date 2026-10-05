# 0028: One device per platform per agent — each worktree binds its own devices, local or on EAS

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
  "touchedAt": "…",
  "created": true,
  "booted": true
}
```

- `backend` is `local-ios`, `local-android` or `eas`. `platform` is `ios` or `android`; an `eas` claim needs both.
- `projectRoot` is resolved through symlinks, as the dev-server lock is.
- `pid` is the process that wrote the claim, for a report that names the owner. It is not used for liveness: the operating system reuses PIDs.
- `touchedAt` is refreshed by every verb that gets a usable device from the claim, and never by a verb that cannot use it (a read of a shut-down simulator). The refresh is a compare-and-swap on `projectRoot` and `claimedAt`, so it never overwrites a claim that replaced this one.
- `booted: true` means this CLI booted the device or created it, so `dev:stop` may shut it down.
- `created: true` means this CLI created the device. Only such devices are ever deleted. A simulator whose name starts with `agent-cli ` (the name this CLI gives at creation) is `created: true` whenever it is claimed, because `dev:stop` deletes the claim and a crash between `simctl create` and the claim write leaves none.
- One file per device, so two agents never write the same file. A claim is created with `O_EXCL` (`wx`).

**Liveness.** A claim is live while the dev-server lock of its `projectRoot` answers, or while `touchedAt` is younger than a grace period (10 minutes). A record alone is not proof ([[0004-smart-start-and-project-state]]: liveness through a socket, not a state file), so the socket is the primary check. The grace period covers a worktree whose `dev` has stopped but whose agent still runs `navigate` or screenshots. A claim that fails both checks is stale.

**Takeover.** Taking over a stale claim, creating a device, and counting capacity all run under one registry lock, `~/.expo/agent-cli/devices/.lock`, taken with `mkdir` (atomic on every platform). A lock older than 60 seconds is stale: the one waiter that holds a second `mkdir` guard, `.lock.takeover`, checks the age again, renames the lock aside and removes it. The holder writes a token into the lock and removes only a lock that still holds its token. A claim file that does not parse and is older than 60 seconds is a crash mid-write, and is removed under the lock. Without the lock, two agents can both see a claim as stale, both remove it and both write their own.

`bindDeviceAsync({ platform, backend, projectRoot })` returns the device for the worktree, or a refusal. Every verb calls it. The choice itself is a pure function of the claims, the device inventory and the capacity; the file and socket work sits around it.

**Allocation**, in order:

1. The live claim of this worktree.
2. A stale claim of this worktree (the same agent, restarted), if the device still exists.
3. A booted device with no live claim.
4. A shut-down device with no live claim. `pickSimulator` keeps its current ranking inside this set.
5. A new device, created from the newest runtime and device type, if the capacity allows it.
6. Stop with `DEVICES_ALL_CLAIMED`. The message names each holder by project root. The CLI never takes a live claim from another worktree.

Step 3 takes a device a human may have booted. That is today's behaviour, and the alternative doubles the simulators on a machine where a human keeps one booted. `--device` is the override. [decided — Vojtech, 2026-09-30]

**Capacity.** The default limit is `max(1, floor(cpus / 2))` iOS simulators and `max(1, min(floor(cpus / 4), floor(totalRamGb / 8)))` emulators. These are simlock's defaults, which budget about 1.5 GiB per simulator and 4 GiB per emulator [read — simlock CONFIGURATION.md, not measured]. `EXPO_AGENT_MAX_DEVICES` overrides both.

**Device set.** New simulators go into the default `simctl` device set. A private `--set` would hide them from Simulator.app, but Expo CLI has no `--set` support, so `expo run:ios` could not build for them. [decided — 2026-09-30]

**No local iOS backend.** On Windows and Linux, `simctl` does not exist. `bindDeviceAsync` for `local-ios` then refuses and names `--eas`. Android can run locally or on EAS on every host.

## EAS backend: sessions this worktree started

**Selection**, in order:

1. The session named by this worktree's `eas` claim, if `eas simulator:list --status in-progress` lists it on this platform.
2. The session named by `.env.eas-simulator` in this worktree, if it is in progress. `eas simulator` writes that file when a start is run from this worktree, with or without this CLI, so it is a claim made by another tool for the same worktree.
3. A new session, started by this worktree. Its id is written as an `eas` claim.

All four verbs that resolve a session go through `probeCloudSessionAsync` → `selectCloudSession` (`smoke/smokeAsync.ts`, `navigate/device.ts`, `dev/openAppEas.ts`, `dev/stopAsync.ts`) [observed — 2026-09-30], so the rule changes in one place.

The CLI never picks an in-progress session that this worktree did not start or bind. "The newest session on the platform" is removed as a selection rule. A session that is listed but not bound is reported, as `selectCloudSession` reports `wrongType` sessions today, so the agent knows that it exists.

The dotenv rung is skipped when the registry holds a live `eas` claim of another project root on that session (a copied `.env.eas-simulator`), the probe reports the session as not this worktree's and names the holder, and a claim write that loses to another worktree is a refusal, not a bind.

**Cross-machine protection.** When each worktree uses only its own bound session, two agents with this CLI cannot take the same session, on one machine or on many. Other clients are not covered: an older CLI version, MCP, or a human with `eas simulator` can still take a session. Full protection needs an owner mark on the server (§Open questions).

**Stale sessions.** A session outlives its worktree when the agent crashes, and it keeps using account minutes. `dev:stop --eas` already stops the session by id. A session whose worktree is gone needs a cleanup rule on the server or an expiry (§Open questions).

## Explicit device

`--device <udid|serial|name|session-id>` on `dev` and `navigate` (`status` has the flag already) skips allocation steps 1 to 5 and writes the claim, so other agents skip that device. This is also the way to bind an EAS session that another tool started.

For a local device, `--device` is step 0 of the allocation, under the same registry lock. Devices that another live worktree holds are dropped before the name is matched, because two emulators of one AVD share a name. The worktree's other claims on the platform are released only after the named device is claimed and usable, so a `--device` that fails keeps the device that works.

## Every verb uses the claim

- `openApp`, install, `navigate`, `status`, screenshot and interaction verbs get the device from the claim. `simctl` receives the UDID, `adb` receives `-s <serial>`, and `eas simulator:*` receives the session id. No code path passes `booted`.
- `expo run:ios` and `expo run:android` get `--device <id>`, so Expo CLI does not choose the first booted device. `expo run:*` runs without `--device` only when no booted device of the platform is another worktree's. When other live worktrees hold every booted device, `dev` and `dev --plan` stop with `DEVICES_ALL_CLAIMED` and name the holders. `run:ios --device` matches a UDID or a name (`run/ios/options/resolveDevice.ts`), and `run:android --device` matches a serial or a name (`start/platforms/android/AndroidDeviceManager.ts` §resolveFromNameAsync) [observed — expo/expo 2026-09-30]. @expo/cli 57 and lower match `run:android --device` by name only, and an emulator's name is its AVD, so when two running emulators share one AVD (a read-only second instance) the install step is refused with `RUN_DEVICE_AMBIGUOUS` rather than risk the other worktree's emulator; 58 and newer receive the serial [observed — @expo/cli 57.0.21 and 58.0.9 `AndroidDeviceManager.resolveFromNameAsync`].
- The local call sites that pick a device today, all to be routed through the claim: `navigate/device.ts` (booted simulator, first adb device), `installedApp/iosSimulator.ts` and `installedApp/android.ts`, `runtime/targetPlatform.ts`, `device/bootDevice.ts` §pickSimulator, `device/installDevBuild.ts`, `dev/openApp.ts` [observed — 2026-09-30].
- `adb reverse` runs only on the claimed serial. Expo CLI's `startAdbReverseAsync` still reverses on every attached device (`start/platforms/android/adbReverse.ts`) [observed — expo/expo 2026-09-30]. This causes no failure, because each app connects only to its own port.

## Android boot

- The console port is the first free even port in 5554–5584, found with a bind test. The serial is `emulator-<port>`. The adb server scans only 5555–5585, so this range allows 16 emulators. [observed — developer.android.com/tools/adb]
- `EMULATOR_SERIAL` becomes a value returned from the boot, not a constant.
- If the AVD is already running for another claim, the new instance boots with `-read-only`. Detox does the same for parallel workers. [observed — Detox devices.mdx]

## Release and cleanup

- `dev:stop` releases the local claims of its worktree only when the dev server stopped or none was running. While the dev server still runs, the claims stay and the report says why.
- A local device is shut down only if the claim has `created: true` or `booted: true`. `booted` is set when this CLI boots the simulator or spawns the emulator, because `dev:stop` runs in a later process than the boot. The shutdown and the claim's release run under one registry lock, so no other worktree takes a device that is still up.
- `dev:stop --eas` stops every EAS session the worktree claims, by id (one per platform). A plain `dev:stop` keeps the `eas` claims and reports each session as still running, with the reason ([[0021-honest-reports]]).
- A created local device is deleted when its claim has been stale for 1 hour. The next `bindDeviceAsync` does this cleanup, because there is no daemon.
- The CLI never shuts down or deletes a local device that it did not boot or create.

## Discovery

When no lock answers, `discoverDevServerAsync` probes 8081, then 8082–8085, and the first server that answers wins (`devServer.ts` caveat). With parallel worktrees, that server is often another worktree's server.

Change: a server found by the port scan counts as this project's server only if its project root matches. The source is the `X-React-Native-Project-Root` header of `GET /status`. The Expo CLI dev server sets it to `encodeURI(metroConfig.projectRoot)` (`createMetroStatusMiddleware` in `start/server/metro/dev-server/createMetroMiddleware.js`), and the RN community CLI compares it with its project root (`isDevServerRunning.js`) [observed — `@expo/cli` 57.0.21, `@react-native/community-cli-plugin` 0.86.3]. Decode the value before the comparison, and resolve both paths through symlinks. This is an HTTP check, so it works on Windows. Expo CLI's own port check reads the cwd of the listening process with `lsof`, which does not exist on Windows, so this RFC does not use it. A server that does not match is reported as foreign, the same way `dev:stop` reports it. The port that `.expo/dev/logs/start.log` names gets the same check, because the log outlives its server, and a server whose `/status` does not answer after one retry is not accepted, because it proves nothing.

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
