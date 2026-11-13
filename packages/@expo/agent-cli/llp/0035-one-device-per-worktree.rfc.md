# 0035: One device per worktree

**Type:** RFC
**Status:** Draft
**Systems:** device binding (`src/deviceBinding/`); local device selection and boot (`src/device/`, `src/navigate/device.ts`, `src/installedApp/`); `dev`, `dev --detach` and `dev:stop` (`src/dev/`); `smoke`'s device phases and cleanup (`src/smoke/`); the Metro runner (`src/start/startAsync.ts`); `status`; EAS session selection, the EAS open and `dev:stop --eas` (`src/device/cloudSimulator.ts`, `src/dev/easSession.ts`, `src/dev/openAppEas.ts`); the dev-server lock (`src/devLock/`); the e2e stubs `xcrun`, `adb`, `emulator` and `eas`
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-10-08
**Revised:** 2026-11-13
**Related:** [[0004-smart-start-and-project-state]], [[0005-runtime-loop-tools]], [[0010-agent-conventions]] (exit codes), [[0021-honest-reports]], [[0026-dev-owns-the-open]], [[0027-everything-on-eas]], [[0022-live-tier]]

## Summary

Developers run several agents on one Expo app in parallel, one agent per git worktree. Before this RFC the agents collided on devices:

- Every verb used the first booted simulator or the first `adb` device, so each agent replaced the app of the others.
- Each agent booted a device when none was booted, and nothing recorded whose it was.
- The emulator always booted on ports 5554 and 5555, so a second boot collided.
- `dev --eas` reused the newest session of the platform, which another worktree or a CI job could own ([[0027-everything-on-eas]] §Testing).

Decision [confirmed — Vojtech, 2026-09-30]: **each worktree gets its own device on each platform.** The device is a simulator this CLI created, an emulator instance this CLI spawned, a device the user named, or an EAS session this worktree started. A **binding** records it. Every verb of the worktree uses the bound device, never "the first booted" one.

| Question                         | Answer                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| Which verbs give a device?       | `dev` and `smoke` only (§Entry points). Every other verb reads the binding (§Readers).   |
| How long does a binding live?    | A 60 min lease, renewed by use and while Metro runs (§Lease).                            |
| Who ends a device?               | `dev:stop --release`, smoke's cleanup, and the reap of stale bindings (§Release, §Reap). |
| Which EAS session is this one's? | One that this worktree bound, or that `.env.eas-simulator` names (§EAS session binding). |

The design follows `appandflow/stim`: the CLI owns its devices, so it never classifies, adopts or takes over a device a human booted. An earlier design that adopted any free booted device worked, but was rejected for its size and its two sources of liveness.

The local registry is machine-wide, because only processes on this machine claim a local device. An EAS session can be claimed from any machine, so the service is the authority and the local binding is a cache of it. There is no daemon.

## Glossary

- **Root**: the canonical project root, the path the dev lock keys on. "Worktree" means the root. **Digest**: the hash of the root that the dev lock also uses.
- **Registry**: `<expo home>/agent-cli/bindings` and its lock. **Binding**: one JSON file in it per worktree, platform and backend. **Backend**: `local-ios`, `local-android` or `cloud`.
- **Lease**: the binding's `expiresAt`. **Live**: not past. **Expired**: past. **Stale**: expired, or the root is deleted.
- **Parked**: a `created` simulator binding whose lease expired; the file stays. Only simulators park.
- **Inventory**: what the platform tool lists: `simctl list devices -j`, or `adb devices -l` and `emulator -list-avds`.
- **Section**: one hold of the registry lock.
- **Let go**: what happens to a binding's device when its worktree, or a reap, is done with it (§Records).
- **Reap**: let go of other worktrees' stale bindings. **Release**: let go of this worktree's own bindings.
- **Session cap**: an EAS session lives at most 40 min on a normal-priority account and 115 min on a high-priority one. The reap and `status` use 115 min, the longest cap.
- **Dev lock**: the per-project lock that the process running Metro holds. "The lock" alone means the registry lock.
- **How line**: the last line of every CLI error, one next action.

## Decisions

1. **Hybrid ownership.** iOS: each worktree binds a simulator this CLI created. Android: every worktree boots its own instance of the first AVD, with `-read-only`, on a free even console port. The CLI never chooses a device a human booted; `dev --device` binds the device the human names. **Why:** owned devices need no classification, takeover or capacity rule. Simulators share a runtime and own a small data container; an AVD owns a large userdata image, and `-read-only` runs many instances off one image.
2. **Every Android instance is `-read-only`, the first one too.** **Why:** an agent never writes the human's AVD image, and the first and fifth worktree behave the same. The cost is a cold boot and a reinstall per instance start.
3. **Liveness is a 60 min lease, renewed by use. Nothing else.** No agent pid, no socket probe, no mtime. **Why:** one source of truth. Metro renews the lease, so a long Fast Refresh session never expires, and a crashed agent's binding is stale within 60 min.
4. **Only `dev` (with its EAS open and dev-wait) and `smoke` give a device. Every other verb reads the binding**, with one device-tool call per binding and no network call before the EAS rung. **Why:** the hottest verb must not pay for the rarest decision.
5. **A parked simulator is an expired `created` binding, not a second record.** A living worktree gets its simulator back on the next `dev`; a deleted worktree's simulator is deleted by the next reap. **Why:** one record cannot disagree with itself, and the worktree that paid for the native build keeps it. Nothing takes another worktree's simulator.
6. **A deleted worktree's bindings are stale at once.** Deleted means `lstat` of the root fails with `ENOENT`. **Why:** its simulator should not hold RAM for 60 min. An unmounted volume therefore loses its devices.
7. **Every registry write runs under one machine-wide lock, with write-then-rename.** The lock also covers `simctl create` and the emulator spawn, and no other device call. **Why:** a new device and the binding that names it appear in one section, so two `dev` runs in one worktree never make two devices; a read verb never waits on a boot.
8. **Every device that `dev` makes has a cleanup path**: lease renewal, release, smoke cleanup and the reap.
9. **`dev:stop` keeps the worktree's devices; `dev:stop --release` lets go of them.** **Why:** the restart follow-up is `dev:stop && dev --detach`, and a killed read-only instance costs a cold boot and a reinstall. The lease reclaims a stopped worktree's device within 60 min anyway.
10. **Also decided.** `start --ios` keeps Expo CLI's device choice, because `dev` is the verb that binds. `dev --no-open` still binds, because the build step must be pinned. Local devices come before an EAS session, because a session bills by the minute. `status` calls the network on every run ([[0011-impact-and-freshness]]).

