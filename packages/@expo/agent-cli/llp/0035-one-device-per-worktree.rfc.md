# 0035: One device per worktree

**Type:** RFC
**Status:** Draft
**Systems:** device binding (new `src/deviceBinding/`); local device selection and boot (`src/device/bootDevice.ts`, `src/navigate/device.ts`, `src/installedApp/`); the `dev` resolver and run (`src/dev/resolveOptions.ts`, `src/dev/devAsync.ts`, `src/dev/detachAsync.ts`, `src/dev/index.ts`); the app-presence probe (`src/device/appPresence.ts`); the local open (`src/dev/openApp.ts`); `installDevBuild` and `askDeviceAsync`; `dev:stop` and its `--release` flag (`src/dev/stopAsync.ts`, `src/dev/resolveStopOptions.ts`); `smoke`'s device phases and cleanup (`src/smoke/smokeAsync.ts`); the Metro runner (`src/start/startAsync.ts`); `status --json`; EAS session selection (`src/device/cloudSimulator.ts`), the EAS open (`src/dev/openAppEas.ts`), dev-wait and `dev:stop --eas`; the dev-server lock (`src/devLock/`); the e2e stubs `adb`, `emulator` and `eas`; the live tier (`e2e-live/`, `live-cloud`)
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-10-08
**Related:** [[0004-smart-start-and-project-state]], [[0005-runtime-loop-tools]], [[0010-agent-conventions]] (exit codes), [[0021-honest-reports]], [[0026-dev-owns-the-open]], [[0027-everything-on-eas]] §Testing, [[0025-dev-requires-platform]], [[0022-live-tier]]

## Summary

Developers run several agents on one Expo app in parallel, one agent per git worktree. Today the agents collide on devices:

- Every verb uses the first booted simulator or the first `adb` device. All agents drive one device, and each agent replaces the app of the others.
- When no device is booted, each agent boots one. Nothing records which device belongs to which agent.
- The emulator always boots on ports 5554 and 5555. A second concurrent boot collides.
- `dev --eas` reuses the newest in-progress session of the platform, which another worktree or a CI job may own. [[0027-everything-on-eas]] §Testing observed this live.

Decision [confirmed — Vojtech, 2026-09-30]: **each worktree gets its own device on each platform.** The device is a simulator this CLI created, an emulator instance this CLI spawned, a device the user named, or an EAS session this worktree started. A **binding** records it. Every verb of that worktree uses the bound device and never "the first booted" one.

A first implementation on the branch `feat/one-device-per-platform` adopted any free booted device. It worked, and it was rejected for size: a 942-line module, a full device inventory on every verb, and liveness from two sources. This RFC owns its devices instead, which removes device classification, adoption and takeover. The model follows `appandflow/stim`, which solves the same problem for agents in worktrees.

This RFC holds the rules, once each. The four sections after §Verification hold the wiring, acceptance criteria and tests for iOS binding, Android instances, device lifecycle and EAS session binding.

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
- **Session cap**: an EAS session lives at most 40 min on the service for a normal-priority account and 115 min for a high-priority one (§Answers from the EAS code, item 2).
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
4. **Only `dev`, with `openAppEas` and dev-wait, and `smoke` allocate. Every other verb reads the binding**, with one device-tool subprocess per binding and no network call before the EAS rung.
   **Why.** The agent's hottest verb must not pay for the rarest decision. `dev` is where the agent's loop starts ([[0026-dev-owns-the-open]]); `smoke` brings its own device ([[0005-runtime-loop-tools]]).
5. **A parked simulator is an expired `created` binding, not a second record.** A living worktree keeps its parked simulator and gets it back on the next `dev`. A deleted worktree's simulator is deleted by the next reap.
   **Why.** One record type cannot disagree with itself. The worktree that paid for the native build keeps it. Disk is reclaimed when the worktree goes, with no count and no cap. Nothing takes another worktree's simulator: a `simctl create` is cheap, and the app on a foreign simulator is a foreign build anyway.
6. **A deleted worktree's bindings are stale at once.** Deleted means `lstat` of the root fails with `ENOENT`.
   **Why.** A deleted worktree's simulator should not hold RAM for 60 min. A parent check cannot tell a removed monorepo worktree from an unmounted volume, so there is none; an unmounted volume loses its devices (Risk 14).
7. **Every registry write runs under one machine-wide lock, with tmp+rename. The lock also covers `simctl create` and the emulator spawn, and nothing else that touches a device.**
   **Why.** A create or spawn under the lock ties the new device to the binding that names it in one section, so two `dev` runs in one worktree never make two devices. Every other device call runs after the section, so a read verb never waits on a boot or a shutdown. The races that leaves are in §Risks and each costs one rerun of `dev`.
8. **Device allocation requires binding-aware readers, lease renewal, release, smoke cleanup and stale-binding reaping.**
   **Why.** A device that `dev` creates must have a cleanup path. Every reader must use the binding so it drives the same device that `dev` prepared.
9. **`dev:stop` keeps the worktree's devices; `dev:stop --release` lets go of them now.**
   **Why.** The CLI's own restart follow-up is `dev:stop && dev --detach`, and a read-only emulator instance that is killed costs a cold boot and a reinstall on the next `dev`. The lease reclaims a stopped worktree's device within 60 min anyway (Decision 3), so a release on every stop buys little. The cost is RAM held for up to an hour after a stop; `--release` is for the agent that is done.
10. **Decided, not open.** `start --ios` keeps Expo CLI's device choice, because `dev` is the verb that binds. `dev --no-open` still binds, and may create, a simulator the user never sees, because the build step must be pinned. Local devices come before an EAS session, because a session bills by the minute. `status` calls the network on every run ([[0011-impact-and-freshness]]).

## Invariant

A created simulator boots, shuts down or is deleted, and a spawned emulator is killed, only after a section that wrote or removed its binding for that action. A child whose binding was never written is killed through its own process handle. The inventory is read before the lock and may be seconds stale; acquisition records the binding identity before reading it, then revalidates that identity under the lock before choosing a device. A changed identity leaves the registry untouched and retries with a new inventory outside the lock. Identity is absent or `(backend, device id)`; lease timestamps and names do not invalidate a snapshot. There are three attempts total (the initial snapshot and two refreshes), each retaining the existing inventory and lock timeouts. Exhaustion refuses `DEVICE_UNAVAILABLE` reason `binding-changed`, exit 22, and asks for a rerun.

## Contracts every verb honors

1. Only `acquireDeviceAsync` and `acquireCloudBindingAsync` write a device into a binding, and only `dev` (including `openAppEas` and dev-wait) and `smoke` call them. A read verb changes only `expiresAt`.
2. Read verbs call `inspectBindingAsync`, then `useBoundDeviceAsync` when they drive the device, and never list devices to choose one.
3. No code outside `src/deviceBinding/` runs `simctl list devices` or `adb devices` to select a device. The one exception is `status --device`, which lists to filter and binds nothing.
4. Every binding write runs under the lock.
5. A `created` simulator is never deleted while a binding names it. A simulator no binding names is never touched.
6. A recorded emulator pid is killed only after its file is removed. Never `emu kill` by serial.
7. `explicit` devices are booted at most, never shut down or deleted.
8. Every process that runs Metro or a build step on a bound device extends the lease, and on `lost` it writes nothing for that binding.
9. The EAS probe considers only sessions this worktree bound and its dotenv id.
10. `src/deviceBinding/` imports nothing from `navigate`, `smoke`, `dev` or `installedApp`; a unit test enforces it.

Files and budgets: `types.ts`, `registry.ts` (read, write, lock), `lease.ts`, `choose.ts` (pure), `inspect.ts` (the inspect table, the cache, `useBoundDeviceAsync`, `extendBoundLeaseAsync`), `rungs.ts` (`findBoundDeviceAsync`, the rung loop of §Readers), `ios.ts` (the `simctl` calls), `errors.ts`, `events.ts`, `tools.ts` (`defaultTools`), `index.ts` (`acquireDeviceAsync`, `releaseWorktreeDevicesAsync`, re-exports); `reap.ts`, `android.ts`, `cloud.ts` (with `readCloudBindings`, `live` and `claimable`), `cloudRung.ts` and the other files are named by the section that adds them. Every file under 250 lines, no function over 60, the iOS and Android boots in their own functions.

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
  spawnEmulator(args: string[]): {
    pid?: number;
    exited: Promise<number | null>;
    kill(): void;
    lastOutput(): string;
  };
  now: () => Date;
  isPidAlive: (pid: number) => boolean;
  commandOf: (pid: number) => string | null; // '' when `ps` lists none, null where `ps` does not exist
  kill: (pid: number) => void;
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

- Origins. `created`: the CLI may shut down, park and delete. `spawned`: the CLI may kill the emulator it spawned. `explicit`: boot at most. `cloud` `started`: this CLI started the session, and may stop it; `dotenv`: adopted from `.env.eas-simulator`; a reap never stops it, `dev:stop --eas` does.
- Let go, one rule per origin, first match. The file action runs under the lock, the device action after it. A reap's `delete` or `kill` that fails writes the binding back under the lock, unless another binding took its file, so the next reap tries again.
  - A local binding whose device the inventory does not list or lists as unavailable (its runtime was removed), or a `spawned` one whose `emulatorPid` is dead: remove the file.
  - `created` of a deleted root: remove the file, then `simctl delete`, where "not found" counts as success.
  - `created`: park, then `simctl shutdown`, where an already shut-down simulator counts as success. A reap skips the shutdown when its inventory listed `Shutdown`.
  - `spawned`: remove the file, then kill `emulatorPid` while the instance check holds: it is alive and, where `ps` exists, its arguments name `-avd <avd>` and `-ports <port>,<port+1>`. Never the binary name: the `emulator` launcher execs `qemu-system-<arch>`, so the pid stays and the name does not. When the check fails, the instance has already exited, so nothing is signalled and a reap reports it `device-gone`. A kill that throws while the pid is alive writes the binding back with an expired lease.
  - `explicit`: expire the lease and keep the file, so the next `dev` reuses the named device; the device holds nothing of ours, and a reap finds the binding expired and leaves it. A deleted root removes the file. Release does not ask `adb` about an `explicit` Android serial, because `adb` does not list a phone that is off or an emulator that is stopped.
  - `dotenv`: remove the file.
  - `started`: remove the file, then `stopEasSessionAsync(<the binding's projectRoot>, id)` with main's EAS stop timeout, or under the calling worktree's root when that root is deleted, because eas-cli reads the project and the account from the directory it runs in. A missing eas-cli or a failed stop is reported with the session id; the idle timeout or the session cap ends that session.
