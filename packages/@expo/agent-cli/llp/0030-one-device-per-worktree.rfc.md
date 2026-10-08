# 0030: One device per worktree

**Type:** RFC
**Status:** Draft
**Systems:** device binding (new `src/deviceBinding/`); local device selection and boot (`src/device/bootDevice.ts`, `src/navigate/device.ts`, `src/installedApp/`); the `dev` resolver and run (`src/dev/`); `dev:stop` (`src/dev/stopAsync.ts`); `smoke` (`src/smoke/smokeAsync.ts`); EAS session selection (`src/device/cloudSimulator.ts`); the dev-server lock (`src/devLock/`)
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-10-08
**Related:** [[0004-smart-start-and-project-state]], [[0005-runtime-loop-tools]], [[0010-agent-conventions]] (exit codes), [[0021-honest-reports]], [[0026-dev-owns-the-open]], [[0027-everything-on-eas]] §Testing
**Plans:** [[0031-ios-binding]], [[0032-android-instance]], [[0033-device-lifecycle]], [[0034-eas-session-binding]]

## Summary

Developers run several agents on one Expo app in parallel, one agent per git worktree. Today the agents collide on devices:

- Every verb uses the first booted simulator or the first `adb` device. All agents drive one device, and each agent replaces the app of the others.
- When no device is booted, each agent boots one. Nothing records which device belongs to which agent.
- The emulator always boots on ports 5554 and 5555. A second concurrent boot collides.
- `dev --eas` reuses the newest in-progress session of the platform, which another worktree or a CI job may own. [[0027-everything-on-eas]] §Testing observed this live.

Decision [confirmed — Vojtech, 2026-09-30]: **each worktree gets its own device on each platform.** The device is a simulator this CLI created, an emulator instance this CLI spawned, a device the user named, or an EAS session this worktree started. A **binding** records it. Every verb of that worktree uses the bound device and never "the first booted" one.

A first implementation on the branch `feat/one-device-per-platform` adopted any free booted device. It worked, and it was rejected for size: a 942-line module, a full device inventory on every verb, and liveness from two sources. This RFC owns its devices instead, which removes device classification, adoption and takeover. The model follows `appandflow/stim`, which solves the same problem for agents in worktrees.

This RFC holds the rules, once each. The four plans hold the wiring, the acceptance lists and the tests of one PR each. §Delivery lists the PRs.

## Prior art

- **Detox** keeps `device.registry.json` under an exclusive file lock. Entries with dead pids are removed. [observed — wix/Detox master]
- **Callstack simlock** is a daemon that gives out TTL leases, creates devices in its own `simctl --set` directory, and deletes only devices it created. [observed — callstackincubator/simlock README]
- **appandflow/stim** gives each agent worktree a device the tool created, writes every lease under a lock, and removes a lock whose pid is dead. Its liveness is process identity, which does not fit this CLI: our verbs are short processes and nothing runs between two `navigate` calls. [read — local clone, 2026-10-07]
- **Expo CLI** `run:ios` uses the first booted simulator. `adb reverse` runs on every attached device. [observed — expo/expo `packages/@expo/cli`]

## Where exclusivity comes from

The claimants of a device decide where its ownership record must live. A local device is claimed only by processes on the same machine, so a machine-wide file registry sees all of them. An EAS session is claimed by agents on any machine, in CI, and by other clients. Only the EAS service sees all of them, so the service carries an owner mark (§EAS) and the local registry is a cache of it. No daemon.

## Glossary

- **Root**: the canonical project root of the Expo app, the same path the dev lock keys on; in a monorepo it is the app directory inside the git worktree. "Worktree" in this RFC means the root. **Digest**: `digestOf(canonicalizeExistingPath(root))`, shared with the dev lock.
- **Registry**: the directory `<expo home>/agent-cli/bindings` and its lock. **Binding**: one JSON file in it, one per worktree, platform and backend. **Backend**: `local-ios`, `local-android` or `cloud`.
- **Lease**: the binding's `expiresAt`. **Live**: not past. **Expired**: past. **Stale**: expired, or the root is deleted (Decision 6).
- **Parked**: a `created` binding whose lease is expired. **Park**: set `expiresAt` to now; the file stays. Only simulators park.
- **Inventory**: what the platform tool lists: `simctl list devices -j` for iOS, `adb devices -l` and `emulator -list-avds` for Android.
- **Section**: one hold of the registry lock, from taking it to giving it up. The lock is **given up**, never released.
- **Let go**: what happens to a binding's device when its worktree, or a reap, is done with it; one rule per origin, in §Records.
- **Reap**: let go of other worktrees' stale bindings. **Release**: let go of the own bindings; done by `dev:stop --release` and smoke's cleanup. A plain `dev:stop` keeps the devices, because the agent's common next step is `dev` again (Decision 9).
- **Session cap**: an EAS session lives at most 115 min on the service (§Answers from the EAS code, item 2).
- **Dev lock**: main's per-project socket lock that the process running Metro holds (`src/devLock/`). "The lock" alone means the registry lock.
- **Metro runner**: `runDevServerAsync` in `start/startAsync.ts`. **Step runner**: `runStepAsync` in `dev/devAsync.ts`, which runs prebuild, the `--no-bundler` install step and `eas build` with no dev lock.
- **Draft**: the first start plan the resolver decides, before it knows about devices; **building** when it has a build location. Named by `ProjectTarget`: `expo-go`, `dev-client`, `bare`, `web`, `none`.
- **Rung**: one source a verb tries for a device (§Readers). **Probe**: a read that writes no binding.
- **How line**: the last line of every CLI error, one next action.
- A simulator state is capitalised (`Booted`, `Shutdown`); an origin is lower case (`created`, `spawned`, `explicit`).