## Contracts every verb honors

1. Only `dev` and `smoke` write a device into a binding. A read verb changes only `expiresAt`.
2. A read verb reads the binding and never lists devices to choose one. The one exception is `status --device`, which lists to filter and binds nothing.
3. Every binding write runs under the lock.
4. A `created` simulator is never deleted while a binding names it. A simulator no binding names is never touched.
5. A recorded emulator pid is killed only after its file is removed. Never `emu kill` by serial.
6. An `explicit` device is booted at most, never shut down or deleted.
7. Every process that runs Metro or a build step on a bound device renews the lease, and writes nothing for a binding it lost.
8. The EAS probe considers only sessions this worktree bound and the dotenv id.
9. The binding module imports nothing from `navigate`, `smoke`, `dev` or `installedApp`. A unit test enforces it.

## Records

A file is named `<digest>-<platform>-<backend>`, so a worktree has at most four. A binding holds the device, the `projectRoot`, `boundAt` and `expiresAt`. Code that acts on an existing file uses its stored `projectRoot`, never a recomputed digest, because a deleted worktree's canonical path can change. `dev` at a moved path gets a new device.

Origins:

| Origin            | Device                                  | The CLI may                                       |
| ----------------- | --------------------------------------- | ------------------------------------------------- |
| `created`         | a simulator this CLI created            | shut it down, park it, delete it                  |
| `spawned`         | an emulator instance this CLI spawned   | kill the emulator pid it recorded                 |
| `explicit`        | a device the user named with `--device` | boot it at most                                   |
| `cloud` `started` | an EAS session this CLI started         | stop it                                           |
| `cloud` `dotenv`  | the session `.env.eas-simulator` names  | only `dev:stop --eas` stops it; a reap never does |

Let go, one rule per origin, first match. The file action runs under the lock, the device action after it. A reap's delete or kill that fails writes the binding back, unless another binding took its file, so the next reap tries again.

1. A local device the inventory does not list or lists as unavailable, or a `spawned` instance whose pid is dead: remove the file.
2. `created` with a deleted root: remove the file, then `simctl delete`. "Not found" counts as success.
3. `created`: park, then `simctl shutdown`. An already shut-down simulator counts as success.
4. `spawned`: remove the file, then kill the pid only while the instance check holds: the pid is alive and, where `ps` exists, its arguments name `-avd <avd>` and `-ports <port>,<port+1>`. The binary name is never checked, because the launcher execs `qemu-system-<arch>`. When the check fails, the instance already exited and nothing is signalled.
5. `explicit`: expire the lease and keep the file, so the next `dev` reuses the named device. A deleted root removes the file. A release does not ask `adb` about an explicit serial, because `adb` does not list a phone that is off.
6. `dotenv`: remove the file.
7. `started`: remove the file, then stop the session under the binding's root, or under the caller's root when that root is deleted, because eas-cli reads the project and account from its directory. A failed stop is reported with the session id; the idle timeout or the session cap ends it.

A file with an unknown version, backend or origin from another worktree is skipped. An own file that does not parse is `unreadable`: `dev` refuses and read verbs report it. A created simulator is named `agent-cli <first 8 chars of the digest>`, so a leaked one shows whose it was. Names are never identity.

## Lease

- A lease lasts 60 min. A renewal sets it 60 min ahead.
- A renewal runs under the lock. A live lease is renewed. An expired or missing lease, or a file that now names another device, is `lost`, and nothing is written.
- A read verb waits 5 s for the lock: a timeout warns and goes on; `lost` refuses `gone`.
- While Metro (for `dev`, the detached child and `start`) or a build step runs, a timer renews every 5 min each of the worktree's binding files that exists, so a cloud binding that appears later is renewed too. A tick that cannot take the lock is skipped. The timer warns once when a binding changes to `lost`, and names the `dev` command of §Output and errors. A tick never throws.
- The foreground `dev` exit and the detached child touch no local binding. The lease expires on its own and the next reap parks or kills the device.

## Lock

- The lock is a directory renamed into place with a `pid-<pid>-<nonce>` marker inside it, so a lock never exists without a pid.
- A waiter polls every 100 ms. A lock whose pid is dead is removed, and a lock with no marker is removed. No nesting.
- `dev` and release wait 30 s; read verbs and the lease timer wait 5 s. The refusal `DEVICE_REGISTRY_LOCKED` names the pid, the lock's age and, where `ps` exists, the command.
- Under the lock: record reads and writes, the detached emulator spawn, and `simctl create` with a 20 s timeout. A timeout kills the child and refuses `create-timeout`. Every other device call runs after the section.

**Invariant.** A created simulator boots, shuts down or is deleted, and a spawned emulator is killed, only after a section that wrote or removed its binding. A child whose binding was never written is killed through its own process handle. The inventory is read before the lock. Acquisition records the binding's identity (absent, or backend and device id) before it reads the inventory, and checks it again under the lock. On iOS, a changed identity writes nothing and retries outside the lock; a changed lease or name does not count. After three attempts it refuses `DEVICE_UNAVAILABLE` reason `binding-changed`. On Android, the section reads the inventory again once when the own `explicit` serial is not in it, then binds.