- Parsing. A foreign file with an unknown version, backend or origin is skipped. An own file that does not parse makes `acquire` refuse `unreadable` and read verbs report `unreadable`.
- Names. A created simulator is named `agent-cli <first 8 chars of the digest>`, so a leaked one shows whose it was. Names are never identity.
- `tools` is optional on every entry point and defaults to `defaultTools()`.

## Lease

- `LEASE_MS = 3_600_000` (60 min), `EXTEND_EVERY_MS = 300_000` (5 min).
- `extendLease(root, platform, backend, tools, { waitMs, deviceId? })` → `'extended' | 'lost'`, under the lock. A live lease is renewed. An expired or missing one, or, with `deviceId`, one whose file names another device, is `lost`, and nothing is written.
- A lock not obtained in `waitMs` throws `DEVICE_REGISTRY_LOCKED` before any write.
- Read verbs extend with a 5 s wait through `useBoundDeviceAsync`: a lock timeout warns and goes on; `lost` (the file went missing, expired, or names another device since the inspect) throws `gone`.
- `isStale(b, now)`: expired, or the root is deleted (Decision 6). `git worktree move` makes the old path stale at once.
- `withLeaseExtendedAsync(root, work)`: a 5 min `unref` timer around `work`, cleared when `work` ends. Every tick tries every one of the worktree's four candidate files that exists, so a cloud file that appears after Metro starts, and a parked file that `dev --detach` revived, are both picked up. A 5 s lock wait that fails skips the tick. The timer warns once per change from `extended` to `lost`, naming the `dev` command of §Output and errors, with `--eas` for a `cloud` file. A tick never throws. Used by the Metro runner and around the step runner.

## Lock

- `withRegistryLockAsync(work, { waitMs })`: a temp dir inside the registry holding one marker `pid-<pid>-<nonce>` is renamed to `.lock`, so a lock never exists without a pid. A rename that fails with `EEXIST`, `ENOTEMPTY`, `EPERM` or `EACCES` means wait.
- A waiter polls every 100 ms. A dead pid's marker is unlinked, then `rmdir`; `ENOENT` or `ENOTEMPTY` means someone else won, retry. A `.lock` with no marker is `rmdir`'d. The owner gives the lock up with unlink, then `rmdir`, ignoring `ENOTEMPTY` and `ENOENT`. No nesting.
- Waits: `acquire` and release 30 s; read verbs and the timer 5 s. The refusal has reason `locked` and names the pid, the lock age from the marker's mtime and, where `ps` exists, the command.
- Under the lock: record reads and writes, the detached emulator spawn, and `simctl create` with a 20 s timeout; a timeout kills the child, gives the lock up and refuses `create-timeout`. Every other device call runs after the section.

## Choice (`choose.ts`, pure)

Inputs: the own binding and the other worktrees' bindings, each marked stale or not; the inventory, read before the lock; `explicit`; `reuseOnly`; `now`; on Android `busyPorts`, computed by `android.ts` in the same section: the running `emulator-NNNN` serials, the Android bindings whose lease is live, and every Android binding whose `emulatorPid` is alive, because a reap kills it only after the section. The free port is the first free even one in 5554..5584. `IosInventory` holds `SimulatorEntry[]` and `newestIosRuntime: { identifier, deviceType } | null`: the newest available iOS runtime that lists a mainstream iPhone, with its highest-numbered `iPhone <n> Pro`, else `iPhone <n>`, else `iPhone <n> Pro Max`, whatever order `simctl` lists them in, because the newest runtime can list only a device no app renders on (iOS 27.1 lists iPhone Duo alone); only when no runtime has one does the newest runtime's first iPhone type apply. `AndroidInventory` holds the first AVD of `emulator -list-avds`, `runningSerials`, and the listed serials that are not ready, with their state. With `--device`, Android reads only `adb devices -l`: a USB device needs no emulator package. Outputs:

```ts
| { kind: 'reuse'; binding }        // own binding, live or expired, device present (iOS: listed and available; Android spawned: the instance check; Android explicit: serial listed); also --device naming the own device
| { kind: 'ios-create'; runtime; deviceType; name }
| { kind: 'android-spawn'; port; avd }
| { kind: 'explicit'; device }
| { kind: 'refuse'; reason: 'no-ios-runtime' | 'no-avd' | 'no-free-port' | 'explicit-not-found' | 'explicit-not-ready' | 'explicit-bound' | 'own-explicit-over-owned' | 'not-reusable'; boundBy?: { id: string; root: string }[]; matches?: string[] }
```

- `--device` matches a simulator by name or udid, case-insensitive, and an emulator by serial only, because read-only instances share one AVD name. Two or more matches are `explicit-not-found` with `matches`. A serial `adb` lists in a state other than `device`, such as `offline` or `unauthorized`, that no candidate matches is `explicit-not-ready`, not `explicit-not-found`. A device that another worktree's `created` or `spawned` binding names, live or stale, is `explicit-bound`, and so is one its live `explicit` binding names; an expired `explicit` binding of another worktree is removed in the section and the device is bound here, because a named device belongs to whoever names it now. A simulator named `agent-cli …` that no binding names is `explicit-not-found`, so a leaked create is never bound. `--device` naming another device while the own binding is `spawned` and the instance check holds is `own-explicit-over-owned`, because one file per worktree and platform cannot hold both and a replaced instance would be orphaned; an own `spawned` binding that fails the instance check counts as gone, and the `explicit` binding replaces its file. While the own binding is `created`, the own simulator's file is removed in the same section and the simulator is deleted with `simctl delete` after it, the `explicit` binding is written, and the delete is reported on stderr: the user named the device, so the replacement is what they asked for, and a parked binding would refuse forever. An own `explicit` binding is replaced.
- With `reuseOnly`, any choice but `reuse` is `not-reusable`.
- An own binding whose device is gone is removed under the lock and allocation goes on. `no-free-port` carries the serials and the worktrees they are bound to in `boundBy`. There is no cloud variant: the cloud path writes a binding and chooses nothing.

## Entry points

**`acquireDeviceAsync(root, platform, { explicit?, reuseOnly?, tools? }) → AcquireResult`**, throws `DEVICE_UNAVAILABLE` with `data.reason`. For `dev` and `smoke` in bootstrap mode; both skip it under `AGENT_CLI_NO_DEVICE`, and `dev` skips it on a host that cannot run the platform's local device (iOS off macOS), where the run serves for a device elsewhere and binds nothing, as on main. Read the platform's inventory; a device tool that cannot run is main's `toolError`, and one that does not answer within the 20 s timeout refuses `create-timeout`, the reason `simctl create` shares. Under the lock, in one section: read the bindings, choose, write, reap; a refusal is thrown after the reap, so a deleted worktree's device does not block a rerun, and the device actions of the section's let-go rules run in a `finally` before the throw, so a reaped emulator is never left running without a file. After the section: boot and verify on every choice, whatever the inventory said (iOS: `simctl bootstatus <udid> -b`, which boots only when the simulator is not `Booted` and then waits, because `simctl boot` on a `Booted` simulator exits non-zero; Android: `sys.boot_completed`), with `BOOT_DEVICE_TIMEOUT_MS` per platform. A failed boot lets go of the binding; a spawn whose binding was never written kills its child through its handle. The caller prints `action` as one line on stderr.

| Choice          | Write under the lock                                                                     |
| --------------- | ---------------------------------------------------------------------------------------- |
| `reuse`         | rewrite `boundAt` and `expiresAt`                                                        |
| `ios-create`    | `simctl create`, then write the real udid                                                |
| `android-spawn` | spawn detached, then write serial and pid, in that order (no pid: refuse `spawn-failed`) |
| `explicit`      | write the binding                                                                        |

**`acquireCloudBindingAsync(root, { platform, id, origin, start?, tools? })`**: under the lock, writes or rewrites the own `cloud` binding (a reuse of the same id keeps `boundAt` and `origin`), then reaps the rows that need no inventory. `origin` is `started` for a session this run started, else `dotenv`. Every session id a verb obtains is bound, a reuse of the bound id and a start that failed after it created the session included, so a later reap can stop that session. `dev --eas` refuses an unreadable binding file before it starts a session. A start passes the time it began. If the file holds a different session bound after that time, two starts ran at once in this worktree. Only the session that `.env.eas-simulator` names can be driven (§Session guard), so the bind keeps that session and stops the other one: the replaced `started` session, or its own. A run that stops its own session reports failure and names the session that stays.

**`inspectBindingAsync(root, platform, backend, tools?) → Inspection`**, lock-free, no extension, no network, one device-tool subprocess at most. iOS: one `simctl list devices -j` filtered by udid. Android: `get-state`, plus the instance check for a listed `spawned` binding; a `get-state` whose stderr says the device is not found counts as not listed, one that says offline, unauthorized or still authorizing counts as listed and not up, and any other non-zero exit is `cause: tool`. Cloud: the binding alone. The device check uses the 20 s timeout; `status` uses its own probe deadline. The inspect cache is main's probe cache with the root added to its key; `acquire` and release clear it; the rung loop never uses it. `state` is the first row that matches:

