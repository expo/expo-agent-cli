# 0035: One device per worktree

**Type:** RFC
**Status:** Draft
**Systems:** device binding (`src/deviceBinding/`); local device boot and selection (`src/device/`, `src/navigate/device.ts`, `src/installedApp/`); `dev` and `dev:stop` (`src/dev/`); `smoke`'s device phases (`src/smoke/`); the Metro runner (`src/start/startAsync.ts`); `status`; EAS session selection and the guard (`src/device/cloudSimulator.ts`, `src/device/cloudCommand.ts`), the EAS open (`src/dev/openAppEas.ts`, `src/dev/easSession.ts`); the dev-server lock (`src/devLock/`); the e2e stub `e2e/stubs/eas.js` and the `adb` and `emulator` stubs that `e2e/__tests__/installedAppStubs.ts` writes
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-10-08
**Revised:** 2026-11-14
**Related:** [[0004-smart-start-and-project-state]], [[0005-runtime-loop-tools]], [[0010-agent-conventions]] (exit codes), [[0021-honest-reports]], [[0026-dev-owns-the-open]], [[0027-everything-on-eas]], [[0025-dev-requires-platform]], [[0022-live-tier]]

## Summary

Developers run several agents on one Expo app in parallel, one agent per git worktree. Without a binding the agents collide on devices:

- Every verb uses the first booted simulator or the first `adb` device, so each agent replaces the app of the others.
- When no device is booted, each agent boots one, and nothing records whose it is.
- The emulator always boots on ports 5554 and 5555, so a second boot collides.
- `dev --eas` takes the newest in-progress session of the platform, which another worktree or a CI job may own.

Decision [confirmed — Vojtech, 2026-09-30]: **each worktree gets its own device on each platform.** A **binding** records it. Every verb of that worktree uses the bound device and never "the first booted" one.

| Device                    | Origin     | Who makes it            | The CLI may                     | Let go             |
| ------------------------- | ---------- | ----------------------- | ------------------------------- | ------------------ |
| iOS simulator             | `created`  | `dev`, `smoke`          | boot, shut down, park, delete   | park and shut down |
| Android emulator instance | `spawned`  | `dev`, `smoke`          | kill the instance it spawned    | kill               |
| A device the user named   | `explicit` | `dev --device`          | boot, never shut down or delete | park               |
| EAS session               | `started`  | `dev --eas`, `smoke`    | stop                            | stop the session   |
| EAS session of the dotenv | `dotenv`   | adopted from the dotenv | stop only on `dev:stop --eas`   | forget the binding |

The CLI owns its devices instead of adopting any free booted device. That removes device classification, adoption and takeover. The model follows `appandflow/stim`, which solves the same problem for agents in worktrees.

## Prior art

- **Detox** keeps `device.registry.json` under an exclusive file lock and removes entries with dead pids.
- **Callstack simlock** is a daemon that gives out TTL leases and deletes only devices it created.
- **appandflow/stim** gives each worktree a device the tool created and writes every lease under a lock. Its liveness is process identity, which does not fit this CLI: our verbs are short processes, and nothing runs between two `navigate` calls.
- **Expo CLI** `run:ios` uses the first booted simulator; `adb reverse` runs on every attached device.

Rejected: adopt any free booted device. It needs a full device inventory on every verb and liveness from two sources.

## Where exclusivity comes from

The claimants of a device decide where its ownership record lives. Only processes on this machine claim a local device, so a machine-wide file registry sees all of them. Agents on any machine, CI and other clients claim an EAS session, and only the service sees all of them. So the registry is the authority for local devices, and for EAS sessions it records what this machine started. No daemon.

## Glossary

- **Root**: the canonical project root of the Expo app, the path the dev-server lock keys on. In a monorepo it is the app directory inside the worktree. "Worktree" in this RFC means the root. **Digest**: the hash of the root that the dev-server lock also uses.
- **Registry**: the directory `<expo home>/agent-cli/bindings` and its lock. **Binding**: one JSON file in it per worktree, platform and backend. **Backend**: `local-ios`, `local-android` or `cloud`.
- **Lease**: the binding's `expiresAt`. **Live**: not past. **Expired**: past. **Stale**: expired, or the root is deleted (Decision 6).
- **Park**: set a binding's `expiresAt` to now and keep the file.
- **Inventory**: what the platform tool lists: `simctl list devices -j`, or `adb devices -l` and `emulator -list-avds`.
- **Section**: one hold of the registry lock.
- **Let go**: what happens to a binding's device when its worktree, or a reap, is done with it (§Records).
- **Reap**: let go of other worktrees' stale bindings. **Release**: let go of the own bindings (`dev:stop --release`, smoke's cleanup).
- **Session cap**: the longest an EAS session runs on the service (EAS facts 2). The reap uses 115 min.
- **How line**: the last line of every CLI error, one next action.

## Decisions

1. **Hybrid ownership.** iOS: each worktree binds a simulator this CLI created. Android: every worktree boots its own instance of one AVD on a free even console port. The CLI never chooses a device a human booted; `--device` binds the device the human names.
   **Why.** Owned devices need no classification, takeover or capacity rule, and a human's device is never hijacked. Simulators share one runtime and own a small data container; an AVD owns a userdata image of several GB, and `-read-only` runs many instances off one image.
2. **Every Android instance is `-read-only`, the first one too.**
   **Why.** An agent never writes the human's AVD image, and the first and the fifth worktree behave the same. The cost is a cold boot and a reinstall per instance start.
3. **Liveness is a 60 min lease, renewed by use. Nothing else.** No agent pid, socket probe or mtime.
   **Why.** One source of truth. Metro renews the lease on a timer, so a long Fast Refresh session never expires, and a crashed agent's binding is stale within 60 min. A pid would add a second source and a pid-reuse risk (Risk 8 is the one case it would catch).
4. **Only `dev` (with its EAS open) and `smoke` allocate. Every other verb reads the binding**, with one device-tool subprocess per binding and no network call before the EAS rung.
   **Why.** The hottest verb must not pay for the rarest decision.
