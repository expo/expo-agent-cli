# 0010: Agent conventions

**Type:** RFC
**Status:** Active
**Systems:** `@expo/agent-cli` launcher (`src/cli.ts`, `src/commandRegistry.ts`, `src/exitCodes.ts`, `src/utils/errors.ts`, `src/utils/jsonMode.ts`); `@expo/agent-cli typecheck` (`src/typecheck/`); the needs-human protocol (`src/needsHuman/`, `src/utils/subprocess.ts`, `src/utils/expoCli.ts`); `packages/@expo/cli`; `eas-cli`
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-23
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0002-testing-and-evals]], [[0006-agent-native-cli-surface]], [[0008-guardrails]], [[0016-v1-scope]]

## Summary

The rules every `@expo/agent-cli` command shares: what the exit code means, how a failure says what to do next, and how one argv resolves to one command. [[0006-agent-native-cli-surface]] owns the shape of the surface. §Upstream asks lists the gaps in the Expo CLI family that the tool layer works around.

## Exit codes

A driving agent reads the exit code first. The code says whether the tool worked, and whether the thing it was asked about worked.

| Code    | Meaning                                                                     | The agent's next move                            |
| ------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `0`     | The tool worked, the outcome was success                                    | Continue                                         |
| `1`     | The tool did not work: usage error, missing dependency, bug                 | Read the error and the `Try:` line. Fix the call |
| `7`     | The tool worked. A person must finish the step                              | Hand the printed URL or instruction to the human |
| `20`    | The tool worked. The operation failed                                       | Read the payload. Act on the subject's failure   |
| `21`    | Reserved for "canceled". No v1 command emits it                             | Nothing                                          |
| `22`    | The tool worked. It could not conclude: timed out, or nothing could measure | Look again, or read why it could not measure     |
| `23-29` | Reserved for further outcome classes                                        |                                                  |

Why the codes sit where they do:

- `20-29` is one band. A caller that tests the range keeps working when a command adds a new outcome class.
- `7` is apart from both bands. A step that only a person can do (sign in through a browser, approve a device) does not finish when the agent runs the command again.
- `22` is apart from `20`. After `22`, looking again can help. After `20`, it wastes minutes.
- No assigned code is above `125`. Shells and `npx` use the codes above `125` for their own conditions.

`21` is reserved: a unit test fails when loadable source starts to use it. `dev --plan` runs nothing on purpose. That is a success, so it exits `0`, not `21`.

The one exception to the `125` ceiling is `dev`. It follows the shell's convention for signals. A signal that arrives before, between or during any step other than the dev server exits `128` plus the signal number (`DEV_INTERRUPTED`). A signal that ends the dev-server step is the stop the caller asked for, so it exits `0`.

A failure takes one of two paths:

- A **tool error** is an error object. The CLI prints it and exits with the code the error carries, or `1` when it carries none.
- An **outcome** is not an error. The command prints its report and exits with the outcome code (`0`, `20` or `22`).

Both paths flush the event stream before the process exits.

### An empty target list is inconclusive

After a reload, the debugger target list is empty for about half a second while the runtime comes back. So a command that needs a debugger target waits first ([[0005-runtime-loop-tools]] §One preflight for the runtime family). A list that is still empty after the wait is `22`: the tool worked and could not conclude.

Two other states stay `1`: no dev server, and a target list with no app in the run's scope (another platform, worktree or session). Neither changes within a second. The fix is a different call: start a dev server, open the app in scope, or change the flag.

### Forwarded codes, and the exception

`install`, `start`, `dev` and the `expo` passthrough return the subprocess's exit code unchanged. A child that a signal ended has no exit code, so the CLI picks one:

- An `expo` child ended by `SIGINT` or `SIGTERM` gives `0`. Any other signal gives `1`.
- The bare install's package manager gives `1` for any signal.

A wrapper's own failures use the table above. A forwarded `7` is the child's own code, not a needs-human stop. Only a non-null `needsHuman`, or the `Needs a human` block, means a person must act.

