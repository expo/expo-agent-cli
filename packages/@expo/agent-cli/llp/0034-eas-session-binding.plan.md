# 0034: An EAS session belongs to the worktree that started it

**Type:** Plan
**Status:** PR 5 implemented locally; PR 6 draft
**Systems:** `src/deviceBinding/cloud.ts` (new); EAS session selection (`src/device/cloudSimulator.ts`); the EAS open (`src/dev/openAppEas.ts`); `smoke`'s EAS branches; `dev:stop --eas`; the e2e stub `eas`; the live suite `live-cloud`
**Author:** Vojtech Novak (drafted with Claude)
**Date:** 2026-10-08
**Related:** [[0030-one-device-per-worktree]] (the rules and §Answers from the EAS code), [[0027-everything-on-eas]], [[0005-runtime-loop-tools]] §Cloud simulator

PRs 5 and 6 of [[0030-one-device-per-worktree]] §Delivery. PR 5 requires [[0033-device-lifecycle]]; PR 6 requires PR 5.

## Questions

PR 5: how does a worktree keep to its own EAS session? PR 6: how does a session survive a lost registry?

## State it leaves

- PR 5: two worktrees get two sessions; `navigate --eas` uses its own; `dev:stop --eas` ends this worktree's sessions; a deleted worktree's `started` session is stopped from another worktree, a `dotenv` one only removed; `dev --eas` reaps too.
- PR 6: a lost registry recovers its session by tag; the live suite is green on a Mac with two worktrees.

## PR 5

- Required safeguards: every cloud action carries the selected session ID through execution. EAS loads its dotenv inside `simulator:exec`; a wrapper checks the loaded ID before launching the controller, and refuses a missing or mismatched connection without acting. This checks the environment actually used by the child, not an earlier filesystem snapshot. No credentials are persisted by agent-cli. A mismatch names the selected session and asks the caller to restore its EAS connection settings.
- Session selection prefers the requested platform, then its bound ID, then the dotenv ID. A queued bound session blocks a replacement start. List both `new` and `in-progress` statuses. An unknown/failed listing never authorizes starting a session. Tests cover iOS binding A plus Android dotenv B, a queued bound session beside another active session, and discovery failures with zero starts.
- Keep cleanup scoped to the exact session ID captured by the run. A successful stop of A must leave a replacement binding B intact; a failed stop keeps A's binding. Reusing a `started` binding preserves its origin and `boundAt`. Cloud smoke never releases local devices; the lifecycle PR fixes this before PR 5.
- `cloud.ts`; `acquireCloudBindingAsync` and the `sessionId` release of RFC §Entry points; the cloud rows of the inspect and reap tables.
- `selectCloudSession(boundIds)` and the `unbound` result per RFC §EAS, without the tag rung. Readers of `candidateCount` are checked. `ensureEasSessionAsync` returns the source of the selected id with its `sessionId`.
- `ownCloudIdsAsync(root)` serves every probe caller: the rung loop, `ensureEasSessionAsync`, smoke's reuse branch and `stopCloudSessionsAsync`.
- Binding points. `openAppEas` and both of smoke's EAS branches call `acquireCloudBindingAsync` whenever `ensureEasSessionAsync` or a direct probe returns a session id. That includes a reuse of the bound id and a start that failed after it created the session, so a later reap can stop that session.
- `dev --eas` binds; the foreground `dev --eas` stops its session at exit as today and then releases with `sessionId`. The detached child keeps its cloud session and binding when Metro exits, so plain `dev:stop` preserves both; `dev:stop --eas` owns their explicit cleanup. `dev --eas --detach` on a running server runs `openAppEas`, which reuses the bound session or starts one and binds it; this is the How line of the `gone` cloud refusal (RFC §Readers), raised when the listing shows the bound id in no live state; a queued bound session is `not-up` and is never replaced by a new start.
- `--max-idle-time-minutes 30` on the session start, with the "Nonexistent flag" retry of RFC §EAS, for the reason given there. `smoke --eas` binds in both its start and its reuse branch and, after its own stop succeeds, releases with `sessionId`.
- `dev:stop --eas` stops the probe's session, bound or dotenv, and then each other `cloud` binding's session of this worktree. It calls the `sessionId` release for each stop that succeeded. The JSON `session` reports the probe's id and `devices` the rest. A plain `dev:stop` keeps `cloud` bindings and reports each as "recorded, not checked" ([[0021-honest-reports]]), with `dev:stop --eas` as the next step. `dev:stop_session` gains `platform`.
- The start follow-ups and `status` switch from the dotenv file to the `recorded` state of the own cloud binding, with no network call. `dev-wait` is deferred and is not changed.
- Tests: the rejected branch's `stubEas.ts` and `stubs/eas.js` `STUB_SIM_STORE` with repeatable `--status`, paging dropped, and its e2e cases, including "plain `dev:stop` keeps it". Unit, named: `session-id-release-skips-stale-check`, `start-failure-with-session-binds`, `dotenv-removed-not-stopped`, `select-bound-only`, `cloud-expired-is-gone`, `unlisted-bound-id-is-gone`, `queued-bound-id-is-not-up`, `cloud-rung-writes-nothing`, `reap-stops-under-binding-root`, `idle-flag-retry-on-nonexistent-flag`, `cloud-exec-refuses-wrong-session`, `cloud-exec-uses-loaded-environment`, `unknown-probe-does-not-start`, `platform-binding-beats-dotenv`, `session-release-keeps-replacement`.

About 350 source lines.

## PR 6

- `--tag agent-cli:<digest>` on the session start, with the same "Nonexistent flag" retry. Any other failure is reported as today, because a start can create a session and still exit non-zero. The event `dev:open_app_eas_flag_unsupported { flag }` records a retry.
- The tag field in `CloudSessionInfo`, named from a recorded `simulator:list --json` fixture that carries a tag. The tag match reads that one listing, with no second `eas` call.
- The runbook and a live test trimmed to the acceptance lists. `live-cloud` starts its session with `eas` directly, so the dotenv source stays and a reap never stops a `dotenv` session (RFC Risk 7).
- Tests, named: `tag-matches-on-one-listing`, `tag-retry-only-on-nonexistent-flag`, with a stub version switch for the eas-cli skew (RFC Risk 3).

About 120 source lines.