| Condition                                                                                                           | `state`                     | Rung loop                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| no own file                                                                                                         | `none`                      | next rung                                                                                                                          |
| own file does not parse                                                                                             | `unreadable`                | refuse, exit 7                                                                                                                     |
| the device tool cannot run (`cause: tool`)                                                                          | `unknown`                   | with a platform flag: throw the tool error at once; without one: next rung, and after the EAS rung throw the first tool error seen |
| the device check timed out (`cause: timeout`)                                                                       | `unknown`                   | refuse, exit 22                                                                                                                    |
| cloud: lease live                                                                                                   | `recorded`                  | the EAS rung decides                                                                                                               |
| lease expired                                                                                                       | `gone`, cause `expired`     | next rung                                                                                                                          |
| local, device up: iOS listed `Booted`; Android `get-state` is `device` and, for `spawned`, the instance check holds | `up`                        | wins                                                                                                                               |
| local, Android `spawned` failing the instance check                                                                 | `gone`, cause `device-gone` | next rung                                                                                                                          |
| local, device listed                                                                                                | `not-up`                    | refuse, exit 20                                                                                                                    |
| local, device not listed                                                                                            | `gone`, cause `device-gone` | next rung                                                                                                                          |

**`useBoundDeviceAsync(inspection, tools?) → BoundDevice`**: takes an `up` inspection, extends the lease per §Lease, and returns the device; `lost` throws `gone` with cause `expired` (exit 20). It never inspects again and never boots.

**`releaseWorktreeDevicesAsync(root, { platform?, expected? }) → ReleasedDevice[]`**, never reaps. `expected` restricts a failed-boot cleanup to the binding that run acquired, so a replacement binding is left alone. It lets go of the local bindings, or only `platform`'s when given. Under the lock it acts only when the file still holds the binding it read: the same root, `boundAt` and device; an extended `expiresAt` is the same binding. Callers: `dev:stop --release`, after the server stop or when no server ran; smoke's cleanup. The foreground `dev` exit and the detached child touch no local binding; the lease expires on its own.

**`releaseCloudBindingAsync(root, sessionId)`**, never reaps. Under the lock it removes the own cloud binding that names the id, at any lease age, and leaves a binding that names another id. Callers: `dev:stop --eas`, the foreground `dev --eas` exit and `smoke --eas`, each after its stop succeeded. They need no `--release`, because a stopped session leaves nothing to keep.

## Readers

- Rung order. With a platform flag and no `--eas`: that platform's local binding. With no platform flag: both local platforms are inspected, iOS on macOS only, and any `up` wins; when both are `up`, the binding with the newer `boundAt` wins, so after `dev --android` on a worktree whose simulator is still up the agent drives the instance it just asked for. When no platform is `up`, the first state that is not `none`, in iOS, Android order, decides per the inspect table's last column: iOS `gone` and Android `not-up` is a refusal naming Android; iOS `gone` and Android `none` goes to the EAS rung. When every local rung passed, verbs that fall back to EAS (`navigate` and `smoke` in `fallback` mode) run the EAS rung when this worktree has a cloud binding at any age or a dotenv id, so an expired-only binding is refused `gone` with cause `expired`; `runtime:stop` and `runtime:reload` do not. With `--eas` the local rungs are skipped. A tool error seen on any rung is thrown after the EAS rung; else the refusal reports the first non-`none` state seen, with its How line; with only `none` states it names the platform of the flag, else iOS on macOS and Android elsewhere. The loop is `findBoundDeviceAsync(root, { platform?, extend })` in `rungs.ts`; it has no `eas` option, because `resolveDeviceAsync`'s `cloud: 'required'` short-circuit handles `--eas` before the loop. It calls `inspectBindingAsync` per platform, fresh, and with `extend` calls `useBoundDeviceAsync` once, on the winner. `resolveDeviceAsync` calls it with `extend: true` and sets `adb: resolveAdb()` on a `local-android` winner, so `openRoute`'s `adb reverse` still runs.
- The installed readers (`src/installedApp/`) call `findBoundDeviceAsync` once per platform with `extend: false`, because `status` never writes.
- The EAS rung (`cloudRung.ts`) reads one snapshot of the registry (`readCloudBindings`) and makes one probe call: `probeCloudSessionAsync({ boundIds })`, with the ids of the live bindings (`live`). Every probe caller gives `boundIds`. When the selected id is an own binding's, the verb extends it per §Lease. The rung extends it with `extendBoundLeaseAsync`, the helper `useBoundDeviceAsync` uses: a locked registry warns and goes on, and `lost` refuses `gone` with cause `expired`. `cloudVerdict` returns `device`, `refuse` or `none`; a queued or active session on another platform than the flag is a platform mismatch, and an active session that reports no platform, read with no flag, is `CLOUD_SIMULATOR_PLATFORM_UNKNOWN`. When the listing shows a bound id as queued, the rung refuses `not-up` ("The <platform> EAS session <id> is not up yet (status <STATUS>).", How line: retry in a minute). These refusals hold for `--eas` (`use: 'required'`). In `fallback` mode, a queued session and a session on another platform than the flag are no device: the verb keeps its local refusal and names the session in an `Or:` line ("is not up yet … run this command again in a minute", or "is <platform> … run this command again with --eas and no platform flag"). When the listing shows it in no live state, the rung refuses `gone` with cause `device-gone` and writes nothing (Contract 1); its How line is the `dev` command with `--eas`, which on a running server opens a session through `openAppEas` and rewrites the binding (§EAS session binding).
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

Each reaped device is reported on stderr and in JSON with reason `expired`, `deleted-worktree`, `device-gone` or `session-cap`. The JSON `error` of a failed device action ends with a How line that names the step by hand: `xcrun simctl delete <udid>` or `xcrun simctl shutdown <udid>` for a simulator, `kill <pid>` for an emulator instance. `dev:stop` reports the first such error as `deviceError` and exits 20; an acquisition prints the failure on stderr and goes on.

## Output and errors

- `dev:stop` JSON always has `devices: ReleasedDevice[]` (llp/0006: every key always present). `dev:stop --release` reports what it released there; a plain `dev:stop` reports the kept bindings under the same key with `released: null`; `false` is a release that failed. `status --json` gains `binding: { platform, backend, id, name, origin, state, expiresAt }[]`, one entry per file of the worktree, cloud bindings unprobed. `status`'s next action is the `dev` command when there is no live binding; §Lifecycle output has the platform choice and the `dev:stop &&` prefix.
- Events: `cli:device_binding_reaped { reason }` and `cli:device_registry_lock_removed { lock, pid }` from `src/deviceBinding/`; `dev:stop_session` gains `platform`; `dev:open_app_eas_flag_unsupported { flag }` from `openAppEas`.
- A `DEVICE_UNAVAILABLE`, `DEVICE_REGISTRY_LOCKED` or `NO_BOUND_DEVICE` error the detached child raises reaches the agent unchanged, code, exit and How line, through the child verdict; today every child failure that is not needs-human is `DEV_DETACH_DIED`, whose How line reruns the same command.
- Exit codes per [[0010-agent-conventions]], one How line each. The `dev` command is `<cli> dev --<platform> --detach --wait-ready`. The missing-device errors `NO_DEVICE`, `NO_IOS_DEVICE` and `NO_ANDROID_DEVICE` become `NO_BOUND_DEVICE`.

| Code                     | Reason                    | Exit | What                                                                                               | How                                                                                  |
| ------------------------ | ------------------------- | ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `NO_BOUND_DEVICE`        | `none`                    | 20   | "No <platform> device is bound to this worktree"                                                   | the `dev` command                                                                    |
| `NO_BOUND_DEVICE`        | `gone`                    | 20   | "the lease expired" or "the device is gone"                                                        | the `dev` command                                                                    |
| `NO_BOUND_DEVICE`        | `not-up`                  | 20   | "the bound device is not up"                                                                       | the `dev` command; a queued EAS session: run the command again in a minute           |
| `NO_BOUND_DEVICE`        | `unknown` (timeout)       | 22   | "the device check timed out"                                                                       | run the command again                                                                |
| `NO_BOUND_DEVICE`        | `unreadable`              | 7    | "the binding file <path> does not parse; a newer CLI may have written it"                          | `rm -f '<path>'`                                                                     |
| `DEVICE_UNAVAILABLE`     | `unreadable`              | 7    | the same                                                                                           | `rm -f '<path>'`                                                                     |
| `DEVICE_UNAVAILABLE`     | `no-ios-runtime`          | 7    | "no iOS runtime with an iPhone is installed"                                                       | `xcodebuild -downloadPlatform iOS`                                                   |
| `DEVICE_UNAVAILABLE`     | `no-avd`                  | 7    | "no Android virtual device exists"                                                                 | create one in Android Studio                                                         |
| `DEVICE_UNAVAILABLE`     | `no-free-port`            | 20   | the serials and the worktrees they are bound to; a serial no binding names is listed as "not ours" | `<cli> dev:stop --release` in a listed worktree, or stop the unlisted serial by hand |
| `DEVICE_UNAVAILABLE`     | `explicit-bound`          | 20   | "<name> is bound to the worktree <root>"                                                           | the caller's `<cli> dev` without `--device`                                          |
| `DEVICE_UNAVAILABLE`     | `explicit-not-found`      | 1    | "no device matches <query>, or more than one does" with `matches`                                  | the same command with `--device <first match>`; none: `simctl list`/`adb devices`    |
| `DEVICE_UNAVAILABLE`     | `explicit-not-ready`      | 7    | "adb lists <serial> as <state>"                                                                    | allow USB debugging or reconnect, then the same command with `--device <serial>`     |
| `DEVICE_UNAVAILABLE`     | `own-explicit-over-owned` | 1    | "this worktree runs the emulator instance <serial>"                                                | `<cli> dev:stop --release`                                                           |
| `DEVICE_UNAVAILABLE`     | `not-reusable`            | 20   | "a dev server is running and this worktree has no <platform> device to reuse"                      | `<cli> dev:stop`                                                                     |
| `DEVICE_UNAVAILABLE`     | `create-timeout`          | 22   | "the device tool did not answer in time"                                                           | run the command again                                                                |
| `DEVICE_UNAVAILABLE`     | `binding-changed`         | 22   | "the binding changed during all three inventory attempts"                                          | run the command again                                                                |
| `DEVICE_UNAVAILABLE`     | `spawn-failed`            | 22   | the spawn error                                                                                    | run the command again                                                                |
| `DEVICE_UNAVAILABLE`     | `boot-failed`             | 20   | the boot's reason; the binding is let go of first                                                  | run the command again                                                                |
| `DEVICE_REGISTRY_LOCKED` | `locked`                  | 22   | "pid N (<command>) has held the device registry for <age>"                                         | run the command again, or `kill <pid>` when it repeats                               |

