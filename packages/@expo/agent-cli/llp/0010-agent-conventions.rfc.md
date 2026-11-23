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
- `7` is apart from both. Running the command again cannot finish a step that only a person can do, such as signing in through a browser.
- `22` is apart from `20`. After `22`, looking again can help. After `20`, it wastes minutes.
- No assigned code is above `125`, which shells and `npx` use for their own conditions.

A unit test fails when loadable source starts to use `21`. `dev --plan` runs nothing on purpose, which is a success: exit `0`.

The one exception to the `125` ceiling is `dev`, which follows the shell's convention for signals. A signal at any other time exits `128` plus the signal number. During a step, the error is `DEV_INTERRUPTED`. A signal that ends the dev-server step is the stop the caller asked for: exit `0`.

A command ends in one of three ways:

- A **tool error** is a throw. It is printed and exits with the code it carries, or `1` when it carries none.
- An **outcome** is not an error. The command prints its report and returns `0`, `20` or `22`.
- A **forwarded code** is the exit code of the CLI the command handed the run to (§Forwarded codes), returned unchanged.

A command returns its code and never exits by itself. The dispatcher is the one place a finished command exits, and it flushes the event stream first. The command type accepts only an outcome or a code marked as forwarded, and every path must return one, so a returned `1` or a body that falls off the end does not compile (type test in `__tests__/exitCodes-test.ts`). The same file has a sweep that keeps the exits the type cannot see in the files that need them. One drop still compiles: a command that awaits another command and returns its own `0`. The e2e `help-test.ts` case for `help <forwarded command>` guards the one place that does this.

### An empty target list is inconclusive

After a reload, the debugger target list is empty for about half a second. So a command that needs a debugger target waits first ([[0005-runtime-loop-tools]] §One preflight for the runtime family). A list that is still empty after the wait is `22`. An attached app that ran no JavaScript bundle is the same question: the same wait, then `22`, with `APP_NOT_LOADED` ([[0005-runtime-loop-tools]] §A loaded app).

Two other states stay `1`, because neither changes within a second and the fix is a different call: no dev server (start one), and no app in the run's scope, such as an app on another platform, worktree or session (open the app in scope, or change the flag).

### Forwarded codes, and the exception

`install`, `start` and the `expo` passthrough return the subprocess's exit code unchanged. For a child that a signal ended, the CLI picks the code:

- An `expo` child ended by `SIGINT` or `SIGTERM` gives `0`. Any other signal gives `1`.
- The bare install's package manager gives `1` for any signal.

`dev` does not forward a signal code. It follows the signal rule of §Exit codes: `DEV_INTERRUPTED` and `128` plus the signal number, except a signal that ends the dev-server step, which is exit `0`. A failed step is §Needs-human protocol's `PLAN_STEP_FAILED`.

A wrapper's own failures use the table above. A forwarded `7` is the child's own code: only a non-null `needsHuman`, or the `Needs a human` block, means a person must act.

