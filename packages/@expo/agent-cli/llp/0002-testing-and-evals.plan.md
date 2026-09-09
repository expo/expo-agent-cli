# 0002: Testing and evals for the agentic tool layer

**Type:** Plan
**Status:** Active
**Systems:** eval harness; fixtures; CI (GitHub Actions); `e2e-live/`
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-20
**Revised:** 2026-08-30
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0022-live-tier]]

## Summary

Testing infrastructure is built first, before feature work. [confirmed, Kudo, 2026-08-20] Shipping any tool from [[0001-agentic-cli-on-expo-cli]] is gated on the layers below. Model-driven tiers prefer a free local model that runs on GitHub Actions. [confirmed, Kudo, 2026-08-18]

**A backend is a second process boundary.** A command that "supports EAS" (or Expo Go, or a development build) spawns a different binary, reads a different failure vocabulary, and needs a different recovery sentence. A row is filled only by a test that ran the command against that backend's binary: a stub for e2e, the real thing for live. A test that pins the plan an EAS run would produce exercises none of that.

## Layers

1. **Unit tests (vitest).** `bun run test` in this package. Everything deterministic is unit-tested: the project-state probe, decision tables, the impact classifier, tool input/output schemas, skill discovery.
2. **E2E CLI tests.** (`test:e2e`, `e2e/vitest.config.ts`). Run bins against fixture projects, with no model involved. Per the process-boundary constraint in [[0001-agentic-cli-on-expo-cli]], e2e tests spawn the real `expo` CLI as a subprocess and assert on its JSONL events. The events contract is the API under test. Stubs stand in for sibling CLIs. The stub `eas` is one script, `e2e/stubs/eas.js` (installed by `e2e/stubEas.ts`), answering every verb this CLI is known to run — `whoami`, `build`, `build:list`, `build:configure`, `simulator:*` — in the shapes the real CLI was observed to print, and recording every argv; it used to be three per-file scripts, and a command that reached a verb another file's stub knew got "unhandled command" and a red test about nothing [2026-09-08]. A lint (`src/lint/__tests__/easFlagCoverage-test.ts`) reads the option schemas and fails when a command that takes `--eas` has no e2e running it with `--eas`. A stub answers whatever it was written to answer.
3. **Live CLI tests** (`test:live`, `e2e-live/vitest.config.ts`). The same published surface, against the real thing: a real Metro, a real booted simulator running Expo Go or a development build, a real Hermes debugger connection, and the real EAS service on the expo-ci account. Nothing runs these automatically. Not `test`, not `test:e2e`, not CI. Each suite spends a simulator, an account, or a deployment. See [[0022-live-tier]].
4. **Evals.** A scenario is a fixture project, a task prompt, a driving agent, and a programmatic grader.

## Eval tiers

- **Tier 0, deterministic (every PR, free).** Unit tests plus subprocess e2e with JSONL-event assertions (layers 1 and 2).
- **Tier 1, short agent integration tests (every relevant PR, advisory).** `evals/tier1/*.eval.ts` uses Vitest 4 and `vitest-evals` directly. Ollama with pinned `qwen3:8b` weights selects native CLI tool calls from public help and real results. Independent JSON/file assertions grade the outcome. Fresh projects and user profiles prevent local installations from changing fixture context. Six turns, twelve calls, a three-minute case deadline; no automatic retries or pass@k. All cases run on PRs, dispatch and the weekly diagnostic schedule. Artifacts retain model/CLI evidence even when the job fails.
- **Tier 2, frontier model (scheduled and pre-release).** Claude Code headless (`claude -p`, Bash allowed, max 12 turns) drives the full scenario set via `runTier2Scenario` in `evals/run.mjs`. It runs from a label-triggered EAS workflow (`packages/@expo/agent-cli/.eas/workflows/agent-cli-tier2-evals.yml`, label `agent-cli-eval` or dispatch). The workflows live under the package because that is the EAS base directory — `app.json` links it to the `expo-ci/expo-agent-cli` CI project and `eas.json` sits beside it. Advisory only: the job never fails, and a `github-comment` job posts pass/fail plus a log excerpt to the PR. Prerequisite: `ANTHROPIC_API_KEY` in the EAS `production` environment.
- **The `--eas` e2e, and a real EAS build with it.** `agent-cli-cloud-e2e` (`packages/@expo/agent-cli/.eas/workflows/`) runs the live-cloud suite on EAS as four parallel jobs — `{iOS, Android} × {Expo Go, dev build}` — against real EAS Simulator sessions, over a cloudflared tunnel (the cloud sim is in a datacenter and needs a public origin; GitHub CI has no way to give it one). The **dev-build** jobs first build a real development client of `apps/eas-example` on EAS (an `ios.simulator: true` build needs no code signing), then run the `--eas` suite against that client on a cloud simulator. So one workflow both creates a real native EAS build — the one path GitHub CI and the local live tier cannot take, [[0022-live-tier]] marks native build creation `unreachable in v1` — and tests agent-cli's whole cloud path against it. `@expo/agent-cli` has no EAS build command by design, so the build itself is eas-cli; the app is committed, linked, and build-ready. Runs under `EXPO_TOKEN` from the project's production environment. (This subsumed an earlier `agent-cli-eas-build` workflow that only built.)