## Decisions

1. **Hybrid ownership.** iOS: each worktree binds a simulator this CLI created. Android: one AVD; every worktree boots its own instance of it with `-read-only` on a free even console port. The CLI never chooses a device a human booted. `--device` on `dev` binds the device the human names.
   **Why.** Owned devices need no classification, no takeover and no capacity rule, and a human's device is never hijacked. The split follows disk cost: simulators share one runtime per iOS version and own a small data container; each AVD owns a userdata image of several GB, and `-read-only` runs many instances off one image.
2. **Every Android instance is `-read-only`, the first one too.**
   **Why.** The human's AVD image is never written by an agent, and the first and the fifth worktree behave the same. The cost is a cold boot and a reinstall per instance start.
3. **Liveness is a 60 min lease, renewed by use. Nothing else.** No agent pid in the binding, no socket probe, no mtime. The `emulatorPid` of a spawned instance identifies the emulator, not the agent.
   **Why.** One source of truth. Metro renews the lease on a timer, so a Fast Refresh session never expires while Metro runs, and a crashed agent's binding is stale within 60 min. A pid in the binding would add a second source and a pid-reuse risk. The one case a pid would catch, `dev:stop --release` during a build step of the same worktree, costs one rerun of `dev` (Risk 9).
4. **Only `dev` and `smoke` allocate. Every other verb reads the binding**, with one subprocess per binding and no network call before the EAS rung.
   **Why.** The agent's hottest verb must not pay for the rarest decision. `dev` is where the agent's loop starts ([[0026-dev-owns-the-open]]); `smoke` brings its own device ([[0005-runtime-loop-tools]]).
5. **A parked simulator is an expired `created` binding, not a second record.** A living worktree keeps its parked simulator and gets it back on the next `dev`. A deleted worktree's simulator is deleted by the next reap.
   **Why.** One record type cannot disagree with itself. The worktree that paid for the native build keeps it. Disk is reclaimed when the worktree goes, with no count and no cap. Nothing takes another worktree's simulator: a `simctl create` is cheap, and the app on a foreign simulator is a foreign build anyway.
6. **A deleted worktree's bindings are stale at once.** Deleted means `lstat` of the root fails with `ENOENT`.
   **Why.** A deleted worktree's simulator should not hold RAM for 60 min. A parent check cannot tell a removed monorepo worktree from an unmounted volume, so there is none; an unmounted volume loses its devices (Risk 14).
7. **Every registry write runs under one machine-wide lock, with tmp+rename. The lock also covers `simctl create` and the emulator spawn, and nothing else that touches a device.**
   **Why.** A create or spawn under the lock ties the new device to the binding that names it in one section, so two `dev` runs in one worktree never make two devices. Every other device call runs after the section, so a read verb never waits on a boot or a shutdown. The races that leaves are in §Risks and each costs one rerun of `dev`.
8. **Seven PRs, one of them behavior-free. PRs 3a, 3b and 4 are reviewed one at a time and merged as one unit. 3a is committed module-first.**
   **Why.** Between 3a and 4 main would have a window where `dev` creates simulators and nothing releases them. The readers ship with the iOS binding, because they are what prove the binding works.
9. **`dev:stop` keeps the worktree's devices; `dev:stop --release` lets go of them now.**
   **Why.** The CLI's own restart follow-up is `dev:stop && dev --detach`, and a read-only emulator instance that is killed costs a cold boot and a reinstall on the next `dev`. The lease reclaims a stopped worktree's device within 60 min anyway (Decision 3), so a release on every stop buys little. The cost is RAM held for up to an hour after a stop; `--release` is for the agent that is done.
10. **Decided, not open.** `start --ios` keeps Expo CLI's device choice, because `dev` is the verb that binds. `dev --no-open` still binds, and may create, a simulator the user never sees, because the build step must be pinned. Local devices come before an EAS session, because a session bills by the minute. `status` never calls the network.

## Invariant

A created simulator boots, shuts down or is deleted, and a spawned emulator is killed, only after a section that wrote or removed its binding for that action. A child whose binding was never written is killed through its own process handle. The inventory is read before the lock and may be seconds stale; that is safe because every state change of a CLI device goes through a binding, and bindings are read under the lock.

## Contracts every verb honors