## Choice

The choice is pure. It reads this worktree's binding, the other worktrees' bindings (each stale or not), the inventory and `--device`, and gives one of: reuse, create a simulator, spawn an emulator, bind the named device, or refuse.

- **Reuse** the own binding, live or expired, when its device is present, and write a new `boundAt` and `expiresAt`: an iOS simulator listed and available; a `spawned` instance whose instance check holds; an `explicit` serial that `adb` lists.
- **Create** on the newest iOS runtime that lists a mainstream iPhone, with its highest-numbered `iPhone <n> Pro`, else `iPhone <n>`, else `iPhone <n> Pro Max`, because the newest runtime can list only a device no app renders on [observed — iOS 27.1 lists only iPhone Duo, 2026-10-08]. Only when no runtime has one does the newest runtime's first iPhone apply. None: `no-ios-runtime`.
- **Spawn** on the first free even port in 5554..5584. A port is busy when an `emulator-NNNN` serial runs on it, a live Android binding holds it, or any Android binding's pid is alive. None: `no-free-port`, which names the serials and the worktrees that hold them. No AVD: `no-avd`.
- An own binding whose device is gone is removed in the section, and the choice goes on.

`--device`:

- It matches a simulator by name or udid, case-insensitive, and an emulator by serial only, because read-only instances share one AVD name. Two or more matches are `explicit-not-found` with the matches. With `--device`, Android reads only `adb devices -l`, so a USB phone needs no emulator package.
- A serial `adb` lists as `offline` or `unauthorized` is `explicit-not-ready`.
- A device another worktree's `created` or `spawned` binding names, live or stale, or its live `explicit` binding names, is `explicit-bound`. An expired foreign `explicit` binding is removed and the device is bound here: a named device belongs to whoever names it now.
- A simulator named `agent-cli …` that no binding names is `explicit-not-found`, so a leaked create is never bound.
- Over an own `spawned` instance that still runs, it refuses `own-explicit-over-owned`, because a replaced instance would be orphaned. Over an own `created` simulator, it deletes that simulator after the section and says so on stderr: the user named the device. An own `explicit` binding is replaced.

## Entry points

**Acquire** (`dev` and `smoke`). Skipped under `AGENT_CLI_NO_DEVICE`, and on a host that cannot run the platform's device (iOS off macOS, Android where `adb` does not resolve); there the run serves a device elsewhere and binds nothing. In one section: read the bindings, choose, write, reap. A refusal is thrown after the reap, so a deleted worktree's device does not block a rerun, and the reaped devices are let go of first. After the section every choice boots and verifies the device, whatever the inventory said: iOS with `simctl bootstatus <udid> -b`, Android by `sys.boot_completed`. A failed boot lets go of the binding this run wrote and refuses `boot-failed`. The caller prints the action (`reused`, `created`, `spawned`, `explicit`) as one line on stderr.

**Inspect** (read verbs). No lock, no renewal, no network, one device-tool call at most, with a 20 s timeout; `status` uses its own probe deadline. iOS reads `simctl list devices -j`; Android reads `adb get-state`, plus the instance check for a `spawned` binding; a cloud binding is read alone. The first matching row gives the state:

| Condition                                                                   | State                       | What a reader does                                                            |
| --------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| no own file                                                                 | `none`                      | next rung                                                                     |
| own file does not parse                                                     | `unreadable`                | refuse, exit 7                                                                |
| the device tool cannot run                                                  | `unknown`                   | with a platform flag: throw the tool error; without: next rung, then throw it |
| the device check timed out                                                  | `unknown`                   | refuse, exit 22                                                               |
| cloud, lease live                                                           | `recorded`                  | the EAS rung decides                                                          |
| lease expired                                                               | `gone`, cause `expired`     | next rung                                                                     |
| iOS listed `Booted`; Android `device` and, if `spawned`, the instance check | `up`                        | wins                                                                          |
| Android `spawned` failing the instance check                                | `gone`, cause `device-gone` | next rung                                                                     |
| device listed, not up (Android `offline`, `unauthorized`, still booting)    | `not-up`                    | refuse, exit 20                                                               |
| device not listed                                                           | `gone`, cause `device-gone` | next rung                                                                     |

A reader that drives an `up` device renews its lease once, per §Lease. It never inspects again and never boots.

**Release** is §Release. **Cloud binding** is §Session binding.

## Readers

