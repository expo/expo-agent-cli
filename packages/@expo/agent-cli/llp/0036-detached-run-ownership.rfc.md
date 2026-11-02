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

Repeated detached starts refuse even with identical options; changing options requires
explicit stop/start. Observers report their own child and retain its private log.
Each worktree has independent ownership. Fixed-name logs remain readable.

Parent-held guards, the best-effort dev-server lock alone, and timeout-based takeover
leave duplicate-start windows. General orphan adoption and foreground exclusivity are
out of scope. Socket liveness does not imply that Metro is ready.

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
||||||| parent of e380652f4 (Specify interrupted-run discard and POSIX force-stop recovery)

## Interrupted runs

An unexplained death retains the record, even before startup work begins. Refusal and
`dev:stop` name an attempt-specific `dev:stop --discard-run <attempt-id>` action.
Discard removes that record, not processes or EAS sessions. It refuses a reachable or
ambiguously reachable owner, and an outdated action cannot discard a replacement.
Malformed records do not grant automatic admission. Explicit discard still checks the
named attempt's endpoint independently of the record's contents.

Windows stop force-terminates the tree. Only successful delivery and confirmed termination
allow the stop command to clear the record captured before signalling. Failed or uncertain
stops retain it. Normal POSIX shutdown lets the owner release after awaited cleanup.

POSIX SIGKILL always retains the record: the CLI PID can die while Expo's process group
survives. The report names the PID, port, possible surviving processes, and discard action.
After discard, an answering server on that port still receives the existing unowned-server
refusal. Preventing these survivors requires separate work and is outside this contract.

| Contract                                                     | Enforcing process test in `dev-detach-recovery-test.ts`                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Interrupted ownership has explicit recovery                  | `a crashed detached run names an explicit discard command and can be restarted`                     |
| Force-stop reporting does not promise subprocess termination | `SIGKILL retains ownership and discard leaves a surviving server subject to foreign-server refusal` |