1. Only `acquireDeviceAsync` and `acquireCloudBindingAsync` write a device into a binding, and only `dev` (including `openAppEas` and dev-wait) and `smoke` call them. A read verb changes only `expiresAt`.
2. Read verbs call `inspectBindingAsync`, then `useBoundDeviceAsync` when they drive the device, and never list devices to choose one.
3. No code outside `src/deviceBinding/` runs `simctl list devices` or `adb devices` to select a device. The one exception is `status --device`, which lists to filter and binds nothing.
4. Every binding write runs under the lock.
5. A `created` simulator is never deleted while a binding names it. A simulator no binding names is never touched.
6. A recorded emulator pid is killed only after its file is removed. Never `emu kill` by serial.
7. `explicit` devices are booted at most, never shut down or deleted.
8. Every process that runs Metro or a build step on a bound device extends the lease, and on `lost` it writes nothing for that binding.
9. The EAS probe considers only sessions this worktree bound, its dotenv id (from PR 5; until then the fallback without `--eas` accepts the dotenv id only and `--eas` keeps main's choice), and sessions tagged with its digest (PR 6).
10. `src/deviceBinding/` imports nothing from `navigate`, `smoke`, `dev` or `installedApp`; a unit test enforces it.

Files and budgets: `types.ts`, `registry.ts` (read, write, lock), `lease.ts`, `choose.ts` (pure), `reap.ts`, `inspect.ts` (the inspect table, the cache, `useBoundDeviceAsync`, `ownCloudIdsAsync`), `rungs.ts` (`findBoundDeviceAsync`, the rung loop of §Readers), `android.ts`, `cloud.ts`, `index.ts` (`acquireDeviceAsync`, `releaseWorktreeDevicesAsync`, `defaultTools`, re-exports). Every file under 250 lines, no function over 60, the iOS and Android boots in their own functions.

## Records

One file per worktree, platform and backend: `<digest>-<platform>-<backend>.json`, so a worktree has at most four. Anything that acts on an existing file uses the `projectRoot` stored in it, never a recomputed digest, because a deleted worktree's canonical path can change. `dev` at a moved path gets a new device.

```ts
export type DevicePlatform = 'ios' | 'android';
export type BoundDevice =
  | {
      backend: 'local-ios';
      platform: 'ios';
      udid: string;
      name: string;
      origin: 'created' | 'explicit';
    }
  | {
      backend: 'local-android';
      platform: 'android';
      serial: string;
      origin:
        { kind: 'spawned'; avd: string; port: number; emulatorPid: number } | { kind: 'explicit' };
    }
  | {
      backend: 'cloud';
      platform: DevicePlatform;
      id: string;
      origin: 'started' | 'dotenv';
      tag?: string;
    };
export interface Binding {
  version: 1;
  device: BoundDevice;
  projectRoot: string;
  boundAt: string; // ISO; the session-cap clock, so a cloud reuse keeps it
  expiresAt: string; // ISO, the lease
}
export type Runner = (
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<SpawnCaptureResult>;
export interface DeviceTools {
  simctl: Runner;
  adb: Runner;
  emulatorList: Runner;
  spawnEmulator(args: string[]): { pid?: number; exited: Promise<number | null>; kill(): void };
  now: () => Date;
  isPidAlive: (pid: number) => boolean;
}
export type AcquireResult = {
  device: BoundDevice;
  justBooted: boolean;
  action: 'reused' | 'created' | 'spawned' | 'explicit';
};
export type InspectState =
  'none' | 'unreadable' | 'unknown' | 'recorded' | 'up' | 'not-up' | 'gone';
export type Inspection = {
  binding: Binding | null;
  path: string;
  state: InspectState;
  cause?: 'expired' | 'device-gone' | 'timeout' | 'tool';
  toolError?: CommandError;
};
export type ReleasedDevice = {
  backend;
  platform;
  id;
  name;
  released: boolean;
  shutDown: boolean;
  reason: string | null;
};
```

- Origins. `created`: the CLI may shut down, park and delete. `spawned`: the CLI may kill the emulator it spawned. `explicit`: boot at most. `cloud` `started`: this CLI started the session or found it by tag, and may stop it; `dotenv`: adopted from `.env.eas-simulator`; a reap never stops it, `dev:stop --eas` does, as today.
- Let go, one rule per origin, first match. The file action runs under the lock, the device action after it.
  - A local binding whose device the inventory does not list, or a `spawned` one whose `emulatorPid` is dead: remove the file.
  - `created` of a deleted root: remove the file, then `simctl delete`, where "not found" counts as success.
  - `created`: park, then `simctl shutdown`, where an already shut-down simulator counts as success. A reap skips the shutdown when its inventory listed `Shutdown`.
  - `spawned`: remove the file, then kill `emulatorPid` while it is alive and, where `ps` exists, its arguments name `-avd <avd>` and `-ports <port>,<port+1>`. Never the binary name: the `emulator` launcher execs `qemu-system-<arch>`, so the pid stays and the name does not.
  - `explicit`: expire the lease and keep the file, so the next `dev` reuses the named device; the device holds nothing of ours, and a reap finds the binding expired and leaves it. A deleted root removes the file.
  - `dotenv`: remove the file.
  - `started`: remove the file, then `stopEasSessionAsync(<the binding's projectRoot>, id)` with main's EAS stop timeout, or under the calling worktree's root when that root is deleted, because eas-cli reads the project and the account from the directory it runs in. A missing eas-cli or a failed stop is reported with the session id; the idle timeout or the session cap ends that session.
- Parsing. A foreign file with an unknown version, backend or origin is skipped. An own file that does not parse makes `acquire` refuse `unreadable` and read verbs report `unreadable`.
- Names. A created simulator is named `agent-cli <first 8 chars of the digest>`, so a leaked one shows whose it was. Names are never identity.
- `tools` is optional on every entry point and defaults to `defaultTools()`.

## Lease

- `LEASE_MS = 3_600_000` (60 min), `EXTEND_EVERY_MS = 300_000` (5 min).
- `extendLease(root, platform, backend, tools, { waitMs })` → `'extended' | 'lost'`, under the lock. A live lease is renewed. An expired or missing one is `lost`, and nothing is written.
- A lock not obtained in `waitMs` throws `DEVICE_REGISTRY_LOCKED` before any write.
- Read verbs extend with a 5 s wait through `useBoundDeviceAsync`: a lock timeout warns and goes on; `lost` (the file went missing or expired since the inspect) throws `gone`.
- `isStale(b, now)`: expired, or the root is deleted (Decision 6). `git worktree move` makes the old path stale at once.
- `withLeaseExtendedAsync(root, work)`: a 5 min `unref` timer around `work`, cleared when `work` ends. Every tick tries every one of the worktree's four candidate files that exists, so a cloud file that appears after Metro starts, and a parked file that `dev --detach` revived, are both picked up. A 5 s lock wait that fails skips the tick. The timer warns once per change from `extended` to `lost`. A tick never throws. Used by the Metro runner and around the step runner.

## Lock

- `withRegistryLockAsync(work, { waitMs })`: a temp dir inside the registry holding one marker `pid-<pid>-<nonce>` is renamed to `.lock`, so a lock never exists without a pid. A rename that fails with `EEXIST`, `ENOTEMPTY`, `EPERM` or `EACCES` means wait.
- A waiter polls every 100 ms. A dead pid's marker is unlinked, then `rmdir`; `ENOENT` or `ENOTEMPTY` means someone else won, retry. A `.lock` with no marker is `rmdir`'d. The owner gives the lock up with unlink, then `rmdir`, ignoring `ENOTEMPTY` and `ENOENT`. No nesting.
- Waits: `acquire` and release 30 s; read verbs and the timer 5 s. The refusal has reason `locked` and names the pid, the lock age from the marker's mtime and, where `ps` exists, the command.
- Under the lock: record reads and writes, the detached emulator spawn, and `simctl create` with a 20 s timeout; a timeout kills the child, gives the lock up and refuses `create-timeout`. Every other device call runs after the section.

## Choice (`choose.ts`, pure)

Inputs: the own binding and the other worktrees' bindings, each marked stale or not; the inventory, read before the lock; `explicit`; `reuseOnly`; `now`; on Android `busyPorts`, computed by `android.ts` in the same section: the running `emulator-NNNN` serials, the Android bindings whose lease is live, and every Android binding whose `emulatorPid` is alive, because a reap kills it only after the section. The free port is the first free even one in 5554..5584. `IosInventory` holds `SimulatorEntry[]` and `newestIosRuntime: { identifier, deviceType } | null`, the highest available iOS runtime that lists an iPhone and its first iPhone device type. `AndroidInventory` holds the first AVD of `emulator -list-avds` and `runningSerials`. Outputs:

```ts
| { kind: 'reuse'; binding }        // own binding, live or expired, device present (iOS: listed; Android spawned: emulatorPid alive; Android explicit: serial listed); also --device naming the own device
| { kind: 'ios-create'; runtime; deviceType; name }
| { kind: 'android-spawn'; port; avd }
| { kind: 'explicit'; device }
| { kind: 'refuse'; reason: 'no-ios-runtime' | 'no-avd' | 'no-free-port' | 'explicit-not-found' | 'explicit-bound' | 'own-explicit-over-owned' | 'not-reusable'; boundBy?: { id: string; root: string }[]; matches?: string[] }
```

- `--device` matches a simulator by name or udid, case-insensitive, and an emulator by serial only, because read-only instances share one AVD name. Two or more matches are `explicit-not-found` with `matches`. A device that another worktree's `created` or `spawned` binding names, live or stale, is `explicit-bound`, and so is one its live `explicit` binding names; an expired `explicit` binding of another worktree is removed in the section and the device is bound here, because a named device belongs to whoever names it now. A simulator named `agent-cli …` that no binding names is `explicit-not-found`, so a leaked create is never bound. `--device` naming another device while the own binding is `spawned` is `own-explicit-over-owned`, because one file per worktree and platform cannot hold both and a replaced instance would be orphaned. While the own binding is `created`, the own simulator's file is removed in the same section and the simulator is deleted with `simctl delete` after it, the `explicit` binding is written, and the delete is reported on stderr: the user named the device, so the replacement is what they asked for, and a parked binding would refuse forever. An own `explicit` binding is replaced.
- With `reuseOnly`, any choice but `reuse` is `not-reusable`.
- An own binding whose device is gone is removed under the lock and allocation goes on. `no-free-port` carries the serials and the worktrees they are bound to in `boundBy`. There is no cloud variant: the cloud path writes a binding and chooses nothing.

## Entry points

**`acquireDeviceAsync(root, platform, { explicit?, reuseOnly?, tools? }) → AcquireResult`**, throws `DEVICE_UNAVAILABLE` with `data.reason`. For `dev` and `smoke` in bootstrap mode; both skip it under `AGENT_CLI_NO_DEVICE`. Read the platform's inventory; a device tool that cannot run is main's `toolError`. Under the lock, in one section: read the bindings, choose, write, reap; a refusal is thrown after the reap, so a deleted worktree's device does not block a rerun, and the device actions of the section's let-go rules run in a `finally` before the throw, so a reaped emulator is never left running without a file. After the section: boot and verify on every choice, whatever the inventory said (iOS: `simctl bootstatus <udid> -b`, which boots only when the simulator is not `Booted` and then waits, because `simctl boot` on a `Booted` simulator exits non-zero; Android: `sys.boot_completed`), with `BOOT_DEVICE_TIMEOUT_MS` per platform. A failed boot lets go of the binding; a spawn whose binding was never written kills its child through its handle. The caller prints `action` as one line on stderr.

| Choice          | Write under the lock                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| `reuse`         | rewrite `boundAt` and `expiresAt`                                                        |
| `ios-create`    | `simctl create`, then write the real udid                                                |
| `android-spawn` | spawn detached, then write serial and pid, in that order (no pid: refuse `spawn-failed`) |
| `explicit`      | write the binding                                                                        |

**`acquireCloudBindingAsync(root, { platform, id, origin, tools? })`**: under the lock, writes or rewrites the own `cloud` binding (a reuse of the same id keeps `boundAt` and `origin`), then reaps the rows that need no inventory. The `origin` comes from the probe's reported source. Every session id a verb obtains is bound, a reuse of the bound id and a start that failed after it created the session included, so a later reap can stop that session.

**`inspectBindingAsync(root, platform, backend, tools?) → Inspection`**, lock-free, no extension, no network, one subprocess at most. iOS: one `simctl list devices -j` filtered by udid. Android: `get-state`, plus `isPidAlive` for `spawned`; a `get-state` whose stderr says the device is not found counts as not listed, and any other non-zero exit is `cause: tool`. Cloud: the binding alone. The device check uses the 20 s timeout; `status` uses its own probe deadline. The inspect cache is main's probe cache with the root added to its key; `acquire` and release clear it; the rung loop never uses it. `state` is the first row that matches:

| Condition                                                                                                      | `state`                     | Rung loop                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| no own file                                                                                                    | `none`                      | next rung                                                                                                                          |
| own file does not parse                                                                                        | `unreadable`                | refuse, exit 7                                                                                                                     |
| the device tool cannot run (`cause: tool`)                                                                     | `unknown`                   | with a platform flag: throw the tool error at once; without one: next rung, and after the EAS rung throw the first tool error seen |
| the device check timed out (`cause: timeout`)                                                                  | `unknown`                   | refuse, exit 22                                                                                                                    |
| cloud: lease live                                                                                              | `recorded`                  | the EAS rung decides                                                                                                               |
| lease expired                                                                                                  | `gone`, cause `expired`     | next rung                                                                                                                          |
| local, device up: iOS listed `Booted`; Android `get-state` is `device` and, for `spawned`, `emulatorPid` alive | `up`                        | wins                                                                                                                               |
| local, Android `spawned` with `emulatorPid` dead                                                               | `gone`, cause `device-gone` | next rung                                                                                                                          |
| local, device listed                                                                                           | `not-up`                    | refuse, exit 20                                                                                                                    |
| local, device not listed                                                                                       | `gone`, cause `device-gone` | next rung                                                                                                                          |

**`useBoundDeviceAsync(inspection, tools?) → BoundDevice`**: takes an `up` inspection, extends the lease per §Lease, and returns the device; `lost` throws `gone` with cause `expired` (exit 20). It never inspects again and never boots.

**`releaseWorktreeDevicesAsync(root, { platform?, sessionId? }) → ReleasedDevice[]`**, never reaps. Without `sessionId`: lets go of the local bindings, or only `platform`'s when given. With `sessionId`: removes the cloud binding that names that id, live or expired. Callers of the local release: `dev:stop --release`, after the server stop or when no server ran; smoke's cleanup. Callers of the `sessionId` release: every stop of a session this worktree bound, that is the foreground `dev --eas` exit, `dev:stop --eas` and `smoke --eas`, with no `--release` needed, because a stopped session leaves nothing to keep. The foreground `dev` exit and the detached child touch no local binding; the lease expires on its own.

## Readers

- Rung order. With a platform flag and no `--eas`: that platform's local binding. With no platform flag: both local platforms are inspected, iOS on macOS only, and any `up` wins; when both are `up`, the binding with the newer `boundAt` wins, so after `dev --android` on a worktree whose simulator is still up the agent drives the instance it just asked for. When no platform is `up`, the first state that is not `none`, in iOS, Android order, decides per the inspect table's last column: iOS `gone` and Android `not-up` is a refusal naming Android; iOS `gone` and Android `none` goes to the EAS rung. When every local rung passed, verbs that fall back to EAS (`navigate` and `smoke` in `fallback` mode) run the EAS rung; `runtime:stop` and `runtime:reload` do not. With `--eas` the local rungs are skipped. A tool error seen on any rung is thrown after the EAS rung; else the refusal reports the first non-`none` state seen, with its How line; with only `none` states it names the platform of the flag, else iOS on macOS and Android elsewhere. The loop is `findBoundDeviceAsync(root, { platform?, eas?, extend })` in `rungs.ts`. It calls `inspectBindingAsync` per platform, fresh, and with `extend` calls `useBoundDeviceAsync` once, on the winner. `resolveDeviceAsync` calls it with `extend: true` and sets `adb: resolveAdb()` on a `local-android` winner, so `openRoute`'s `adb reverse` still runs.
- The installed readers (`src/installedApp/`) call `findBoundDeviceAsync` once per platform with `extend: false`, because `status` never writes.
- The EAS rung is one probe call: `probeCloudSessionAsync({ boundIds })`. `ownCloudIdsAsync(root)` returns the ids of the own `cloud` bindings whose state is `recorded`; every probe caller uses it. When the selected id is an own binding's, the verb extends it per §Lease. When the listing shows a bound id as queued, the rung refuses `not-up` ("the bound session is still queued", How line: run the command again in a minute). When the listing shows it in no live state, the rung refuses `gone` with cause `device-gone` and writes nothing (Contract 1); its How line is the `dev` command with `--eas`, which on a running server opens a session through `openAppEas` and rewrites the binding ([[0034-eas-session-binding]]). Until PR 5 the fallback without `--eas` accepts the dotenv id only, never the newest session, so a worktree with no binding does not drive another worktree's session; with `--eas` main's choice stays until PR 5.
- `probeLocalDeviceAsync({ projectRoot, ... })` maps the states of both platforms, with its cache keyed by root: any `up` is `present`; else any `unreadable` or `unknown` is main's `unknown`; else `absent`, with the first state seen as the reason. `status`, the start follow-ups and dev-wait fold it into their suggestion ladders.

## Reap

Runs inside `acquireDeviceAsync`, `acquireCloudBindingAsync` and `dev:stop`, for stale bindings of other worktrees. It reads the bindings after the section's own write. A caller acts only on the rows its inventory can decide: `acquireDeviceAsync` has its platform's inventory; `acquireCloudBindingAsync` and `dev:stop` have none and take only the rows that need nothing. First match, in the order of §Records:

| Stale binding                                        | Needs                                                                 | Action                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| local, device not listed (iOS) or `emulatorPid` dead | iOS inventory for `created` and `explicit` iOS, nothing for `spawned` | remove the file                                                           |
| `created`, root deleted                              | nothing (macOS)                                                       | remove the file, then `simctl delete`                                     |
| `created`                                            | iOS inventory                                                         | park, then `simctl shutdown` unless listed `Shutdown`                     |
| `spawned`                                            | nothing                                                               | remove the file, then kill `emulatorPid`                                  |
| `explicit`, root deleted                             | nothing                                                               | remove the file                                                           |
| `explicit`                                           | nothing                                                               | nothing; a stale `explicit` binding is already expired and keeps its file |
| `cloud` `started`, `boundAt` past the session cap    | nothing                                                               | remove the file                                                           |
| `cloud` `started`                                    | nothing                                                               | remove the file, then stop the session                                    |
| `cloud` `dotenv`                                     | nothing                                                               | remove the file                                                           |

Each reaped device is reported on stderr and in JSON with reason `expired`, `deleted-worktree`, `device-gone` or `session-cap`.

## Output and errors

- `dev:stop --release` JSON gains an optional `devices: ReleasedDevice[]`; a plain `dev:stop` reports the kept bindings under the same key with `released: false`. `status --json` gains `binding: { platform, backend, id, name, origin, state, expiresAt }[]`, one entry per file of the worktree, cloud bindings unprobed. `status`'s next action is `dev --<platform>` when there is no binding.
- Events: `cli:device_binding_reaped { reason }` and `cli:device_registry_lock_removed { lock, pid }` from `src/deviceBinding/`; `dev:stop_session` gains `platform`; `dev:open_app_eas_flag_unsupported { flag }` from `openAppEas`.
- A `DEVICE_UNAVAILABLE`, `DEVICE_REGISTRY_LOCKED` or `NO_BOUND_DEVICE` error the detached child raises reaches the agent unchanged, code, exit and How line, through the child verdict; today every child failure that is not needs-human is `DEV_DETACH_DIED`, whose How line reruns the same command.
- Exit codes per [[0010-agent-conventions]], one How line each. The `dev` command is `<cli> dev --<platform> --detach --wait-ready`. Main's `NO_DEVICE` and `NO_IOS_DEVICE` become `NO_BOUND_DEVICE` in 3a, `NO_ANDROID_DEVICE` in 3b.

| Code                     | Reason                    | Exit | What                                                                                               | How                                                                                  |
| ------------------------ | ------------------------- | ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `NO_BOUND_DEVICE`        | `none`                    | 20   | "No <platform> device is bound to this worktree"                                                   | the `dev` command                                                                    |
| `NO_BOUND_DEVICE`        | `gone`                    | 20   | "the lease expired" or "the device is gone"                                                        | the `dev` command                                                                    |
| `NO_BOUND_DEVICE`        | `not-up`                  | 20   | "the bound device is not up"                                                                       | the `dev` command                                                                    |
| `NO_BOUND_DEVICE`        | `unknown` (timeout)       | 22   | "the device check timed out"                                                                       | run the command again                                                                |
| `NO_BOUND_DEVICE`        | `unreadable`              | 7    | "the binding file <path> does not parse; a newer CLI may have written it"                          | `rm -f '<path>'`                                                                     |
| `DEVICE_UNAVAILABLE`     | `unreadable`              | 7    | the same                                                                                           | `rm -f '<path>'`                                                                     |
| `DEVICE_UNAVAILABLE`     | `no-ios-runtime`          | 7    | "no iOS runtime with an iPhone is installed"                                                       | `xcodebuild -downloadPlatform iOS`                                                   |
| `DEVICE_UNAVAILABLE`     | `no-avd`                  | 7    | "no Android virtual device exists"                                                                 | create one in Android Studio                                                         |
| `DEVICE_UNAVAILABLE`     | `no-free-port`            | 20   | the serials and the worktrees they are bound to; a serial no binding names is listed as "not ours" | `<cli> dev:stop --release` in a listed worktree, or stop the unlisted serial by hand |
| `DEVICE_UNAVAILABLE`     | `explicit-bound`          | 20   | "<name> is bound to the worktree <root>"                                                           | `<cli> dev` without `--device`                                                       |
| `DEVICE_UNAVAILABLE`     | `explicit-not-found`      | 1    | "no device matches <query>, or more than one does" with `matches`                                  | `<cli> status --json`                                                                |
| `DEVICE_UNAVAILABLE`     | `own-explicit-over-owned` | 1    | "this worktree runs the emulator instance <serial>"                                                | `<cli> dev:stop --release`                                                           |
| `DEVICE_UNAVAILABLE`     | `not-reusable`            | 20   | "a dev server is running and this worktree has no <platform> device to reuse"                      | `<cli> dev:stop`                                                                     |
| `DEVICE_UNAVAILABLE`     | `create-timeout`          | 22   | "the device tool did not answer in time"                                                           | run the command again                                                                |
| `DEVICE_UNAVAILABLE`     | `spawn-failed`            | 22   | the spawn error                                                                                    | run the command again                                                                |
| `DEVICE_UNAVAILABLE`     | `boot-failed`             | 20   | the boot's reason; the binding is let go of first                                                  | run the command again                                                                |
| `DEVICE_REGISTRY_LOCKED` | `locked`                  | 22   | "pid N (<command>) has held the device registry for <age>"                                         | run the command again, or `kill <pid>` when it repeats                               |

- The agent guide (`src/agents/content.ts`) gains a `## Devices` heading with two sentences. One: run `dev` before `navigate`, `runtime:reload` or `runtime:stop`, or they refuse with `NO_BOUND_DEVICE` and name the command. Two: never boot, shut down or delete a simulator named `agent-cli …` yourself; it may be bound to another worktree.

## EAS

- `probeCloudSessionAsync` calls the pure `selectCloudSession`, which takes `boundIds`. A session is a candidate only when the service lists it as queued or in progress and its id is in `boundIds`, is the dotenv id, or carries the tag `agent-cli:<digest>`; a queued bound session is reported as such, never replaced by a new start. Unbound in-progress sessions come back as `unbound` for the report. The probe reports which source the selected id came from.
- The session start passes `--max-idle-time-minutes 30` (PR 5) and `--tag agent-cli:<digest>` (PR 6). When the start exits non-zero with oclif's "Nonexistent flag" on stderr and no session id was read, it retries once without the flag that was refused. A session found by tag is recorded as `started`. The idle timeout ships with the bound-only selection, because a start that an agent's tool timeout kills before it returns an id leaves a session with no binding, which the bound-only probe never reuses.
- `dev:stop --eas` stops the probe's session, bound or dotenv, and then each other `cloud` binding's session of this worktree, and removes each stopped session's binding with the `sessionId` release; it needs no `--release`. A plain `dev:stop` keeps `cloud` bindings and reports each as recorded, not checked.

## Not built

The agent's pid in the binding; a take of another worktree's simulator; a cap on parked simulators; allocation from "any free booted device"; `peek` mode; capacity from cpus and RAM; mtime touch, lock token and heartbeat; a `pool.json`, a create marker, adopt-by-name; a lock-free write path; a `busy` lease result; a `StartPlan.device` or `dev --json` device field; dev-lock socket liveness; a writable first emulator; `emu kill` by serial; `--device` on `navigate`; a "still booting" inspect state; a stop of the old session on a cloud id change.

## Answers from the EAS code

Read on 2026-10-01 in the local clones of `eas-cli` (24.7.0) and `universe` (`server/www/src/data/entities/device-run-session/`). The service calls a session a `DeviceRunSession`.

1. **Owner mark: the service has one.** `eas simulator` accepts `--name` and `--tag` (repeatable, stored lowercased). Both come back in `simulator:list --json`, and the list filters by `--tag` (a session must carry every listed tag). No field carries a client identity. So the mark is a convention this CLI sets. `--tag` is in eas-cli since v23.2.0 (PR #4318). [read — eas-cli history, 2026-10-05]
2. **Expiry: opt-in.** `maxIdleTimeMinutes` stops a session after that many idle minutes; omitted, there is no idle timeout. `maxRunTimeMinutes` is capped at 40 minutes for normal-priority accounts and 115 for high-priority ones. `--max-idle-time-minutes` is in eas-cli since v22.5.0.
3. **Concurrency: no hard limit.** Sessions queue behind the plan's job concurrency; parallel agents wait, they do not fail.

At eas-cli 24.7.0 a `--json` start still writes the session id to `.env.eas-simulator` once the session is ready.

## Risks

Each accepted race costs one rerun of `dev`, never a lost build or a touched human device.

1. `-read-only` with `adb reverse` and install, "an emulator on a taken port exits non-zero", and the cold boot time are unverified here. The [[0032-android-instance]] live gate runs before 3a to 4 merge.
2. A pid reused by an unrelated long-lived process keeps the registry lock until a human reads the message; a reused emulator pid is never killed where `ps` exists, and on a platform without `ps` the kill can hit the wrong process. Needs pid wrap-around during days of uptime.
3. eas-cli skew: a project pinned under 23.2 refuses `--tag` on the start; [[0034-eas-session-binding]] tests the fallback.
4. The idle-timeout semantics on the service are unread; 30 min may stop a session during a long pause.
5. A crash or a 20 s timeout during `simctl create` leaks one `Shutdown` simulator named `agent-cli <first 8 chars>`, and a retry creates a second; nothing adopts or deletes them. Main measured a cold `simctl list` at 2.6 s, so `status`'s 2.5 s probe deadline can report `unknown` on a cold machine.
6. In bootstrap mode, `smoke` on a development-build project compiles onto the worktree's simulator instead of a simulator that already has the app.
7. A cloud binding can outlive its session while this worktree's Metro runs. After a plain `dev:stop`, the binding expires in 60 min unless `navigate --eas` renews it; the next reap of another worktree then stops a `started` session. A `started` session that a rewrite to a new id left behind has no binding and ends by the idle timeout or the session cap. A session of another EAS account cannot be stopped from this machine.
8. An `explicit` Android serial that a different emulator takes over after ours exits reads as `up`; Contract 7 keeps it unharmed. An instance answers `get-state` `device` before `sys.boot_completed`, so a read verb can reach it a few seconds early.
9. `dev:stop --release` during a build step of the same worktree finds no server and releases the device the step uses, so the simulator shuts down under the build and the build fails. The next verb reports `gone` and the agent reruns `dev`, which reuses the device. A plain `dev:stop` keeps the device, so an emulator instance holds its RAM for up to 60 min after a stop.
10. A deleted root's booted simulator stays up until the next reap anywhere, which deletes it. The simulator a `dev` exit or a plain `dev:stop` leaves `Booted` stays up until its lease expires and a reap with an iOS inventory parks it, or `dev:stop --release` runs. After `git worktree move`, the next reap deletes the old path's simulator while its Metro may still run; `dev` at the new path creates a new one.
11. `not-reusable` after `dev --android --detach` then `dev --ios --detach`, or after a server that `start` runs, tells the agent to stop its own server; both belong to the same worktree.
12. Shutdowns run after the section, so a release or a reap can shut down a simulator that a later section reused in the same seconds; that `dev` fails its boot or install and is rerun. A sleep over 60 min with a server that `start` runs loses the device, and the next `dev --detach` rebinds it.
13. Without a cap, one parked simulator per living worktree stays on disk, each with its installed build. `git worktree remove` reclaims it on the next reap.
14. A worktree created at a deleted worktree's path has the same digest and inherits its bindings, devices and cloud session, with the old build installed; the fingerprint decides whether that build is current, as after a branch switch. The bindings of an unmounted volume are stale, so its simulator is deleted and its emulator killed; a rebuild on the next `dev` is the cost.

## Open questions

1. Where does the idle check run on the service, and what counts as activity?
2. Should `--device <session-id>` with `--eas`, refused as `BAD_ARGS` today, bind an in-progress session that another tool started outside this worktree?

## Delivery

Seven PRs, stacked with `gh stack`, rebased never merged, one question per PR; 3a, 3b and 4 merge as one unit. Each later PR updates the section of this RFC it implements and carries its CHANGELOG entry. Prerequisite outside the stack: `apps/eas-example` moves to SDK 58 in its own PR, because `@expo/cli` 57 matches `run:android --device` by name only and the 3b live gate needs the serial.

| #   | Question                                                                                       | Plan                         |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | Which Metro is mine? Discovery verifies the project root.                                      | below                        |
| 2   | Prep, no behavior change.                                                                      | below                        |
| 3a  | How does a worktree get an iOS simulator nobody else has, and how do the other verbs find it?  | [[0031-ios-binding]]         |
| 3b  | The same question, on Android.                                                                 | [[0032-android-instance]]    |
| 4   | What happens when a worktree stops, pauses or disappears, and how does a person pick a device? | [[0033-device-lifecycle]]    |
| 5   | An EAS session belongs to the worktree that started it.                                        | [[0034-eas-session-binding]] |
| 6   | How does a session survive a lost registry?                                                    | [[0034-eas-session-binding]] |

**PR 1.** Cherry-pick 94a6890, f6262e1, 80ccfb1 and 7e88e97 from the rejected branch. One conflict: the branch's `llp/0028-one-device-per-agent` file, which main lacks; delete it. One project-root predicate over the `/status` header's reported root serves the port scan, the dev lock's step 0 and the dev-lock port check; `/status` is retried only for the logged and default ports; the Discovery section goes into [[0004-smart-start-and-project-state]]. About 350 source lines. Leaves: a foreign Metro on 8081 is skipped and named in `status`. Independently mergeable.

**PR 2.** Export `digestOf` from `src/devLock/address.ts`; add `Runner`; move `parseBootedIosSimulators`, `listBootedIosSimulatorsAsync`, `parseSimulators` and `SimulatorEntry` to `src/device/simulators.ts`; `parseAndroidDevices` and `AndroidDeviceLine` to `src/device/adb.ts`; `stopEasSessionAsync` with `buildSessionStopArgs` and its timeout to `src/device/eas.ts`; `openAppEas.ts`'s `firstLine` to `src/utils/text.ts`; retarget the lazy requires in `dev/devAsync.ts`, `dev/stopAsync.ts` and `smoke/smokeAsync.ts`. The e2e `installStubXcrunAsync` of `installedAppStubs.ts` replaces the private copies in `navigate-test.ts`, `stop-test.ts` and `runtime-reload-test.ts`, and gains a `simulators` option, `list runtimes -j`, `create` (udids `E2E-CREATED-<n>` from a counter file, listed `Shutdown`), `delete`, `boot`, `bootstatus` (`-b` sets `Booted`), `openurl` and `shutdown`; `spawnAgentCli` gains a per-project `__UNSAFE_EXPO_HOME_DIRECTORY` default at `<fixture dir>.expo-home`. About 200 source lines. Leaves: the unit and e2e suites pass as before. Independently mergeable.

Verification shared by every PR: typecheck, lint, the module's unit tests, and the e2e files it touches (e2e after `bun run build` with `EXPO_E2E_TEMP_DIR` set; device tests with `AGENT_CLI_NO_DEVICE=0`; iOS cases `skipIf` off macOS, Android device cases skipped on win32). E2E fixtures: two fixture worktrees, one stub `xcrun`/`adb`/`emulator`/`eas`, one shared Expo home. Tests that pin a decision are named in each plan; the rest live in the PR descriptions.