- **Rung order.** With a platform flag and no `--eas`: that platform's local binding. With no flag: both local platforms, iOS on macOS only; any `up` wins, and of two `up` the newer `boundAt` wins, so after `dev --android` the agent drives the instance it just asked for. When none is `up`, the first state that is not `none`, iOS first, decides per the inspect table. Then `navigate` and `smoke` fall back to the EAS rung when this worktree has a cloud binding of any age or a dotenv id; `runtime:stop` and `runtime:reload` do not. With `--eas` the local rungs are skipped. A refusal reports the first non-`none` state, with its How line; with only `none`, it names the flag's platform, else iOS on macOS and Android elsewhere.
- **Scope.** A `runtime:*` command reads only the device bound to this worktree on the run's platform. A flag names the platform; with no flag, the bound device names it. Without `--eas` the bound device is the local binding with a live lease (of two, the newer `boundAt`), else the live EAS session binding of that platform (with no flag, only when exactly one platform has one). With `--eas` it is the session binding only. The binding file is the scope whether or not its device is up, and no device tool is read to choose it. An own binding file that cannot be read refuses `NO_BOUND_DEVICE`, exit 7, once the dev server answers. `AGENT_CLI_NO_DEVICE=1` skips the local bindings but keeps the EAS session binding. A flag never drops the bound device of its platform. The reload report names the scope as `{ platform, platformFrom, bound, device }`, and a read of an app prints the scope on stderr. Which app each device reads is [[0005-runtime-loop-tools]] §Which app a run reads.
- **Refusals.** A bound simulator that is shut down has no app: a read refuses `NO_APP_CONNECTED` and names the device. The How line names the other platform's flag only to a caller who named no flag. A local binding outranks a live session of this worktree, and the refusal says that only a command that takes `--eas` reaches the session.
- **Other readers.** `navigate` scopes to the device it resolved and reads no other worktree's binding. `smoke` scopes to the device it resolved, and before that to the binding the runtime readers use. `dev:wait` reads its flags only. `status` and the installed-app readers never renew a lease.
- **Android twins.** An Android app's name carries only the model. When another attached device has the same model, the run asks `adb reverse --list` on each, and reads only when the bound serial alone reverses this dev server's port. Otherwise it refuses `NO_APP_CONNECTED`, names the devices, and says how to remove the other forward.
- **The EAS rung** reads the registry once and makes one listing call with the ids of the live bindings. When it selects an own binding, it renews it. A probe that is `unknown` or `unavailable` gives no device, so the caller raises the signed-out or waitlist error. A bound session that is queued refuses `not-up` (retry in a minute). A queued or active session on another platform than the flag is a platform mismatch; an active session with no platform, read with no flag, is `CLOUD_SIMULATOR_PLATFORM_UNKNOWN`. A bound id the listing shows in no live state is `gone` (the session ended), and the rung writes nothing. In fallback mode a queued session or one on another platform is no device: the verb keeps its local refusal and adds an `Or:` line that names the session. The How line of a cloud `gone` is the `dev` command with `--eas`, which on a running server opens a session and binds it.
- **Known limits.** An expired or released own binding gives no scope, so the run reads by its flags. An expired foreign binding is no owner, so another worktree's app can be read again ([[0005-runtime-loop-tools]] §Target owner). An Android app that reaches Metro over `10.0.2.2` or a LAN address has no reverse, so beside a twin the read refuses.

## Reap

`dev`, `dev --eas` and `dev:stop` reap other worktrees' stale bindings, after the section's own write. A caller acts only on rows its inventory can decide; `dev --eas` and `dev:stop` have no inventory and take only the rows that need none.

| Stale binding                                   | Needs                      | Action                                                |
| ----------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| local, device not listed, or `spawned` pid dead | iOS inventory for iOS rows | remove the file                                       |
| `created`, root deleted                         | nothing (macOS)            | remove the file, then `simctl delete`                 |
| `created`                                       | iOS inventory              | park, then `simctl shutdown` unless listed `Shutdown` |
| `spawned`                                       | nothing                    | remove the file, then kill the pid                    |
| `explicit`, root deleted                        | nothing                    | remove the file                                       |
| `explicit`                                      | nothing                    | nothing: it is already expired and keeps its file     |
| `cloud` `started`, `boundAt` over 115 min ago   | nothing                    | remove the file                                       |
| `cloud` `started`                               | nothing                    | remove the file, then stop the session                |
| `cloud` `dotenv`                                | nothing                    | remove the file                                       |

- Each reaped device is reported on stderr and in JSON with the reason `expired`, `deleted-worktree`, `device-gone` or `session-cap`, and the worktree's root. A failed device action's How line names the step by hand: `xcrun simctl delete <udid>`, `xcrun simctl shutdown <udid>` or `kill <pid>`. `dev:stop` runs every action, reports the first error, and exits 20; `dev` warns and goes on.
- A reap reports device cleanup only (`devServerCleanup: 'not-checked'`). A deleted worktree's Metro may still run, and a binding is no proof of who owns a server.

## Release

`dev:stop --release` and smoke's cleanup let go of this worktree's local bindings. A release never reaps.

- `dev:stop` stops the dev server first. With `--release` it releases only when this worktree's own server stopped or is absent. It checks the own dev lock again before the release: a remaining or replacement server keeps the devices. A dev server that answers on `--port` and holds no lock of this worktree also keeps them, because a missing lock does not prove it is not this worktree's. A listener that does not answer as an Expo dev server does not keep them. A dev lock that says `finishing` counts as no running server.
- Under the lock a release acts only when the file still holds the binding it read: the same root, `boundAt` and device, and for a `spawned` instance the same AVD, port and pid. A renewed lease is the same binding. A replacement binding keeps its file and its device. A failed boot's cleanup targets only the binding that run wrote.
- `dev:stop` reaps once, whatever the stop outcome.
- Without `--release` the bindings stay, and `dev:stop` reports them as kept.

## Output and errors

- `dev:stop --json` always has `devices`, one row per binding: `released: true` for one it released, `null` for one it kept, `false` for a release that failed. `status --json` has `binding`, one row per readable file of the worktree (`platform`, `backend`, `id`, `name`, `origin`, `state`, `expiresAt`), cloud bindings unprobed.
- A device error that the detached child raises reaches the agent unchanged, with its code, exit and How line.
- Events: `cli:device_binding_reaped { reason }`, `cli:device_registry_lock_removed { lock, pid }`; `dev:stop_session` carries `platform`.
- The agent guide has a `## Devices` heading: run `dev` before `navigate`, `runtime:reload` or `runtime:stop`; never boot, shut down or delete a simulator named `agent-cli …`, or kill a `-read-only` emulator instance, yourself.

Exit codes per [[0010-agent-conventions]]. "The `dev` command" is `<cli> dev --<platform> --detach --wait-ready`.

