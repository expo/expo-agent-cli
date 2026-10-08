# 0033: Release, park, reap, `--device`, and the lease that outlives a pause

**Type:** Plan
**Status:** Draft
**Systems:** `src/deviceBinding/reap.ts` (new); `releaseWorktreeDevicesAsync`; `dev:stop` and its `--release` flag (`src/dev/stopAsync.ts`, `src/dev/resolveStopOptions.ts`); the Metro runner (`src/start/startAsync.ts`); `status --json`; `smoke`'s cleanup; the live tier (`e2e-live/`)
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-10-08
**Related:** [[0030-one-device-per-worktree]] (the rules), [[0031-ios-binding]], [[0032-android-instance]], [[0021-honest-reports]]

PR 4 of [[0030-one-device-per-worktree]] §Delivery. Requires [[0032-android-instance]]. Merges as one unit with 3a and 3b.

## Question

What happens when a worktree stops, pauses or disappears, and how does a person pick a device?

## State it leaves

- `dev:stop` keeps the worktree's devices; `dev:stop --release` parks the simulator and kills the emulator instance.
- A deleted worktree's simulator is deleted by the next reap anywhere; its emulator instance is killed.
- A worktree with Metro running keeps its device for hours without a verb.
- `--device` binds a named device, keeps it across `dev:stop` and the lease, and never shuts it down; `--device` over an own created simulator deletes that simulator and says so.
- `smoke` releases its device.
- `status --json` shows the binding; `dev:stop --json` shows what it kept or released.
- The restart follow-up `dev:stop && dev --detach` reuses the running instance, so it costs no boot and no install.

## Release

- `dev:stop`: stop the dev server as today (main signals the dev-lock holder and waits for it to exit); with `--release`, then release the local bindings only when this worktree's own server stopped or is absent. `devServerOk` alone is insufficient: `--port` can name an idle port while the worktree's server runs elsewhere. Recheck the own lock before release; a remaining or replacement server keeps the devices. Then run the reap once, whatever the stop outcome. Without `--release` the bindings stay and are reported as kept. `--release` is in `resolveStopOptions` and sets `DevStopOptions.release`; `platform?` is internal, with no CLI flag, so smoke releases its platform only.
- Release re-reads the binding under the registry lock and verifies it still names the device checked before taking the lock, including the origin and emulator pid. A replacement binding is left untouched; stale inventory or an earlier cleanup must never remove or expire its record. Device actions use the binding validated in that section. Failed-boot cleanup likewise targets the binding acquired by that run.
- The foreground `dev` exit and the detached child touch no binding: the lease, renewed while Metro ran, expires on its own and the next reap parks or kills the device.

## Lease timer

`withLeaseExtendedAsync` of RFC §Lease wraps the Metro runner (for `dev`, the detached child and `start`) and the step runner.

## Reap

`reap.ts` per RFC §Reap, called from `acquireDeviceAsync` and `dev:stop`. The `cloud` rows wait for [[0034-eas-session-binding]].

## `--device` on `dev`

In `DEV_OWN_FLAGS`; its value is read as `resolvePort` reads `--port`, `--device=<v>` included; the flag and value are stripped from the Expo args as `withoutPortArgs` strips the port; `detachArgv` carries it unchanged; with `--eas` it is `BAD_ARGS`, checked where `assertEasRunFits` runs. The match and the refusals are in RFC §Choice; the origin's rule is RFC Contract 7. `dev --plan` naming a device bound to another worktree carries "will refuse: <name> is bound to <root>".

## smoke

One release per device. A device the child bound is released by `devStopAsync`, which smoke's `stopDevServer` already calls, once the child has exited, through the internal `DevStopOptions` fields `release: true` and `platform`. A device smoke's own boot phase bound, after a reused dev server, is released by smoke's device cleanup hook with its `platform`. A `smoke --no-start` run binds nothing and releases nothing.

## Output

`dev:stop` JSON `devices`, `status --json` `binding`, the reap events and the `cli:device_binding_reaped` reasons, per RFC §Output and errors.

## Live tier

The live tier passes `--device $AGENT_CLI_LIVE_UDID` to `dev` or lets it create. The runbook in `e2e-live/README` gains the two-worktree setup.

## Tests

- Required safeguards: `release-keeps-devices-when-own-server-runs-on-another-port`, `release-keeps-devices-when-server-is-replaced`, `release-leaves-replacement-binding`, and `failed-boot-leaves-replacement-binding`.
- Unit, named: `extend-expired-is-lost`, `timer-picks-up-late-cloud-file`, `timer-resumes-revived-file`, `timer-warns-lost-once`, `deleted-worktree-deletes-simulator`, `reap-reads-after-write`, `dev-stop-keeps-without-release`, `foreground-exit-touches-no-binding`, `explicit-expires-keeps-file`, `device-over-own-created-deletes`, `smoke-releases-own-platform-only`, `dev-stop-reaps-once`, `explicit-bound-live-or-stale`, `explicit-never-shut-down`.
- E2E, kept verbatim from the rejected branch's device-claims suite: the one machine dir, `envFor()`, the `afterEach` `dev:stop --release` loop, the `dev:stop --release` JSON plus the exact `shutdown` call, and the deleted-worktree reap case, adapted to assert the `simctl delete` call. Dropped: `touchRace.ts`, `lockRace.ts`, `claimedDevice-test.ts` and the 10-field claim literal.

About 500 source lines.
