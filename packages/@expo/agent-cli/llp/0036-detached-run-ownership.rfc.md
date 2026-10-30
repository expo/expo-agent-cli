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
Once a server is published, a repeated detached start also refuses with exit 20 and its PID/port, even for identical options. Changing options requires explicit stop/start.
Observers report only their own child. A startup observation timeout exits 22 without stopping it. Independent worktrees remain independent.

| Ownership evidence                                                           | Contender behavior                 |
| ---------------------------------------------------------------------------- | ---------------------------------- |
| Live owner                                                                   | Refuse; never start competing work |
| Dead owner, proved never to have begun work                                  | Compete to recover ownership       |
| Dead owner that may have begun work, unreadable claim, or uncertain liveness | Refuse automatic takeover          |

Recovery removes only the old owner's evidence, never a replacement owner's. Age is not death.
Each candidate has private output; only the owner selects the current log. Observers retain the selected file independently of that pointer.
Fixed-name logs remain readable.

A parent-only guard, the server socket alone, and timeout-based takeover all leave duplicate-start
windows. General orphan adoption, foreground exclusivity, and pre-server cancellation are out of scope.

Normal stop releases ownership, and a new run preserves the previous run's log.
Windows stop force-terminates the process tree, so child cleanup cannot run. Only a successful
tree stop followed by proof that its PID and server lock are gone may remove that captured
owner's claim. Failed stops and unexplained deaths grant no such permission. The stop/restart
process E2E runs on the Windows CI runner.

## Contract evidence

Process tests use external-tool stubs; the live test uses the EAS service. Test names below are in
`e2e/__tests__/dev-detach-concurrency-test.ts` unless another file is named.

| Contract                                                               | Enforcing test                                                                                                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A contender cannot perform startup work or replace the owner log       | `a concurrent detached start refuses without replacing the owner: $name`                                                                                              |
| Observer timeout and death do not release the child's claim            | `the starter times out without stopping its child, and another start refuses`; `a retry refuses while the surviving child owns startup after its parent dies`         |
| Recovery of a never-executed dead claim cannot delete a replacement    | `two retries recover a dead child that never began work without removing the new owner`                                                                               |
| Ambiguous death and unreadable claims forbid takeover                  | `refuses automatic takeover when the dead child had already begun work`; `does not replace a live owner whose claim cannot be read`                                   |
| Cleanup stops only the captured child                                  | `cleanup for a live %s child cannot stop a different live owner`                                                                                                      |
| Normal failure releases ownership; stop/start preserves earlier output | `releases ownership after a normal startup failure so another attempt can succeed`; `stopping and starting again selects a new log without changing the previous run` |
| Observer readiness belongs to the same server                          | `refuses success when the published %s changes during the final readiness probe`                                                                                      |
| EAS preflight belongs to the child, including after observer death     | `an EAS %s contender does no config or session work`; `EAS %s preflight survives its parent and preserves linking guidance`                                           |
| Real EAS recovery preserves the session, port and target               | `owned EAS startup refuses contenders and recovers the same session with the printed port and target` in `e2e-live/__tests__/live-cloud-test.ts`                      |