| Code                     | Reason                    | Exit | What                                                                          | How                                                                               |
| ------------------------ | ------------------------- | ---- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `NO_BOUND_DEVICE`        | `none`                    | 20   | no <platform> device is bound to this worktree                                | the `dev` command                                                                 |
| `NO_BOUND_DEVICE`        | `gone`                    | 20   | the lease expired, or the device is gone                                      | the `dev` command                                                                 |
| `NO_BOUND_DEVICE`        | `not-up`                  | 20   | the bound device is not up                                                    | the `dev` command; a queued EAS session: run the command again in a minute        |
| `NO_BOUND_DEVICE`        | `unknown`                 | 22   | the device check timed out                                                    | run the command again                                                             |
| `NO_BOUND_DEVICE`        | `unreadable`              | 7    | the binding file <path> does not parse; a newer CLI may have written it       | `rm -f '<path>'`                                                                  |
| `DEVICE_UNAVAILABLE`     | `unreadable`              | 7    | the same                                                                      | `rm -f '<path>'`                                                                  |
| `DEVICE_UNAVAILABLE`     | `no-ios-runtime`          | 7    | no iOS runtime with an iPhone is installed                                    | `xcodebuild -downloadPlatform iOS`                                                |
| `DEVICE_UNAVAILABLE`     | `no-avd`                  | 7    | no Android virtual device exists                                              | create one in Android Studio                                                      |
| `DEVICE_UNAVAILABLE`     | `no-free-port`            | 20   | the serials and the worktrees that hold them; an unbound serial is "not ours" | `<cli> dev:stop --release` in a listed worktree                                   |
| `DEVICE_UNAVAILABLE`     | `explicit-bound`          | 20   | <name> is bound to the worktree <root>                                        | the caller's `dev` without `--device`                                             |
| `DEVICE_UNAVAILABLE`     | `explicit-not-found`      | 1    | no device matches <query>, or more than one does                              | the same command with `--device <first match>`; none: `simctl list`/`adb devices` |
| `DEVICE_UNAVAILABLE`     | `explicit-not-ready`      | 7    | adb lists <serial> as <state>                                                 | allow USB debugging or reconnect, then the same command                           |
| `DEVICE_UNAVAILABLE`     | `own-explicit-over-owned` | 1    | this worktree runs the emulator instance <serial>                             | `<cli> dev:stop --release`                                                        |
| `DEVICE_UNAVAILABLE`     | `create-timeout`          | 22   | the device tool did not answer in time                                        | run the command again                                                             |
| `DEVICE_UNAVAILABLE`     | `binding-changed`         | 22   | iOS: the binding changed during all three inventory attempts                  | run the command again                                                             |
| `DEVICE_UNAVAILABLE`     | `spawn-failed`            | 22   | the spawn error                                                               | run the command again                                                             |
| `DEVICE_UNAVAILABLE`     | `boot-failed`             | 20   | the boot's reason; the binding is let go of first                             | run the command again                                                             |
| `DEVICE_REGISTRY_LOCKED` | `locked`                  | 22   | pid N (<command>) has held the device registry for <age>                      | run the command again, or `kill <pid>` when it repeats                            |

### Lifecycle output

- **`status`'s next action.** With no live binding on the platform, it is the `dev` command plus the plan's own flags such as `--eas`, because every device verb refuses without one. An unreadable binding prefixes `rm -f '<path>' &&`. Beside a live own dev lock, a local request prefixes `dev:stop &&`, because a local detached `dev` stops on that lock; when that server runs an EAS session for the other platform, the prefix is `dev:stop --eas &&`, and the `why` says the session ends. While the dev server runs with an app connected, `status` keeps the plan's next action. Where `dev` binds no device (`AGENT_CLI_NO_DEVICE=1`, iOS off macOS, Android with no `adb`), `status` keeps the plan's next action too, or it would name the same `dev` command forever.
- **The last request.** A real `dev` start writes `.expo/agent-cli-last-dev.json` with its platform, port, device, build backend and app target; a dry run does not. It is a preference for recovery, not evidence of a live process. `status` chooses the platform from an explicit flag, then the last request, then a sole bound platform, then the project default. A different explicit platform drops the saved request's other choices. The port is a port named on `status`, the own dev lock's port, or the last requested port, unless that port serves another project. A probe chosen from the last request reports `source: 'last-request'`.
- **A detached `dev`** reads the binding before its final health checks, with the inspect timeout, and prints one `Device <name> (<id>) · <origin>` line; `--json` carries it under `device`, or `null` when the run binds none.

## How `dev` uses it

- **Order.** `dev` stops on a live dev lock of this project before it binds anything ([[0004-smart-start-and-project-state]] §A busy port). Then a named `--port` that cannot be bound refuses. Then the plan's other refusals (an EAS route nobody chose, the EAS project check). A building draft acquires only then, so no simulator is created for a run that then refuses. `--plan` never acquires.
- **Serving draft** (Expo Go, development client, bare). `dev` acquires after the port check and before the app-presence probe, and the probe runs on the acquired device. A device this run created has no app, so the probe answers "missing" without asking, even when no app id resolves. A shut-down simulator's apps are read off its disk.
- **Building draft.** The plan decides with no probe; `dev` acquires after the refusals.
- **Pinning.** Every `run` and `install` step gets `--device <udid or serial>`, replacing any the user gave. `expo run:android --device <serial>` needs SDK 58, because 57 matched by name only. The local open uses the acquired device and never chooses again.
- **`dev --plan`** reads the own binding without writing. An `up` or `not-up` binding pins the plan; otherwise the plan adds a reason that it will reuse or create the device and leaves the steps unpinned. Beside a live dev lock it reads nothing.
- **`dev --detach`.** The child acquires and never releases on exit. Its `DEVICE_*`, `NO_BOUND_DEVICE` and `DEV_SERVER_RUNNING` errors reach the parent unchanged. A local detached run beside this project's running server stops on the lock; an EAS run opens its session on that server (§Preserved sessions).

### `--device` on `dev`

