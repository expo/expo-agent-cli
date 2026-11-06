# 0036: A detached child owns its run

**Type:** RFC
**Status:** Draft
**Systems:** detached dev startup, detached logs
**Related:** [[0004-smart-start-and-project-state]], [[0002-testing-and-evals]]

## Problem

Concurrent starts can both observe no server and begin competing builds or Metros.
A parent-held guard cannot protect a child that survives its parent. A dead owner does
not establish that its subprocesses or remote operations ended.

## Decision

The detached child owns admission before project evaluation or external work, through
awaited build, server, and app-open cleanup. A private endpoint establishes liveness;
an immutable, attempt-specific record preserves evidence after unexpected termination.
Only an elected child starts work. Parent exit and observer timeout never release it.

| Evidence                                         | Admission                  |
| ------------------------------------------------ | -------------------------- |
| No record                                        | Compete for ownership      |
| Endpoint accepts a connection, without a reply   | Refuse competing work      |
| Timeout, permission error, or malformed evidence | Refuse; do not infer death |
| Record remains after endpoint disappears         | Refuse automatic takeover  |
| Normal cleanup completes                         | Release ownership          |

PIDs and age are diagnostic information, not proof of ownership or permission to kill.
Publication never exposes an owner whose endpoint is not yet listening. Removal targets
only the captured attempt; delayed cleanup cannot remove its replacement.
Empty directories left by release do not prevent a later election.

Observers use the endpoint published by the owner, even when their temporary directories
differ. An unknown endpoint is uncertain evidence, not proof of absence or permission to
discard. Invalid ancillary metadata does not change a known endpoint's liveness. Existing
dev-server locks retain their published address across CLI versions.

A repeated request never adopts the child or reopens its app. While a live run is still
starting, the same startup options return **22**, `DEV_START_IN_PROGRESS`, with an observe
action and the elected attempt's log. Different startup options return **20**,
`DEV_START_BUSY`, with explicit stop-then-start advice preserving the requested options.
Once startup completes, a repeated start returns 20 even when its options match.
Output and waiting options do not change startup identity; platform, backend, target,
device, requested port, app opening and startup-affecting Expo options do.

An observation deadline does not turn pending work into failure or completion. After the
default parent timeout, status identifies the same starting attempt and its log; reading
that log and retrying the same request start no additional build, device or session.
Readiness and app-open settlement come from the work itself, even if the best-effort
dev-server lock could not publish. Missing evidence remains unknown.

Observers report their own child and retain its private log. A proven non-owner candidate's
refused log can be removed; elected failures remain available for diagnosis. Each worktree
has independent ownership. Fixed-name logs remain readable.

Parent-held guards, the best-effort dev-server lock alone, and timeout-based takeover
leave duplicate-start windows. General orphan adoption and foreground exclusivity are
out of scope. Socket liveness does not imply that Metro is ready.

## Stopping a starting run

Ordinary stop addresses the captured attempt before or after dev-lock publication. One
cancellation path stops subsequent startup and accounts for work already in flight.
An acknowledgement means accepted, not completed. A bounded wait may return pending;
it does not release admission or authorize stopping a replacement.

Plain stop preserves and reports EAS sessions. Explicit session/device cleanup acts only
on resources captured by that run, including a late session ID returned by its submitted
work, and completes while admission is held. An unknown resource outcome retains evidence.
A missed terminal reply cannot authorize a later sweep of the worktree's current resources.

These contracts are exercised through the compiled CLI in `dev-detach-control-test.ts` and
`dev-detach-long-build-test.ts`. Their external barriers hold preparation, build submission and app opening;
the long-build acceptance uses the actual default parent timeout on iOS and Android.

## Contract evidence

| Contract                                        | Enforcing process test                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Election and normal release                     | `simultaneous detached starts elect one owner and normal stop releases it`        |
| Empty-target recovery                           | `an empty ownership directory does not prevent publication`                       |
| Endpoint, not PID, establishes liveness         | `a silent ownership endpoint prevents admission regardless of its diagnostic PID` |
| Ambiguous connection retains evidence           | `an uncertain endpoint (%s) permits neither start nor discard`                    |
| An unpublished attempt does not block admission | `death before publication leaves admission available`                             |

These tests live in `e2e/__tests__/dev-detach-ownership-test.ts`.

Cross-environment observation and interrupted recovery are enforced by
`another TMPDIR cannot discard a live %s owner, but can recover its interrupted run`.
`an unknown ownership endpoint (%s) never grants discard authority` covers malformed
endpoint evidence. Both are process tests in `dev-detach-endpoint-test.ts`.

## Interrupted runs

An unexplained death retains the record, even before startup work begins. Refusal and
`dev:stop` name an attempt-specific `dev:stop --discard-run <attempt-id>` action.
Discard removes that record, not processes or EAS sessions. It refuses a reachable or
ambiguously reachable owner, and an outdated action cannot discard a replacement.
Malformed records do not grant automatic admission. Discard probes the captured endpoint
even when ancillary metadata is malformed. Unknown or invalid endpoint evidence remains
uncertain; the observer cannot invent an address and treat its absence as proof of death.

Windows stop force-terminates the tree. Only successful delivery and confirmed termination
allow the stop command to clear the record captured before signalling. Failed or uncertain
stops retain it. Normal POSIX shutdown lets the owner release after awaited cleanup.

POSIX SIGKILL always retains the record: the CLI PID can die while Expo's process group
survives. The report names the PID, port, possible surviving processes, and discard action.
After discard, an answering server on that port still receives the existing unowned-server
refusal. Preventing these survivors requires separate work and is outside this contract.

| Contract                                                      | Enforcing process test in `dev-detach-recovery-test.ts`                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Interrupted ownership has explicit recovery                   | `a crashed detached run names an explicit discard command and can be restarted` |
| Force-stop reporting does not promise subprocess termination  | `SIGKILL retains ownership independently of surviving work (server alive: %s)`  |
| Delayed discard or confirmed stop cannot remove a replacement | `delayed %s cannot remove replacement ownership`                                |
| Failed tree-stop delivery retains ownership                   | `a failed Windows tree stop retains ownership`                                  |
| Discard checks liveness independently of record contents      | `discard refuses a live owner even with malformed contents (%s)`                |
| Death before work still requires explicit recovery            | `death after publication but before work requires explicit discard`             |
