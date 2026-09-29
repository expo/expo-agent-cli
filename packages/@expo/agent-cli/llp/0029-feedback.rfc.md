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

[observed] The receiving service's `CliFeedbackSchemas.ts` validates `metadata.cli.name` as the
literal `submit-expo-feedback`. Keep that value and the original User-Agent name for compatibility;
the version comes from the installed agent CLI. Displayed help and continuation commands use
`PROGRAM_PREFIX` and the new `feedback` command.

Project metadata uses the same public `@expo/config` and `@expo/package-manager` APIs as the
original, including skipping config plugins, installed-package version lookup, and graceful
fallback when project configuration fails. No `@expo/cli` internals are imported.

## Command behavior

The command retains `--message`/`-m`, `--category`/`-c`, `--subject`/`-s`, and `--resume`. Positional
feedback remains accepted with the original deprecation warning. Messages are trimmed and must
contain 40–5,000 characters. A terminal can prompt for missing input; non-interactive runs fail.
The command also follows the agent CLI help and error conventions and offers `--json` with exactly
`sent` and `feedbackId` on success or opt-out. Failures use the shared error envelope and exit 1.

`DO_NOT_TRACK=1` or `EXPO_NO_TELEMETRY=1` exits successfully before collecting metadata or sending
feedback. Opt-out prints the existing instruction to respect the user's choice, and JSON mode
returns `{ "sent": false, "feedbackId": null }`. The launcher suppresses command telemetry for a
feedback invocation with `DO_NOT_TRACK=1`, so its earlier telemetry hook cannot bypass this contract.

## Validation

Unit tests pin metadata, validation, prompting, session IDs, authentication priority, request
shape, endpoint selection, opt-out, timeout, and server errors. Subprocess tests run the published
bundle against a local HTTP capture server, covering submission, continuation, JSON output,
validation, and opt-out. No production feedback is needed for these checks.