- `--device <name, udid or serial>` binds that device, per §Choice. The detached child gets the flag, and every How line that repeats the caller's `dev` command repeats what the caller typed.
- With `--eas` it is `BAD_ARGS`, and so is a run that binds no local device (`--web`, `AGENT_CLI_NO_DEVICE`, a host that cannot run the device).
- `dev --plan --device` prints a `Device:` line and `explicitDevice` from the same choice, with no writes or boots: the device it binds, the expired foreign binding it takes over, the own simulator it deletes, or "Will refuse — <reason>". A refusal of the choice keeps the plan at exit 0; a tool error, timeout or unreadable binding fails the plan. A plan that stops on an EAS route nobody chose, or beside a running dev server, previews no device, because the run binds none.

## Android boot

Before the lock: `adb devices -l`, and `emulator -list-avds` unless `--device` is given or the own `explicit` serial is listed. In the section: the port choice, then `emulator -avd <avd> -ports P,P+1 -no-snapshot-save -read-only` spawned detached, then the binding with serial and pid. No pid refuses `spawn-failed`. After the section: poll `sys.boot_completed` until the boot timeout, while the child is alive and `adb` lists the serial. The child's output goes to `agent-cli-emulator-<port>.log` in the temp directory; a child that exits during the boot fails it with that file's last line and path.

[observed — live gate, SDK 58, `apps/eas-example`] A second `-read-only` instance boots beside the first and takes `adb reverse` and an install; an emulator on a taken port exits non-zero; the launcher keeps its pid; a cold boot plus the install fits the boot timeout.

## Lifecycle smoke

- In bootstrap mode `smoke` starts its own `dev --detach --no-open` child, which acquires; smoke boots nothing itself. After a reused dev server, or a child that reported the server already running, smoke's boot phase acquires. A device this run created needs an install. Smoke registers no shutdown of its own.
- One release per device. The child's device is released by smoke's `dev:stop` once the child exited, for its platform only. A device smoke's own boot phase bound is released by smoke's device cleanup. `smoke --no-start` binds and releases nothing.
- Smoke leaves a device as it found it: when the binding was live and the device up before the start, or the check did not answer, the device is `existing`, and smoke stops the dev server without a release.
- The report names the device in `environment.boundDevice` (`id`, `name`, `action`, `released`, `shutDown`) and a human `device` line. `action` is `created`, `spawned`, `explicit`, `reused` or `existing`; `released: null` is kept, `false` a failed release.
- Follow-ups: when no app connected and the run stopped its dev server, they lead with `dev --<platform> --detach --wait-ready`. When the run released its device and a reused server still runs, they lead with `dev:stop && dev --<platform> --detach --wait-ready --local`. All keep the caller's `--port`.

## EAS

- A session is a candidate only when the service lists it as pending or in progress and its id is bound or is the dotenv id. A queued bound session is reported as queued, never replaced by a new start. Other live sessions come back as `unbound`, for the report only.
- The session start passes `--max-idle-time-minutes 30` (eas-cli 22.6.0+). It limits the cost of a session no binding records, such as one whose start an agent's tool timeout killed before it returned an id.
- `.env.eas-simulator` holds the session's auth token. After every bind, the run asks `git check-ignore --no-index`. When git does not ignore the file, it appends `.env.eas-simulator` to `info/exclude`, never to `.gitignore`, and says so in one line. When a rule that wins over `info/exclude`, such as `!.env*`, still un-ignores it, the run warns and names that rule. When git tracks the file, the run names `git rm --cached` and never runs it. Outside a git repo it does nothing.

[read — eas-cli 24.7.0 and the service code, 2026-10-01] `eas simulator` accepts `--name` and `--tag` (eas-cli 23.2.0+); no field carries a client identity. `maxIdleTimeMinutes` is opt-in. Sessions queue behind the plan's job concurrency rather than fail. A `--json` start writes the session id to `.env.eas-simulator` once the session is ready.

## EAS session binding

An EAS session belongs to the worktree that started it. `dev --eas` and `smoke --eas` bind; `dev:stop --eas` ends this worktree's sessions; a plain `dev:stop` keeps them. The session start passes no `--tag`, so a lost registry leaves its session unbound; `dev:stop --eas` and the dotenv id still reach it.

### Session guard

- Every cloud device verb carries the id of the session it selected to execution.
- `eas simulator:exec` loads `.env.eas-simulator` and starts a guard, not the controller. The guard compares the loaded `EAS_SIMULATOR_SESSION_ID` with the selected id. On a match it starts the controller with the same environment. On a missing or different id it exits 20 and starts nothing, so a dotenv that another run replaced cannot change the session the controller drives.
- A mismatch is `CLOUD_SESSION_MISMATCH`, with `data.selectedSessionId` and `data.loadedSessionId`. Its suggested command is `dev:stop --eas`. No command writes an existing session's connection back to the file, so the message never asks the caller to edit it.
- The guard passes the controller target through the Windows `npx.cmd` shim unchanged, spaces, quotes, `^`, `%`, `&` and newlines included.
- The screenshot never throws on a mismatch; it reports the message as the reason for no picture. A report's `command` is the logical `eas simulator:exec npx agent-device@latest …`, not the guard.

### Session discovery

- The listing asks for every pending status (`new`, `queued`, `starting`) and `in-progress`, and follows every page, because a session not on page 1 has not ended.
- A page that fails, cannot be read, or lists more pages with no cursor gives `unknown`; so do more than 10 pages. `unknown` starts no session.
- A pinned eas-cli that refuses `--status queued` (24.8.0 and older) fails the listing, so no session starts.
- `navigate --eas` on a queued session says that the session is not up yet. `dev:stop --eas` stops a queued session.

### Session binding

