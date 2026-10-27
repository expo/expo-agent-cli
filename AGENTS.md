# Working in expo-agent-cli

This Bun monorepo provides Expo's agent-facing CLI. The shipped CLI is model-free;
model-backed evaluations live in the test tooling.

## Find the right context

- `packages/@expo/agent-cli/` owns the CLI. Read its [AGENTS.md](packages/@expo/agent-cli/AGENTS.md)
  before changing it; it defines the CLI contracts, test conventions, and LLP design workflow.
- `packages/expo-agent-cli/` is the npm alias launcher. Edit `src/`, then run `bun run bundle`
  from the root to regenerate its committed `bin/cli.js`.
- `scripts/` and `.github/workflows/` own release and CI automation.
- Read the relevant implementation, callers, and tests before deciding on a change. For CLI
  subsystem work, follow the package guide to the governing LLP rather than reading the whole corpus.

## Make a focused change

- Keep one feature or issue per PR. Avoid unrelated refactors, formatting, new abstractions,
  and dependencies that the change does not need.
- Fix the cause and preserve existing contracts unless the requested behavior requires changing
  them. Keep help, documentation, and tests consistent with public behavior changes.
- Check assumptions about external tools against their installed help or source. Distinguish
  observed behavior from inference; don't invent APIs, test results, or reasons for a decision.
- Review the final diff, including generated changes. Preserve unrelated work already in the checkout.

## Commands and verification

Use Bun for dependency management and scripts. Run these from the repository root:

| Task                              | Command                                      |
| --------------------------------- | -------------------------------------------- |
| Install locked dependencies       | `bun install --frozen-lockfile`              |
| Format changed files              | `bun run format <paths>`                     |
| Check repository formatting       | `bun run format:check`                       |
| Script, alias, and CLI unit tests | `bun run test`                               |
| Build the CLI                     | `bun run --filter @expo/agent-cli build`     |
| CLI type checks                   | `bun run --filter @expo/agent-cli typecheck` |
| CLI lint                          | `bun run --filter @expo/agent-cli lint`      |
| CLI process-level tests           | `bun run --filter @expo/agent-cli test:e2e`  |

- Use `bun run test`, not bare `bun test`, for the combined suite: the CLI package uses Vitest.
  For a focused CLI test, run `bun run test -- <test-file>` from `packages/@expo/agent-cli/`.
- Build the CLI before running `test:e2e`; these tests execute the built CLI.
- Choose checks for the changed behavior. For a bug, reproduce it and add or update a regression
  test that fails without the fix when practical. Prefer observable outcomes over implementation
  details; follow the package's testing rules for CLI changes.
- Formatting and content/link review are sufficient for prose-only changes. Don't add tests that
  merely assert documentation text or run runtime suites for an unrelated prose edit.
- Live tests and model evals are separate from unit and process-level tests. Read the
  [live-test guide](packages/@expo/agent-cli/e2e-live/README.md) and
  [eval guide](packages/@expo/agent-cli/evals/README.md) before choosing them; they can need devices,
  services, credentials, or paid resources. Report missing prerequisites as gaps, not passes.
- Report exact checks and outcomes. Label checks not run and any unresolved failures; don't call
  a failure pre-existing without evidence from the base revision or an existing report.

## Pull requests

- Use [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md), including when creating
  a PR through a CLI or agent. Keep the applicable feature or bug section; use Summary for maintenance.
- Explain the approach, alternatives actually considered, and tradeoffs. Don't fabricate rejected
  options just to fill a section. Keep the description current when the scope changes.
- Include concise verification evidence and meaningful gaps. Diagrams and interactive artifacts
  can explain a change; distinguish those illustrations from evidence of executed behavior.

## Maintaining this guide

Keep this file short and repository-wide. Put subsystem rules in the nearest `AGENTS.md` and
design rationale in the existing LLP documents. Add durable, actionable guidance when a recurring
mistake warrants it; leave task history, temporary environment state, and duplicated tool instructions out.