The exception to forwarding is `doctor`, which adds a verdict of its own ([[0016-v1-scope]] §Doctor's exit code).

A bare `install` in an Expo app whose `expo` package does not resolve runs the package manager's plain install. It runs in the workspace root or the project, as `@expo/package-manager` resolves it, never in an unrelated parent folder. It is not frozen, because `npm ci` deletes the workspace root's `node_modules`, which every member shares. The other states:

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

`reason` is non-null exactly when `checked` is false. A follow-up also says that nothing was checked, so the `0` cannot read as a pass.

What counts:

- **A TypeScript project** has a `tsconfig.json`, or its own `.ts`, `.tsx`, `.mts` or `.cts` sources. `.d.ts` files alone do not count, because `expo-env.d.ts` is generated into every app.
- **The compiler** is a `node_modules/.bin/tsc` in the project or in a folder above it. Nothing is fetched, because the result depends on the project's own compiler, `tsconfig.json` and `@types`.

A TypeScript project with no compiler stops with `TYPECHECK_CLI_MISSING` and `Try: npx @expo/agent-cli install typescript --dev`. When the app's dependencies are not installed, that is the cause, so the stop is `DEPENDENCIES_NOT_INSTALLED` with the bare `install` as its `Try:` line.

A compiler that failed and printed nothing readable is `1`, not `20`: there is no type error to look for. Both output forms are parsed, because a project's `pretty` setting overrides `--pretty false`.

### Other gates, in brief

A command that reports on the app does not fail because of what it reports: without a flag, `runtime:errors` exits `0` whatever it collects. A preflight refusal comes before the collection and keeps its own code. A flag makes a report a gate. Every `--assert` or `--fail-on-*` flag answers a measured failure with `20` and a state it cannot measure with `22`.

| Command                    | Codes                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `runtime:errors`           | `0`; with `--fail-on-error`, `20` on a non-empty window, `22` when the runtime cannot answer ([[0005-runtime-loop-tools]])        |
| `runtime:reload`           | `0` observed, `20` did not happen, `22` ran and saw nothing, `1` not attempted ([[0005-runtime-loop-tools]] §Reloading the app)   |
| `status --assert <class>`  | `20` when the real class is stronger, `22` when nothing classifies; `0` without the flag                                          |
| `runtime:stop`, `dev:stop` | `0` when already stopped; other `20`s in [[0005-runtime-loop-tools]] §Stopping the app                                            |
| `runtime:stop`             | `1`, `DEVICE_STOP_REFUSED`, when the device tool refused                                                                          |
| `dev:stop`                 | `20` when the dev server or EAS session did not stop or a device tool failed; `22` with `--eas` while the EAS session is starting |

The entry-bundle check runs inside `smoke`, `runtime:reload`, `runtime:tree`, `runtime:tap` and `runtime:type`. A broken bundle is `20` in all five. A check that does not finish depends on the command:

| Command                                       | Wait                                                                                | A check that does not finish |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| `runtime:reload`                              | the remaining `--timeout`                                                           | `22`                         |
| `smoke`                                       | `--timeout`; on a dev server this run started, its own first-bundle budget of 180 s | `22`                         |
| `runtime:tree`, `runtime:tap`, `runtime:type` | a fixed 20 s, not `--timeout`                                                       | `20`                         |

An unknown result is not a broken bundle: `bundle.checked` is exactly `bundle.ok != null`.

The check sends its HEAD request to the dev server it was given ([[0005-runtime-loop-tools]] §Where a device reaches the dev server), with the path and query that the manifest or web page names, never their host. `bundle.url` is that URL. The reason: a HEAD, or a GET cancelled after its headers, through the Expo tunnel closes every websocket on that tunnel, the app's debugger socket too.

## Needs-human protocol

A needs-human `7` comes from one error class, one event, one registry and four layers.

The needs-human error is a tool error with exit `7` and a record: `scenario`, `need`, `command`, `url`, `unattendedEnv`, `resumable`, `detectedBy`.

- A failure that the protocol reclassifies keeps the error code its site already had. The exception is a `dev` plan step, which takes the registry row's code.
- A `dev --detach` parent relays a stop that its child process classified, with `detectedBy: "detached-child-log"`, so a reader knows it was relayed, not seen.

The CLI emits `cli:error` with `needsHuman: true`, then `cli:needs_human` with the whole record. Then it prints this block in place of the `Try:` line, since its second line is the command:

```
Needs a human   eas-login
Ask the user    npx @expo/agent-cli login
Or set          EXPO_TOKEN  (https://expo.dev/settings/access-tokens)
```

The registry is a data table of scenarios. Callers never match output strings themselves.

- A row can have a signature: a pattern that layer 3 matches against a child's output.
- The generic rows `expo-prompt` and `eas-prompt` sort last, so a specific row that matches always wins.
- A row with no signature is never matched against output. Only a caller that names the row raises it, and no v1 caller does.

Two words in the layers below:

- A **captured** child is a subprocess whose output this CLI reads through a pipe.
- A **rung** is one source of an answer in an ordered list. If it cannot answer, the next rung is asked.

Four layers, in priority order:

1. **Preflight.** Before a command that needs an account starts, ask who is signed in, with a short deadline. The answer is cached for the process.
   - The rungs, in order: `eas whoami`, then the project's own `expo whoami`, then `EXPO_TOKEN`.
   - A rung that cannot answer passes to the next: no binary, an `eas` that needs a download, a run past the deadline, or a binary that is not the CLI.
   - "Not the CLI" needs both: output with nothing that looks like that CLI's, _and_ a wrapper's exit (`101`, `126`, `127`, `134`, `139`, or a panic signature).
   - When no rung answers, `loggedIn` is `null`, never `false`. A CLI that ran and could not verify the account (a network failure, a stop, a timeout) also makes `EXPO_TOKEN` alone no answer, because the CLI most likely failed on that token.
   - On `false`, the command stops with `eas-login`, exit `7`, before it spends anything. A rejected `EXPO_TOKEN` stops with `expo-token-rejected` instead, which names no command (e2e `deploy-test.ts`). On `null`, it runs, and layer 3 recognises a real sign-in failure.
2. **Nobody can answer.** A captured child gets no stdin, and its stdout is a pipe, never a terminal.
   - An `eas` command that can prompt also gets `--non-interactive`, or `--json`, which implies it.
   - An `expo` command gets `CI=1` in its environment, because the Expo CLI rejects `--non-interactive`.
   - The exception is the captured run that starts a dev server (`expo start`, `expo run:*`), because `CI` also turns off Metro's file watcher. That child inherits the caller's environment unchanged, not even `CI=0`. The pipe still tells it that nobody can answer.
3. **Classify the output.** Match the captured output against the registry. The patterns that matter most: eas-cli's `Either log in with … EXPO_TOKEN`, `@expo/cli`'s `is in non-interactive mode`, and the `in non-interactive mode` fragment that eas-cli's prompts share.
4. **Generic prompt fallback.** Only for a captured child, and only when the caller opts in. If the child writes nothing for `AGENT_CLI_PROMPT_TIMEOUT_MS` (default 20 s), _and_ its last non-empty line looks like a prompt, the CLI kills the child. The line is quoted as untrusted text.

A busy port, and this project's own running dev server, are recognised before the classifier runs. Neither is needs-human: no account, permission or click is involved, so the caller or this CLI can recover ([[0004-smart-start-and-project-state]] §A busy port). Neither is a negative signature, so `expo-prompt` still catches every other prompt.

A failed `dev` plan step raises an error. The plan object prints only when every step worked.

- A stop that layer 3 recognises raises that row's needs-human error, with the row's own code (such as `EXPO_NEEDS_INPUT`).
- Any other failure is `PLAN_STEP_FAILED`, with the step's own exit code and `needsHuman: null`. This holds even at exit `7`, which Node also uses for an unhandled rejection.
- Under `--json`, the error also holds the tail of the step's output. Without `--json`, the run already showed it.

`dev` captures its steps under `--json` or without a TTY, and inherits the terminal otherwise. Forwarded passthrough commands inherit the terminal and are not classified.

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
- Argument parsing is covered. An unknown option or a stray positional is a tool error, caught where every command is invoked. A bad option gets `Try: <command> --help`, or names the command that has it, such as `--port` on `dev`. A unit test checks that each named command resolves.
- `--json` is read from the raw arguments, because the error path can run before the command parses its own. Only the arguments after the command name and before any `--` count: in `install -- --json`, the flag is npm's.
- An `Error` that is not a `CommandError` is a defect: `UNCAUGHT_EXCEPTION`, exit `1`, the same envelope as a crash.
- A command returns only an outcome (`0`, `20`, `22`). A tool error or a step for a person is a throw, so it always gets the envelope and the flush. The type checker refuses a returned `1`. `exitCodes-test.ts` keeps every other way out (`process.exitCode`, `process.exit`, a forwarded child code) in a named list of files.
- `dev --json` prints exactly one object at the end: the plan with step results, or the envelope. `dev --plan --json` prints the plan. The `cli:start_plan` event carries the plan before the first step.

The exit code is still the first thing to read. The envelope explains a failure; it does not signal one.

## Registry rules

Four rules decide how an argv resolves, and what a wrong argv gets.

### (a) Options without an action are an error, not help

In a group with no default action, a group name followed by options and no action is an error. The CLI prints the group listing first and the error last, because an agent acts on the last line: `UNKNOWN_ACTION` with `Try: npx @expo/agent-cli <group> --help`, exit `1`. An exit `0` would read as success.

The same group with nothing after its name prints its listing and exits `0`: asking a group what it does is not wrong. `<group> --help` and `-h` always print the listing.

A group with a default action gives that action every option, so `doctor --json` runs the check. Its `--help` prints the listing and then the action's own help.

### (b) A group cannot capture the bare form of a forwarded `expo` command

A command that shares a name with an `expo` command behaves like that command ([[0006-agent-native-cli-surface]]). No v1 group has such a name. A unit test checks the rule with a synthetic `config` group:

| Argv                   | Result                                |
| ---------------------- | ------------------------------------- |
| `config --type public` | forwards: `expo config --type public` |
| `config:doctor`        | the group's own action                |
| `config:nope`          | `UNKNOWN_ACTION`, never a forward     |
| `config doctor`        | forwards: `expo config doctor`        |

So a group under a forwarded name has one spelling for its actions, not two, and its `--help` must show the colon form.

### (c) A group named after another CLI's verb recovers into that CLI

A group may declare the other CLI's command for its bare name. Then the error of rule (a) names that command, and the `Try:` line is that command with the caller's own flags (`Try: npx eas build --platform ios`). No v1 group declares one; the mechanism is tested.

Rule (b) covers a name that `@expo/agent-cli` forwards to `expo`. Rule (c) covers a name it does not forward, such as an `eas` verb.

### (d) An argument a command has no place for is an error, not a shrug

A command that drops an argument and reports success is a silent no-op: the one answer a driving agent cannot recover from ([[0006-agent-native-cli-surface]]).

Every command that parses arguments declares `positionalArgs: 'none' | 'own'`, with no default, so the type checker asks each command.

- `'none'`: a positional is an error, `BAD_ARGS`, which names what was dropped. A command can add one sentence for what the caller probably meant.
- `'own'`: the command reads its positionals itself. The parser also puts unrecognized options in that list, so a blanket rejection would reject flags that the command reads or forwards.

## Three names for the recovery

`help workflow` says all three ([[0024-cli-ui]] §The on-ramp):

| Band                                         | Where the recovery is                                | Under `--json`           |
| -------------------------------------------- | ---------------------------------------------------- | ------------------------ |
| `1`, and any failure a command raises itself | `Try: <command>`                                     | `error.suggestedCommand` |
| `7`                                          | `Ask the user <…>`, under `Needs a human <scenario>` | `error.needsHuman`       |
| `20`, `22` outcomes                          | the report's `Suggested next:` list                  | the report's `followups` |

## Suggestions are pasted, so they have to be runnable

Every suggestion (a `Try:` line, an `Ask the user` line, a `Suggested next:` entry) and every error message is written as `npx @expo/agent-cli …`. As it is printed, only that prefix is rewritten, into the spelling of the runner the caller used. `--json` payloads and events keep the written form.

The caller's runner is Bun when the CLI runs on Bun, or when `npm_config_user_agent` or `npm_execpath` names Bun. `BUN_INSTALL` is not a signal: it says Bun is installed, not that Bun ran this.

The runner this CLI spawns other tools with is `bunx` when the caller's runner is Bun, or, for `eas-cli` only, when the project's lockfile is Bun's. Either way, `bunx` must be on `PATH`; otherwise it is `npx`. `eas simulator:exec npx <agent-device>` is exempt, because that `npx` runs in a datacenter.

## EAS JSON

No `eas --json` payload contains a `null`: eas-cli deletes every key whose value is null before it prints. So no parser here tries to tell "the service said null" from "the service said nothing".

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
| §The `--json` error envelope                         | `utils/__tests__/errors-test.ts`, `jsonMode-test.ts`, `unknownOption-test.ts`, `args-test.ts`; e2e `dev-test.ts`, `typecheck-test.ts`, `error-envelope-test.ts`, `doctor-test.ts`                                                                                                                                                 |
| §Registry rules                                      | `__tests__/commandRegistry-test.ts`, `utils/__tests__/args-test.ts`; e2e `help-test.ts`, `wrapper-test.ts`                                                                                                                                                                                                                        |
| §Three names for the recovery                        | e2e `help-test.ts`                                                                                                                                                                                                                                                                                                                |
| §Suggestions are pasted, so they have to be runnable | `utils/__tests__/invoker-test.ts`, `packageRunner-test.ts`, `easCli-test.ts`                                                                                                                                                                                                                                                      |
| §EAS JSON                                            | none: a rule for parsers, not a behavior a test can observe                                                                                                                                                                                                                                                                       |