- **Selection.** Among candidates (§EAS), the order is: the requested platform, then a bound id, then the dotenv id, then the newest `createdAt`. A selected pending session is `queued`, an in-progress one `active`. A bound id that the listing shows in no live state is `inactive`, after the availability check, so an account without EAS Simulator still answers `unavailable`.
- **Claim.** Before the probe, `dev --eas` and `smoke --eas` renew this platform's expired binding under the lock, so a reap in another worktree cannot stop that session while the listing runs, and count it as bound. When the probe does not select that session, the old lease end is written back, so a failed open does not keep a dead binding live. An unreadable binding file of this platform refuses before the probe. `navigate` still refuses an expired binding.
- **Binding points.** Every session id the open obtains is bound: a reuse, a new start, and a start that failed after it created the session, so a later reap can stop it. A reuse of a `started` binding keeps its `origin` and `boundAt`. A binding that cannot be written fails the open, and the open stops the session it started at once, unless a `dotenv` binding in this worktree already records it.
- **Two starts at once** in one worktree: only the session the dotenv names can be driven, so the bind keeps that one and stops the other. A run that stops its own session fails and names the session that stays.
- **The cloud rung** writes nothing but the selected binding's lease (§Readers). An expired binding is `gone` unless the dotenv names a different live session.
- **Stops.** The foreground `dev --eas` stops the session it started at exit. `smoke --eas` stops the session it started. Smoke never compiles a build for a new session; with none it fails with its own reason ([[0027-everything-on-eas]] §smoke).
- **Reports.** The start follow-ups and `status` read the own cloud bindings with a live lease, with no network call and no dotenv read. `status` reports an installed row with no local device, beside a live session binding of its platform, as `reason: 'cloud-session'`. dev-wait does not read the bindings.

### Session cleanup

- `dev:stop --eas` stops the probe's session (active or queued, bound or dotenv) and the session of every other cloud binding of this worktree, expired ones included. In one lock section it removes those bindings; then it stops the sessions one after another. A failed stop writes its binding back for a retry, and its reason names `eas simulator:stop --id <id>` as the command that ends it. When the lock cannot be taken, it still stops the sessions, keeps the bindings, and says the record remains.
- `dev:stop --eas` exits 0 when every known session stopped or none exists. A probe that is `unknown` or `unavailable` reports its reason in `session.reason`, never in `deviceError`. `deviceError` names a failed stop, a lock error or an unreadable cloud binding file.
- A plain `dev:stop` keeps cloud bindings and reports each as "recorded, not checked" ([[0021-honest-reports]]), with `dev:stop --eas` as the next step.
- A session this run started and stops (foreground `dev --eas` exit, `smoke --eas`, an unbound start) is kept, not stopped, when a `dotenv` binding records it, the binding file is unreadable, or the lock cannot be taken; the run reports it as kept.
- **Reap.** A `dotenv` binding of a stale worktree is removed and never stopped. A `started` one is stopped, unless it is past the session cap. The line that stops a deleted worktree's session says why another worktree stops it: "Stopped EAS Simulator session <id> of worktree <path>: that worktree no longer exists, so no other command can stop it."
- **`status`** names the sessions of deleted worktrees that a reap would stop, from their files, with no `eas` call and no lock, as recorded, not checked, that may still bill (`orphanSessions` in `--json`). The first follow-up is plain `dev:stop`, whose reap stops them; with this worktree's dev server running, it is `eas simulator:stop --id <id>`.
- A session stopped by hand keeps its binding until a reap, which stops it again with no error, because eas-cli answers a stopped session as stopped.

### One session per worktree

eas-cli keeps one session's connection in `.env.eas-simulator`, only a session start writes it, and `simulator:exec` drives only the session it names (§Session guard). So one worktree drives one session.

- The open starts no session when the probe selects a live or queued session of this worktree on the other platform, bound or named only by the dotenv. It fails, binds nothing and stops nothing. Its message names `dev:stop --eas`, which ends the existing session.
- Its How line names the command that uses the existing session: `navigate / --eas --<its platform>` beside a running dev server, and `dev --<its platform> --eas --detach` before any server exists.
- A detached run asks the same question before it spawns the child, so the refusal is its exit code. It asks the service only when a binding or the dotenv points at a session on the other platform.
- Two starts at once on two platforms can still bind two sessions; the guard refuses the one the dotenv does not name.

### Preserved sessions

- **A detached `dev --eas` keeps its session.** The child keeps its session and binding when Metro exits, so a plain `dev:stop` keeps both and `dev:stop --eas` ends them. The foreground `dev --eas` still stops the session it started. The detached report's last follow-up is `dev:stop --eas`, with the bound id. A detached `dev --eas` that fails after it spawned the child names `dev:stop --eas`.
- **`--wait-ready` waits for the session.** The registry decides, with a poll every second and no network call. The wait ends on a live cloud binding of the platform whose `boundAt` is at or after the spawn, or, once the child's lock says its open returned, on the binding from before the spawn that the child reused and renewed. A binding whose lease is still expired does not count. An open that returned with no such binding ends the wait at once with exit 22 `DEV_DETACH_SESSION_PENDING`, because the child binds only inside its open. The budget is 180 s after the bundler and the tunnel (`AGENT_CLI_EAS_SESSION_WAIT_MS`), because an Android session binds 105 to 120 s after the tunnel. At the deadline it exits 22 `DEV_DETACH_SESSION_PENDING` with `pid`, `url`, `tunnelUrl`, `platform` and `waitedMs`, and names the same command. On success the report carries `eas.sessionId`. Without `--wait-ready` nothing waits, and the `Session` row says `--wait-ready` waits for it.
- **A re-run follows a child that is still starting its session** instead of opening a second one. It follows when the lock names this EAS platform and does not say the open returned, the detached log names the lock's live pid, no live binding of the platform exists, no binding of the platform has a `boundAt` at or after the lock's `startedAt`, and the lock is younger than the child's start window (the tunnel wait plus the session start timeout, 17 min). The child's lock says so when its open returns, bound or failed. A port retry keeps that mark and renews `startedAt`. A lock from an older child reads as not finished. Outside that condition the run reopens: it reuses the session the dotenv names and binds it again.
- **Metro stops during the session start.** The run keeps its dev lock and the lock says `finishing` until the start returns the id it binds; the port is free. A `dev:stop` that reads `finishing` reports the dev server stopped, offers no SIGKILL (which would lose that id), and names `dev:stop --eas` first. `dev:stop --eas` beside `finishing` waits until the lock says the open returned, or closes, then stops the sessions; at the end of the start window, and no later than 180 s, it stops nothing, reports `session.id: null` with the reason, and exits 22. A run with no EAS open has no `finishing`. A start that returns after Metro stopped binds only when the listing still shows the session, or cannot be read.
- **A reopen beside a running Metro.** `dev --eas --detach` checks the Metro's health first (with `--wait-ready`, waits for it to be ready), then reuses the bound session or starts one and binds it. A Metro with no tunnel refuses `DEVICE_UNAVAILABLE`, and its How line is `dev:stop`, then `dev --<platform> --eas --detach`. A development build looks up a build id only for a new session, so a reuse makes no lookup. A failed open fails with `DEVICE_UNAVAILABLE`; the other-platform refusal is thrown as it is.
- **A new tunnel.** A reused development-client session gets the connection URL of the current tunnel, read from the manifest, not the log. The open refuses a URL whose host is not that tunnel, so a LAN or loopback URL is never sent. A bare app scheme has no Metro address and can keep the old tunnel after a restart.

