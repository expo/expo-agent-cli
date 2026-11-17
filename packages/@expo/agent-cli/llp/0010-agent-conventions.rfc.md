# 0010: Agent conventions

**Type:** RFC
**Status:** Active
**Systems:** `@expo/agent-cli` launcher (`src/cli.ts`, `src/commandRegistry.ts`, `src/exitCodes.ts`, `src/utils/errors.ts`, `src/utils/jsonMode.ts`); `@expo/agent-cli typecheck` (`src/typecheck/`); the needs-human protocol (`src/needsHuman/`, `src/utils/subprocess.ts`, `src/utils/expoCli.ts`); `packages/@expo/cli`; `eas-cli`
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-23 · finalized 2026-08-28
**Revised:** 2026-08-30 · 2026-11-17
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0002-testing-and-evals]], [[0006-agent-native-cli-surface]], [[0008-guardrails]], [[0016-v1-scope]]

## Summary

The conventions every `@expo/agent-cli` command shares: what the exit code means, how a failure says what to do next, and how one argv resolves to one command. [[0006-agent-native-cli-surface]] owns the shape of the surface. This document owns the rules that hold across all of it. §Upstream asks lists the gaps in the Expo CLI family that the tool layer works around.

## Exit codes

A driving agent reads the exit code before it reads the output. The code answers two questions: did the tool work, and did the thing the tool was asked about work.

| Code    | Meaning                                                                         | The agent's next move                            |
| ------- | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `0`     | The tool worked, the outcome was success                                        | Continue                                         |
| `1`     | The tool did not work: usage error, missing dependency, bug                     | Read the error and the `Try:` line. Fix the call |
| `7`     | The tool worked. A person must finish the step                                  | Hand the printed URL or instruction to the human |
| `20`    | The tool worked. The operation failed                                           | Read the payload. Act on the subject's failure   |
| `21`    | The tool worked. The operation was canceled. Reserved, emitted by no v1 command | Nothing branches on it in this release           |
| `22`    | The tool worked. It could not conclude: timed out, or nothing could measure     | Look again, or read why it could not measure     |
| `23-29` | Reserved for further outcome classes                                            |                                                  |

The codes sit in bands. `20-29` is one band an agent can test with a range, so a command that grows a new outcome class does not break a caller that knew only the old ones. `1` is the whole "the tool did not work" band. `7` sits away from both: a step only a person can complete (signing in through a browser, approving a device, finishing a launch in a web page) is its own class, because a retry of the same command cannot finish it. Inconclusive sits apart from failure: looking again can help after `22` and is a waste of minutes after `20`. No code this CLI assigns is above `125`, which POSIX shells and `npx` use for their own conditions. A forwarded code is the subprocess's own.

`21` is reserved. The constant stays defined so the number keeps its meaning for the command that brings it back. A unit test fails when loadable source starts to use it. `dev --plan` runs nothing on purpose and exits `0`: that is a success, not a cancellation.

A tool error is an error object that may carry its own code. The CLI prints it and exits with that code, or `1` when it names none. An outcome is not an error: the command prints its report and exits with the outcome code. Both paths flush the event stream before the process exits.

### An empty target list is inconclusive

`1` promises that the same line run again changes nothing. After a reload, the debugger target list is empty for about half a second while the runtime comes back.

So a command that needs a debugger target waits first, and an empty list after the wait is `22`: the tool worked and could not conclude. The wait and the scope are [[0005-runtime-loop-tools]] §One preflight for the runtime family.

No dev server, and a target list with no app in the run's scope (another platform, worktree, or session), stay `1`. Neither changes within a second. The fix for the first is to start a dev server, and the fix for the second is to open the app in scope or change the flag. "Fix the call" is what `1` says.

### Forwarded codes, and the exception

`install`, `start`, `dev`, and the `expo` passthrough hand back the subprocess's exit code unchanged. A wrapper's own failures use the table.

A bare `install` in an Expo app whose `expo` package does not resolve runs the package manager's plain install (`npm install`, `bun install`, `pnpm install` or `yarn install`) in the directory `@expo/package-manager` resolves (the project's workspace root, or the project), and exits with its code. An unrelated parent's lockfile never runs. The install is not frozen: `npm ci` deletes a workspace root's `node_modules` for every member, and a runnable clone is worth a lockfile update. A manager that is not installed stops with `PACKAGE_MANAGER_NOT_FOUND`. An install that exits 0 and leaves `expo` unresolved stops with `DEPENDENCIES_NOT_INSTALLED` and names the command that ran. Every other form of `install` runs `expo install`, which cannot read the SDK yet, so in that state it stops with `DEPENDENCIES_NOT_INSTALLED` and `Try:` the bare `install`.

