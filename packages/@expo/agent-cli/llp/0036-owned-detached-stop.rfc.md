# 0036: Stopping an owned detached run

**Type:** RFC
**Status:** Draft
**Systems:** detached ownership, plan interruption, managed subprocess trees, dev-server lock, `dev:stop`

A detached owner must remain alive long enough to record a session created by an outstanding EAS start.
Killing that owner can lose the session ID and the completion receipt that permits cleanup.

An authenticated stop interrupts the plan and force-stops its selected managed child tree on Windows and POSIX.
It sends no signal to the owner and reports `signal: null`.
The existing startup scope retains tree-termination evidence and waits for work already started.
A separate run-stop signal closes plan admission without cancelling sibling EAS captures.
No new child registry, receipt journal, or recovery daemon is introduced.

| Contract                                                                                                                                                                                                                                                                                                               | Enforcement                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The owner checks the current port, allocates one nonce and latches stop without yielding. A changed target, old peer or custom signal grants no authority to signal a PID.                                                                                                                                             | `dev-owned-stop-test` port-move case and `stopAsync-test` response table.                                                               |
| Planned publication, runner queues and gaps between steps cannot admit later plan children after stop.                                                                                                                                                                                                                 | `dev-owned-stop-test` handoff/queue cases and shipped build/lookup table.                                                               |
| A cooperative transition to `finishing` requires successful forced native tree termination and direct-child close. Failed termination stays uncertain even after direct fallback closes the parent.                                                                                                                    | `dev-owned-stop-test` held-session table observes an independent-stdio leaf that ignores SIGTERM.                                       |
| Post-handoff tree failure invalidates the receipt but does not terminate a later EAS helper.                                                                                                                                                                                                                           | `dev-owned-stop-test` helper-failure case.                                                                                              |
| Plain stop returns promptly at a matching qualified `finishing` lock and keeps cloud sessions. An already-finishing natural exit retains its narrower direct-child contract.                                                                                                                                           | Both platforms in the held-session table.                                                                                               |
| Cloud inventory keeps its existing budget. Request, native tree stop and observation share one local deadline after capture. Only proven finishing extends it for EAS work. Cloud cleanup requires the matching receipt, owner exit and loss of that generation's lock. It stops only captured and owner-reported IDs. | Held-session, deadline, crash and disconnect cases in `dev-owned-stop-test`; the unchanged billed-session case in `cloud-binding-test`. |
| A retained EAS grant excludes successors through exact-session cleanup. Binding replacement does not expand cleanup authority.                                                                                                                                                                                         | Held-session cleanup barrier and owner-election checks.                                                                                 |

New clients use authenticated `POST /stop`. Old owners reject it before allocating a grant.
New owners keep pre-lock `POST /cancel` for old clients and refuse its locked path.
A plain grant release can use its validated drained receipt if the control listener has closed.
An explicit release denial or a missing receipt still refuses that fallback.
Non-default signals are refused for owned runs. Matching locked `--force` and `--release` use the cooperative policy;
those modifiers remain unsupported before handoff. Foreground and unowned stops retain their ordinary behavior.

An explicit child-handle lifecycle was rejected because it duplicates the existing step-admission and scope tracking.
Process-wide signal forwarding was rejected because it also reaches the EAS capture that must return its session ID.
Native tree operations cover the managed group or Windows taskkill tree, not deliberately escaped descendants.
An absent receipt retains the claim for explicit recovery as described in [[0004-smart-start-and-project-state]].