## Risks

Each accepted race costs one rerun of `dev`, never a lost build or a touched human device.

1. A reused pid can hold the registry lock until a human reads the message. Where `ps` does not exist, a reused emulator pid can be killed, and `dev` can drive whatever answers on the serial.
2. The service's idle-timeout semantics are unread; 30 min may stop a session during a long pause.
3. A crash or a 20 s timeout during `simctl create` leaks one `Shutdown` simulator named `agent-cli …`, which nothing adopts or deletes. A cold `simctl list` took 2.6 s, so `status`'s 2.5 s probe can report `unknown` on a cold machine.
4. In bootstrap mode, `smoke` on a development-build project compiles onto the worktree's simulator, not onto one that already has the app.
5. After a plain `dev:stop`, a cloud binding expires in 60 min unless a verb renews it; the next reap elsewhere then stops a `started` session. A session of another EAS account cannot be stopped from this machine.
6. An emulator that takes over an `explicit` serial after ours exits reads as `up`; Contract 6 keeps it unharmed. An instance answers `device` before `sys.boot_completed`, so a read can reach it a few seconds early.
7. `dev:stop --release` during a build step of the same worktree finds no server, releases the device, and the build fails; the agent reruns `dev`, which reuses the device.
8. A plain `dev:stop` leaves the device up until its lease expires and a reap parks or kills it. After `git worktree move`, the next reap deletes the old path's simulator while its Metro may still run.
9. A shutdown runs after the section, so it can hit a simulator that a later section reused in the same seconds; that `dev` fails and is rerun.
10. One parked simulator per living worktree stays on disk with its build. `git worktree remove` reclaims it on the next reap.
11. A worktree created at a deleted worktree's path has the same digest and inherits its bindings, devices and session.

## Not built

The agent's pid in the binding; taking another worktree's simulator; a cap on parked simulators; allocation from "any free booted device"; capacity from CPUs and RAM; a heartbeat or mtime touch; a lock-free write path; dev-lock socket liveness; a writable first emulator; `emu kill` by serial; `--device` on `navigate`; a "still booting" inspect state; stopping the old session when the cloud id changes; deleting `.env.eas-simulator` on `dev:stop --eas`, because the registry lock does not cover eas-cli's write of that file.

**Recovery by tag** is designed, not built: the start would pass `--tag agent-cli:<digest>`, and selection would accept a live session that carries this worktree's tag and record it as `started`, so a lost registry could find its session again from one listing.

## Open questions

1. Where does the service run the idle check, and what counts as activity?
2. Should `--device <session-id>` with `--eas`, `BAD_ARGS` today, bind a session another tool started?

## Testing

The e2e tier uses two fixture worktrees, one stub `xcrun`/`adb`/`emulator`/`eas`, and one shared Expo home. Device cases run with `AGENT_CLI_NO_DEVICE=0`; iOS cases skip off macOS, Android device cases skip on win32. The stub `eas` loads the connection file as eas-cli does and runs the real guard.

| Contract                                     | Tests                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| §Contracts every verb honors, Contract 9     | `src/deviceBinding/__tests__/boundary-test.ts`                                                                                                     |
| §Lock, §Choice, §Entry points, §Android boot | `src/deviceBinding/__tests__/` (`registry`, `acquire`, `acquireConcurrency`, `inspect`, `ios`, `android`, `explicit`)                              |
| §Readers                                     | `rungs-test.ts`, `cloudRung-test.ts`, `e2e/__tests__/runtime-bound-selection-test.ts`, `navigate-target-selection-test.ts`                         |
| §Lease, §Reap, §Release                      | `lifecycle-test.ts`, `reap-test.ts`, `stopLifecycle-test.ts`, `e2e/__tests__/device-lifecycle-test.ts`                                             |
| §How `dev` uses it                           | `e2e/__tests__/dev-test.ts` (two worktrees, two devices), `dev-device-test.ts`                                                                     |
| §Lifecycle smoke                             | `src/smoke/__tests__/smokeDeps-test.ts`, `phases-test.ts`, `e2e/__tests__/smoke-test.ts`                                                           |
| §EAS session binding                         | `cloud-test.ts`, `cloudSimulator-test.ts`, `openAppEas-test.ts`, `detachAsync-test.ts`, `stopAsync-test.ts`, `e2e/__tests__/cloud-binding-test.ts` |
| On real devices and sessions                 | `e2e-live/`; a change to the EAS path is proven only there ([[0022-live-tier]])                                                                    |
