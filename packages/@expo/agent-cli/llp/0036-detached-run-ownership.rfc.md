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

Repeated detached starts refuse even with identical options; changing options requires
explicit stop/start. Observers report their own child and retain its private log.
Each worktree has independent ownership. Fixed-name logs remain readable.

Parent-held guards, the best-effort dev-server lock alone, and timeout-based takeover
leave duplicate-start windows. General orphan adoption and foreground exclusivity are
out of scope. Socket liveness does not imply that Metro is ready.

## Contract evidence

| Contract                                | Enforcing process test                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| Election and normal release             | `simultaneous detached starts elect one owner and normal stop releases it`        |
| Empty-target recovery                   | `an empty ownership directory does not prevent publication`                       |
| Endpoint, not PID, establishes liveness | `a silent ownership endpoint prevents admission regardless of its diagnostic PID` |

These tests live in `e2e/__tests__/dev-detach-ownership-test.ts`.