- The agent guide (`src/agents/content.ts`) gains a `## Devices` heading with two sentences. One: run `dev` before `navigate`, `runtime:reload` or `runtime:stop`, or they refuse with `NO_BOUND_DEVICE` and name the command. Two: never boot, shut down or delete a simulator named `agent-cli …` yourself; it may be bound to another worktree.

## EAS

- Per §Session binding: `probeCloudSessionAsync` calls the pure `selectCloudSession`, which takes `boundIds`. A session is a candidate only when the service lists it as queued or in progress and its id is in `boundIds` or is the dotenv id; a queued bound session is reported as such, never replaced by a new start. Unbound in-progress sessions come back as `unbound` for the report.
- The session start passes `--max-idle-time-minutes 30`. When the start exits non-zero with oclif's "Nonexistent flag" on stderr and no session id was read, it retries once without the flag that was refused. The idle timeout limits the cost of a session that has no binding: a start that an agent's tool timeout kills before it returns an id leaves a session with no binding, which the probe never reuses.
- `dev:stop --eas` stops the probe's session, bound or dotenv, and removes the stopped session's binding with `releaseCloudBindingAsync`; it needs no `--release`.
- `.env.eas-simulator` holds the session's auth token. After every bind, `ensureEasSessionAsync` asks `git check-ignore --no-index`. When git does not ignore the file, it appends an unanchored `.env.eas-simulator` line to `info/exclude` at `git rev-parse --git-path info/exclude`, never to `.gitignore`, and the run says so in one line. It appends the line only when `info/exclude` does not list it yet, and asks `git check-ignore` again after the write: when a rule that wins over `info/exclude` (a `.gitignore` negation such as `!.env*`) still un-ignores the file, the run warns and names that rule as `git check-ignore -v` prints it. When git tracks the file, the run warns and names `git rm --cached`; it never runs it. Outside a git repo it does nothing and says nothing.

## Not built