5. **A parked simulator is an expired `created` binding, not a second record.** A living worktree gets it back on the next `dev`; a deleted worktree's simulator is deleted by the next reap.
   **Why.** One record type cannot disagree with itself, and the worktree that paid for the native build keeps it. Nothing takes another worktree's simulator: `simctl create` is cheap, and the app on it is a foreign build anyway.
6. **A deleted worktree's bindings are stale at once.** Deleted means `lstat` of the root fails with `ENOENT`.
   **Why.** Its simulator should not hold RAM for 60 min. A parent check cannot tell a removed monorepo worktree from an unmounted volume, so there is none (Risk 13).
7. **Every registry write runs under one machine-wide lock, with tmp+rename. The lock also covers `simctl create` and the emulator spawn, and no other device call.**
   **Why.** A create under the lock ties the new device to its binding in one section, so two `dev` runs in one worktree never make two devices. A read verb never waits on a boot or a shutdown. The races that remain each cost one rerun of `dev` (§Risks).
8. **`dev:stop` keeps the worktree's devices; `dev:stop --release` lets go of them now.**
   **Why.** The restart follow-up is `dev:stop && dev --detach`, and a killed read-only instance costs a cold boot and a reinstall. The lease reclaims a stopped worktree's device within 60 min anyway.
9. **Decided, not open.** `start --ios` keeps Expo CLI's device choice, because `dev` is the verb that binds. `dev --no-open` still binds, because the build step must be pinned. Local devices come before an EAS session, because a session bills by the minute.

## Invariant

A created simulator boots, shuts down or is deleted, and a spawned emulator is killed, only after a section that wrote or removed its binding for that action. A child whose binding was never written is killed through its own process handle.

