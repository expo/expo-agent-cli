# The EAS session as a first-class device — plan from the dogfood run

**Type:** Plan
**Status:** Draft
**Date:** 2026-10-05
**Source:** [[dogfood-parallel-example.notes]] (24 findings: 1 blocked, 9 wrong, 1 slow, 7 unclear, 2 missing, 4 nice), the live run of 2026-10-05 behind [[0030-one-device-per-agent]].
**Related:** [[0005-runtime-loop-tools]], [[0021-honest-reports]], [[0026-dev-owns-the-open]], [[0027-everything-on-eas]]

## What the run showed

An agent with only this CLI built a feature on an EAS Simulator session in 45 minutes. `dev --ios --eas` did the build, the tunnel, the session and the open in one command. `runtime:tap`, `runtime:type` and `--verify` drove every screen in 0 to 2 s and found a real bug on the first Save. `runtime:errors` mapped the stack onto the agent's files.

The agent had to leave the CLI once, for every screenshot, and it read the CLI's source twice to find a workaround. Thirteen of the twenty findings that are not `nice` have one cause: **the EAS session is not a device in the runtime model.** `navigate`, `runtime:reload`, `smoke` and `dev:stop` take `--eas`; `runtime:tree`, `runtime:tap`, `runtime:type` and `runtime:errors` take only `--ios` or `--android`, and their target index reads the platform from a local device name, which a cloud session does not have. So `navigate --eas` waits 55 s for an attach it cannot see (13), `smoke --eas` says the bundle never ran while it ran (16), the runtime verbs refuse `--ios` (14), `status` names the local simulator and plans the local path (4, 12), and every follow-up drops `--eas` (3, 6, 22, 24).

## Phases

Each phase is one PR, ends green on unit and stub e2e, and is accepted by a rerun of the live check named in it. Infrastructure first.

### Phase 0 — the four live-run fixes (in flight)

`dev --detach` budget that follows the plan; `--non-interactive` on every `eas` argv; a cross-process warm-up lock for `bunx <spec>`; a port probe that binds `::` and `127.0.0.1`. Accepted by `test:live:claims` Block 1 with a foreign `*:8081` Metro present.

### Phase 1 — one device target for every runtime verb (findings 1, 13, 14, 15, 16, 22)

- **Data shape.** `DeviceTarget = { backend: 'local-ios' | 'local-android' | 'eas'; id: string; platform: 'ios' | 'android' }`, resolved once from the claim (`src/device/claimedDevice.ts`, `src/device/cloudSimulator.ts`) and passed to every runtime verb. The debugger-target index keys on this, not on a device name parsed from CDP.
- `--eas` on `runtime:tree`, `runtime:tap`, `runtime:type`, `runtime:errors`, `runtime:eval`; `--ios`/`--android` on them means "the claimed local device of that platform".
- Attach detection reads the dev server's `/json/list` and matches the target to the resolved device, for a cloud session as for a local one. `navigate --eas` and `smoke --eas` then see the attach they wait for.
- A `screenshot` verb: `xcrun simctl io <udid> screenshot` locally, `adb -s <serial> exec-out screencap` on Android, `simulator:exec … agent-device screenshot` on EAS. It never opens or moves the app. About 10 s on EAS was measured.
- The bundle check must not take the debugger target away (15). Trace why the entry-bundle request drops the target on a tunnelled dev server; until then, the verb waits for the target to return and the error text names `--no-bundle-check`.
- Accepted by: the dogfood feature's five screens photographed through `screenshot --eas`, `navigate /notes --eas` exits 0 in under 20 s, `runtime:tree --eas` exits 0 on the first try.

### Phase 2 — reports and follow-ups keep the backend (findings 3, 4, 6, 8, 10, 12, 24)

- Follow-ups are built from the resolved options, so a run started with `--eas` suggests `--eas` (22, 24, 3, 6). A follow-up for a step that has not run yet is printed after the step, or worded "when the build finishes" (8).
- `status --eas`: freshness from the EAS build the CLI itself made (12), the session on the device line, `next` for the EAS path (4). The plan reads `ios.simulator` from `eas.json` before it rejects the `development` profile (3).
- `install` on a CNG project says "rebuild the development build", not "prebuild" (6).
- The Expo CLI prompt text and the QR code do not reach the agent's log when the device is a session (10).
- `dev:stop --eas` says "stopped by the dev server on exit" when the lock holder stopped the session (24).
- Accepted by: a `--json` run of each verb on EAS with `followups` that run as printed; the stub e2e asserts no `--ios` follow-up appears in an `--eas` run.

### Phase 3 — `--verify` tells the truth about the screen (findings 19, 20)

- Elements are matched by `testID`, then by key, so a deleted row is `-` and a moved row is unchanged (20). The focused screen is the top of the stack, not the tab (20).
- A render error in the tree is reported as one line, "a render error appeared: <message>", with `runtime:errors` as the next step, instead of 200 `RCTVirtualText` lines (19).
- Accepted by: unit tests on the diff over recorded trees from the dogfood run.

### Phase 4 — no silent side effects (findings 17, 23)

- `lint` prints its plan when `expo lint` is about to install eslint and write `eslint.config.js`, and refuses under `--json` without `--yes` (23). The lockfile change is named.
- `dev` and `smoke` mark the dev-menu onboarding as finished on a fresh dev build, the way they answer system alerts (17), so a relaunch does not cover the app.
- Accepted by: stub e2e for `lint`; the dogfood screenshots show no onboarding sheet.

### Phase 5 — the first-run material covers the EAS path (findings 1, 2, 5)

- `help workflow` has one paragraph on the EAS path and names `screenshot`.
- The managed block in `AGENTS.md` states when it was generated and matches `status`; `agents:setup` says why it linked zero skills.
- Accepted by: a fresh dogfood agent given only the app and the CLI, no prompt about `--eas`, reaches a screenshot of a route on an EAS session.

### Acceptance for the whole plan

Rerun the dogfood: a new agent, the same feature brief, the same rule (CLI only). Target: 0 `blocked`, 0 `wrong`, no CLI source read. The journal of that run replaces [[dogfood-parallel-example.notes]].

## Not in this plan

- The `--tag` and `--max-idle-time-minutes` follow-up for EAS sessions ([[0030-one-device-per-agent]] §Follow-up work) stays its own PR.
- `npx tsc` resolving a registry package in a bun workspace (9) is npm's behaviour, not the CLI's.
- EAS build time (7 minutes) is the service's.
