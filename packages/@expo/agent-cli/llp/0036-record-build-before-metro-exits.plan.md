# 0036: Record a completed native installation before Metro exits

**Type:** Plan
**Status:** Draft
**Systems:** `src/dev/devAsync.ts`; `src/dev/buildEvidence.ts`; `src/plan/lastBuild.ts`; `src/project/fingerprint.ts`; `src/start/startAsync.ts`; `src/utils/expoCli.ts`; `src/utils/subprocess.ts`
**Date:** 2026-10-14
**Related:** [[0004-smart-start-and-project-state]], [[0006-agent-native-cli-surface]], [[0011-impact-and-freshness]], [[0021-honest-reports]], [[0023-fingerprint-caching]], [[0035-active-dev-session-planning]]

## Target and outcome

One new, focused PR against `main`. This is the build-recording portion of [[0035-active-dev-session-planning]], independent of #125 and the #146–#152 device lifecycle stack.

After a local `dev --ios --detach` or `dev --android --detach` successfully installs its development build, `.expo/agent-cli-last-build.json` should contain that build's verified input fingerprint while the same native runner and Metro remain alive. Another CLI process must be able to read the record without stopping the server.

This removes the false “No development build recorded” reason after a successful installation. Selection or reuse of port 8082 is a separate concern. Session reuse, startup ownership, device leases, new app-opening behavior, cloud builds, and smoke follow-up wording are outside this PR. Foreground and detached builds use the same recording mechanism.

## Cause and evidence

`executePlanAsync` awaits `runStep` before calling `recordBuildOf` or `recordBuildReachedDevice`. A serving `expo run:*` step includes Metro's lifetime, so installation can finish minutes or hours before the record is written.

[observed, 2026-10-14] The Fieldwork worktree installed and opened its iOS app, bundled successfully, and served `/status` on 8082 while its native runner remained alive. Its last-build record was missing.

[observed in installed Expo CLI 58.1.7 source] The iOS simulator and Android paths emit structured `run:install` after awaiting installation. Their human `Installing` messages are emitted before completion. The current `appReachedDevice` matcher accepts those early messages; it must not become the trigger for a live successful-build record.

## Implementation

### 1. Observe confirmed installation from the running child

Add an optional live event observer to the subprocess adapter and carry it through the captured and inherited Expo runners, `runDevServerAsync`, and the plan executor. Consume the child's events incrementally through the public `2g` API. Do not import Expo CLI internals or wait for an event collection that resolves only when the child exits.

Accept a successful `run:install` only from the exact child attempt, with a validated event shape and the expected platform/application identity. Bind it to the invocation's selected target when known. A port retry is a new child attempt: stale events and callbacks from the previous child cannot complete it.

Preserve stdout, stderr, terminal interactivity, and an explicitly configured event-log destination. Set up observation before the child can emit, dispose on spawn failure/exit/cancellation, and handle observer errors without killing Metro. Cover captured, tee, and inherited output.

Verify the event contract and transport against supported installed Expo CLI versions first. For versions without this event, accept only a documented, tested post-install signal or a verified successful bounded installation. An `Installing` line, `Build Succeeded`, Metro readiness, app presence alone, or cancellation normalized to exit 0 cannot establish completion. Without reliable evidence, retain the previous record and explain that the new build could not be recorded. Do not split `expo run:*` into separate build and Metro processes for this fix.

### 2. Preserve the inputs that produced the binary

Create an attempt-local fingerprint snapshot before the first step that consumes native inputs: before `prebuild` when present, otherwise before native compilation. This does not depend on the proposed startup-ownership feature. Use the same platform/preset as the existing freshness comparison. Each measurement below bypasses the cross-run cache and invalidates the in-process memo.

- After preparation, measure again before compiling. If inputs changed, stop before compilation and request a rerun of preparation against the new inputs. Include changes preparation itself made; do not silently assign a later hash to native files already generated from an earlier config, and do not loop automatically.
- After confirmed installation, revalidate without replacing the attempt's snapshot. If inputs changed during compilation or installation, report installation success with unknown freshness and retain the previous build record.
- If a fingerprint cannot be obtained or revalidated, a build may still proceed, but it produces no new verified build record.
- For stable inputs, record the captured hash and sources. Never recompute a newer hash and attribute it to the older binary.

The prebuild check matters for CNG: fingerprints describe config and plugin inputs, while compilation consumes generated native files. A config edited after prebuild read it must not be recorded as the source of those files. Include an unchanged real CNG project in validation so normal preparation does not cause unnecessary refusal.

### 3. Publish once, without waiting for Metro

As soon as installation evidence and input verification are complete, publish the per-platform last-build entry while the serving child is still alive. Keep the existing readable record format and preserve the other platform's entry. Serialize the short read/merge/write operation and publish atomically so concurrent writers cannot lose each other's updates and readers never see a partial file. This is record-write coordination, not a session lock held throughout a build.

Use one completion path for live observation, bounded installs, and exit-time handling. It must be idempotent: duplicate events or shutdown after a recorded installation do not write again or overwrite a later build's record. Remove any exit-time fallback that promotes an installation attempt to success after the live observer declined it.

Installation and launch have separate outcomes. Verified installation remains recorded if a later app launch fails. Failed or cancelled installation preserves the previous record. A record-write failure remains best-effort: report it without stopping Metro or claiming the write succeeded.