The inventory is read before the lock and may be seconds stale. iOS acquisition records the binding identity, `(backend, device id)` or none, before it reads the inventory, and checks it again under the lock. A changed identity writes no own binding and retries outside the lock (the section's reap still runs); lease and name changes do not count. After three attempts it refuses `DEVICE_UNAVAILABLE` reason `binding-changed`, exit 22.

## Contracts every verb honors

| #   | Rule                                                                                                                                                                                         | Test                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Only `dev` (with its EAS open) and `smoke` write a device into a binding. A read verb changes only `expiresAt`.                                                                              | `src/deviceBinding/__tests__/inspect-test.ts`, `cloudRung-test.ts`                         |
| 2   | A read verb reads its binding and never lists devices to choose one; it spawns one device-tool subprocess per binding it inspects, plus `ps` for the instance check of a `spawned` instance. | `src/deviceBinding/__tests__/inspect-test.ts`                                              |
| 3   | No code outside `src/deviceBinding/` lists devices to select one. `status --device` lists to filter and binds nothing.                                                                       | the filter: `src/installedApp/__tests__/android-test.ts`; the rest: none (Open question 3) |
| 4   | Every binding write runs under the lock.                                                                                                                                                     | `src/deviceBinding/__tests__/registry-test.ts`, `acquire-test.ts`                          |
| 5   | A `created` simulator is never deleted while a binding names it. A simulator no binding names is never touched.                                                                              | `src/deviceBinding/__tests__/reap-test.ts`, `explicit-test.ts`                             |
| 6   | A recorded emulator pid is killed only after its file is removed, and only while the instance check holds. Never `emu kill` by serial.                                                       | `src/deviceBinding/__tests__/android-test.ts`, `reap-test.ts`                              |
| 7   | `explicit` devices are booted at most, never shut down or deleted.                                                                                                                           | `src/deviceBinding/__tests__/explicit-test.ts`, `lifecycle-test.ts`                        |
| 8   | Every process that runs Metro or a build step on a bound device renews the lease, and on a lost lease writes nothing for that binding.                                                       | `src/deviceBinding/__tests__/lifecycle-test.ts`                                            |
| 9   | The EAS probe considers only sessions this worktree bound and the dotenv session.                                                                                                            | `src/device/__tests__/cloudSimulator-test.ts`                                              |
| 10  | `src/deviceBinding/` imports nothing from `navigate`, `smoke`, `dev` or `installedApp`.                                                                                                      | `src/deviceBinding/__tests__/boundary-test.ts`                                             |

## Records

One file per worktree, platform and backend, named `<digest>-<platform>-<backend>.json`, so a worktree has at most four. Code that acts on an existing file uses the root stored in it, never a recomputed digest, because a deleted worktree's canonical path can change. `dev` at a moved path gets a new device. A binding stores the device, the root, `boundAt` (the session-cap clock; a cloud reuse keeps it) and `expiresAt`.

**States.** A binding file is absent, `unreadable`, live or expired; stale is derived (Glossary). Acquire and the cloud bind write a live file. A renew keeps a live file live and writes nothing for a lost one (§Lease); the one exception is the EAS open's provisional renew (§Session binding). Local release and the reap apply the let-go table below: release parks own `created` and `explicit` bindings, a reap parks other worktrees' `created` ones, and every other row removes the file. A failed device action writes back the file it removed, unchanged, unless another binding took the file; a failed Android release kill writes it back expired. An `unreadable` file refuses the verbs that read it, and its How line removes it. A device no binding names is never touched by a later run, except a session the dotenv names, which `dev:stop --eas` stops. A run stops a session it started and could not bind, or lost to a concurrent start, itself (§Session binding), unless it keeps it (§Entry points, Cloud release). Other such devices come from, for example, a leaked create (Risk 4), a start that died before it returned an id (§Session start), a rebind that replaced a session id (§Not built), or a failed delete, kill or stop whose file another binding took (Risk 15); the failure names the device.

Let go, one rule per binding, first match. The file action runs under the lock, the device action after it. "Reap needs" is the inventory a reap must hold to act on the row; `dev:stop` and the cloud bind hold none.

| Binding                                                                   | Let go                                                                           | Reap needs                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| local, device not listed or unavailable; `spawned` whose instance is gone | remove the file                                                                  | iOS inventory for iOS; nothing for `spawned` |
| `created`, root deleted                                                   | remove the file, then `simctl delete` ("not found" is success)                   | nothing                                      |
| `created`                                                                 | park, then `simctl shutdown` (skipped when the reap's inventory says `Shutdown`) | iOS inventory                                |
| `spawned`                                                                 | remove the file, then kill the pid while the instance check holds                | nothing                                      |
| `explicit`, root deleted                                                  | remove the file                                                                  | nothing                                      |
| `explicit`                                                                | park; a reap leaves it                                                           | —                                            |
| `cloud` `started`, `boundAt` past the session cap                         | remove the file                                                                  | nothing                                      |
| `cloud` `started`                                                         | remove the file, then stop the session                                           | nothing                                      |
| `cloud` `dotenv`                                                          | remove the file; the reap never stops it                                         | nothing                                      |

- **Instance check.** The pid is alive and, where `ps` exists, its arguments name `-avd <avd>` and `-ports <port>,<port+1>`. Never the binary name: the `emulator` launcher execs `qemu-system-<arch>`, so the pid stays and the name does not. A failed check means the instance already exited; nothing is signalled.
- **Explicit Android.** Release does not ask `adb` about an `explicit` serial, because `adb` does not list a phone that is off.
- **Session stop.** A `started` session stops under the binding's root, or under the caller's root when that root is deleted, because eas-cli reads the project and account from its directory. A failed stop is reported with the session id; the idle timeout or the session cap ends it.
- **Parsing.** A foreign file with an unknown version, backend or origin is skipped. An own file that does not parse is `unreadable` (§Output and errors).
- **Names.** A created simulator is named `agent-cli <first 8 chars of the digest>`. Names are never identity.

## Lease

- 60 min, renewed every 5 min by a running Metro or build step. A renewal of a live lease writes a new `expiresAt`; an expired or missing one, or, for a read verb, a file that now names another device, is **lost**, and nothing is written.
- A read verb renews with a 5 s lock wait. A lock timeout warns and goes on; a lost lease refuses `gone`.
- Metro (for `dev`, the detached child and `start`) and the build steps of a plan run inside a renewal timer. Each tick renews every file of the worktree that exists, so a cloud binding made after Metro started and a parked simulator that `dev --detach` revived are both kept alive. A tick that cannot take the lock in 5 s is skipped. The timer warns once per change to lost, with the `dev` command of §Output and errors (`--eas` for a cloud file), and never throws.
- The foreground `dev` exit and the detached child touch no local binding; the lease expires on its own.

## Lock

- The lock is a directory `.lock` in the registry whose marker names the holder's pid. A `.lock` never exists without its marker, so every CLI version on the machine can tell a dead holder from a live one.
- A waiter polls every 100 ms. It removes a dead pid's lock, and a `.lock` with no marker. No nesting.
- Waits: acquire and release 30 s; read verbs and the timer 5 s. The refusal names the holder's pid, the lock's age and, where `ps` exists, its command.
- Under the lock: record reads and writes, `simctl create` (20 s timeout; a timeout kills the child and refuses `create-timeout`), and the detached emulator spawn. Every other device call runs after the section.

## Choice

The choice is a pure function of the own binding, the other worktrees' bindings (each marked stale or not), the inventory and `--device`.

- **Reuse.** The own binding, live or expired, whose device is present (iOS: listed and available; `spawned`: the instance check; `explicit` Android: serial listed). An own binding whose device is gone is removed in the section, and allocation goes on.
- **iOS create.** The newest available iOS runtime that lists a mainstream iPhone, with its highest-numbered `iPhone <n> Pro`, else `iPhone <n>`, else `iPhone <n> Pro Max`. Only when no runtime has one does the newest runtime's first iPhone apply (Risk 14). None: `no-ios-runtime`.
- **Android spawn.** The first AVD of `emulator -list-avds` (none: `no-avd`) on the first free even console port in 5554..5584. A port is busy when `adb` lists its `emulator-NNNN` serial in any state, a live Android binding holds it, or a binding's emulator pid is alive. None free: `no-free-port`, naming each serial and its worktree.
- **`--device`.** It matches a simulator by name or udid, case-insensitive, and an emulator by serial only, because instances share one AVD name.
  - Two or more matches, or none: `explicit-not-found` with the matches. A simulator named `agent-cli …` that no binding names is not found, so a leaked create is never bound.
  - A serial that no other candidate matches and that `adb` lists in a state other than `device` (`offline`, `unauthorized`, `no permissions`): `explicit-not-ready`.
  - `--device` whose one match is the own bound device reuses that binding, origin unchanged, before the rules below.
  - Another worktree's `created` or `spawned` binding, live or stale, or its `explicit` binding that is not stale: `explicit-bound`. Another worktree's stale `explicit` binding is removed and the device is bound here, because a named device belongs to whoever names it now.
  - The own binding is a `spawned` instance that passes the instance check, and `--device` names another device: `own-explicit-over-owned`, because one file per platform cannot hold both, and the instance would be orphaned.
  - The own binding is `created`: the `explicit` binding replaces its file in the section, the simulator is deleted after it, and the deletion is reported on stderr. The user named a device, so the replacement is what they asked for.
  - With `--device`, Android reads only `adb devices -l` and skips `emulator -list-avds`: a USB device needs no emulator package.
  - `--device` is refused (`BAD_ARGS`) with `--eas`, and on a run that binds no local device (`--web`, `AGENT_CLI_NO_DEVICE`, a host that cannot run the platform's device).
  - `dev --plan --device` previews the choice without writes or boots: the device it binds, the expired foreign binding it takes, the own simulator it deletes, or "Will refuse — <reason>" with that How command, while the plan exits 0. Only a choice refusal prints so; a tool error, a timeout or an unreadable binding fails the plan as it fails the run.

## Entry points

- **Acquire** (`dev`, `smoke`). Read the inventory; a tool that cannot run is a tool error, one that does not answer in time is `create-timeout`. One section: read the bindings, choose, write, reap. A refusal is thrown after the reap and after the reaped devices' actions, so a deleted worktree's device never blocks a rerun and a reaped emulator never runs without a file. After the section, boot and verify on every choice, whatever the inventory said (iOS `simctl bootstatus <udid> -b`; Android `sys.boot_completed`). A failed boot lets go of the binding that run wrote and refuses `boot-failed`. Acquisition is skipped under `AGENT_CLI_NO_DEVICE`, under `--eas`, and on a host that cannot run the platform's device (iOS off macOS; Android where `adb` does not resolve), where `dev` serves for a device elsewhere.
- **Inspect** (every reader). Lock-free, no renewal, no network, one device-tool subprocess at most. The device check has a 20 s timeout; `status` uses its own probe deadline. `state` is the first row that matches:

| Condition                                                                                         | `state`                     | Rung loop                                                                                                     |
| ------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| no own file                                                                                       | `none`                      | next rung                                                                                                     |
| own file does not parse                                                                           | `unreadable`                | refuse, exit 7                                                                                                |
| the device tool cannot run or fails                                                               | `unknown`                   | with a platform flag: throw the tool error; without: next rung, throw the first tool error after the EAS rung |
| the device check timed out                                                                        | `unknown`                   | refuse, exit 22                                                                                               |
| cloud, lease live                                                                                 | `recorded`                  | the EAS rung decides                                                                                          |
| lease expired                                                                                     | `gone`, cause `expired`     | next rung                                                                                                     |
| local, up: iOS `Booted`; Android `get-state` `device` and, if `spawned`, the instance check holds | `up`                        | wins                                                                                                          |
| local, `spawned` failing the instance check                                                       | `gone`, cause `device-gone` | next rung                                                                                                     |
| local, device listed (Android `offline`, `unauthorized` or still authorizing)                     | `not-up`                    | refuse, exit 20                                                                                               |
| local, device not listed                                                                          | `gone`, cause `device-gone` | next rung                                                                                                     |

- **Use.** A reader that drives the device takes an `up` inspection and renews the lease per §Lease. It never inspects again and never boots.
- **Cloud bind.** Every session id the EAS open obtains is bound, a reuse and a start that failed after it created the session included, so a later reap can stop it. A reuse of the same id keeps `boundAt` and `origin`. When two starts on the same platform ran at once in this worktree, the bind keeps the session `.env.eas-simulator` names, because only that one can be driven (§Session guard), and stops the other.
- **Cloud release.** `dev:stop --eas` removes the own cloud bindings of the given ids in one section, then stops each session in order, whatever its origin. The cloud rows of §Records apply only to a reap. A failed stop writes its binding back. When the lock cannot be taken, it still stops the sessions and keeps the bindings. A run that stops only the session it started (foreground `dev --eas`, `smoke --eas`, a start it could not bind) keeps a session whose binding is `dotenv`, an unreadable file, or a lock it cannot take.

## Readers

- **Rung order.** With a platform flag and no `--eas`: that platform's local binding. With no flag: both local platforms, iOS on macOS only; any `up` wins, and of two `up`, the newer `boundAt`, so after `dev --android` the agent drives the instance it just asked for. When none is `up`, the first state that is not `none`, iOS first, decides per the inspect table. When every local rung passed, `navigate` and `smoke` fall back to the EAS rung when this worktree has a cloud binding at any age, an unreadable cloud binding file of the platform asked, or a dotenv id; `runtime:stop` and `runtime:reload` do not. With `--eas`, the local rungs are skipped. A row that refuses (`unreadable`, a timeout, `not-up`) throws at once; else the refusal reports the first non-`none` state with its How line; with only `none`, it names the flag's platform, else iOS on macOS and Android elsewhere.
- **Scope.** A `runtime:*` command reads only the device bound on the run's platform. A flag names the platform, and with no flag the bound device names it. Without `--eas`, that is the own local binding of the platform while its lease is live (with no flag: both platforms, the newer `boundAt`), else the own live EAS session binding of the platform (with no flag, when exactly one platform has one). With `--eas`, only the session binding. The binding file is the scope whether or not its device is up; no device tool runs to choose it. An own binding file that cannot be read on a platform the run considers refuses `NO_BOUND_DEVICE`, exit 7, once the dev server answers. `AGENT_CLI_NO_DEVICE=1` skips the local files, and an EAS session binding still scopes the run. The reload report names the scope as `{ platform, platformFrom, bound, device }`. Which app each bound device reads is [[0005-runtime-loop-tools]] §Which app a run reads.
- **Refusals.** A bound simulator that is shut down has no app, so a read refuses `NO_APP_CONNECTED` and names the device. The How line names the other platform's flag only to a caller who named no flag. A local binding outranks a live session of this worktree: with no flag, a shut-down bound simulator beside a live session reads nothing, and the refusal says only a command with `--eas` reaches the session.
- **Other readers.** `navigate` scopes to the device it resolved and reads no other worktree's binding. `smoke` scopes like the runtime readers until it resolves a device. `dev:wait` uses its flags only. The installed readers of `status` inspect without renewal, because `status` never writes.
- **A local Android device** is placed by model, because its app's name carries only the model. When another attached device has the same model, the run asks `adb -s <serial> reverse --list` on each of them, again for each new target list, and reads only when the bound serial alone reverses this dev server's port. Otherwise it refuses `NO_APP_CONNECTED`, names the devices and says how to remove the other reverse.
- **The EAS rung** reads one snapshot of the registry and makes one probe, with the live bound ids (this platform's first). A selected own binding is renewed per §Lease. With `--eas`, a probe that is `unknown` or `unavailable` answers the signed-out or waitlist error whatever the leases say; in fallback mode it is no device, and the local refusal stands. A queued bound session refuses `not-up` ("is not up yet", How: retry in a minute). A session on another platform than the flag is a platform mismatch; an active session that reports no platform, read with no flag, is `CLOUD_SIMULATOR_PLATFORM_UNKNOWN`. A bound id the listing shows in no live state refuses `gone` and writes nothing (Contract 1). In fallback mode a queued or other-platform session is no device: the verb keeps its local refusal and names the session in an `Or:` line. The How line of a cloud `gone` or `unreadable` is the `dev` command with `--eas`, which opens a session on a running server and binds it.
- **Known limits.** An expired or released own binding gives no scope, so the run reads by its flags. A foreign binding whose lease expired is no owner ([[0005-runtime-loop-tools]] §Target owner). An Android app that reaches the dev server over `10.0.2.2` or a LAN address has no reverse, so beside a device of the same model the read refuses.

## Reap

Runs inside acquire, the cloud bind and `dev:stop`, on other worktrees' stale bindings, after the section's own write. Each caller takes only the rows of §Records its inventory can decide. Each reaped device is reported on stderr and in JSON with reason `expired`, `deleted-worktree`, `device-gone` or `session-cap`, and the event `cli:device_binding_reaped`. A failed device action's JSON `error` ends with the manual step: `xcrun simctl delete <udid>`, `xcrun simctl shutdown <udid>`, `kill <pid>` or `eas simulator:stop --id <id>`. `dev:stop` reports the first such error as `deviceError` and exits 20; acquire prints it and goes on.

A reap reports device cleanup only (`devServerCleanup: 'not-checked'`). A deleted worktree's CLI or Metro processes may remain, and its output says so; a device binding is no evidence about who owns a server. A late last-build write does not recreate a deleted worktree.

## Output and errors

- `dev:stop` JSON always has `devices`: what `--release` let go of, or, on a plain stop, the kept bindings with `released: null`. `false` is a release that failed.
- `status --json` has `binding`, one entry per readable file of the worktree (an unreadable file has none) (`platform`, `backend`, `id`, `name`, `origin`, `state`, `expiresAt`), cloud bindings unprobed.
- A `DEVICE_UNAVAILABLE`, `DEVICE_REGISTRY_LOCKED` or `NO_BOUND_DEVICE` error from the detached child reaches the agent unchanged: code, exit, data and How line.
- The `dev` command of a How line is `<cli> dev --<platform> --detach --wait-ready`, with `--eas` for a cloud binding.
- The agent guide has a `## Devices` heading: run `dev` before a device verb, and never boot, shut down or delete an `agent-cli …` simulator yourself.

| Code                     | Reason                    | Exit | How                                                                                                          |
| ------------------------ | ------------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `NO_BOUND_DEVICE`        | `none`, `gone`, `not-up`  | 20   | the `dev` command; a queued EAS session: retry in a minute                                                   |
| `NO_BOUND_DEVICE`        | `unknown` (timeout)       | 22   | run the command again                                                                                        |
| `NO_BOUND_DEVICE`        | `unreadable`              | 7    | `rm -f '<path>'`, then the `dev` command                                                                     |
| `DEVICE_UNAVAILABLE`     | `unreadable`              | 7    | `rm -f '<path>'`, then the same command                                                                      |
| `DEVICE_UNAVAILABLE`     | `no-ios-runtime`          | 7    | `xcodebuild -downloadPlatform iOS`                                                                           |
| `DEVICE_UNAVAILABLE`     | `no-avd`                  | 7    | create one in Android Studio's Device Manager                                                                |
| `DEVICE_UNAVAILABLE`     | `no-free-port`            | 20   | `<cli> dev:stop --release` in one of the listed worktrees                                                    |
| `DEVICE_UNAVAILABLE`     | `explicit-bound`          | 20   | the caller's `dev` without `--device`                                                                        |
| `DEVICE_UNAVAILABLE`     | `explicit-not-found`      | 1    | the same command with `--device <first match>`; none: `xcrun simctl list devices available` or `adb devices` |
| `DEVICE_UNAVAILABLE`     | `explicit-not-ready`      | 7    | allow USB debugging or reconnect, then the same command                                                      |
| `DEVICE_UNAVAILABLE`     | `own-explicit-over-owned` | 1    | `<cli> dev:stop --release`                                                                                   |
| `DEVICE_UNAVAILABLE`     | `create-timeout`          | 22   | run the command again                                                                                        |
| `DEVICE_UNAVAILABLE`     | `binding-changed` (iOS)   | 22   | run the command again                                                                                        |
| `DEVICE_UNAVAILABLE`     | `spawn-failed`            | 22   | run the command again                                                                                        |
| `DEVICE_UNAVAILABLE`     | `boot-failed`             | 20   | run the command again                                                                                        |
| `DEVICE_REGISTRY_LOCKED` | `locked`                  | 22   | run the command again, or `kill <pid>` when it repeats                                                       |

## How `dev` uses it

- The start-plan resolver serves `dev`, `smoke` and `status`; only `dev` acquires. For a native platform without `--eas`, a draft binds after the `web`/`none` exit and before every other exit, so an `expo-go`, `--no-open` or EAS-build run still binds a device. The order of the other exits is in the resolver.
- Acquisition runs only for a run that passed the dev-server lock. Beside this project's running server, a local `dev` (also `--detach`) stops on the lock before it binds a device ([[0004-smart-start-and-project-state]] §A busy port). A named `--port` that cannot bind refuses before acquisition.
- A building draft acquires after the `--plan` return and after the refusals (the EAS route and project checks), so no simulator is made for a run that then refuses.
- The probe answers `missing` without asking on a device the run just created or spawned, because a fresh device never has the app. On iOS a `Shutdown` simulator's apps are read off its disk.
- Every `run` and `install` step of the plan is pinned to the bound device (`--device <udid or serial>`, replacing any `--device` there). The local open uses the same device and does not select or boot again.
- With this project's live dev-server lock, a plan inspects no binding and pins nothing. `dev --plan` never acquires. It reports the own binding as reused when it is `up` or `not-up`; otherwise it leaves the steps unpinned and adds "will reuse or create a simulator" (Android: "start an emulator instance").
- `dev --detach`: the child acquires and never releases on exit. Its `DEVICE_*`, `NO_BOUND_DEVICE` and `DEV_SERVER_RUNNING` failures reach the parent unchanged. A detached `dev` prints one `Device <name> (<id>) · <origin>` line, where the origin is how the device came to be bound; `--json` has it under `device`, or `null`.

## Android boot

- Before the lock: `adb devices -l` and `emulator -list-avds`. In the section: the port choice and the spawn `-avd <avd> -ports P,P+1 -no-snapshot-save -read-only`, then one binding with serial and pid. No pid: `spawn-failed`.
- After the section: poll `sys.boot_completed` until the boot timeout, accepted only while the child is alive and `adb devices` lists the serial. A child that exits during the boot fails it with the last line of `agent-cli-emulator-<port>.log` in the temp directory, truncated at each spawn.
- `get-state` on a booting instance says `device offline`: that is `not-up`, not `unknown`. Only "not found" is missing.
- Android selection needs SDK 58: several instances of one AVD are addressed by serial, which `run:android --device` takes from SDK 58 on.
- A live gate on SDK 58 confirmed the basis of this design: a second `-read-only` instance boots beside the first and takes `adb reverse` and an install; an emulator on a taken port exits non-zero; the launcher keeps its pid; a cold boot plus the install fits the boot timeout.

## Release

- **Release** lets go of the own local bindings, or one platform's. Under the lock it acts only when the file still holds the binding it read: the same root, `boundAt` and device, and for a `spawned` instance the same AVD, port and pid. A renewed `expiresAt` is the same binding. So stale inventory, an earlier cleanup or a replacement binding never loses its file or its device. Release never reaps.
- A plain `dev:stop` (Decision 8) reports the devices as kept. Every `dev:stop`, with or without `--release`, runs the reap once, whatever the stop outcome; release itself never reaps. Under `AGENT_CLI_NO_DEVICE=1`, no `dev:stop` releases, reports a local binding or reaps; `dev:stop --eas` still stops the sessions.
- `dev:stop --release` lets go of the local bindings only when this worktree's own server stopped or is absent. It checks the own dev-server lock again first: a remaining or replacement server keeps the devices, and so does a dev server that answers on `--port` but holds no lock of this worktree, because a missing lock proves nothing. A listener on `--port` that is not an Expo dev server does not keep them. A `finishing` lock ([[0004-smart-start-and-project-state]]) counts as no server.
- A refused stop reports the listener's measured state; what it cannot identify is `null`.

## Lifecycle smoke

- Smoke binds through the same acquire as `dev`, and skips it under `AGENT_CLI_NO_DEVICE`. It installs onto a device the run just created or spawned without reading it first.
- One release per device. A device the `dev --detach` child bound is released when smoke stops that child, for smoke's platform only. A device smoke's own boot phase bound, after a reused dev server, is released by smoke's cleanup. `smoke --no-start` binds and releases nothing.
- Smoke leaves a device as it found it. When the binding was live and the device up before the start, or the check did not answer, the device is `existing` and smoke stops the server without a release.
- The report names the device in `environment.boundDevice` (`id`, `name`, `action`, `released`, `shutDown`): `action` is `created`, `spawned`, `explicit`, `reused` or `existing`; `released: null` is kept, `false` a failed release.
- When smoke released its device and a reused server still runs, the first follow-up is `dev:stop && dev --<platform> --detach --wait-ready --local`. Follow-ups keep the caller's `--port`.

## Lifecycle output

- With no live binding on the platform, `status`'s next action is the `dev` command, plus the plan's own flags such as `--eas`. An unreadable binding prefixes `rm -f '<path>' &&`. Beside a live own dev-server lock, a local request prefixes `dev:stop &&`; when that server runs an EAS session of the other platform, `dev:stop --eas &&`, and the `why` says the session ends.
- While this project's server runs with an app connected, and where `dev` binds no device (`AGENT_CLI_NO_DEVICE=1`, iOS off macOS, Android with no `adb`), `status` keeps the plan's next action.
- `status` chooses the platform from an explicit flag, then the EAS platform of this worktree's running server, then the last `dev` request, then a sole bound platform, then the project default. An explicit flag for another platform discards the saved request. The recovery port is the port `status` was pointed at, else the own lock's, else the last request's, unless another project serves it. The last request (`.expo/agent-cli-last-dev.json`: platform, port, device, build backend, app target) is written before a real `dev` startup, never by a dry run. It is a preference, not evidence of a live process.

## EAS session binding

An EAS session belongs to the worktree that started it. The registry records which sessions this machine started; the service decides which sessions are live. [[0027-everything-on-eas]] uses these rules and does not repeat them.

### Session start

- The start passes `--max-idle-time-minutes 30`. A start that an agent's tool timeout kills before it returns an id leaves a session with no binding; the idle timeout limits its cost.
- `.env.eas-simulator` holds the session's auth token. After every bind, and after a start that ends unbound because Metro stopped, the run asks `git check-ignore --no-index`. When git does not ignore the file, the run appends `.env.eas-simulator` to `info/exclude` (never `.gitignore`), once, and says so. When a rule that wins over `info/exclude` still un-ignores it, the run warns and names that rule. When git tracks the file, the run warns and names `git rm --cached`; it never runs it. Outside a git repo it does nothing.

### Session guard

- Every cloud device verb carries the selected session id to execution. `eas simulator:exec` loads `.env.eas-simulator` and starts a local guard with that environment. The guard starts the controller only when the loaded `EAS_SIMULATOR_SESSION_ID` equals the selected id. Else it exits 20, starts nothing, and the run refuses `CLOUD_SESSION_MISMATCH` with both ids (`selectedSessionId`, `loadedSessionId`) and the How line `dev:stop --eas`.
- The guard checks the environment the controller gets, so a dotenv another run replaces during the command cannot change the session.
- The screenshot never throws: a mismatch is its reason for no picture. A report's `command` is the logical `eas simulator:exec npx agent-device@latest …`, not the guard.

### Session discovery

- `simulator:list` asks for every pending status (`new`, `queued`, `starting`) and `in-progress`, and follows the cursor while more pages exist, up to 10 pages. A page that fails, or lists more pages with no cursor, makes the probe `unknown`.
- A probe that is `unknown`, or an account with no EAS Simulator, starts no session.
- A queued session that a binding or the dotenv names, on the requested platform, is never replaced by a new start; the open asks for a retry in a minute. A queued session on another platform is a platform mismatch. `dev:stop --eas` stops a queued session.

### Session binding

- A candidate is a live `agent-device` session whose id is bound or is the dotenv id. The order: the requested platform, a bound id, the dotenv id, then the newest `createdAt`. A selected pending session is `queued`, an in-progress one `active`. A bound id in no live state is `inactive`. Live sessions that are not candidates are `unbound`, reported and never selected.
- The rung loop and `dev:stop --eas` pass the live bound ids. The EAS open of `dev --eas` and `smoke --eas` passes this platform's bindings at any age and the other platform's live ones. It first renews this platform's expired lease under the lock, so a reap elsewhere cannot stop a session still alive while the listing runs; when the probe does not select it, the old lease end is written back.
- An unreadable binding file of this platform refuses before the probe, and no session starts.
- The EAS open binds whenever it has a session id. A binding that cannot be written fails the open. A session no binding records belongs to no run, so the open stops a session it started and could not bind, unless a `dotenv` binding records that id. The check and the stop decision are one section; the stop runs after it, and a lock that cannot be taken keeps the session.
- The foreground `dev --eas` and `smoke --eas` stop the session they started at exit. `smoke --eas` passes no build id: with no EAS build of this fingerprint it fails its gate and starts nothing.
- The cloud rung writes only the lease of the selected binding. An expired binding does not hide a different live session that the dotenv names.
- The start follow-ups and `status` read the own live cloud bindings, with no network call and no dotenv. `status` maps an installed row with no local device, beside a live binding of its platform, to `reason: 'cloud-session'` with no commands.

### Session cleanup

- `dev:stop --eas` stops the probe's session (active or queued, bound or dotenv) and every other cloud binding of this worktree, expired ones included. It needs no `--release`. A stop that worked while the lock was not taken leaves the binding with `released: null` and says the record remains. `deviceError` names a failed stop, a lock error or an unreadable cloud file. A probe that is `unknown` or `unavailable` reports its reason in `session.reason`, not `deviceError`, so the stop exits 0 when every known session stopped.
- A plain `dev:stop` keeps cloud bindings and reports each as recorded, not checked ([[0021-honest-reports]]), with `dev:stop --eas` next.
- A reap that stops a deleted worktree's `started` session (§Records) says why: "Stopped EAS Simulator session <id> of worktree <path>: that worktree no longer exists, so no other command can stop it."
- `status` names the `started` sessions of deleted worktrees inside the session cap from their files, with no `eas` call and no lock: a `billing` line says they are recorded, not checked, and may still bill, and `--json` has `orphanSessions`. The command is `dev:stop`, whose reap stops them; beside a running dev server of this worktree it is `eas simulator:stop --id <id>`.
- A session stopped by hand keeps its file until a reap, which stops it again with no error, because eas-cli answers a stopped session as stopped.

### One session per worktree at the open

- eas-cli keeps one session's connection in `.env.eas-simulator`, only a start writes it, and the guard drives only that session. So the EAS open starts no session while this worktree has a live or queued session on another platform, bound or named by the dotenv. The refusal binds and stops nothing and names `dev:stop --eas`.
- Its How line names the command that uses the existing session: `navigate / --eas --<its platform>` beside a running dev server, and `dev --<its platform> --eas --detach` in the detach pre-check, before the child spawns. For a session that reports no platform, it names only `dev:stop --eas`.

### Preserved sessions

- The detached `dev --eas` child keeps its session and binding when Metro exits, so a plain `dev:stop` keeps both and `dev:stop --eas` owns their cleanup. The detached report's last follow-up is `dev:stop --eas`.
- **`--wait-ready` waits for the session.** The registry is the authority: the wait ends on a live cloud binding of the platform bound at or after the spawn, or, once the child's lock says `easOpenFinished`, on the platform's binding from before the spawn that the child reused and renewed. A finished open with no such binding ends the wait at once with exit 22 `DEV_DETACH_SESSION_PENDING`; so does the deadline, with `pid`, `url`, `tunnelUrl`, `platform` and `waitedMs`. The budget is 180 s after the bundler and the tunnel (`AGENT_CLI_EAS_SESSION_WAIT_MS`), because an Android session binds up to 120 s after the tunnel. It polls the registry each second, with no network call.
- **A child still starting its session is followed, not reopened.** A rerun beside a Metro follows the child when the lock names this EAS platform, does not say `easOpenFinished`, line 1 of the detached log names the lock's pid and that pid is alive, no binding of the platform is live or bound since the lock's `startedAt`, and the lock is younger than the start window (17 min: the 2 min tunnel wait plus the 15 min start timeout). Outside that condition the rerun reopens; beside a `finishing` lock it refuses ([[0004-smart-start-and-project-state]]).
- **A finishing run binds its session.** When Metro stops during the session start, the run keeps its dev-server lock as `finishing` until the start returns the id it binds, so nothing may kill it: a SIGKILL would lose that id. `dev:stop --eas` beside a `finishing` lock waits until the open finished or the lock is gone, until the start window ends or 180 s pass, whichever comes first, then stops the sessions; at that deadline it stops nothing and exits 22. A start that returns after Metro stopped binds only when the listing still shows the session, or cannot be read.
- **An existing Metro can get a fresh session.** `dev --eas --detach` beside a running Metro checks its health, then opens the app through the EAS open: it reuses the bound session or starts one and binds it. A Metro with no tunnel refuses `DEVICE_UNAVAILABLE`, How: `dev:stop`, then `dev --<platform> --eas --detach`. A development build looks up its build id only when it starts a session.
- A reused development-client session gets the connection URL of the current tunnel, built from the tunnel host the manifest names now. The open refuses a URL whose host is not that tunnel, so LAN or loopback is never sent.

## Not built

The agent's pid in the binding; a take of another worktree's simulator; a cap on parked simulators; allocation from any free booted device; capacity from CPUs and RAM; mtime touch, lock token or heartbeat; a lock-free write path; dev-lock socket liveness; a writable first emulator; `emu kill` by serial; `--device` on `navigate`; a "still booting" inspect state; a stop of the old session when the cloud id changes; deleting `.env.eas-simulator` on `dev:stop --eas` (the registry lock does not cover eas-cli's write of it).

## EAS facts

Read in eas-cli 24.7.0 and the service source, 2026-10-01.

1. `eas simulator` accepts `--name` and `--tag`; both come back in `simulator:list --json`, and the list filters by tag. No field carries a client identity.
2. `--max-idle-time-minutes` stops a session after that many idle minutes; without it there is no idle timeout. The run time is capped at 40 min for normal-priority accounts and 115 for high-priority ones.
3. Sessions queue behind the plan's job concurrency; parallel agents wait, they do not fail.
4. A `--json` start writes the session id to `.env.eas-simulator` once the session is ready.

## Risks

Each accepted race costs one rerun of `dev`, never a lost build or a touched human device.

1. A reused pid of an unrelated process holds the registry lock until a human reads the message. Where `ps` does not exist, a reused emulator pid can be killed, and a verb can drive whatever answers on the serial.
2. A pinned eas-cli 24.8.0 or older rejects `--status queued`, so the listing fails, the probe is `unknown` and no session starts.
3. The service's idle semantics are unread; 30 min may stop a session during a long pause.
4. A crash or a timeout during `simctl create` leaks one `Shutdown` `agent-cli …` simulator; nothing deletes it. A cold `simctl list` can exceed `status`'s probe deadline, so `status` reports `unknown`.
5. `smoke` on a development-build project compiles onto the worktree's simulator, not onto one that already has the app.
6. After a plain `dev:stop`, a cloud binding expires in 60 min unless a verb renews it; another worktree's reap then stops a `started` session. A session of another EAS account cannot be stopped from this machine.
7. A different emulator that takes an `explicit` serial reads as `up`; Contract 7 keeps it unharmed. An instance answers `get-state` before `sys.boot_completed`, so a read verb can reach it seconds early.
8. `dev:stop --release` during a build step of the same worktree finds no server and shuts down the simulator under the build. The next verb reports `gone` and the agent reruns `dev`.
9. A simulator left `Booted` stays up until its lease expires and a reap with an iOS inventory parks it. After `git worktree move`, the next reap deletes the old path's simulator while its Metro may still run.
10. Shutdowns run after the section, so a reap can shut down a simulator that a later section reused in the same seconds; that `dev` fails and is rerun.
11. A sleep over 60 min with a server that `start` runs loses the device.
12. Without a cap, each living worktree keeps one parked simulator with its build on disk until the worktree is removed.
13. A worktree created at a deleted worktree's path inherits its bindings, devices and session. The bindings of an unmounted volume are stale, so its simulator is deleted and its emulator killed.
14. The newest iOS runtime may list only a device no app renders on [observed — iOS 27.1 lists only iPhone Duo, 2026-10-08]; the choice prefers a mainstream iPhone across runtimes.
15. A device whose delete, kill or stop failed after another binding took its file keeps running with no file. The failure names the device and nothing retries; a failed Android release kill does not print the `kill <pid>` step.
16. Two EAS opens at once on two platforms can each bind a session. The guard drives only the one the dotenv names; the other bills until `dev:stop --eas`, which stops every cloud binding of the worktree, or until its idle timeout.
17. Under `AGENT_CLI_NO_DEVICE=1` no renewal timer runs, but `dev --eas` still binds its session, so that binding expires 60 min after the bind or a verb's last renewal while Metro runs, and another worktree's reap can then stop the `started` session.

## Open questions

1. Where does the idle check run on the service, and what counts as activity?
2. Should `--device <session-id>` with `--eas`, refused as `BAD_ARGS` today, bind a session another tool started?
3. Should a lint or boundary test enforce Contract 3: no listing of devices to select one outside `src/deviceBinding/`, and `status --device` binds nothing?
4. Should each start pass `--tag agent-cli:<digest>`, with a selection rung for a live session of that tag recorded as `started`, so a lost registry does not leave a session unbound? Today `dev:stop --eas` and the dotenv id still reach it.

## Testing

| Contract                                                                      | Test                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §Invariant, §Lock                                                             | `src/deviceBinding/__tests__/acquireConcurrency-test.ts`, `registry-test.ts`                                                                                                                 |
| §Records, §Reap                                                               | `src/deviceBinding/__tests__/reap-test.ts`, `android-test.ts`, `records-test.ts`; `e2e/__tests__/device-lifecycle-test.ts`                                                                   |
| §Lease                                                                        | `src/deviceBinding/__tests__/lifecycle-test.ts`; `src/dev/__tests__/devAsync-test.ts`, `src/start/__tests__/startAsync-test.ts`                                                              |
| §Choice                                                                       | `src/deviceBinding/__tests__/ios-test.ts`, `android-test.ts`, `explicit-test.ts`                                                                                                             |
| §Entry points, §Readers                                                       | `src/deviceBinding/__tests__/acquire-test.ts`, `inspect-test.ts`, `rungs-test.ts`, `cloudRung-test.ts`; `e2e/__tests__/runtime-bound-selection-test.ts`, `navigate-target-selection-test.ts` |
| §Output and errors                                                            | `src/deviceBinding/__tests__/errors-test.ts`                                                                                                                                                 |
| §How `dev` uses it, §Android boot                                             | `src/deviceBinding/__tests__/android-test.ts`; `e2e/__tests__/dev-device-test.ts`, `dev-test.ts`; `src/dev/__tests__/devAsync-test.ts`                                                       |
| §Release, §Lifecycle output                                                   | `src/dev/__tests__/stopLifecycle-test.ts`, `lastRequest-test.ts`; `e2e/__tests__/device-lifecycle-test.ts`                                                                                   |
| §Lifecycle smoke                                                              | `src/smoke/__tests__/smokeDeps-test.ts`; `e2e/__tests__/smoke-binding-test.ts`                                                                                                               |
| §Session guard, §Session discovery                                            | `src/device/__tests__/cloudCommand-test.ts`, `cloudSimulator-test.ts`, `cloudErrors-test.ts`                                                                                                 |
| §Session start, §Session binding, §Session cleanup, §One session per worktree | `src/deviceBinding/__tests__/cloud-test.ts`; `src/dev/__tests__/openAppEas-test.ts`, `stopAsync-test.ts`; `e2e/__tests__/cloud-binding-test.ts`                                              |
| §Preserved sessions                                                           | `src/dev/__tests__/detachAsync-test.ts`, `detachEasProgress-test.ts`, `detachRunningServer-test.ts`, `reopenEas-test.ts`, `stopAsync-test.ts`; `e2e/__tests__/cloud-binding-test.ts`         |
