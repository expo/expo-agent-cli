# 0008: Guardrails for agent-driven Expo workflows

**Type:** RFC
**Status:** Active
**Systems:** `src/dev/devAsync.ts`; `src/utils/consent.ts` (deferred `doctor:fix` only); runtime fences (`src/runtime/untrusted.ts`)
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-20
**Revised:** 2026-09-06
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0004-smart-start-and-project-state]], [[0016-v1-scope]], [[0017-deferred-commands]]

## Summary

Cheap mechanisms that make it safe for a driving agent to act autonomously on an Expo project.

Shipped: plan-with-cost dry runs, `dev --plan` as the dry run a caller asks for, and untrusted-content fences.

`dev` itself has no consent gate. It prints the plan and runs it, in a terminal as much as out of one. The two gates that used to be here — a `? Run this plan? ›` prompt, then a `Nothing ran` stop that handed back the same line with `--yes` — are both gone, and so is `--yes` itself. §The plan is announced, not negotiated is the record of why.

Checkpoints are deferred. See [[0017-deferred-commands]]. Code is on `src/deferred/checkpoint/`. Nothing in the v1 surface takes a snapshot. `runGitAsync` and `resolveWorkTreeAsync` stayed live in `src/utils/git.ts` because `src/impact/` reads a diff through them.

MCP permission-tier metadata is not built. There is no MCP server. It is scoped out in [[0016-v1-scope]], not a v1 candidate.

## Plan-with-cost dry run

Before acting, emit the plan with time-class estimates, as in "prebuild ~2 min, pod install ~4 min, dev build ~8 min", for one-shot approval. The smart start `--plan` contract ([[0004-smart-start-and-project-state]]) is the first implementation. Shipped as `@expo/agent-cli dev --plan`, and as the plan `@expo/agent-cli dev` prints before it runs it.

## The plan is announced, not negotiated

`dev` prints the plan it decided on, then runs it. There is no second act of consent. [confirmed, Kudo, 2026-09-06: "i want the `dev` acts like agent that will run the plan as well"]

This is the third position this section has held, and the reason it moved twice is that the first two both answered "how should a person approve this?" when the question that mattered was "who is this command for?".

The first was a prompt — `? Run this plan? › (Y/n)`. It was removed because an agent cannot answer one. A `(Y/n)` needs a keystroke on a TTY; an agent driving this CLI through a pty gets the cursor and nothing to type into it, and one driving it through a pipe got a different behaviour than the person who wrote its prompt saw.

The second was a stop [confirmed, Kudo, 2026-08-29]. Same plan on screen, but the command ended there and handed back the caller's own `process.argv` plus `--yes`. That fixed the hang and kept the gate, and its trigger was a TTY: a run with no terminal is an agent or a CI job that asked for the work and is waiting for it, so only a watched run stopped.

The TTY is what was wrong with it. It made one command two commands. `dev --ios` in an agent's transcript built the app; the same line pasted into a terminal printed a plan and refused, and the fix was to type a flag whose only effect was to undo the refusal. A person watching the plan go by is not more in need of protection than the agent that was never asked — they are just the one the CLI could detect, which is not the same thing. Detecting a terminal answers "is somebody looking", and the gate was being justified by "did somebody ask for this", and those two questions have different answers.

Somebody did ask. `dev --ios` means get this app onto an iOS device, and on a project whose development build is missing or stale, a prebuild and a native build **are** that — not a surprise the command sprang on the way, but the work itself. A guardrail in front of the requested work is a guardrail against the request.

So what remains is the dry run, and it is a command rather than a mode: **`--plan` prints the plan and exits, for every caller, terminal or not** (§Plan-with-cost dry run). A caller who wants to see before running says so. One that does not, does not.

`--yes` is gone, not accepted-and-ignored. A no-op flag is a flag callers keep passing to get a behaviour they already have, and it would have outlived every reader of this document. `cli:start_plan_needs_consent` is off the event stream for the same reason. `dev` no longer refers to `src/utils/consent.ts`; the deferred `doctor:fix --apply` is its last caller, and that does not ship ([[0017-deferred-commands]]).

**What did not change is that this CLI asks no questions.** No prompt module remains in the package and the `prompts` dependency is still gone. The `skills` / `agents:setup` agent checklist stays removed — it selected among detected agents, which is the answer the non-interactive path already gave for free, and `--agent` is the override.

Also unchanged, and deliberately: a forwarded CLI that prompts. `expo login` asks for a password on purpose. The needs-human protocol ([[0010-agent-conventions]]) is what covers it.

**A destructive command is a different question.** Nothing in v1 deletes a caller's files, so nothing needs an answer here yet. The one command that would have — the deferred `doctor:fix --apply` — kept the re-run pattern, and the argument above does not reach it: `doctor:fix` deleting `node_modules` is not the work its caller asked for, it is what the tool decided the work required. That distinction, not the presence of a TTY, is the line a future guardrail should be drawn on.

## Untrusted-content marking

App logs, network payloads, and screenshots flow into agent context. They can contain user- or attacker-controlled text, which is prompt injection. [confirmed, Kudo, 2026-08-20] Runtime commands ([[0005-runtime-loop-tools]]) mark that content as untrusted data, as fenced blocks with marker-forgery neutralization.

## A command whose targets are gitignored

A command whose targets are gitignored must state that its recovery does not cover them, in the same output that names the recovery. Printing an id and letting the reader infer the guarantee is worse than printing no id at all. `node_modules`, `ios/Pods`, `.expo`, and the Metro caches are the files a snapshot of tracked content does not hold. Whatever the recovery mechanism of the day is, an artifact that names it must also name what it leaves out. The case that produced the rule was `doctor:fix` and the checkpoint it took. Both are deferred ([[0017-deferred-commands]]). The rule is not about snapshots and stays here.

## Testing

Checkpoint/undo was deterministic. Its suites moved to `src/deferred/checkpoint/__tests__/` with the code and are not run. Plan-emission is covered by the smart start tests.

That a plan which builds runs unasked is covered by `src/dev/__tests__/devAsync-test.ts` §a plan that builds, which runs the stale-dev-client case on both sides of the TTY check — the axis the old gate turned on, pinned so it cannot come back by accident. `src/dev/__tests__/resolveOptions-test.ts` pins that `--yes` is refused rather than ignored, and `e2e/__tests__/dev-test.ts` asserts that neither `Run this plan?` nor `Nothing ran` appears in a real run.