Keep attempts to install distinct from completed installation in shared evidence helpers. Update `childVerdict` only where necessary to preserve honest phase reporting; do not make its text heuristics an alternative source of successful-build records.

## Files and validation

Primary changes: `dev/devAsync.ts`, `dev/buildEvidence.ts`, `plan/lastBuild.ts`, `start/startAsync.ts`, `utils/expoCli.ts`, and `utils/subprocess.ts`, plus their focused tests. Reuse the existing fingerprint helpers. Amend the build-record contract in [[0004-smart-start-and-project-state]] and [[0011-impact-and-freshness]] when behavior is verified.

Add regression coverage before implementation:

1. A native-runner fixture emits installation completion and keeps serving. A separate CLI process reads the expected record **before the fixture is allowed to exit**. Cover iOS and Android.
2. `Installing` followed by failure, cancellation before completion, or successful compilation without installation leaves the previous record unchanged. Installation followed by launch failure retains the verified record.
3. Duplicate, malformed, wrong-platform/app/child, and late events do not create extra or incorrect records. Observer/transport failure preserves server behavior. Exit-time handling cannot overwrite a later recorded build.
4. Pause prebuild after it reads config A, change it to B, and resume: compilation must not start and B must not be recorded for A's generated files. Edits during compilation, unavailable fingerprints, and preparation's own input changes follow the specified conservative behavior.
5. Captured, tee, and inherited output still work, including an explicit event-log destination. Concurrent platform writes preserve both entries and every read sees valid JSON.
6. With unchanged inputs, stop the completed session normally and plan again: no native rebuild is requested because of a missing build record. Existing app-presence checks still require installation if the app was removed.

Run focused unit and subprocess e2e suites, package typechecking/build, and repository formatting. Verify the built CLI with a real iOS simulator and Android emulator: capture the actual install event, read the record from a second process while Metro remains alive, then stop normally and confirm the next plan recognizes the build. Check older supported Expo CLI behavior explicitly; mocked events alone do not establish compatibility.

The PR is complete when verified installations become durable before Metro exits, failed or uncertain installations cannot become successful-build records, and the existing server and app-opening behavior is preserved.

## Review and implementation evidence (2026-10-14)

The implementation is based on `main` at `a862c111`, which already uses `2g` 1.0.1.
The following details refine the draft without changing its scope:

- `dev` freshness currently compares the default all-platform fingerprint, so the three
  independent measurements use that same platform/preset selection. They clear the memo
  and pass `cache: false` each time.
- `2g/api.captureEvents` provides a private per-spawn pipe and live async iteration. The
  root event identifies the CLI behind a shim; events tagged as other workers remain
  ineligible for installation evidence. Captured, tee and inherited output are preserved.
- An initialized `2g` logger consumes `LOG_EVENTS`. The public logger-info API identifies
  its destination; relaying through that logger prevents independent file positions from
  overwriting one another. Explicit destinations not owned by the parent receive the wire
  bytes directly.
- [observed] Installed Expo CLI 58.1.4 and 58.1.7 emit `run:install` after awaiting the iOS
  simulator / Android installation, with `platform`, `appId`, `_t`, `_d`, and possibly an
  `event_log_child:<pid>` origin. `run:device:selected` precedes it.
- [observed] Installed Expo CLI 57.0.21 has no such completion event and its numeric event
  logger calls `fsync` on the supplied descriptor, which crashes on a pipe. The exact
  executable's public `--version` is therefore checked before observation. Versions below
  58.1.4 and unrecognized versions retain their original transport and cannot create a
  verified record. There is no text or exit-code fallback.
- A supplied binary (`--binary`) cannot be attributed to this invocation's input snapshot.
  It can establish installation, but cannot create a new fingerprint record.

Focused regressions cover publication before exit and a second CLI reading it, duplicate
and wrong events, preparation/compilation edits, cancellation, launch failure, output modes,
explicit logging, instrumented parents, and concurrent platform writers. Existing dev,
app-presence, detached-run, subprocess and plan tests remain part of validation.

[observed] An unchanged CNG project using Expo 58.0.5 / CLI 58.1.4 completed preparation
without a false input-change refusal. Real `dev --ios --detach` and `dev --android --detach`
installed on an iOS 27 simulator and an Android emulator. Each wrote the captured hash
`fae4c6b6e2d02c3f7020a29ca5d2e44db46e5a6e` while its runner remained alive and `/status`
answered `packager-status:running`. A separate CLI process planned `dev-client-fresh`.
The actual Android completion event carried `platform: android`,
`appId: dev.expo.recordvalidation`, and a completed-install duration of about 809 ms.

[observed] Both detached sessions stopped normally with `dev:stop` (no forced termination),
and separate post-stop plans still selected `dev-client-fresh` with the original recorded
hash. A bounded installation using the real CLI 58.1.7 emitted an iOS completion event
with the expected application ID and a duration of about 1171 ms. The real CLI 57.0.21
also completed a bounded installation successfully with the compatibility guard enabled;
it emitted no completion event and preserved the previous record.

Validation passed: all 4,880 package unit tests across 223 files; 88 focused subprocess and
end-to-end tests across five files; package build, all five typechecking configurations,
lint, repository formatting, and whitespace checks. Test devices created for this check
were stopped after validation.
