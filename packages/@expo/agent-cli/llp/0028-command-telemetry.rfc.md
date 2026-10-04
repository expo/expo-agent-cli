# 0028: Command telemetry

**Type:** RFC
**Status:** Draft
**Systems:** `src/telemetry/`; `src/cli.ts`; package build scripts
**Date:** 2026-09-29
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0006-agent-native-cli-surface]], [[0010-agent-conventions]]

## Destination and schema

[confirmed, user, 2026-09-29] Use the Expo CLI/EAS CLI observability pipeline with a distinct CLI
name and minimal command latency. Both repositories send RudderStack-compatible events to
`https://cdp.expo.dev/v1/batch`. The agent CLI uses the same production and staging/local
ingestion sources as Expo CLI's `expo unified` source. BigQuery routing belongs to that
service; this package does not connect to BigQuery directly. [observed in sibling repositories]

The agent CLI sends one `track` event named `action` for each registered command invocation:
`properties.action = "expo-agent-cli <canonical command>"`, `context.app.name = "expo/agent-cli"`,
and HTTP user agent `expo-agent-cli/<version>`. Aliases and space-form groups resolve before
recording. Help, version, bare group listings, and unrecognized command names are excluded.
Invocation measures usage, not completion or success.

Internal CLI relaunches do not count as another invocation. The detached dev-server child carries
`__EXPO_AGENT_CLI_INTERNAL_INVOCATION=1`; the launcher consumes it before running the command.
This also covers the dev server started by `smoke --start`, while preserving upstream Expo's own
telemetry settings.

Context follows Expo's fields: app/system versions, architecture, CI, a new invocation session ID,
`context.agent = { id, sessionId }`, and `context.sandbox_provider`. Undetected agent/sandbox fields
are omitted. The pinned detector versions use only environment checks by default, so the worker
inherits the invoking environment and performs detection there. The existing agent helper caches
detection and tolerates failure. [observed in agent-cli-detector 0.1.7 and sandbox-cli-detector 0.2.0]

## Process boundary and latency

The launcher hands only the canonical command, version, and timestamp to a separately bundled Node
worker as one JSON argument. It uses ignored stdio, `detached: true`, and `unref()`. No telemetry
network request, detector call, settings read, or flush happens in the command process. The small
spawn cost is paid once. Passing a small record directly avoids a temporary queue file.

Unlike Expo's short-command exit queue, the handoff occurs at invocation. This covers long-running
commands and explicit exits without signal hooks or changes to existing shutdown behavior. The
worker owns identity lookup and the HTTP request. Like Expo CLI's `FetchClient`, it makes up to
three attempts, retrying immediately only when fetch rejects. All attempts reuse the serialized
payload, including its message ID, and share one three-second deadline. HTTP error responses are
not retried, matching Expo CLI. Once the deadline expires, no further attempt starts.
Failures are silent and cannot change the command's output or exit status. Delivery is best effort;
a machine shutdown or unavailable service may lose the event.

Both development and production builds emit `build/cli/index.js` and `build/telemetry/index.js`.
Both are included by the existing published `build` directory. The worker never imports the CLI
entry point, so it cannot recursively emit command events.

Expo CLI emits its worker through its TypeScript build. This package bundles the worker with a
second ncc invocation. ncc's automatic asset builds use a transpilation mode that removes
`rootDir`, which fails with TypeScript 6 error TS5011. Keep the explicit worker build until that
compatibility issue is resolved. [observed, 2026-09-30]

## Identity and opt-out

Reuse a UUID and hashed cached user ID from Expo's `state.json` when available. Honor Expo's
staging/local home and shell-only `__UNSAFE_EXPO_HOME_DIRECTORY` override through
`src/utils/expoHome.ts`, shared with auth session notices. Do not query authentication
services for telemetry. When `EXPO_TOKEN` is set, do not attribute a cached interactive user's ID.
Invalid `EXPO_STAGING` or `EXPO_LOCAL` values produce a `BAD_ENV` command error when a command
needs them, naming the variable and the accepted values: `0`, `1`, `false`, or `true`.
The worker never modifies the shared authentication file. Without an existing Expo UUID it persists
an agent CLI anonymous UUID separately, with atomic exclusive publication and owner-only
permissions. A read-only home or filesystem without hard-link support falls back to a per-run
anonymous ID.

A readable but corrupt agent CLI identity file is repaired under an exclusive directory lock.
Workers reread the file after taking the lock and preserve any valid ID another worker published.
Contenders wait at most 250 ms for the repair. Unreadable files are left alone, and a lock left
by an interrupted repair is never stolen; these cases keep the per-run fallback.

`EXPO_NO_TELEMETRY`, `DO_NOT_TRACK`, and `EXPO_OFFLINE` disable telemetry before the spawn and are
rechecked by the worker. The shared privacy check in `src/utils/env.ts` treats an unset opt-out
variable or an explicit `0` or `false` as allowing telemetry, case-insensitively. Any other present
value, including an empty string, disables it without throwing. This policy applies to
`EXPO_NO_TELEMETRY` and `DO_NOT_TRACK`; `EXPO_OFFLINE` keeps its boolean parsing.

The payload is an explicit command schema, not a subscriber to `2g` events: local events can
contain raw arguments, paths, typed values, and command output. None belongs in remote telemetry.

## Validation

Unit tests exercise opt-outs, spawn failures, ingestion shape, detector failures, identities,
retries, and a shared deadline. Subprocess tests use the built CLI and worker with a fetch
interception shim, checking command naming, unchanged output/exit behavior, no raw arguments, and
parent exit while delivery is still pending. Tests disable production telemetry by default. No live ingestion is necessary to
validate the client contract; downstream warehouse delivery requires service-side verification.
[confirmed, user, 2026-09-30] Three command events from the PR build reached BigQuery.

Local production-bundle measurement on 2026-09-29: 16 alternating enabled/disabled pairs after three
warmups, using `runtime:eval --json` with intercepted, pending telemetry requests. Median parent
duration was 84.97 ms enabled and 84.48 ms disabled; median paired overhead was 1.51 ms. Every parent
exited before delivery settled, with identical output and exit status. These are indicative local
measurements under concurrent test activity, not a cross-platform latency guarantee. The package
dry run included the independently bundled worker. No event was sent to production for validation.
