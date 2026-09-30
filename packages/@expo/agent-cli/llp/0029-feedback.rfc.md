# 0029: Feedback submission

**Type:** RFC
**Status:** Draft
**Systems:** `src/feedback/`; command registry
**Date:** 2026-09-29
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0006-agent-native-cli-surface]], [[0024-cli-ui]]

## Compatibility

[confirmed, user, 2026-09-29] `npx --yes @expo/agent-cli feedback` replaces the invocation of
`submit-expo-feedback` while preserving its logic, request format, and endpoint. The implementation
ports that package's message validation, category/subject normalization, feedback session IDs,
interactive prompts, authentication, and metadata collection. It runs inside this CLI and requires
no separate download of `submit-expo-feedback`.

[observed] The request is `POST /v2/feedback/cli-send` at `https://api.expo.dev`, with JSON
`{ feedback, metadata }`, a 15-second timeout, and no retry. Staging/local selection and the
local-only `EXPO_FEEDBACK_API_BASE_URL` override retain the original precedence. `EXPO_TOKEN`
takes precedence over a cached `expo-session` secret; neither credential enters the body.
Environment flags use Expo's boolean parsing, so `0` and `false` disable staging/local mode.
Session lookup honors `__UNSAFE_EXPO_HOME_DIRECTORY` before selecting the staging, local, or
production Expo home.

[confirmed, user, 2026-09-30] `metadata.cli.name` is `agent-cli`, and the User-Agent is
`agent-cli/<version>`. The version comes from the installed agent CLI. The receiving service's
`CliFeedbackSchemas.ts` must accept the new name alongside `submit-expo-feedback`, which remains
valid for the standalone package. Both the new CLI name and the `agent-cli` category require
[Universe #31713](https://github.com/expo/universe/pull/31713) to be deployed before this client
ships. Displayed help and continuation commands use `PROGRAM_PREFIX` and the `feedback` command.

Project metadata uses the same public `@expo/config` and `@expo/package-manager` APIs as the
original, including skipping config plugins, installed-package version lookup, and graceful
fallback when project configuration fails. No `@expo/cli` internals are imported.

## Command behavior

The command retains `--message`/`-m`, `--category`/`-c`, `--subject`/`-s`, and `--resume`. Positional
feedback remains accepted with the original deprecation warning. Unknown options are rejected
instead of becoming part of the positional message. Messages are trimmed and must
contain 40–5,000 characters. A terminal can prompt for missing input; non-interactive runs fail.
The command also follows the agent CLI help and error conventions and offers `--json` with exactly
`sent` and `feedbackId` on success or opt-out. Failures use the shared error envelope and exit 1.

The `agent-cli` category identifies feedback about this CLI, with the full command as its subject.
Help retains the original category-specific subject guidance.

`DO_NOT_TRACK` or `EXPO_NO_TELEMETRY` set to `1` or `true` exits successfully before collecting
metadata or sending feedback. `0` and `false` leave feedback enabled. Opt-out prints the existing
instruction to respect the user's choice, and JSON mode returns `{ "sent": false, "feedbackId": null }`.
The launcher defers feedback's command event to the feedback handler, which checks opt-out after
project config loads. A config-driven opt-out therefore prevents both network requests. The send
boundary also rechecks opt-out and reports whether feedback was sent, so an opt-out returns
`sent: false` and does not print a success message. Network failures and
timeouts use `FEEDBACK_ERROR`, including the shared JSON error envelope, without retrying.

## Validation

Unit tests pin metadata, validation, prompting, session IDs, authentication priority, request
shape, endpoint selection, opt-out, timeout, and server errors. Subprocess tests run the published
bundle against a local HTTP capture server, covering submission, continuation, JSON output,
validation, opt-out loaded by project config, connection failures, and timeouts. No production
feedback is needed for these checks.
