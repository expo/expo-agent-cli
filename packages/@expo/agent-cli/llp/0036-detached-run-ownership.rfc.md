# 0036: A detached child owns its run

**Type:** RFC
**Status:** Draft
**Systems:** detached dev startup, detached logs
**Related:** [[0004-smart-start-and-project-state]], [[0002-testing-and-evals]]

## Problem

Concurrent detached starts can both observe no server, then start competing builds or Metros.
A parent-held guard cannot protect a child that survives its parent.

## Decision

The child owns startup before probing or other work, through normal subprocess cleanup.
Overlapping detached starts refuse with exit 20, the owner PID, and its private log path; observer death or timeout never releases ownership.
Observers report only their own child. A startup observation timeout exits 22 without stopping it. Independent worktrees remain independent.

| Ownership evidence                                                           | Contender behavior                 |
| ---------------------------------------------------------------------------- | ---------------------------------- |
| Live owner                                                                   | Refuse; never start competing work |
| Dead owner, proved never to have begun work                                  | Compete to recover ownership       |
| Dead owner that may have begun work, unreadable claim, or uncertain liveness | Refuse automatic takeover          |

Recovery removes only the old owner's evidence, never a replacement owner's. Age is not death.
Each candidate has private output; only the owner selects the current log. Observers retain the selected file independently of that pointer.
The process E2E `dev-detach-concurrency-test.ts` enforces one start, refusal metadata and owner logs,
and compatibility with existing status/stop discovery. Fixed-name logs remain readable.

A parent-only guard, the server socket alone, and timeout-based takeover all leave duplicate-start
windows. General orphan adoption, foreground exclusivity, and pre-server cancellation are out of scope.

Normal stop releases ownership, and a new run preserves the previous run's log.
Windows stop force-terminates the process tree, so child cleanup cannot run. Only a successful
tree stop followed by proof that its PID and server lock are gone may remove that captured
owner's claim. Failed stops and unexplained deaths grant no such permission. The stop/restart
process E2E enforces this contract on the Windows CI runner.