The exception to forwarding is `doctor`, which adds a verdict of its own ([[0016-v1-scope]] §Doctor's exit code).

A bare `install` in an Expo app whose `expo` package does not resolve runs the package manager's own plain install command. It runs in the directory that `@expo/package-manager` resolves: the workspace root, or the project. It never runs in an unrelated parent folder. The install is not frozen, because `npm ci` deletes the `node_modules` of every member of a workspace. The other states:

| State                                               | Stop                                                  |
| --------------------------------------------------- | ----------------------------------------------------- |
| manager not installed                               | `PACKAGE_MANAGER_NOT_FOUND`                           |
| install exits `0`, `expo` still unresolved          | `DEPENDENCIES_NOT_INSTALLED`, names the command run   |
| any other `install` form while `expo` is unresolved | `DEPENDENCIES_NOT_INSTALLED`, `Try:` the bare install |

### The fourth: `typecheck`

`typecheck` runs the project's own compiler and uses the outcome band.

| Code | The project                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------ |
| `0`  | type-checks; or has no TypeScript, or a compiler but no `tsconfig.json` (`checked: false`)             |
| `20` | does not type-check. The diagnostics are the payload                                                   |
| `1`  | a TypeScript project with no compiler, a compiler that cannot start, or one that failed saying nothing |

`reason` is non-null exactly when `checked` is false. A follow-up also says that nothing was checked, so "nothing was checked" cannot read as "everything passed".

What counts:

- **A TypeScript project** has a `tsconfig.json`, or its own `.ts`, `.tsx`, `.mts` or `.cts` sources. `.d.ts` files alone do not count, because `expo-env.d.ts` is generated into every app.
- **The compiler** is a `node_modules/.bin/tsc` in the project or in a folder above it. Nothing is fetched: a type check depends on the project's own compiler version, `tsconfig.json` and `@types`.

A TypeScript project with no compiler stops with `TYPECHECK_CLI_MISSING` and `Try: npx @expo/agent-cli install typescript --dev`. When the app's dependencies are not installed at all, that is the real cause, so the stop is `DEPENDENCIES_NOT_INSTALLED` with the bare `install` as its `Try:` line.

A compiler that failed and printed nothing readable is `1`. Reported as an outcome, it would send an agent to look for a type error that does not exist. Both output forms of the compiler are parsed, because a project's own `pretty` setting overrides the `--pretty false` that the command asks for.

### Other gates, in brief

A command that reports on the app does not fail because of what it reports. For example, `runtime:errors` exits `0` whatever errors it collects. To make a report a gate, the caller adds a flag. Every `--assert` or `--fail-on-*` flag answers a measured failure with `20` and a state it cannot measure with `22`.

| Command                    | Codes                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `runtime:errors`           | `0`; with `--fail-on-error`, `20` on a non-empty window, `22` when the runtime cannot answer ([[0005-runtime-loop-tools]])        |
| `runtime:reload`           | `0` observed, `20` did not happen, `22` ran and saw nothing, `1` not attempted ([[0005-runtime-loop-tools]] §Reloading the app)   |
| `status --assert <class>`  | `20` when the real class is stronger, `22` when nothing classifies; `0` without the flag                                          |
| `runtime:stop`, `dev:stop` | `0` when already stopped; other `20`s in [[0005-runtime-loop-tools]] §Stopping the app                                            |
| `runtime:stop`             | `1` when the device tool refused                                                                                                  |
| `dev:stop`                 | `20` when the dev server or EAS session did not stop or a device tool failed; `22` with `--eas` while the EAS session is starting |

The entry-bundle check runs inside `smoke`, `runtime:reload`, `runtime:tree`, `runtime:tap` and `runtime:type`:

- A broken bundle is `20`.
- A cold first build that does not finish inside `--timeout` is `22`.
- An unknown result is not a broken bundle. `bundle.checked` is exactly `bundle.ok != null`.

The check sends its HEAD request to the dev server it was given ([[0005-runtime-loop-tools]] §Where a device reaches the dev server). It uses the path and query that the manifest or web page names, but never their host. `bundle.url` is that URL. The reason: a HEAD of the bundle through the Expo tunnel closes every websocket on that tunnel, the app's debugger socket too. A GET that is cancelled after its headers does the same.

## Needs-human protocol

A needs-human `7` comes from one error class, one event, one registry and four layers.

The needs-human error is a tool error with exit `7` and a record: `scenario`, `need`, `command`, `url`, `unattendedEnv`, `resumable`, `detectedBy`.

- A failure that the protocol reclassifies keeps the error code its site already had. The exception is a `dev` plan step, which takes the registry row's code.
- A `dev --detach` parent relays a stop that its child process classified, with `detectedBy: "detached-child-log"`. The reader then knows the stop was relayed, not seen.

The CLI emits `cli:error` with `needsHuman: true`, then `cli:needs_human` with the whole record. Then it prints this block in place of the `Try:` line, because the block's second line already is the command:

```
Needs a human   eas-login
Ask the user    npx @expo/agent-cli login
Or set          EXPO_TOKEN  (https://expo.dev/settings/access-tokens)
```

The registry is a data table of scenarios. Callers never match output strings themselves.

- Most rows have a signature: a pattern that layer 3 matches against a child's output.
- The generic rows `expo-prompt` and `eas-prompt` sort last, so a specific row always wins.
- A row with no signature is never matched against output. Only a caller that names the row raises it, and no v1 caller does.

Two words in the layers below:

- A **captured** child is a subprocess whose output this CLI reads through a pipe, instead of letting it print to the terminal.
- A **rung** is one source of an answer in an ordered list. When one rung cannot answer, the next rung is asked.

Four layers, in priority order:

1. **Preflight.** Before a command that needs an account starts, ask who is signed in. The question has a short deadline, and the answer is cached for the process.
   - The rungs, in order: `eas whoami`, then the project's own `expo whoami`, then `EXPO_TOKEN`.
   - A rung that cannot answer passes to the next one: no binary, an `eas` that would have to be downloaded, a run past the deadline, or a binary under that name that is not the CLI.
   - "Not the CLI" needs both: output with nothing that looks like that CLI's, _and_ a wrapper's exit (`101`, `126`, `127`, `134`, `139`, or a panic signature).
   - When no rung answers, `loggedIn` is `null`, never `false`.
   - On `false`, the command stops with `eas-login`, exit `7`, before it spends anything. On `null`, it runs, and layer 3 recognises a real sign-in failure.
2. **Nobody can answer.** A captured child gets no stdin, and its stdout is a pipe, never a terminal.
   - An `eas` command that can prompt also gets `--non-interactive`, or `--json`, which implies it.
   - An `expo` command gets `CI=1` in its environment, because the Expo CLI rejects `--non-interactive`.
   - The exception is the captured run that starts a dev server (`expo start`, `expo run:*`). `CI` also turns off Metro's file watcher, so that child inherits the caller's environment unchanged. Nothing is set, not even `CI=0`. The pipe still tells the Expo CLI that nobody can answer.
3. **Classify the output.** Match the captured output against the registry. The patterns that matter most: eas-cli's `Either log in with … EXPO_TOKEN`, `@expo/cli`'s `is in non-interactive mode`, and the `in non-interactive mode` fragment that eas-cli's prompts share.
4. **Generic prompt fallback.** Only for a captured child, and only when the caller opts in. If the child writes nothing for `AGENT_CLI_PROMPT_TIMEOUT_MS` (default 20 s), _and_ its last non-empty line looks like a prompt, the CLI kills the child. The line is quoted as untrusted text.

A busy port, and this project's own running dev server, are recognised before the classifier runs. Neither is needs-human, because the recovery is another command that this CLI can run itself ([[0004-smart-start-and-project-state]] §A busy port). Neither is a negative signature in the registry, so `expo-prompt` still catches every other prompt.

A failed `dev` plan step raises an error. The plan object prints only when every step worked.

- A stop that layer 3 recognises raises that row's needs-human error, with the row's own code (such as `EXPO_NEEDS_INPUT`).
- Any other failure is `PLAN_STEP_FAILED`, with the step's own exit code and `needsHuman: null`. This holds even for a step that exited `7`: Node exits `7` after an unhandled rejection, and a matching number is not a stop.
- Under `--json`, the error also holds the tail of the step's output. A run without `--json` already showed that output.

`dev` captures its steps when nobody watches a terminal (`--json`, or a run without a TTY), and inherits the terminal when somebody does. Forwarded passthrough commands inherit the terminal and are not classified.

## The `--json` error envelope

A command with its own `--json` prints one JSON object on stdout under `--json`, success or failure. `--help` prints help. `start` and forwarded `expo` commands have no `--json`. The failure object:

```json
{
  "error": {
    "code": "EAS_DEPLOY_FAILED",
    "message": "…",
    "suggestedCommand": "npx @expo/agent-cli login",
    "needsHuman": { "scenario": "eas-login", "need": "…", "command": "npx @expo/agent-cli login" },
    "data": null
  }
}
```

- The key set never varies; `suggestedCommand`, `needsHuman` and `data` are `null`, not absent.
- `needsHuman` is the whole record (the example shows three fields); `suggestedCommand` is then its `command`.
- `data` is a flat object of facts already in the message, with keys fixed per error code, or `null`.
- Success output is the command's own payload, not wrapped.
- stderr still carries the what / Why: / How: / `Try:` block.
- Argument parsing is covered. An unknown option or a stray positional is a tool error, caught where every command is invoked, so the envelope is a property of the CLI and not of each command. A bad option gets `Try: <command> --help`. When the option exists on another command, such as `--port` on `dev`, the error names that command. A unit test checks that each named command still resolves.
- Whether `--json` was asked for is read from the raw arguments, because the error path often runs before the command parsed its own arguments. Only the arguments after the command name and before any `--` count: in `install -- --json`, the flag is npm's.
- `dev --json` prints exactly one object at the end: the plan with step results, or the envelope. `dev --plan --json` prints the plan. The `cli:start_plan` event carries the plan before the first step.

The exit code is still the first thing to read. The envelope explains a failure; it does not signal one.

## Registry rules

Four rules decide how an argv resolves, and what a wrong argv gets.

### (a) Options without an action are an error, not help

Take a group with no default action. A group name followed by options and no action is an error. The CLI prints the group listing first and the error last: `UNKNOWN_ACTION` with `Try: npx @expo/agent-cli <group> --help`, exit `1`. An exit `0` would read as success, and an agent would wait for output that never comes. The last line is the one an agent acts on.

The same group with nothing after its name prints its listing and exits `0`: asking a group what it does is not wrong. `<group> --help` and `-h` always print the listing.

A group with a default action gives that action every option, so `doctor --json` runs the check. Its `--help` prints the listing and then the action's own help.

### (b) A group cannot capture the bare form of a forwarded `expo` command

A command that shares a name with an `expo` command behaves like that command ([[0006-agent-native-cli-surface]]). No v1 group has such a name. A unit test checks the rule with a synthetic `config` group:

| Argv                   | Result                                  |
| ---------------------- | --------------------------------------- |
| `config --type public` | forwards: `expo config --type public`   |
| `config:doctor`        | the group's own action                  |
| `config:nope`          | `UNKNOWN_ACTION`, never a forward       |
| `config doctor`        | forwards two arguments to `expo config` |

So a group under a forwarded name has one spelling for its actions, not two, and its `--help` must show the colon form.

### (c) A group named after another CLI's verb recovers into that CLI

A group may declare the other CLI's command for its bare name. Then the error of rule (a) names that command, and the `Try:` line is that command with the caller's own flags (`Try: npx eas build --platform ios`). The recovery is a paste. No v1 group declares one; the mechanism is kept and tested.

Rule (b) covers a name that `@expo/agent-cli` forwards and runs itself. Rule (c) covers a name owned by a CLI that `@expo/agent-cli` does not forward.

### (d) An argument a command has no place for is an error, not a shrug

A command that drops an argument and reports success is a silent no-op: the one answer a driving agent cannot recover from ([[0006-agent-native-cli-surface]]).

Every command that parses arguments declares `positionalArgs: 'none' | 'own'`. There is no default, so the type checker asks the question of each command.

- `'none'`: a positional is an error, `BAD_ARGS`, which names what was dropped. A command can add one sentence for what the caller probably meant.
- `'own'`: the command reads its positionals itself. The argument parser also puts unrecognized options in the positional list, so a blanket rejection would reject the flags that the command goes on to read.

## Three names for the recovery

`help workflow` says all three ([[0024-cli-ui]] §The on-ramp):

| Band                                         | Where the recovery is                                | Under `--json`           |
| -------------------------------------------- | ---------------------------------------------------- | ------------------------ |
| `1`, and any failure a command raises itself | `Try: <command>`                                     | `error.suggestedCommand` |
| `7`                                          | `Ask the user <…>`, under `Needs a human <scenario>` | `error.needsHuman`       |
| `20`, `22` outcomes                          | the report's `Suggested next:` list                  | the report's `followups` |

## Suggestions are pasted, so they have to be runnable

Every suggestion (a `Try:` line, an `Ask the user` line, a `Suggested next:` entry) and every error message is written as `npx @expo/agent-cli …`. As it is printed, that prefix is rewritten into the spelling of the runner the caller used. Nothing else in the line changes. `--json` payloads and events keep the written form.

The caller's runner is Bun when the CLI runs on Bun, or when `npm_config_user_agent` or `npm_execpath` names Bun. `BUN_INSTALL` is not a signal: it says that Bun is installed, not that Bun ran this command.

The runner this CLI uses to spawn other tools is a separate question. It is `bunx` when the caller's runner is Bun, or, for `eas-cli` only, when the project's lockfile is Bun's. Either way, `bunx` must be on `PATH`. Otherwise it is `npx`. `eas simulator:exec npx <agent-device>` is exempt, because that `npx` runs in a datacenter.

## EAS JSON

No `eas --json` payload contains a `null`: eas-cli deletes every key whose value is null before it prints. So on that wire, a missing key is the only way to say null, and no parser here tries to tell "the service said null" from "the service said nothing".

## `inspect:build-log`

The failure-signature table is capped and in-repo ([[0012-build-explain]]).

## Upstream asks

Gaps found while building the tool layer, recorded and not yet filed ([[0001-agentic-cli-on-expo-cli]] constraint 5).

| Tool                | Ask                                                                                                                          | Workaround here                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `eas-cli`           | `build:logs` (`build:view --json` gives only signed `logFiles` URLs)                                                         |                                                                            |
| `eas-cli`           | `credentials:list --json --non-interactive`                                                                                  |                                                                            |
| `eas-cli`           | `--non-interactive` on `build:view` and `submit:view`                                                                        |                                                                            |
| `eas-cli`           | `env:list --json`                                                                                                            |                                                                            |
| `eas-cli`           | A typed code when a command needs a prompt                                                                                   | the signature table                                                        |
| `@expo/cli`         | `expo start --ios` must not take the dev server down                                                                         |                                                                            |
| `@expo/cli`         | Split "nobody can answer" from "do not watch files"; `CI` means both                                                         | layer 2 exception                                                          |
| `@expo/cli`         | `cli:error` JSONL for every command error, with `needsInput`                                                                 | layer 3 classify                                                           |
| `@expo/cli`         | Metro error class and project-relative file on the web error page                                                            |                                                                            |
| `@expo/cli`         | Standalone typegen for `expo-env.d.ts` and `.expo/types/`                                                                    |                                                                            |
| `@expo/cli`         | `expo cache:clear`                                                                                                           |                                                                            |
| `@expo/cli`         | Do not print the deep-link scheme as the dev server URL                                                                      | keep the host; a non-HTTP scheme becomes `https` for a tunnel, else `http` |
| `@expo/cli`         | `devserver:url` in a released SDK                                                                                            | parse `Waiting on <url>`                                                   |
| `@expo/fingerprint` | `fingerprint:diff` from stdin or two revisions                                                                               | temporary files                                                            |
| `create-expo`       | `--no-git`                                                                                                                   | remove only the repository it made                                         |
| `expo-doctor`       | `--json`                                                                                                                     | parse the prose report                                                     |
| Expo Go (iOS)       | Cold launch with a URL crashes on `UNIQUE constraint failed: updates.scope_key, updates.commit_time`                         | launch with no URL, then send the link ([[0005-runtime-loop-tools]])       |
| `agent-device`      | `close` reports the app it acted on; `open <app> <url>` is not the shape for an Expo Go URL while the launch above is broken | [[0005-runtime-loop-tools]]                                                |

## Testing

Unit tests cover the constants and resolution rules; the built bin against stub tools covers the envelope, the needs-human protocol and exit codes ([[0002-testing-and-evals]]). Paths are under `src/` or `e2e/__tests__/`.

| Section                                              | Tests                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §Exit codes                                          | `__tests__/exitCodes-test.ts`, `utils/__tests__/errors-test.ts`                                                                                                                                                                                                                                                                   |
| §An empty target list is inconclusive                | `runtime/__tests__/preflight-test.ts`; e2e `runtime-preflight-test.ts`                                                                                                                                                                                                                                                            |
| §Forwarded codes, and the exception                  | e2e `wrapper-test.ts`, `install-bootstrap-test.ts`, `doctor-test.ts`                                                                                                                                                                                                                                                              |
| §The fourth: `typecheck`                             | `typecheck/__tests__/checkAsync-test.ts`, `parseTscOutput-test.ts`, `typecheckAsync-test.ts`; e2e `typecheck-test.ts`                                                                                                                                                                                                             |
| §Other gates, in brief                               | `status/__tests__/assert-test.ts`; `runtime/__tests__/bundleCheck-test.ts`, `stopAsync-test.ts`; `dev/__tests__/stopAsync-test.ts`; e2e `runtime-test.ts`, `status-test.ts`, `stop-test.ts`, `runtime-reload-test.ts`, `smoke-test.ts`                                                                                            |
| §Needs-human protocol                                | `needsHuman/__tests__/registry-test.ts`, `detect-test.ts`, `preflight-test.ts`, `promptShape-test.ts`; `utils/__tests__/subprocess-test.ts`, `expoCli-test.ts`, `wrapperCrash-test.ts`, `errors-test.ts`; `dev/__tests__/portCollision-test.ts`, `detachAsync-test.ts`; e2e `dev-test.ts`, `dev-detach-test.ts`, `deploy-test.ts` |
| §The `--json` error envelope                         | `utils/__tests__/errors-test.ts`, `jsonMode-test.ts`, `unknownOption-test.ts`, `args-test.ts`; e2e `dev-test.ts`, `typecheck-test.ts`                                                                                                                                                                                             |
| §Registry rules                                      | `__tests__/commandRegistry-test.ts`, `utils/__tests__/args-test.ts`; e2e `help-test.ts`, `wrapper-test.ts`                                                                                                                                                                                                                        |
| §Three names for the recovery                        | e2e `help-test.ts`                                                                                                                                                                                                                                                                                                                |
| §Suggestions are pasted, so they have to be runnable | `utils/__tests__/invoker-test.ts`, `packageRunner-test.ts`, `easCli-test.ts`                                                                                                                                                                                                                                                      |
| §EAS JSON                                            | none: a rule for parsers, not a behavior a test can observe                                                                                                                                                                                                                                                                       |
