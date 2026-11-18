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

`20-29` is one band, so a caller that tests the range survives a new outcome class. `7` is apart because a retry cannot finish a step only a person can do. `22` is apart from `20` because looking again helps after `22` and wastes minutes after `20`. No assigned code is above `125`, which shells and `npx` use. A unit test fails when loadable source uses `21`. `dev --plan` runs nothing on purpose and exits `0`.

The one exception to the `125` ceiling is `dev`, which follows the shell for signals: a signal outside the dev-server step exits `128` plus the signal number (`DEV_INTERRUPTED`). A signal that ends the dev-server step is the stop the caller asked for: exit `0`.

A tool error exits with its own code, or `1` when it names none. An outcome is not an error: the command prints its report and exits with the outcome code. Both paths flush the event stream first.

### An empty target list is inconclusive

After a reload the debugger target list is empty for about half a second. A command that needs a target waits first ([[0005-runtime-loop-tools]] §One preflight for the runtime family). An empty list after the wait is `22`. No dev server, or no app in the run's scope, stays `1`: neither changes within a second, and the fix is a different call.

### Forwarded codes, and the exception

`install`, `start`, `dev` and the `expo` passthrough return the subprocess's exit code. An `expo` child ended by `SIGINT` or `SIGTERM` gives `0`, by any other signal `1`. The bare install's package manager gives `1` for any signal. A wrapper's own failures use the table. A forwarded `7` is the child's own: only a non-null `needsHuman` or the `Needs a human` block means a person must act. The exception is `doctor`, which adds a verdict ([[0016-v1-scope]] §Doctor's exit code).

A bare `install` in an Expo app whose `expo` does not resolve runs the package manager's plain install in the directory `@expo/package-manager` resolves (workspace root or project), never in an unrelated parent. It is not frozen: `npm ci` deletes a workspace root's `node_modules`.

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

`reason` is non-null exactly when `checked` is false, and a follow-up says so, so "nothing was checked" cannot read as "passed". A TypeScript project has a `tsconfig.json` or its own `.ts`, `.tsx`, `.mts` or `.cts` sources; `.d.ts` alone does not count, since `expo-env.d.ts` is in every app. Only a `node_modules/.bin/tsc` in the project or a folder above it counts; nothing is fetched. No compiler is `TYPECHECK_CLI_MISSING` with `Try: npx @expo/agent-cli install typescript --dev`, or `DEPENDENCIES_NOT_INSTALLED` with the bare `install` when the app's dependencies are missing. Both output forms are parsed, since a project's `pretty` overrides `--pretty false`.

### Other gates, in brief

A report does not gate on what it reports. Every `--assert` or `--fail-on-*` flag answers a measured failure with `20` and an unmeasurable state with `22`.

| Command                    | Codes                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `runtime:errors`           | `0`; with `--fail-on-error`, `20` on a non-empty window, `22` when the runtime cannot answer ([[0005-runtime-loop-tools]])        |
| `runtime:reload`           | `0` observed, `20` did not happen, `22` ran and saw nothing, `1` not attempted ([[0005-runtime-loop-tools]] §Reloading the app)   |
| `status --assert <class>`  | `20` when the real class is stronger, `22` when nothing classifies; `0` without the flag                                          |
| `runtime:stop`, `dev:stop` | `0` when already stopped; other `20`s in [[0005-runtime-loop-tools]] §Stopping the app                                            |
| `runtime:stop`             | `1` when the device tool refused                                                                                                  |
| `dev:stop`                 | `20` when the dev server or EAS session did not stop or a device tool failed; `22` with `--eas` while the EAS session is starting |

The entry-bundle check runs in `smoke`, `runtime:reload`, `runtime:tree`, `runtime:tap` and `runtime:type`. A broken bundle is `20`. A cold build that outlasts `--timeout` is `22`. `bundle.checked` is exactly `bundle.ok != null`: unknown is not broken. The HEAD goes to the given dev server ([[0005-runtime-loop-tools]] §Where a device reaches the dev server) with the path and query the manifest or web page names, never their host, and `bundle.url` is that URL: a HEAD or a cancelled GET through the Expo tunnel closes every websocket on it, the debugger's too.

## Needs-human protocol

A needs-human `7` comes from one error class, one event, one registry and four layers.

The error is a tool error with exit `7` and a record: `scenario`, `need`, `command`, `url`, `unattendedEnv`, `resumable`, `detectedBy`. A reclassified failure keeps its site's error code, except a `dev` plan step, which takes the row's code. A `dev --detach` parent relays a stop its child classified, with `detectedBy: "detached-child-log"`. The CLI emits `cli:error` with `needsHuman: true`, then `cli:needs_human` with the record, then prints this block in place of the `Try:` line:

```
Needs a human   eas-login
Ask the user    npx @expo/agent-cli login
Or set          EXPO_TOKEN  (https://expo.dev/settings/access-tokens)
```

The registry is a data table. The generic rows `expo-prompt` and `eas-prompt` sort last. A row with no signature is never matched against output; only a caller that names it raises it, and no v1 caller does. Callers never match strings.

Four layers, in priority order:

1. Preflight. Before a command that needs an account, ask who is signed in, with a short deadline, cached per process: `eas whoami`, then the project's `expo whoami`, then `EXPO_TOKEN`. A rung that cannot answer (no binary, an `eas` that needs a download, past the deadline, or not the CLI) passes to the next. "Not the CLI" means output with nothing of that CLI's _and_ a wrapper's exit: `101`, `126`, `127`, `134`, `139`, or a panic signature. No answer is `loggedIn: null`, never `false`. `false` stops with `eas-login`, exit `7`, before anything is spent. `null` runs, and layer 3 catches a real failure.
2. Nobody can answer. A captured child gets no stdin and a pipe for stdout. `eas` gets `--non-interactive` where it can prompt (or `--json`, which implies it). `expo` gets `CI=1`, because it rejects `--non-interactive`. The captured run that serves (`expo start`, `expo run:*`) is the exception: `CI` also stops Metro's watcher, so that child inherits the caller's environment unchanged, not `CI=0`. The pipe still tells it nobody can answer.
3. Stderr classify. Match captured output against the registry: eas-cli's `Either log in with … EXPO_TOKEN`, `@expo/cli`'s `is in non-interactive mode`, and eas-cli's `in non-interactive mode` fragment.
4. Generic prompt fallback. Opt-in, captured children only. Silence for `AGENT_CLI_PROMPT_TIMEOUT_MS` (default 20 s) _and_ a prompt-shaped last non-empty line kill the child; the line is quoted as untrusted text.

A busy port and this project's own running dev server are recognised before the classifier and are not needs-human ([[0004-smart-start-and-project-state]] §A busy port). Neither is a negative signature, so `expo-prompt` still catches every other prompt.

A failed `dev` plan step raises; the plan prints only when every step worked. A stop that layer 3 recognises raises that row's error and code (such as `EXPO_NEEDS_INPUT`). Any other failure is `PLAN_STEP_FAILED` with the step's exit code and `needsHuman: null`, even at exit `7`, since Node exits `7` on an unhandled rejection. Under `--json` the error holds the step's output tail. `dev` captures its steps under `--json` or without a TTY and inherits the terminal otherwise. Forwarded passthrough commands inherit and are not classified.

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
- Argument parsing is covered: an unknown option or stray positional is a tool error, caught where every command is invoked. It gets `Try: <command> --help`, or names the command that has the option (`--port` on `dev`); a unit test checks each named command resolves.
- `--json` is read from the raw arguments after the command name and before any `--`: `install -- --json` is npm's flag.
- `dev --json` prints exactly one object at the end: the plan with step results, or the envelope. `dev --plan --json` prints the plan. The `cli:start_plan` event carries the plan before the first step.

The exit code still signals the failure. The envelope explains it.

## Registry rules

Four rules decide how an argv resolves, and what a wrong argv gets.

### (a) Options without an action are an error, not help

A group name with options and no action, in a group with no default action, prints the listing, then `UNKNOWN_ACTION` with `Try: npx @expo/agent-cli <group> --help`, and exits `1`; an exit `0` would read as success. A bare group with no default action prints its listing and exits `0`. `--help` and `-h` always print the listing. A group with a default action passes it every option (`doctor --json` checks); its `--help` prints the listing, then the action's help.

### (b) A group cannot capture the bare form of a forwarded `expo` command

A command named like an `expo` command behaves like it ([[0006-agent-native-cli-surface]]). The bare form forwards: under a `config` group, `config --type public` is `expo config --type public`. The colon forms belong to the group, and an unknown action is `UNKNOWN_ACTION`, never a forward. The space form forwards: `config doctor` is two arguments to `expo config`. The group's `--help` must show the colon form. No v1 group has a forwarded name; a unit test uses a synthetic `config` group.

### (c) A group named after another CLI's verb recovers into that CLI

A group may declare the other CLI's command for its bare name. Rule (a)'s error then names it, and `Try:` is that command with the caller's flags (`Try: npx eas build --platform ios`). Rule (b) covers names `@expo/agent-cli` forwards; rule (c) covers names it does not. No v1 group declares one; the mechanism is tested.

### (d) An argument a command has no place for is an error, not a shrug

A dropped argument with a success report is a silent no-op ([[0006-agent-native-cli-surface]]). Every command that parses arguments declares `positionalArgs: 'none' | 'own'`, with no default. `'none'` reports `BAD_ARGS` naming what was dropped, plus an optional hint. `'own'` reads its positionals itself; unrecognized options land there too, so a blanket rejection would break it.

## Three names for the recovery

`help workflow` says all three ([[0024-cli-ui]] §The on-ramp):

| Band                                         | Where the recovery is                                | Under `--json`           |
| -------------------------------------------- | ---------------------------------------------------- | ------------------------ |
| `1`, and any failure a command raises itself | `Try: <command>`                                     | `error.suggestedCommand` |
| `7`                                          | `Ask the user <…>`, under `Needs a human <scenario>` | `error.needsHuman`       |
| `20`, `22` outcomes                          | the report's `Suggested next:` list                  | the report's `followups` |

## Suggestions are pasted, so they have to be runnable

Every suggestion and error message is written `npx @expo/agent-cli …` and rewritten on output into the caller's runner; only that prefix is rewritten. The runner is Bun when the CLI runs on Bun, or `npm_config_user_agent` or `npm_execpath` names Bun; `BUN_INSTALL` does not count. `--json` payloads and events keep the written form.

The runner this CLI spawns is `bunx` when the caller's runner is Bun, or for `eas-cli` when the lockfile is Bun's, and only when `bunx` is on `PATH`; else `npx`. `eas simulator:exec npx <agent-device>` is exempt: it runs in a datacenter.

## EAS JSON

eas-cli deletes null keys before it prints, so no parser tells "said null" from "said nothing".

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
