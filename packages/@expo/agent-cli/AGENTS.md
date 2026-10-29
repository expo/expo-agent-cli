# Agent instructions — @expo/agent-cli

<!-- BEGIN LLP MANAGED BLOCK (llp-adopt) -->

## LLP

This package's design lives in Linked Literate Programming (LLP) documents in `llp/`.

- Start with `llp/0000-expo-monorepo.explainer.md` (orientation) and `llp/0001-agentic-cli-on-expo-cli.rfc.md` (the umbrella RFC and index).
- Before changing a subsystem, read the LLPs whose `**Systems:**` header covers it, and follow `@ref llp/...` comments from the code.
- Capture significant design decisions as new LLPs (`llp/NNNN-slug.type.md`, start as `Draft`).

<!-- END LLP MANAGED BLOCK (llp-adopt) -->

## Writing an LLP

An LLP holds what the code cannot say: the problem, the decision, the rejected options, and the contracts. The code holds how. Many existing LLPs are older than these rules; apply the rules to a new LLP, and to the part of an old one that you change.

- Start with one page that a person reads in a few minutes: the problem, the decision, and one table or picture.
- Write each contract as a rule that a user or another module can see, and name the test that enforces it. A rule with no test is a wish.
- Leave out function names, test lists and build plans. Put them in the code (a short comment with an `@ref`), in the tests, or in the PR description. One index table of where the detail lives is fine.
- To place a sentence, ask: would a refactor that keeps the behavior make it false? Then it belongs in the code.
- An LLP is design, not history. Write no "was wrong until" sentences; history goes in commits.

## Code and tests

These rules apply to new code and new tests. Do not rewrite old code or old tests only to follow them.

- **One result on stdout.** A command writes its result to stdout and everything else to stderr (`Log.progress`, `Log.warn`). Under `--json`, stdout holds exactly one JSON object (`llp/0006` §Output contract).
- **Verify before you build on it.** Do not build on an assumption. Before you rely on how code, a tool or an environment behaves, observe it: read the source, run the command, or reproduce the state. For `eas`, `expo`, `simctl` or `adb`, run the installed binary, or read the flag's declaration and its default. Check a fake of an external tool (a stub or a mock) against the real one.
- **Prefer fewer, wider tests.** Test behavior that crosses modules or a process boundary with an e2e test (`e2e/`) or an integration test with real inputs, not with many mocked unit tests. Keep unit tests for pure decisions, such as a table, a parser or a choice. Do not add a unit test that only repeats what an e2e test already proves.
- **Remove overlap before you finish.** At the end of the work, read every test that you added. Merge cases that check the same rule into one `it.each` table, and delete a test that another test already covers. One rule, one test.
- **A test must be able to fail.** For each assertion, name a code change that makes it fail. Delete an assertion that no change can break, such as "X is not called" when the module no longer imports X, or "stderr is empty" on a path that prints nothing.
- **Mock at the boundary.** Prefer to mock a subprocess or the network, not a module of this package. Test a decision as a pure function with real inputs. Do not assert the call order of internal functions.
- **Build expected values with the product's helpers.** A test of a platform-specific value (an argv, a path, an escape) builds the expected value with the helper that the code uses.
- **Build fixtures from one builder.** Give each fixture type one builder that takes overrides, and pass only the fields that differ, for example `makeLock({ pid: 4242 })`. Then a new field is a one-file change.
- **Test both platforms.** When a change touches behavior that runs on iOS and Android, test it on both. A pass on one platform proves nothing about the other.
- **Check the EAS path on EAS.** A change to the EAS path is proven only by a real EAS Simulator session; the stub `eas` of the e2e tier cannot prove it. A session bills credits from the moment it starts (`llp/0015` §Who may spend EAS credits), so start one only when the local or stub suites cannot answer the question, on the `expo-ci` login, through the opt-ins: `AGENT_CLI_LIVE_EAS=1 AGENT_CLI_LIVE_CLOUD=1 bun run test:live:cloud` from this package after `bun run build`, or a `dev --<platform> --eas` the person chose. CI bills four cloud sessions on every PR push (`.eas/workflows/agent-cli-cloud-e2e.yml`); read that run before you start another. Stop the session before you finish: `dev:stop --eas`, or the suite's `afterAll`. A start that failed still needs `eas simulator:stop --id`.
- **Keep files small.** In new work, do not grow a file past about 1000 lines. A file that is already larger can stay as it is for now; do not split it as part of an unrelated change.

## Pull requests

- Fill in [the PR template](../../../.github/PULL_REQUEST_TEMPLATE.md), also when a CLI or an agent opens the PR; those paths do not apply it.
- This repo uses GitHub stacks. Install the `gh stack` extension (`gh extension install github/gh-stack`; needs GitHub CLI 2.0+ and Git 2.36+) and its agent skill (`gh skill install github/gh-stack`, from [github/gh-stack](https://github.com/github/gh-stack#ai-agent-integration)). Use the skill and `gh stack` to create, submit, sync and rebase a stack. Do not build a stack from hand-pushed branches.
- Keep each PR focused on one question: one feature or one issue.
- When a PR adds or changes tests, read the tests that already exist for that behavior, and delete in that PR every test that no longer adds confidence beyond the new ones. This holds especially in a stack: write a test in its final form in the PR that adds it, and when a later PR makes a test redundant, delete it in that later PR.

## Formatting

`oxfmt` owns the formatting of this repo, from `.oxfmtrc.json` at the root. Run `bun run format` before you commit; CI fails on `bun run format:check`. It covers the whole repo — code, JSON and Markdown — so run it from the root, not from a package.

Key constraints (from `llp/0001`): invoke the Expo CLI family (`expo`, `eas-cli`, `expo-doctor`, `fingerprint`, `create-expo`) as subprocesses. Never import `@expo/cli` internals. Ship no model and no API keys (Shape 1). Testing first, per `llp/0002`. The kernel is `llp/foundation/`. Work in play is `llp/current/`.