The agent's pid in the binding; a take of another worktree's simulator; a cap on parked simulators; allocation from "any free booted device"; `peek` mode; capacity from cpus and RAM; mtime touch, lock token and heartbeat; a `pool.json`, a create marker, adopt-by-name; a lock-free write path; a `busy` lease result; a `StartPlan.device`; dev-lock socket liveness; a writable first emulator; `emu kill` by serial; `--device` on `navigate`; a "still booting" inspect state; a stop of the old session on a cloud id change; a delete of `.env.eas-simulator` on `dev:stop --eas` (the registry lock does not cover eas-cli's write of that file).

## Answers from the EAS code

Read on 2026-10-01 in the local clones of `eas-cli` (24.7.0) and `universe` (`server/www/src/data/entities/device-run-session/`). The service calls a session a `DeviceRunSession`.

1. **Owner mark: the service has one.** `eas simulator` accepts `--name` and `--tag` (repeatable, stored lowercased). Both come back in `simulator:list --json`, and the list filters by `--tag` (a session must carry every listed tag). No field carries a client identity. So the mark is a convention this CLI sets. `--tag` is in eas-cli since v23.2.0 (PR #4318). [read — eas-cli history, 2026-10-05]
2. **Expiry: opt-in.** `maxIdleTimeMinutes` stops a session after that many idle minutes; omitted, there is no idle timeout. `maxRunTimeMinutes` is capped at 40 minutes for normal-priority accounts and 115 for high-priority ones. `--max-idle-time-minutes` is in eas-cli since v22.5.0.
3. **Concurrency: no hard limit.** Sessions queue behind the plan's job concurrency; parallel agents wait, they do not fail.

At eas-cli 24.7.0 a `--json` start still writes the session id to `.env.eas-simulator` once the session is ready.

## Risks

Each accepted race costs one rerun of `dev`, never a lost build or a touched human device.

1. The Android facts §Live gate verifies: a second `-read-only` instance boots beside the first and takes `adb reverse` and an install, an emulator started on a taken port exits non-zero, the launcher keeps its pid, and a cold boot plus the install fits `BOOT_DEVICE_TIMEOUT_MS`. The gate passed on SDK 58; the cold start's wall time is the cost every instance start pays (Decision 2).
2. A pid reused by an unrelated long-lived process keeps the registry lock until a human reads the message; a reused emulator pid is never killed where `ps` exists, and on a platform without `ps` the kill can hit the wrong process. Without `ps`, `dev` and the read verbs can drive whatever answers on the serial. Needs pid wrap-around during days of uptime.
3. eas-cli skew: a project pinned under 23.2 refuses `--tag` on the start; §Recovery by tag (not built) must test the fallback. A pinned eas-cli that rejects `--status queued` (24.8.0 and older) makes the listing fail, so the probe is `unknown` and no session starts.
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
15. The newest installed iOS runtime may list only a device no app renders on; the choice prefers a mainstream iPhone across runtimes [observed — iOS 27.1 lists only iPhone Duo, 2026-10-08].

## Open questions

1. Where does the idle check run on the service, and what counts as activity?
2. Should `--device <session-id>` with `--eas`, refused as `BAD_ARGS` today, bind an in-progress session that another tool started outside this worktree?

## Integration requirements

Metro discovery verifies the project root reported by `/status` for the port scan, the dev lock's step 0 and the dev-lock port check. It retries `/status` only for the logged and default ports. A foreign Metro on 8081 is skipped and named in `status`; see [[0004-smart-start-and-project-state]] §Discovery.

Android instance selection requires SDK 58: `@expo/cli` 57 matches `run:android --device` by name only, while multiple instances of one AVD must be addressed by serial. The live gate in §Android instance therefore uses `apps/eas-example` on SDK 58.

| Behavior                                                                        | Design               |
| ------------------------------------------------------------------------------- | -------------------- |
| Allocate an iOS simulator for each worktree and use it in every device verb     | §iOS binding         |
| Allocate a read-only Android emulator instance for each worktree                | §Android instance    |
| Renew device leases while Metro or a build step runs                            | §Lease timer         |
| Release devices explicitly with `dev:stop --release`                            | §Release             |
| Release devices acquired by `smoke`                                             | §Lifecycle smoke     |
| Reap bindings of deleted or expired worktrees                                   | §Lifecycle reap      |
| Bind a device named by the user with `dev --device`                             | §`--device` on `dev` |
| Report the worktree's binding in `status`                                       | §Lifecycle output    |
| Bind EAS sessions to their worktree and recover them by tag after registry loss | §EAS session binding |

## Verification

Run typecheck, lint, the module's unit tests, and the e2e files affected by each change (e2e after `bun run build` with `EXPO_E2E_TEMP_DIR` set; device tests with `AGENT_CLI_NO_DEVICE=0`; iOS cases `skipIf` off macOS, Android device cases skipped on win32). E2E fixtures use two fixture worktrees, one stub `xcrun`/`adb`/`emulator`/`eas`, and one shared Expo home. Tests that pin a decision are named in each of those sections.

## iOS binding

`dev` binds its own iOS simulator, and every verb uses it. Implements the iOS binding rules of this RFC. Requires project-root-aware Metro discovery and the cleanup paths in §Device lifecycle; Android instance binding is described in §Android instance.

How does a worktree get an iOS simulator nobody else has, and how do the other verbs find it?

### State after iOS binding

- Two worktrees' `dev --ios` build and open on two `agent-cli` simulators.
- `expo run:ios --device <udid>` carries the bound id, so a second worktree on a current build installs onto its fresh simulator.
- `dev --detach` on a running server boots its own `Shutdown` simulator and refuses otherwise.
- `navigate` without a local binding follows the EAS fallback rules in §EAS session binding and refuses with a `dev` hint when no session is available. With a local binding, it drives the bound device only. Without a platform flag, any `up` binding wins.
- `smoke --ios` gets its simulator from the binding; it releases a device it acquired itself and leaves a pre-existing binding as found (§Lifecycle smoke).
- Android follows §Android instance.

### The module

The iOS binding module follows §Contracts every verb honors. Failed-boot cleanup uses the let-go rule and `releaseWorktreeDevicesAsync`. Reaping is defined in §Device lifecycle; Android and cloud binding are defined in §Android instance and §EAS session binding. `createSimulatorAsync` runs `simctl create` under the lock per §Lock. Acquisition snapshots the binding identity before inventory and checks it again under the lock. A mismatch retries without writes, outside the lock, for at most three attempts; lease and name changes are ignored. Exhaustion is `DEVICE_UNAVAILABLE` reason `binding-changed`, exit 22. Two tests guard the shape: the boundary test (Contract 10) and a subprocess-count test (one subprocess per binding a read verb inspects).

### How `dev` uses it

- `resolveStartPlanAsync` serves `dev`, `smoke` and `status`. It gains an optional `acquireDevice(draft) → Promise<AcquireResult | null>` callback that only `dev` passes, and returns `{ plan, acquired }`; `smoke` and `status` take `.plan`.
- Non-building draft for a native platform without `--eas`. On main the resolver exits early through two draft fields, `awaitsADevice` (the plan needs a device before it can decide the install step) and `opensOn` (the platform the open targets, null under `--no-open`). The resolver's exits, main against new:

| Main                                                                                                                        | New                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1. exit when `awaitsADevice` is false, `opensOn` is null, the requested platform is not native, or `deviceBackend` is `eas` | 1. exit for `web` and `none` drafts, a non-native requested platform, or `deviceBackend` `eas` |
|                                                                                                                             | 2. the callback, for `expo-go`, `dev-client` and `bare` drafts                                 |
|                                                                                                                             | 3. exit for an `expo-go` draft, unprobed                                                       |
|                                                                                                                             | 4. the `--no-open` exit; `opensOn` no longer drops out under `--no-open`                       |
| 2. exit when the build backend is `eas`                                                                                     | 5. the same                                                                                    |
| 3. the app-presence probe                                                                                                   | 6. the probe, on the acquired device                                                           |
| 4. the toolchain exit                                                                                                       | 7. the same                                                                                    |

- `dev`'s callback runs for a run that passed the lock: a run beside this project's live dev-server lock stopped before the project probe ([[0004-smart-start-and-project-state]] §A busy port), and under `--plan` the callback answers null on a live lock without inspecting the own binding. Then it runs main's `--port` bindability check (`resolvePlannedPortAsync`, then `portDemandedError`, outside `--plan`) when the draft serves, and only refuses; main's later port block stays and still sets the port. Then it calls `acquireDeviceAsync`, with nothing to reuse, because the lock stop came first. The port check and the acquisition skip under `AGENT_CLI_NO_DEVICE`, read through one helper in `src/deviceBinding/index.ts` that `smoke` uses too.
- The probe becomes `probeAppPresenceAsync(root, platform, { device, action }, injections)`: the device context is a new third parameter and main's injections move to the fourth; `ResolveStartPlanOptions.probeAppPresence` gains the parameter. With a device it answers `missing` without asking when `action` is `created`, even when no app id resolves, because a fresh device never has the app and the install step needs no id. On iOS a `Shutdown` simulator's apps are read off its disk. With null on iOS it answers main's `UNPROBED`. Android app-presence behavior is described in §Android instance; the `probeDevice` injection takes the root.
- Building draft: the resolver decides fully with no probe. `devAsync`'s order after `withForwardedExpoArgs` is: the port block, which sets the port and stays before the `--plan` return because the plan prints the port; the `--plan` return; the refusals (`implicitEasRouteError` and the EAS project check); `acquireDeviceAsync`; `withDevice`. So no simulator is created for a run that then refuses, and `--plan` never acquires. The named `--port` refusal runs in the callback before `acquireDeviceAsync`, for a serving draft and a building one alike. The lock stop came before the resolver, so neither draft reaches the callback beside a running server, and under `--plan` the port block builds the stopped plan for both.
- Decided while building, where the RFC left it open:
  - The detached child's log carries one row, `Error code      <code> exit <n> data <json>`, written by `logCmdError` only under `__EXPO_AGENT_CLI_DETACHED=1`, which `devDetachAsync` sets on the spawn. The parent reads the row, the `Try:` line right above it, and nothing else, and rebuilds the error with its code, exit, `data` and `suggestedCommand`.
  - A boot that fails lets go of the binding and refuses `DEVICE_UNAVAILABLE` with reason `boot-failed` (§Output and errors). An inventory read that times out refuses `create-timeout`.
  - `DeviceTools` holds `simctl`, `now` and `isPidAlive` until §Android instance adds the Android members, and `inspectBindingAsync` takes `local-ios` and `cloud` only.
  - `findBoundDeviceAsync` takes no `eas` option; `resolveDeviceAsync` keeps its `cloud: 'required'` short-circuit. Main's Android rung is injected as `android?: AndroidRung`, because Contract 10 keeps `navigate` out of the module. The EAS fallback asks the service only when the dotenv names a session.
  - The `--plan` reason "will reuse or create a simulator" is added only for `--ios` without `--eas` and with devices on, so a stubbed harness's plans are unchanged.
  - `smoke`'s iOS boot skips under `AGENT_CLI_NO_DEVICE` and reports a failed boot phase; its install phase honours the boot's `installNeeded`, because a created simulator's disk holds nothing to read.
- `withDevice(plan, device)` runs once a device is acquired, after the `--port` block, the `--plan` return and the refusals, for a serving draft (acquired in the resolver's callback) and a building one alike. It sets `--device <udid>` on every `run` and `install` step and replaces any `--device` there; on a plan with neither it is a no-op. `AppPresenceProbe.installDevice` goes for iOS. `devAsync` passes `acquired.device` through `executePlanAsync` to `openAppForRunAsync`'s local branch, which hands it to `openAppOnDeviceAsync`; its iOS probe and boot go, and it passes the device to `openRouteAsync` through a new `device?: BoundDevice` option, which skips `resolveDeviceAsync`, so the open inspects nothing twice. `report.booted` is `acquired.justBooted`.
- The callback runs for iOS on macOS only; on another host `dev --ios` binds nothing and the plan is unprobed, which is what the live-cloud suite's Linux worker relies on. Android acquisition, where `adb` resolves, is described in §Android instance. `acquire` is skipped for `--eas`.
- `dev --plan` passes a callback that inspects the own binding and returns it as `reused` with `justBooted: false` when the state is `up` or `not-up`; otherwise null. With a live dev-server lock it returns null without inspecting, and the plan, which lists no steps, pins nothing and adds no reason (0004 §A busy port). For a building draft `devAsync` calls that same callback itself and pins the plan, with no probe. When the callback returned null, `devAsync` leaves the step unpinned and adds the reason "will reuse or create a simulator" to the plan, building or not.
- `dev --detach`: the child acquires and never releases on exit. `devDetachAsync` gains an option `reuseBoundDevice`, default false, that `devAsync` passes as true and `smoke` leaves unset. With it, when the server is already running, `devDetachAsync` calls `acquireDeviceAsync` with `reuseOnly` before `reportDetached` prints, for `--ios` on macOS and for `--android` where `adb` resolves, without `--eas` and without `AGENT_CLI_NO_DEVICE`. A host that cannot run the platform's device reuses the server without acquiring. A parked own simulator is booted, the boot is waited for, and the `action` line is printed on stderr before the report. Any other choice refuses `not-reusable` (exit 20), because a device created here would carry no app. The child's `DEVICE_*` and `NO_BOUND_DEVICE` errors are written to the child verdict and the parent rethrows them unchanged, per §Output and errors; `detachFailureError` keeps `DEV_DETACH_DIED` for everything else.

### iOS readers

- `resolveDeviceAsync` makes `context.projectRoot` required and calls `findBoundDeviceAsync` per §Readers; its callers in `runtime/stopAsync.ts`, `runtime/reload/reloadAsync.ts`, `runtime/reload/cloudReload.ts` and `navigate/openRoute.ts` already pass it. Android resolution follows §Android instance and the same RFC inspection states.
- `probeLocalDeviceAsync` takes `projectRoot` in its options, keys its cache by it, and reads `inspectBindingAsync` on iOS; its callers in `status/statusAsync.ts`, `start/followUps.ts`, `deferred/dev-wait/waitAsync.ts` and `appPresence.ts` pass the root. Its `devices` lists each `up` binding as a `NavigateDevice`, because `status`'s sections and `askDeviceAsync` read it. Android bindings follow §Android instance. `noLocalDeviceAction` is unchanged: it runs only while a server is up. `status`'s next action names the `dev` command of §Output and errors where it names `dev` today, with the platform chosen per §Lifecycle output.
- The installed readers take `projectRoot` and call `findBoundDeviceAsync` with `extend: false`; `status --device` keeps its filter through `listBootedIosSimulatorsAsync`. `probeIosSimulatorAsync`'s callers in `dev/openApp.ts` and `device/localDevice.ts` move to the binding. Their `no-device` result keeps its name; its `hint` carries the read verb's How line first and main's connected-phone hint after it.

### iOS smoke

In bootstrap mode `smoke` starts its own `dev --detach --no-open` child through `devDetachAsync`, which acquires. Smoke's `probeDevice` phase then finds the bound device, so smoke boots nothing itself. When that phase finds no device, after a reused dev server or a child that reported the server already running, the shared boot phase in `smoke/phases.ts` branches on the platform: iOS calls `acquireDeviceAsync` without `reuseOnly`, maps `action` to `installNeeded` (`created`) and the device's name to `choice`, registers no shutdown cleanup, and drops "and shut it down again afterwards" from its reason. Android acquisition is described in §Android instance; release and cleanup of bound devices follow §Lifecycle smoke. The `boot.refused` branch of the phase goes; `SmokeDeviceDisposition` `'absent'` stays, because it is also the start value. The smoke e2e boot cases that assert `pickSimulator`'s choice and the shutdown after the run are rewritten to assert the binding.

### iOS deletions

`bootSimulatorAsync`, `pickSimulator`, the iOS branch of `bootDeviceAsync` (`BOOT_DEVICE_TIMEOUT_MS` stays; §Android deletions removes the rest), `probeIosSimulatorAsync`, `parseBootedIosSimulator` (the plural `parseBootedIosSimulators` stays for `status --device`), the iOS `installDevice`, `NO_DEVICE` and `NO_IOS_DEVICE`. Help texts: the iOS lines that `git grep -i 'booted'` finds over `src/**/index.ts` and `runtime/stopAsync.ts`; the Android lines are covered by §Android instance.

### Docs

The agent guide per §Output and errors. §Readers and §Entry points are what §iOS binding implements; first-booted sentences in llp/0004, 0005, 0022, 0025, 0026 change to the bound device.

### iOS tests

- Acquisition concurrency uses real temporary storage (memfs does not model directory-lock rename semantics) and barriers before either initial snapshot advances. Empty, missing and unavailable bindings create exactly one replacement; `reuseOnly` refreshes without creating; lease/name changes do not refresh; inventory failure and three changed snapshots preserve the newer binding. Device reads and boots stay outside the lock.
- Detached reuse explicitly models macOS for acquisition tests and Linux/Windows for existing-server reuse without device acquisition.
- The binding-based missing-Expo-Go smoke case asserts the SDK-specific download, install onto the bound UDID, scheme approvals before opening, successful install/app phases, attachment after opening, and retained binding without shutdown.

- Unit, named: `boot-always-runs`, `failed-boot-lets-go`, `only-create-and-spawn-under-lock`, `agent-cli-name-needs-binding`, `expo-go-and-bare-drafts-acquire`, `created-device-missing-without-app-id`, `withDevice-after-forwarded-args`, `already-running-reuses-only`, `smoke-never-reaches-already-running-reuse`, `smoke-acquires-without-bootDevice`, `smoke-registers-no-shutdown`, `created-device-plans-install`, `null-device-ios-unprobed`, `inspect-state-order`, `any-up-wins-across-platforms`, `bootstatus-b-not-boot`, `detached-device-error-relayed`, `fallback-eas-rung-dotenv-only`, `expired-is-gone`, `platform-flag-throws-tool-error-first`, `read-verb-one-subprocess-per-binding`, `rung-refusal-reports-first-state`, `probe-local-combines-platforms`, `deviceBinding-imports-nothing-from-verbs`, `exit-codes-per-reason`.
- E2E: `bindingFixture` (`created`, `expiresAt` 60 min ahead, canonical root, macOS only) seeded in the cases that hand a verb a booted simulator. A two-worktree case asserts each `run:ios --device` equals its registry id and the two ids are distinct `E2E-CREATED-*` udids, and set equality of `simctl bootstatus -b` calls.
- Live: `navigate` wall time before and after on a machine with ten simulators, warm and cold, with `simctl list devices -j` and the booted-only list timed side by side. A cold `simctl create` is timed to confirm the 20 s timeout (Risk 5).

## Android instance

`dev` binds its own Android emulator instance. Extends the binding module in §iOS binding to Android, with the cleanup paths in §Device lifecycle.

How does a worktree get an Android emulator nobody else has? The Android counterpart to §iOS binding.

### State after Android binding

- Two worktrees' `dev --android` run two read-only instances of one AVD on ports 5554 and 5556.
- `expo run:android --device <serial>` carries the bound serial (SDK 58 floor; the "a serial is refused" notes in `installDevBuild` and llp/0005 go).
- Live gate on SDK 58 passed (below).

### Android boot

Before the lock: `adb devices -l` and `emulator -list-avds`. Under the lock: `busyPorts` and the port choice per §Choice, else `no-free-port`. Then `spawnEmulator(['-avd', avd, '-ports', 'P,P+1', '-no-snapshot-save', '-read-only'])`, then one binding with serial and pid, in that order inside one section. After it: poll `sys.boot_completed` until `BOOT_DEVICE_TIMEOUT_MS`, accepted only while the child is alive and `adb devices` lists the serial; a non-zero exit or the deadline is a failed boot. The child's stdout and stderr go to `agent-cli-emulator-<port>.log` in the temp directory, truncated at each spawn; a child that exits during the boot fails it with that file's last line and its path.

### Wiring

- `android.ts`; the `emulatorList` and `spawnEmulator` tools; the `android-spawn` choice; the boot poll with deadline and exit watcher.
- The resolver callback and the `reuseBoundDevice` reuse of §iOS binding run for Android too. `AppPresenceProbe.installDevice` goes for Android. `withDevice` sets `--device <serial>`.
- `openAppOnDeviceAsync`'s Android branch takes the bound device. `resolveDeviceAsync` sets `adb: resolveAdb()` on a `local-android` winner. `installDevBuild`, `askDeviceAsync` and `installedApp/android` pass the serial; `androidDeviceNameAsync` stays for display only.
- Smoke's Android boot phase calls `acquireDeviceAsync`, and maps a `spawned` instance's AVD to `choice`, and nothing for an `explicit` serial, which the phase line already names. `shutdownDeviceAsync` and smoke's `shutdownDevice` phase go, because every device is bound and that branch runs `emu kill` by serial (Contract 6).
- A release acts only on the binding it read. Under the lock it compares the whole acquisition (`sameBinding`: root, `boundAt`, device, and for a `spawned` instance its AVD, port and pid), and a failed boot passes the binding it wrote as `expected`, so a replacement keeps its file and its device.

### Decided while building

- `src/deviceBinding/emulator.ts` holds the Android tool calls (the inventory, `get-state`, the `EMULATOR_NOT_RUNNABLE` and `ADB_FAILED` errors, the host check) beside `android.ts`, which holds the port choice, the section, the boot poll and the kill; `release.ts` holds the let-go rules of both platforms, so every file stays under the budget of §Contracts every verb honors.
- `DeviceTools` gains `commandOf(pid)` and `kill(pid)` beside the RFC's members, because the kill rule reads `ps` and signals, and a unit test must see both. `commandOf` is null where `ps` does not exist and `''` for a pid it does not list, so a reused pid is never killed, reused or reported `up` where `ps` runs.
- `get-state` on an instance that is still booting exits non-zero with `error: device offline`. That row is `not-up`, not `unknown`: the serial is listed, the device is not up. Only `not found` is missing, and any other non-zero exit is the tool row of the RFC.
- The host guard is `adb` resolving on disk (`resolveAdb().fromPathOnly` false); `emulator` is found beside it, so a host with neither binds nothing and `dev --android` serves for a device elsewhere.
- The `no-free-port` How line says to stop one of the listed instances by hand. The RFC names `dev:stop --release`, which §Device lifecycle adds; the suggested-command lint refuses a flag that does not exist yet, so §Device lifecycle swaps the line.
- Android acquisition lets go of no live device: an own `spawned` binding whose pid is dead loses its file before any refusal, and a live one is reused. Reaping follows §Device lifecycle: after giving up the registry lock, a `finally` runs the reaped devices' actions before a refusal is thrown.
- `status --device <serial>` on Android lists through `adb devices -l` to filter and binds nothing (Contract 3); without `--device` the reader takes the bound serial and names it through `emu avd name` for display.
- `AppPresenceProbe` loses `installDevice` on both platforms: `withDevice` pins every `run` and `install` step to the bound device, so the probe answers presence only, and a `spawned` instance is `missing` without asking, like a `created` simulator.
- The foreign-flag sweep (`src/lint/foreignFlags.ts`) reads the registry's `tools.<runner>([...])` calls, so `-read-only`, `-ports`, `-avd`, `-list-avds`, `-b` and `-j` are pinned where they are spelled.

### Android deletions

`EMULATOR_SERIAL`, `bootDeviceAsync`, `shutdownDeviceAsync`, smoke's `shutdownDevice` phase, `probeAndroidDeviceAsync`, `parseFirstAndroidDevice`, `NO_ANDROID_DEVICE`, the Android `installDevice`, the temporary first-device Android branches of §iOS binding, and the Android help lines that `git grep -i 'attached Android\|adb devices'` finds over `src/**/index.ts` and `runtime/stopAsync.ts`.

### Android tests

- A stub `emulator` that records argv, appends its serial to a state file beside the booted-state file, removes it on `SIGTERM`, and stays alive until killed. `installStubAdbAsync` lists those serials and answers `get-state` and `sys.boot_completed`. Tests kill the pids in their binding files in `afterEach`. Android device e2e skipped on win32. The dev e2e moves from `--device AVD_NAME` to the serial. A win32 lock test for the rename errors of §Lock.
- Unit, named: `spawned-booting-is-not-up`, `get-state-not-found-is-gone`, `busy-ports-include-alive-emulators`, `kill-checks-arguments-not-binary`, `let-go-runs-before-refusal`, `release-leaves-replacement-binding`, `failed-boot-leaves-replacement-binding`, `release validates the Android pid even when its serial did not change`.

### Live gate

Runs on a Mac with two scratch worktrees of `apps/eas-example` on SDK 58, before device allocation is enabled (Risk 1). It verifies five facts and measures one:

1. A second `-read-only` instance boots beside the first; `adb reverse` and install work on it.
2. A human's writable instance beside ours, and ours beside a human's normal launch.
3. An emulator started on a taken port exits non-zero.
4. The spawned process stays alive for the whole life of the instance. If a launcher hands off, the binding must hold the qemu child's pid instead.
5. A cold `-read-only` boot plus the install fits `BOOT_DEVICE_TIMEOUT_MS`; otherwise the Android timeout must be raised.
6. The wall time of `dev --android` from a cold instance to the open app, because every instance start pays it (Decision 2).

## Device lifecycle

Release, park, reap, `--device`, and the lease that outlives a pause. Defines lifecycle behavior for the iOS and Android bindings in §iOS binding and §Android instance, following the rules in this RFC.

What happens when a worktree stops, pauses or disappears, and how does a person pick a device?

### State after lifecycle

- `dev:stop` keeps the worktree's devices; `dev:stop --release` parks the simulator and kills the emulator instance.
- A deleted worktree's simulator is deleted by the next reap anywhere; its emulator instance is killed.
- A worktree with Metro running keeps its device for hours without a verb.
- `--device` binds a named device, keeps it across `dev:stop` and the lease, and never shuts it down; `--device` over an own created simulator deletes that simulator and says so.
- `smoke` releases the device it acquired and leaves a pre-existing binding as found.
- `status --json` shows the binding; `dev:stop --json` shows what it kept or released.
- The restart follow-up `dev:stop && dev --detach` reuses the running instance, so it costs no boot and no install.

### Lease timer

How does a running Metro or build step keep its device?

- `withLeaseExtendedAsync` of §Lease wraps the Metro runner (for `dev`, the detached child and `start`) and the step runner.
- The foreground `dev` exit and the detached child touch no local binding: the lease, renewed while Metro ran, expires on its own and the next reap parks or kills the device.
- `renew.ts` holds `withLeaseExtendedAsync`; `records.ts` holds the own-binding file readers and the kept-device rows (`ownBindingFiles`, `keptDevices`, `deviceReport`).

### Release

How does a worktree give its device back?

- `dev:stop`: stop the dev server as today (main signals the dev-lock holder and waits for it to exit); with `--release`, then release the local bindings only when this worktree's own server stopped or is absent. `devServerOk` alone is insufficient: `--port` can name an idle port while the worktree's server runs elsewhere. Recheck the own lock before release; a remaining or replacement server keeps the devices. A dev server that answers on `--port` and holds no lock of this worktree also keeps them, because a missing lock does not prove the server is not this worktree's. A listener on `--port` that does not answer as an Expo dev server does not keep them. Then run the reap once, whatever the stop outcome. Without `--release` the bindings stay and are reported as kept. `--release` is in `resolveStopOptions` and sets `DevStopOptions.release`; `platform?` is internal, with no CLI flag, so smoke releases its platform only.
- Release re-reads the binding under the registry lock and verifies it still names the device checked before taking the lock, including the origin and emulator pid. A replacement binding is left untouched; stale inventory or an earlier cleanup must never remove or expire its record. Device actions use the binding validated in that section. Failed-boot cleanup likewise targets the binding acquired by that run.
- `dev:stop` JSON `devices`, per §Output and errors.
- A refused stop reports the listener's measured process/port state, not default `false` values. Unidentified state is `null`. A missing lock proves no ownership, not that the CLI never started the server; the refusal and device-preservation rules remain unchanged.
- The `no-free-port` How line of §Android instance names `dev:stop --release` in one of the listed worktrees instead of a stop by hand.

### Lifecycle smoke

Does `smoke` leave a device behind?

One release per device. A device the child bound is released by `devStopAsync`, which smoke's `stopDevServer` already calls, once the child has exited, through the internal `DevStopOptions` fields `release: true` and `platform`. A device smoke's own boot phase bound, after a reused dev server, is released by smoke's device cleanup hook with its `platform`. A `smoke --no-start` run binds nothing and releases nothing.

The report names the device in `environment.boundDevice` (`id`, `name`, `action`, `released`, `shutDown`) and in a human `device` line. `action` is the boot's acquire action; for the child's device, the start phase reads the binding file before and after the start: a new binding is `created` or `spawned`, the same device is `reused`. A run that acquired nothing and used the worktree's bound device reports it as `existing` with `released: null` and the line says `kept`; `released: false` is only a failed release. Smoke leaves a device as it found it: when the binding was live and the device up before the start, or the device check did not answer, the start phase reports that device as `existing` and stops the dev server with `release: false`. Each device `dev:stop --release` let go of is a `device` row under `cleanup`. When no app connected, or the runtime did not answer, and the run stopped its dev server, the follow-ups lead with `dev --<platform> --detach --wait-ready`. Whatever the outcome, when the run released its device and the reused server still runs, the follow-ups lead with the command that binds a device again: on iOS `dev --ios --detach --wait-ready`, which reuses the parked simulator beside the running server, and on Android `dev:stop && dev --android --detach --wait-ready`, because the release removes a spawned instance's binding and `dev` refuses `not-reusable` beside a running server. All keep the caller's `--port`, as does a repeated `smoke`.

### Lifecycle reap

What happens to the device of a deleted or expired worktree?

- `reap.ts` per §Reap, called from `acquireDeviceAsync` and `dev:stop`. It has no `cloud` rows.
- `cleanup.ts` runs the let-go device actions after the section (`runCleanupAsync`, `deleteSimulatorAsync`); `iosAcquire.ts` holds the iOS section (`bindIosSectionAsync`) and the binding identity of §Invariant.
- The reap events and the `cli:device_binding_reaped` reasons, per §Output and errors.
- Reap reports identify `projectRoot` and carry `devServerCleanup: 'not-checked'`: they describe device cleanup only. Deleted-worktree output warns that CLI/Metro processes may remain. Stopping those requires separate server ownership evidence; a device binding grants none. A late last-build write does not recreate an already deleted worktree.

### `--device` on `dev`

How does a person pick a device?

- In `DEV_OWN_FLAGS`; its value is read as `resolvePort` reads `--port`, `--device=<v>` included; the flag and value are stripped from the Expo args as `withoutPortArgs` strips the port; `detachArgv` carries it unchanged, and a detached parent gives its child the caller's argv in `__EXPO_AGENT_CLI_CALLER_ARGV`, which `resolveDevOptions` reads once and keeps from the Expo CLI, so every How line that repeats the caller's `dev` command (`rerunDevCommand`, which adds `--detach --wait-ready` to a foreground command) repeats what the caller typed; with `--eas` it is `BAD_ARGS`, checked where `assertEasRunFits` runs, and so is a run that binds no local device (`--web`, `AGENT_CLI_NO_DEVICE`, a host that cannot run the platform's device), checked before the probe. The match and the refusals are in §Choice; the origin's rule is Contract 7. With `--device`, Android reads only `adb devices -l`: a USB device needs no emulator package. `dev --plan --device` prints a `Device:` line under the steps and the plan's `explicitDevice` (on `--json` and `cli:start_plan`) from the same choice, read without writes or boots: the device it binds, the expired foreign binding it takes over and the own created simulator it deletes, or "Will refuse — <reason>", whose How command replaces the `dev` follow-up while the plan still exits 0. Only a refusal of the choice is printed so; a device tool error, a timeout or an unreadable binding fails the plan as it fails the run. A plan whose EAS route nobody chose, or whose dev server already runs, previews no device, because the run stops before it binds one.
- Live tier: the live tier passes `--device $AGENT_CLI_LIVE_UDID` to `dev` or lets it create. The runbook in `e2e-live/README` gains the two-worktree setup.
- `explicit.ts` holds the `--device` request, its pure choice and the section that binds it (`readExplicitChoice`, `chooseExplicitDevice`, `bindExplicitSection`); `preview.ts` holds the `dev --plan --device` line (`previewExplicitDeviceAsync`).

### Lifecycle output

How does an agent see its binding?

Before a real `dev` startup, `.expo/agent-cli-last-dev.json` retains only its parsed platform, requested port, device, build backend and app target. A dry run does not write it. This is a recovery preference, not evidence of a live process. Status uses an explicit platform first, then the last request, then a sole bound platform, then its existing project default. A different explicit platform discards the saved request's other choices. Recovery keeps a locally named status port, the own lock's port, or the matching last requested port, unless that port is observed serving another project, and uses the shared quoted retry builder. A probe selected from the last request reports `source: 'last-request'`. Rebinding restores the dev plan's steps; rule and target remain the plan's facts.

`status --json` `binding`, per §Output and errors. With no device bound on the platform, or with a binding whose lease expired, `status`'s next action is `dev --<platform> --detach --wait-ready`, plus the plan's own flags such as `--eas`, because every device verb refuses without a live binding. With an unreadable binding file on the platform, the command starts with `rm -f '<path>' &&`, the How line `dev` refuses with. With no binding and a live own dev-server lock, the command starts with `dev:stop &&` (without `--release`), because detached `dev` can only reuse a device beside a running server. An expired existing binding keeps the reuse path. While this project's dev server runs with an app connected, `status` keeps the plan's next action, and an expired lease shows only in `binding`. Where `dev` binds no device (`AGENT_CLI_NO_DEVICE=1`, iOS off macOS, Android with no `adb`), `status` keeps the plan's next action, or it would name the same `dev` command forever. A detached `dev` reads the binding before its final server-health checks, with the device check's timeout of §Entry points rather than `status`'s probe deadline, and prints one `Device <name> (<id>) · <origin>` line, where the origin is how the device came to be bound, not what this run did; `--json` carries the same binding summary under `device`, or `null` when the run binds none.

`summary.ts` holds the binding summary that `status` and a detached `dev` print (`readBindingSummaryAsync`), read from the cached inspection, cloud files unprobed.

### Lifecycle tests

- Lease renewal: `timer picks up late cloud files, warns lost once, and resumes revived files` and `foreground-exit-touches-no-binding` (lifecycle-test); a wiring test that the Metro runner and the build step call `withLeaseExtendedAsync` with the project root.
- Release safeguards: `release-keeps-devices-when-own-server-runs-on-another-port`, `release-keeps-devices-when-server-is-replaced` and `dev-stop-keeps-without-release` (stopLifecycle-test); `explicit-expires-keeps-file` (lifecycle-test). The replacement-binding cases are those of §Android instance (acquire-test, android-test).
- Smoke cleanup: `smoke releases only its acquired platform and binding` (smokeDeps-test).
- Reaping: `deleted-worktree-deletes-simulator` and `reap reads after own write…` (reap-test); `dev-stop-reaps-once` (stopLifecycle-test).
- Explicit device selection: `device-over-own-created-deletes`, `explicit-bound-live-or-stale` and `explicit-never-shut-down` (explicit-test).
- E2E: use one shared machine directory and an `afterEach` `dev:stop --release` loop. Assert the `dev:stop --release` JSON and exact `shutdown` call, and the `simctl delete` call when reaping a deleted worktree.

## EAS session binding

An EAS session belongs to the worktree that started it. Extends the binding and lifecycle rules in this RFC and §Device lifecycle to EAS sessions. The parts are §Session guard, §Session discovery and §Session binding. §Recovery by tag is not built.

How does a worktree keep to its own EAS session, and how does that session survive a lost registry?

**Status:** built, except §Recovery by tag.

### State after EAS binding

- An EAS device command runs only on the session it selected.
- Discovery sees every pending and in-progress session on every page. A failed listing starts no session, and a queued session on the requested platform is never replaced by a new start.
- Two worktrees get two sessions; `navigate --eas` uses its own; `dev:stop --eas` ends the probe's session and removes its binding.
- A lost registry leaves its session unbound. `dev:stop --eas` and the dotenv id still reach it. Recovery by tag is §Recovery by tag, which is not built.
- The live suite is green on a Mac with two worktrees.

### Session guard

**Status:** built.

Does an EAS device command run only on the session it selected?

- Every cloud device verb takes the selected session id (`CloudVerbOptions.sessionId`) and carries it to execution. `navigate`, `runtime:reload`, `runtime:stop` and the screenshot pass the id of the device they resolved, which is the probe's id.
- `simulator:exec` loads `.env.eas-simulator` and starts its child locally with that environment. The child is a guard (`src/device/cloudCommand.ts`), not the controller. The guard compares the loaded `EAS_SIMULATOR_SESSION_ID` with the selected id. When they match, it starts the controller with the same environment. When the id is missing or different, it exits 20 and starts nothing. The guard checks the environment that the controller gets, not an earlier read of the file. A dotenv that another run replaces during the command cannot change the session the controller drives.
- A mismatch is `CLOUD_SESSION_MISMATCH`. The guard prints the id that EAS loaded after its marker, on one stderr line. The message names the selected session and that id (`data.selectedSessionId`, `data.loadedSessionId`). No command writes the connection of an existing session back to the file, so the message never tells the caller to restore or edit it. `sessionId` is required; an empty id is a bug in this CLI and starts no process.
- The guard program is one line, because `cmd.exe` reads a newline as the end of a command when the `npx.cmd` shim forwards the argument on Windows. The session id and the controller target are two separate arguments. The target is resolved for the caller's platform (`resolveSpawnTarget`), with the Windows batch-file escapes. It crosses the outer shim as base64 JSON, and the guard decodes it, so the outer shell cannot consume the escapes for the inner spawn.
- The screenshot degrades and never throws. It reports the same message, with its How line, as the reason for no picture.
- The `command` of a report is the logical argv, `eas simulator:exec npx agent-device@latest …`, not the guard.
- This CLI writes no credentials.
- Tests: a mismatched connection exits before the controller starts, and the controller gets the loaded environment (cloudBinding-test); the guarded argv of the open and the screenshot (cloudSimulator-test); an e2e round trip of a target argv with spaces, quotes, `^`, `%`, `&`, Unicode and a newline through the stub runner, and its refusal on a mismatch (cloud-binding-test). The stub `eas` loads the connection file as EAS does and runs the real guard.

### Session discovery

**Status:** built.

Does discovery see every live session, and does doubt start no session?

- `simulator:list` asks for every pending status (`new`, `queued`, `starting`) and `in-progress`. EAS reports a pending session with any of the three pending statuses.
- The probe follows `--after <endCursor>` while `pageInfo.hasNextPage` is true, because a session that is not on page 1 has not ended. A later page that fails or cannot be read, or a page that lists more pages and names no cursor, gives `unknown`. After `CLOUD_SESSION_MAX_PAGES` (10) pages with more pages listed, the probe gives `unknown`, so a cursor that does not advance cannot loop.
- `ensureEasSessionAsync` starts no session when the probe is `unknown` or the account has no EAS Simulator. A queued session that a binding or the dotenv names, on the requested platform, is never replaced by a new start; the open fails and asks for a retry in a minute.
- `navigate --eas` on a queued session says that the session is not up yet. A queued session on another platform than the one asked answers a platform mismatch. `dev:stop --eas` stops a queued session.
- A pinned eas-cli that refuses `--status queued` (24.8.0 and older) fails the listing, so the probe is `unknown` and no session starts (Risk 3).
- Tests: the listing argv, a session on page 2, pages that do not end, a page with no cursor, a queued and a starting session, a pending session the dotenv does not name, the dotenv session against a foreign one on the asked platform (cloudSimulator-test); a queued session on the other platform (navigate device-test); a failed listing and a queued session start nothing (openAppEas-test).

### Session binding

**Status:** built.

Which EAS session belongs to this worktree?

- `cloud.ts` holds `readCloudBindings`, `live`, `claimable`, `claimCloudBindingsAsync`, and the `acquireCloudBindingAsync` and `releaseCloudBindingAsync` of §Entry points; the cloud rows of the inspect table; the `stop-cloud` action of `cleanup.ts`, which the two-starts rule of `acquireCloudBindingAsync` uses.
- `selectCloudSession(boundIds)` and the `unbound` result per §EAS, without the tag rung. A candidate is a live `agent-device` session whose id is bound or is the dotenv id. The live states are the pending statuses and `in-progress`. The order is: the requested platform, then a bound id, then the dotenv id, then the newest `createdAt` (`id` ascending breaks a tie). A selected pending session gives the probe state `queued`. A selected in-progress session gives `active`. A pending session on another platform than the one asked answers a platform mismatch. A bound id that the listing shows in no live state gives `inactive`, after the availability check, so an account without EAS Simulator still answers `unavailable`. Live sessions that are not candidates give `unbound`, and the probe selects none of them. Readers of `candidateCount` are checked.
- Every probe caller gives `boundIds`. The rung loop, `dev:stop --eas` and smoke's reuse branch give the ids of the live bindings. `ensureEasSessionAsync`, which `dev --eas` and smoke's start branch use, gives the ids of `claimCloudBindingsAsync`: this platform's bindings at any age and the other platform's live ones (`claimable`). This platform's ids come first. The claim renews this platform's expired lease under the lock before the probe, so a reap cannot stop a session that is still alive while the listing runs; when the probe does not select that session, `restoreRenewedLeaseAsync` writes the previous lease end back, so a failed open does not keep a dead binding live.
- `dev --eas` and the start branch of `smoke --eas` first renew, under the registry lock, the lease of this platform's expired binding, so a reap in another worktree cannot stop that session; they then count the binding as bound and reuse a live session. An unreadable binding file of this platform refuses before the probe, and no session starts. `navigate` still refuses an expired binding.
- Binding points. `ensureEasSessionAsync` calls `acquireCloudBindingAsync` whenever it has a session id. `openAppEas` and smoke's start branch go through it, and smoke's reuse branch calls `acquireCloudBindingAsync` itself. That includes a reuse of the bound id and a start that failed after it created the session, so `dev:stop --eas` can find that session. A reuse of a `started` binding keeps its `origin` and `boundAt`. A binding that cannot be written fails the open. A session this run started and could not bind belongs to no run, so the open stops it at once, unless a binding in this worktree records its id: another run may drive it. A binding file that cannot be read keeps the session.
- The cloud rung writes nothing but the lease of the selected binding. An unreadable binding refuses. A queued session is `not-up` and is never replaced by a new start. An expired binding is `gone` with cause `expired`, unless the dotenv names a different live session. A bound id that the listing shows in no live state is `gone`. The How line of `gone` (§Readers) is `dev --<platform> --eas --detach`.
- `dev --eas` binds, and stops the session that it started when Metro exits; a stop that took removes its binding.
- `--max-idle-time-minutes 30` on the session start, with the "Nonexistent flag" retry of §EAS, for the reason given there. The retry runs only when no session id was read. The event `dev:open_app_eas_flag_unsupported { flag }` records a retry. `smoke --eas` binds in both its start and its reuse branch. Smoke looks up the build of this fingerprint first; with none, it reuses a live session of the platform or fails with its own reason, and never starts one. Smoke stops its own session; a stop that took removes its binding.
- The start follow-ups and `status` read the own cloud bindings with a live lease, with no network call. They do not read the dotenv file. `status` maps an installed row that found no local device, while a live binding records a session of its platform, to `reason: 'cloud-session'` with no commands, in `collectStatusReportAsync`, so `--json` and the text agree. The device line lists the cloud sessions after the local fact, also when the device section is unavailable. dev-wait does not read the bindings.
- Tests: cloud-test (a reuse keeps the origin and `boundAt`, two starts at once keep the session the dotenv names, an expired cloud inspection writes nothing); the selection cases of cloudBinding-test and cloudSimulator-test; the binding, claim, race, unrecorded-start and idle-flag cases of openAppEas-test; the cloud binding cases of the status format-test. E2E (cloud-binding-test), on the stub's shared `STUB_SIM_STORE` with a repeatable `--status`: two worktrees, an expired binding, a queued or stopped bound session.

### Recovery by tag

**Status:** not built.

The session start passes no `--tag`, and no selection rule reads a tag. A registry that is lost leaves its session unbound; `dev:stop --eas` and the dotenv id still reach it. The tag rule below is the design for this section only.

- Selection adds a rung: a live `agent-device` session that carries the tag `agent-cli:<digest>` is a candidate, and a session found by tag is recorded as `started`.
- `--tag agent-cli:<digest>` on the session start, with the same "Nonexistent flag" retry and event. Any other failure is reported as it is, because a start can create a session and still exit non-zero.
- The tag field in `CloudSessionInfo`, named from a recorded `simulator:list --json` fixture that carries a tag. The tag match reads that one listing, with no second `eas` call.
- The runbook and a live test trimmed to the acceptance lists. `live-cloud` starts its session with `eas` directly, so the dotenv source stays and a reap never stops a `dotenv` session (§Records).
- Tests, named: `tag-matches-on-one-listing`, `tag-retry-only-on-nonexistent-flag`, with a stub version switch for the eas-cli skew (Risk 3).