## Agent integration migration (2026-09-09)

[confirmed, user, 2026-09-09] Tier 1 means a short prompt exercising calls from an agent;
Tier 2 means a longer end-to-end task. Keep Ollama for Tier 1 and Claude on EAS for Tier 2.
Use `vitest-evals` directly for the Vitest suite/harness API instead of maintaining a bespoke
Vitest wrapper. The CLI package uses Vitest 4, the library's supported peer version.

The migrated suite is `evals/tier1/*.eval.ts`, invoked by `test:evals`. It covers discovery, skill linking, agent setup, development planning, and a real Expo compatibility report.
`test:eval-harness` verifies the adapter without a model. The model selects argv from the public
CLI help; graders never provide the answer to the agent. A finished loop is distinct from a
passed assertion. A missing model, timeout, or exhausted turn budget errors the test. Each run
keeps complete command/model records and actual model identity for triage; no automatic retries.

Run Tier 1 on every relevant PR when measured CPU time permits. Establish real GitHub Actions
evidence before expanding coverage, then enhance Tier 2. This supersedes weekly-only expansion
as a default; cadence follows measured runtime. The legacy JSON runner remains for Tier 0 and the old Tier 2 during migration.
GitHub Actions now invokes `test:evals` for the entire migrated Tier 1 suite on each relevant PR.
The initial pair is skill linking and a read-only compatibility report over real, locked Expo
dependencies; measured CI evidence belongs with the introducing PR.

## Graders

Programmatic and model-free: the dev server responds; the app boots; `expo-doctor` passes; the expected files changed; the JSONL event stream contains the expected events. Graders never read transcripts to decide pass/fail.

Example scenarios: "Make this broken project start", "add expo-camera and get it running", "is this project Expo Go compatible?", "upgrade this SDK 52 fixture", "deploy this app's web build".

Opt-in reports of an agent getting stuck on an Expo task become eval-scenario candidates. The `submit-expo-feedback` channel already exists in the `expo/skills` repo.

## Decisions that still bind

- Harness home: `expo/expo-agent-cli`, under `packages/@expo/agent-cli/evals/`.
- CI split: `tier0-linux` on every PR (subprocess, JSONL and schema tests, no simulator). Simulator scenarios on macOS runners. `tier0-windows` on every PR: full unit and e2e on windows-2022. Node (post CVE-2024-27980) throws `spawn EINVAL` on `.cmd` shims without `shell: true`. Fixed via `resolveSpawnTarget`.
- First fixture matrix: latest stable SDK only. Three fixtures (an Expo Go app, a dev-client app, a broken variant). iOS-first for simulator scenarios, Android after the harness works.
- Sequencing: feature-set review happens before implementation starts. [confirmed, Kudo, 2026-08-20]

## Tier 0 doubles the dev server, not the app

The e2e stub reproduces the protocols `@expo/agent-cli` speaks to the dev server itself: `GET /status` with its project-root header, `GET /json/list`, the manifest and entry bundle, and the `/message` client command socket down to the `version: 2` stamp. It carries no CDP inspector. A double for the inspector proxy would be a double for React Native's runtime, which is the thing under test.

Everything on the far side of that boundary is unreachable at layers 1 and 2 by construction, and reachable at the live tier. Record the gap with live evidence rather than a tier-0 test that asserts the mock.

## A flag is not shipped until it has run against the published binary

Anything this CLI verifies against monorepo source must also be run once against the binary a user's project would actually get: `npx <package>@latest`, in a project outside this repository, before it ships. [confirmed, Kudo, 2026-08-25] A surface read from `cli/src/commands/*.ts` is a claim about an unreleased version. The process boundary of [[0001-agentic-cli-on-expo-cli]] that keeps this CLI working across versions also hides which version it is talking to.

A stub cannot close this. A stub `fingerprint` accepts whatever it is written to accept, so the e2e tier proves the shape of an invocation and never its availability.

The live tier runs the published surface, meaning the ncc bundle through `bin/cli.js`, against a real simulator, a real Hermes, and the real EAS service. That is this tree's bundle. `npx <package>@latest` in a project outside this repository is still one run the live tier does not perform.

The automated half is a countable surface. `src/lint/foreignFlags.ts` collects every option this CLI writes onto a command line. A snapshot pins the list. Adding an option to another CLI's command line is a visible diff in a test, and that diff is where the outside-the-repo run is asked for. Two rows are this CLI re-invoking itself and need no run. They stay in the list because an exclusion list is a place for a real one to hide.

The trick has a second instance now. When `smoke` grew a required `--ios`/`--android`, the places that printed a bare `smoke` were found one at a time, twice ([[0005-runtime-loop-tools]] §Which platform is the caller's to say, F151). So `src/lint/checkCommandMentions.ts` gained `REQUIRED_OPTION_GROUPS`: the same countable-surface idea, one level in — a printed command that omits an option its own parse now requires is a failing test, not a suggestion a caller runs into.