The exception is a command that adds a verdict: `doctor` ([[0016-v1-scope]] §Doctor's exit code).

### The fourth: `typecheck`

`typecheck` is in the outcome band. The other gates parse and watch for throws. This one type-checks, with the project's own compiler.

| Code | The project                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------ |
| `0`  | type-checks, has no TypeScript, or has a compiler but no `tsconfig.json` (`checked: false`)            |
| `20` | does not type-check. The diagnostics are the payload                                                   |
| `1`  | a TypeScript project with no compiler, a compiler that cannot start, or one that failed saying nothing |

A project with no TypeScript exits `0` with `checked: false`. `reason` is present exactly when `checked` is false. The follow-up says so as a command as well as a field, so "nothing was checked" cannot read as "everything passed". Either `tsconfig.json` or `.ts`/`.tsx` sources make a TypeScript project. `.d.ts` files alone do not, since `expo-env.d.ts` is generated into every app.

A TypeScript project with no compiler is `1` (`TYPECHECK_CLI_MISSING`) with `Try: npx @expo/agent-cli install typescript --dev`. In an Expo app whose dependencies are not installed, that is the cause, so the stop is `DEPENDENCIES_NOT_INSTALLED` with the bare `install` as its `Try:` line.

No compiler is fetched. A type check depends on the project's compiler version, its `tsconfig.json`, and its `@types`, so only a `node_modules/.bin/tsc` in the project or a folder above it counts.

A compiler that failed and printed nothing readable is `1`: reported as an outcome, it would send an agent to look for a type error that does not exist. Both output forms are parsed, because a project can set `pretty` in its own config over the `--pretty false` the command asks for.

### Other gates, in brief

A command that reports on the app does not gate on what it reported. `runtime:errors` exits `0` whatever it collects. With `--fail-on-error` it exits `20` on a non-empty window and `22` on a runtime that cannot answer ([[0005-runtime-loop-tools]]).

`runtime:reload` uses both outcome codes: `0` observed, `20` did not happen, `22` a mechanism ran and nothing was seen, `1` not attempted ([[0005-runtime-loop-tools]] §Reloading the app).

`status --assert <class>` exits `20` when the real class is stronger than the one named, and `22` when nothing could be classified. Without the flag it exits `0`. Every `--assert` or `--fail-on-*` flag answers a measured failure with `20` and an unmeasurable state with `22`.

Stopping: a target already in the asked-for state is success, exit `0`. The report fields and the other `20` cases are [[0005-runtime-loop-tools]] §Stopping the app. Beyond those, `runtime:stop` exits `1` when the device tool refused, and `dev:stop` exits `20` when an EAS session did not stop or a device tool failed, and `22` while an EAS session is still starting.

The entry-bundle check runs inside `smoke`, `runtime:reload`, `runtime:tree`, `runtime:tap` and `runtime:type`. A broken bundle is `20`. A cold first build that does not finish inside `--timeout` is `22`. `unknown` is not `broken`: `bundle.checked` is exactly `bundle.ok != null`. The check sends its HEAD to the dev server it was given ([[0005-runtime-loop-tools]] §Where a device reaches the dev server) with the path and query that the manifest or web page names, never their host, and `bundle.url` is that URL. The reason: a HEAD of the bundle through the Expo tunnel closes every websocket on that tunnel, the app's debugger socket too, and a GET cancelled after its headers does the same.

## Needs-human protocol

Exit `7` comes from one error class, one event, one registry, and four layers.

The needs-human error is a tool error with exit code `7` and a record: `scenario`, `need`, `command`, `url`, `unattendedEnv`, `resumable`, `detectedBy`. A reclassified failure keeps the error code its site already shipped. A `dev --detach` parent relays the stop that its child classified, with `detectedBy: "detached-child-log"`, so the reader knows it was relayed and not seen. The CLI emits `cli:error` with `needsHuman: true`, then `cli:needs_human` with the whole record, then prints:

```
Needs a human   eas-login
Ask the user    npx eas login
Or set          EXPO_TOKEN  (https://expo.dev/settings/access-tokens)
```

The block replaces the `Try:` line, because line two already is the command.

The registry is a data table of scenarios. Two rows, `expo-prompt` and `eas-prompt`, are generic and sort last. A row with no signature is never matched against output: only a caller that names it raises it. No v1 caller raises one. Callers never match strings themselves.

Four layers, in priority order:

1. Preflight. Before a command that needs an account starts, ask who is signed in, with a short deadline, and cache the answer for the process. The answer comes from `eas whoami`, then the project's own `expo whoami`, then `EXPO_TOKEN`. A rung that cannot answer passes to the next one: no binary, an `eas` that would have to be downloaded, a run past the deadline, or a binary under that name that is not the CLI. When no rung answers, `loggedIn` is `null`, never `false`. On `false` the command stops with `eas-login`, exit `7`, before it spends anything. On `null` it runs, and layer 3 recognises a real failure.
2. Nobody can answer. A captured subprocess never gets stdin, and its stdout is a pipe, never a TTY. An `eas` command that can prompt also gets `--non-interactive`, or `--json`, which implies it. For `expo` it is `CI=1` in the child environment, because the Expo CLI rejects `--non-interactive` and names the variable instead. The exception is the captured run that starts a dev server (`expo start`, `expo run:ios`, `expo run:android`): `CI` also turns Metro's file watcher off, so that child inherits the caller's environment. Nothing is set, not `CI=0`: a machine whose own environment says `CI` is a machine where a frozen bundler is right. The pipe still tells the Expo CLI that nobody can answer.
3. Stderr classify. Match the captured output against the registry. The load-bearing patterns: eas-cli's `Either log in with … EXPO_TOKEN`, `@expo/cli`'s `is in non-interactive mode`, and the `in non-interactive mode` fragment that eas-cli's prompt sites share.
4. Generic prompt fallback. Only for a captured child, and only when the caller opts in. If the child writes nothing for `AGENT_CLI_PROMPT_TIMEOUT_MS` (default 20 s) _and_ its last non-empty line is prompt-shaped, it is killed and the line is quoted as untrusted text. Never in `inherit` mode.

A busy port is a `PORT_IN_USE` failure (exit `20` when the caller named `--port`), or a retry on a free port this CLI picked. This project's own running dev server is `DEV_SERVER_RUNNING`, exit `20`, decided before the project is probed. Both are recognised before the classifier runs, and neither is needs-human ([[0004-smart-start-and-project-state]] §A busy port): the recovery is another command, one this CLI can run itself. The carve-out is not a negative signature in the registry, so `expo-prompt` still catches every other prompt.

A failure counts as "not the CLI" only when its output holds nothing that looks like that CLI's _and_ the process died the way a wrapper dies: exit `101`, `126`, `127`, `134`, `139`, or a panic signature. That preflight rung then gives no answer instead of "signed out".

A failed `dev` plan step raises. The plan object prints only when every step worked. `--json` gets the error envelope (`PLAN_STEP_FAILED`) with the tail of what the step printed. A real stop carries `error.needsHuman`. A coincidence, such as Node leaving with `7` after an unhandled rejection, carries `null` there. `dev` captures its steps whenever nobody watches a terminal (`--json`, or a non-TTY run) and inherits the terminal when somebody does. Forwarded passthrough commands inherit the terminal and are not classified.

## The `--json` error envelope

A command run with `--json` prints one JSON object on stdout whether it succeeded or failed. The failure object is:

```json
{
  "error": {
    "code": "EAS_DEPLOY_FAILED",
    "message": "…",
    "suggestedCommand": "npx eas-cli whoami",
    "needsHuman": { "scenario": "eas-login", "need": "…", "command": "npx eas login" },
    "data": null
  }
}
```

The key set never varies. `suggestedCommand`, `needsHuman`, and `data` are `null`, not absent. `needsHuman` is the whole record of §Needs-human protocol; the example shows three of its fields. `data` holds a flat object of the facts the refusal was made on, or `null`. The key set inside `data` is fixed per error code, and nothing goes in it that is not already in the message a person reads. Success paths are untouched. stderr still carries the what / Why: / How: / `Try:` block.

The envelope covers argument parsing: an unknown option and a stray positional are tool errors, caught where every command is invoked, so the envelope is a property of the CLI and not of each command. A bad option gets `Try: <command> --help`. When the option exists on another command, such as `--port` on `dev`, the error names that command, and a unit test checks that each named command still resolves.

Whether `--json` was asked for is read from the raw argv, because the error path often runs before the command parsed its own arguments. Only the part before a `--` separator counts: `@expo/agent-cli install -- --json` is npm's flag.

`dev --json` captures the subprocesses and prints exactly one object when the run ends: the plan with the step results on a clean exit, or the envelope. `dev --plan --json` prints the plan, which is the answer there. The plan still reaches a driving agent before the first step, on the `cli:start_plan` event.

The exit code is still the first thing to read. The envelope explains a failure. It does not signal one.

## Registry rules

Four rules decide how an argv resolves to a command, and what a wrong argv gets.

### (a) Options without an action are an error, not help

A group name followed by options and no action, in a group with no default action, is an error. The CLI prints the group listing first and the error last, as `UNKNOWN_ACTION` with `Try: npx @expo/agent-cli <group> --help`, and exits `1`. An exit `0` there would read as success, and an agent would wait for output that never comes. The last line is what an agent acts on.

A bare group with no default action prints its listing and exits `0`: asking a group what it does is not wrong. `<group> --help` and `-h` always print the listing. A group with a default action gives that action every option, so `@expo/agent-cli doctor --json` checks, and its `--help` prints the listing and then the action's own help.

### (b) A group cannot capture the bare form of a forwarded `expo` command

The naming rule of [[0006-agent-native-cli-surface]] decides it: a command that shares a name with an `expo` command behaves like that command.

The bare form of such a name forwards: `@expo/agent-cli config --type public` is `expo config --type public`. The colon forms belong to the group: `config:doctor` resolves as any group action does, and an action the group does not have is `UNKNOWN_ACTION`, never a forward. The space form is unavailable there: `@expo/agent-cli config doctor` forwards two arguments to `expo config`.

A group under a forwarded name has one spelling for its actions instead of two. The group's `--help` must show the colon form.

### (c) A group named after another CLI's verb recovers into that CLI

A group may declare the other CLI's command for its bare name. Then the error of rule (a) names it, and the `Try:` line is that command with the caller's own flags (`Try: npx eas build --platform ios`). The recovery is a paste. No v1 group declares one; the mechanism is kept and tested.

This is narrower than rule (b). Rule (b) is for a name in the forwarded set, where `@expo/agent-cli` runs the other command itself. Rule (c) is for a name owned by a CLI that `@expo/agent-cli` does not forward.

### (d) An argument a command has no place for is an error, not a shrug

A command that drops an argument and reports success is a silent no-op, the one answer a driving agent cannot recover from ([[0006-agent-native-cli-surface]]).

Every command that parses arguments states `positionalArgs: 'none' | 'own'`, with no default, so the type checker asks the question of each one. `'none'` reports `BAD_ARGS` naming what was dropped, plus an optional sentence per command for what the caller probably meant. `'own'` is for a command that reads its positionals itself. There unrecognized options also land in the positional list, so a blanket rejection would reject the flags the command goes on to read.

## Three names for the recovery

`help workflow` says all three ([[0024-cli-ui]] §The on-ramp):

| Band                                         | Where the recovery is                                | Under `--json`           |
| -------------------------------------------- | ---------------------------------------------------- | ------------------------ |
| `1`, and any failure a command raises itself | `Try: <command>`                                     | `error.suggestedCommand` |
| `7`                                          | `Ask the user <…>`, under `Needs a human <scenario>` | `error.needsHuman`       |
| `20`, `22`                                   | the report's `Suggested next:` list                  | the report's `followups` |

An outcome failure is not an error: it prints its report with its follow-ups. A `20`-band failure that a command _raises_ as an error still carries a `Try:`.

## Suggestions are pasted, so they have to be runnable

Every suggestion is written `npx @expo/agent-cli …` and printed in the spelling of the runner the caller used. The line is rewritten as it goes out. The runner is Bun when the CLI runs on Bun, or when `npm_config_user_agent` or `npm_execpath` names Bun. `BUN_INSTALL` is not a signal: it says Bun is installed, not that Bun ran this. Only `npx @expo/agent-cli` is rewritten. `--json` payloads and events keep the written form.

The runner this CLI _spawns_ with is a different question. It is `bunx` when Bun started the process, or, for `eas-cli`, when the project's lockfile is Bun's; either way only when `bunx` is on `PATH`. Else it is `npx`. `eas simulator:exec npx <agent-device>` is exempt: that `npx` runs in a datacenter.

## EAS JSON

No `eas --json` payload contains a `null`: eas-cli deletes every key whose value is null before it prints. Absence is the only way that wire says null, so no parser here tries to tell "the service said null" from "the service said nothing".

## `inspect:build-log`

The failure-signature table is capped and in-repo. Design, cap, and fixtures are [[0012-build-explain]].

## Upstream asks

Gaps found while building the tool layer. Per [[0001-agentic-cli-on-expo-cli]] constraint 5, these become upstream improvements, not imports. Recorded here, not yet filed.

`eas-cli`:

- `build:logs`, to read a build's logs from the CLI. `build:view --json` returns a `logFiles` array of signed URLs, which is a fetch away and is not the same thing.
- `credentials:list --json --non-interactive`.
- `--non-interactive` on `build:view` and `submit:view`.
- Typed non-interactive errors: a machine-readable code when a command cannot continue without a prompt. This would retire the signature table.
- `env:list --json`.

`@expo/cli`:

- Do not let `expo start --ios` take the dev server down with it.
- Separate "nobody can answer a prompt" from "do not watch files". `CI` means both today.
- Emit `cli:error` JSONL for every command error, with a `needsInput` flag.
- Put the Metro error class on the web dev server's static error page, and report the file relative to the project root.
- A standalone typegen command, so `expo-env.d.ts` and `.expo/types/` can be generated without a dev server.
- `expo cache:clear`.
- Do not print the app's deep-link scheme as the dev server's URL. With the v2 tunnel the advertised URL picks up the scheme. Worked around by keeping the host of the printed URL and replacing a non-HTTP scheme with `https` for a tunnel host, `http` otherwise.
- Emit `devserver:url` in a released SDK. Until then the tunnel host is parsed from `Waiting on <url>`.

`create-expo`:

- A `--no-git` flag. Worked around by removing the repository create-expo made, and only that one.

`expo-doctor`:

- `expo-doctor --json`.

Expo Go (iOS):

- A cold launch with a dev-server URL kills the app on its own updates database (`UNIQUE constraint failed: updates.scope_key, updates.commit_time`). Worked around by restarting the app with no URL, then sending the link ([[0005-runtime-loop-tools]]).

`agent-device`:

- A `close` that reports the app it acted on ([[0005-runtime-loop-tools]]).
- `open <app> <url>` should not be the recommended shape for an Expo Go dev URL while the launch path above is broken.

## Testing

The constants and the resolution rules have unit tests. The envelope, the needs-human protocol and each command's exit codes are tested through the built bin against stub tools ([[0002-testing-and-evals]]).

| Section                               | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §Exit codes                           | `src/__tests__/exitCodes-test.ts`; `src/utils/__tests__/errors-test.ts`                                                                                                                                                                                                                                                                                                                                                                             |
| §An empty target list is inconclusive | `src/runtime/__tests__/preflight-test.ts`; `e2e/__tests__/runtime-preflight-test.ts`                                                                                                                                                                                                                                                                                                                                                                |
| §Forwarded codes, and the exception   | `e2e/__tests__/wrapper-test.ts`, `install-bootstrap-test.ts`, `doctor-test.ts`                                                                                                                                                                                                                                                                                                                                                                      |
| §The fourth: `typecheck`              | `src/typecheck/__tests__/checkAsync-test.ts`, `parseTscOutput-test.ts`, `typecheckAsync-test.ts`; `e2e/__tests__/typecheck-test.ts`                                                                                                                                                                                                                                                                                                                 |
| §Other gates, in brief                | `src/status/__tests__/assert-test.ts`; `src/runtime/__tests__/bundleCheck-test.ts`, `stopAsync-test.ts`; `e2e/__tests__/runtime-test.ts`, `status-test.ts`, `stop-test.ts`; `src/dev/__tests__/stopAsync-test.ts`; `e2e/__tests__/runtime-reload-test.ts`, `smoke-test.ts`                                                                                                                                                                          |
| §Needs-human protocol                 | `src/needsHuman/__tests__/registry-test.ts`, `detect-test.ts`, `preflight-test.ts`, `promptShape-test.ts`; `src/utils/__tests__/subprocess-test.ts`, `expoCli-test.ts`, `wrapperCrash-test.ts`, `errors-test.ts`; `src/dev/__tests__/portCollision-test.ts`; `e2e/__tests__/dev-test.ts`; `src/dev/__tests__/detachAsync-test.ts`; `e2e/__tests__/deploy-test.ts`, `dev-detach-test.ts`; `src/deferred/build-wait/__tests__/build-wait-e2e-test.ts` |
| §The `--json` error envelope          | `src/utils/__tests__/errors-test.ts`, `jsonMode-test.ts`, `unknownOption-test.ts`, `args-test.ts`; `e2e/__tests__/dev-test.ts`, `typecheck-test.ts`                                                                                                                                                                                                                                                                                                 |
| §Registry rules                       | `src/__tests__/commandRegistry-test.ts`; `src/utils/__tests__/args-test.ts`; `e2e/__tests__/help-test.ts`, `wrapper-test.ts`                                                                                                                                                                                                                                                                                                                        |
| §Three names for the recovery         | `e2e/__tests__/help-test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| §Suggestions are pasted               | `src/utils/__tests__/invoker-test.ts`, `packageRunner-test.ts`; `src/utils/__tests__/easCli-test.ts`                                                                                                                                                                                                                                                                                                                                                |
| §EAS JSON                             | none: a rule for parsers, not a behavior a test can observe                                                                                                                                                                                                                                                                                                                                                                                         |
