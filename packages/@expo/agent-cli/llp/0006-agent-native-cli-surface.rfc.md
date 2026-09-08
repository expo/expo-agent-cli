# 0006: Agent-native CLI surface

**Type:** RFC
**Status:** Active
**Systems:** `packages/@expo/cli`; JSONL events; `@expo/agent-cli` launcher (`src/commandRegistry.ts`, `src/cli.ts`); agent setup (`src/agents/`)
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-20
**Revised:** 2026-09-08
**Related:** [[0001-agentic-cli-on-expo-cli]], [[0003-knowledge-tools-and-skills]], [[0004-smart-start-and-project-state]], [[0008-guardrails]], [[0024-cli-ui]]

## Summary

Make the Expo CLI itself pleasant for a driving agent: structured output in, structured answers out, no TTY assumptions, and a hard process boundary.

## The process boundary

Agentic tooling invokes the `expo` CLI as a subprocess as much as possible. It does not import `@expo/cli` code. [confirmed, Kudo, 2026-08-20]

The tool layer then works against whatever CLI version the project has installed, across SDK versions. `@expo/cli` is rolled up with swc, and internals are not a public API. The boundary also forces the real contract, the JSONL event stream, to stay complete. Anything the tool layer needs must be an emitted event or a command flag.

Consequence: gaps discovered while building tools become upstream `@expo/cli` improvements (new events, new flags), rather than imports.

## Surface improvements

JSONL events are the API. `installEventLogger` and `LOG_EVENTS` exist today (`packages/@expo/cli/bin/cli.ts`). The tool layer treats the event schema as a versioned contract. Missing events are bugs to fix upstream.

Agent-mode dev server output: no QR code, no spinner, no interactive keymap. JSONL events plus a small status endpoint carrying bundle state, connected clients, and the last error. A QR code is meaningless to an agent. A URL plus a platform-launch tool is not. [confirmed, Kudo, 2026-08-18]

Non-interactive parity: every interactive prompt in Expo/EAS CLIs must have a programmatic answer path (flag or JSON). [confirmed, Kudo, 2026-08-18] The eval suite ([[0002-testing-and-evals]]) runs everything with no TTY attached. A prompt that blocks a pipe is a bug.

Headless CI mode: structured pass/fail invocations with `--json` and exit codes, for jobs like "verify the app still boots after this PR".

### Errors are prompts

Every CLI error is a driving agent's next prompt. `CommandError.suggestedCommand` prints a trailing `Try: <command>` line and rides the `cli:error` JSONL event. Every error event carries machine-readable fields, a cause classification, and a suggested next step.

`agents:setup` writes and maintains a managed section in the project's `AGENTS.md`: SDK version, targets, the right commands, project quirks. It orients every agent, including ones that never call a tool. See [Agent setup](#agent-setup) for installation and confirmation behavior.

## Agent setup

`agents:setup` works before an Expo project exists. It detects agents, lets the user select targets, displays the proposed commands and project writes, and asks for confirmation. Installation defaults to user home, including inside an Expo app. `--project` explicitly selects project-local installation and fails when no Expo app is found; there is no interactive scope question. [confirmed, Kudo, 2026-09-08]

Project detection checks for a declared Expo dependency, so a fresh clone without installed dependencies still offers project scope. A missing project skips package skill synchronization and instruction-file generation; it does not create home-level `AGENTS.md`, `CLAUDE.md`, or a project selection cache. Other commands retain their Expo-app guards. [observed]

### Installation and scope

The official knowledge source is `expo/skills`, installed through each agent's supported installer. No local documentation mirror is included. [confirmed, Kudo, 2026-09-08]

- Claude Code installs `expo@claude-plugins-official` with `claude plugin install` and explicit `--scope user|project`. Its official marketplace must already be registered; a fresh configuration needs `claude plugin marketplace add anthropics/claude-plugins-official`. [observed]
- Codex user setup runs `codex plugin marketplace add expo/skills --ref main`, then `codex plugin add expo@expo-plugins`. Its plugin CLI has no project scope, so `--project` installs project-local Codex skills instead. [observed]
- Other agents, and Codex project setup, use `bunx skills add expo/skills --skill '*'`, falling back to npx. The installer receives the selected agent, explicit noninteractive consent, and `--global` for user scope. The wildcard is a literal subprocess argument. [observed]
- Grok Build is selected as `grok`, matching the upstream skills installer. Its package skill links use `.grok/skills`; detection checks project `.grok`, user `.grok` (or `GROK_HOME`), and setup also checks the `grok` executable. It reads `AGENTS.md` directly. [confirmed, Kudo, 2026-09-08; conventions: https://github.com/vercel-labs/skills/blob/main/src/agents.ts and https://docs.x.ai/build/features/skills-plugins-marketplaces]

Setup inspects existing installations after confirmation, reuses matching installations in the selected scope, and verifies installation through the owning CLI. It reports conflicting sources or disabled plugins rather than replacing or enabling them, and avoids broad updates. Plugin and standalone skill files remain owned by their installers; module `skills:sync` and `skills:clean` retain their existing ownership boundaries ([[0003-knowledge-tools-and-skills]]). [observed]

### Confirmation and project phases

The two setup questions use `@clack/prompts`, pinned to 1.7.0: a multi-select with detected/configured agents preselected and a confirmation defaulting to No. Prompt output goes to stderr. The adapter also maps stdin EOF and Ctrl-D to cancellation and pauses input after each question so completed setup exits normally. This is the repository's only owned interactive prompt flow. [confirmed, Kudo, 2026-09-08; observed adapter behavior]

`--yes` accepts the setup plan for automation; `--project` overrides the user-home default and repeatable `--agent` flags make agent selection explicit. Non-TTY runs without `--yes` fail promptly; `--json` alone is not consent. Decline, EOF, or Ctrl-C before confirmation causes no setup writes or installer invocations. This is the interactive exception described in [[0008-guardrails]]. [observed]

When an app is available, setup also runs its existing `skills:sync` and instruction-file generation, even when the plugin installation targets user home. The shared instruction behavior is described below. `--no-plugins` skips official plugin/skills installation, `--no-agent-skills` skips package skill synchronization, and `--no-agents-md` skips all instruction-file writes, including skill-index refresh during setup. [confirmed, Kudo, 2026-09-08; observed flag behavior]

Installer failures preserve completed work and allow independent project phases to run. Missing dependencies are reported with instructions to install them; setup does not install Expo automatically. Under `--json`, one report goes to stdout and installer progress goes to stderr. Invalid arguments or missing consent exit 1; declining confirmation exits 0 with `cancelled: true`; installer or project-phase failures return the partial report and exit 20. Installation does not prove that a new agent session has loaded skills or that MCP tools are authenticated. [observed]

### Shared instruction files

Keep existing template and user instructions outside the Expo managed block, except for a targeted migration of Expo install examples: replace `npx expo install`, `bunx expo install`, and bare `expo install` at the start of a line or quoted command with agent-cli. Preserve supported runner options and package arguments. This removes conflicting install instructions observed in real agent runs; do not migrate arbitrary user command sections. Inside the block, explicitly prefer agent-cli for equivalent Expo install/start/lint, TypeScript and expo-doctor operations (including suggestions in loaded skills), explain that installation retains SDK-compatible resolution, and preserve the `bunx` convention when `bun.lock` is present. [confirmed, Kudo, 2026-09-08]

When Claude Code is selected, setup creates a missing `CLAUDE.md` containing `@AGENTS.md` or appends the import to an existing regular file without replacing its text. Recognize an active import rather than accepting any mention of the filename; comments and code examples do not count. Existing `CLAUDE.md` → `AGENTS.md` symlinks are reused. Allow `AGENTS.md` → a regular `CLAUDE.md` directly in the same project root so either conventional layout shares one block, with no generated self-import. Other instruction-file symlinks are refused for writes. [observed; Claude import behavior: https://code.claude.com/docs/en/memory#agentsmd]

The confirmation plan names the shared instruction writes before they run. Report `claudeMd` as created/updated/skipped, or null when not targeted, alongside `agentsMd`. A Claude-file failure leaves the successful AGENTS.md result intact and is included in the partial failure report. No instruction files are created in user home. [observed]

Before the package index, direct agents to `expo-overview` when it is available in their skill list; it routes Expo/EAS goals to the relevant skill. Reference its name rather than copying its map or assuming an installation path. Include a compact package-skill index with direct, relative links to verified `SKILL.md` files. Only package-provided links belong in this index; keep it current with skill synchronization and cleanup as defined by [[0003-knowledge-tools-and-skills]] §Instruction skill index. [confirmed, Kudo, 2026-09-08]

## Output contract

The default output stays terse human text, which is the agent-friendly shape. [confirmed, Kudo, 2026-08-22] Three channels, each with one job:

1. Default text, for humans and LLMs reading terminals: one fact per line, in `label value` style, with stable rule and id names, and untrusted app output fenced.
2. `--json`, for programmatic consumers: exactly one JSON object on stdout and nothing else, guaranteed on every command. Field names mirror the text labels. Top-level keys are stable per command and covered by shape tests.
3. `LOG_EVENTS` JSONL, the streaming and telemetry channel for long-running commands, on the same contract as the expo CLI family.

**The keys a help block names are every key the object has.** `--help`'s `keys` line is where a caller reads them, so the branch can be written without running the command once to find out. `--no-followups` is the invariant the guard hangs on: the commands that emit `followups` offer the flag that suppresses it, and the flag is in the help block already, so a command that grows one and forgets the key fails `src/help/__tests__/template-test.ts`. Documented keys are compared against emitted keys through the process boundary (`documentedJsonKeys`). See [[0024-cli-ui]].

Anti-rule: no detection-based shape switching. `agent-cli-detector` may gate extras such as skill context dumps and follow-up verbosity ([[0009-smart-followups]]). It never changes the core shape. An agent transcript must show what a human terminal shows.

## The `@expo/agent-cli` launcher

The package ships as a model-free CLI.

| Command                                               | What it does                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `agents:setup`                                        | confirm home/project Expo plugin/skills installation, plus project setup when available                         |
| `skills:sync\|list\|show\|clean`                      | [[0003-knowledge-tools-and-skills]]                                                |
| `install`, `start`                                    | wrap the `expo` equivalents as subprocesses, with skill sync                       |
| `dev` / `dev:stop` / `dev:logs`                       | the smart-start engine of [[0004-smart-start-and-project-state]]                   |
| `status`                                              | where the project is right now. Under `--json`, the machine-readable project brief |
| `runtime:eval\|errors\|reload\|stop\|tree\|tap\|type` | [[0005-runtime-loop-tools]], [[0018-interaction-commands]]                         |
| `navigate`                                            | deep-link a route                                                                  |
| `typecheck`                                           | run the project's own TypeScript compiler as a gate ([[0010-agent-conventions]])   |
| `new`, `deploy`                                       | headless creation and shipping ([[0007-deploy-and-headless]])                      |
| `inspect:build-log`, `inspect:config-plugins`         | read what the project produced, without running it                                 |
| `doctor` / `doctor:check`                             | expo-doctor, normalized                                                            |
| `smoke`                                               | the whole gate in one command                                                      |
| `help`                                                | the workflow on-ramp ([[0024-cli-ui]])                                             |

Names that are not in this table are not in v1. See [[0017-deferred-commands]].

### Naming rule

A command sharing a name with an `expo` command behaves like that command. A capability only `@expo/agent-cli` has gets a verb of its own. The `expo` commands `@expo/agent-cli` does not wrap are forwarded to the project's `expo` CLI verbatim. [confirmed, Kudo, 2026-08-22] The launcher is a superset of `expo`, so an agent that knows `expo` is never wrong about `@expo/agent-cli`.

### Fixed forwarded list

What is forwarded is a list, not a fallback. It is the `commands` map of `packages/@expo/cli/src/index.ts` minus the commands `@expo/agent-cli` wraps (`start`, `install`, and `add`). What is left: `run`, `run:ios`, `run:android`, `prebuild`, `config`, `export`, `export:web`, `export:embed`, `serve`, `customize`, `lint`, `login`, `logout`, `register`, `whoami`. A name in neither surface is a command neither CLI has, and it fails with `UNKNOWN_COMMAND`. An unrecognized name is a typo far more often than it is a new `expo` command. Cost: the list is hand-maintained, so an `expo` command added upstream is unreachable through `@expo/agent-cli` until the list grows.

### Auth fallback

A forwarded command that acts on the machine rather than on the project falls back to the EAS CLI, rather than failing for want of a project one. [confirmed, Kudo, 2026-08-26] The four are `login`, `logout`, `register`, and `whoami`. The project's own `expo` wins whenever there is one. They read and write `~/.expo/state.json`, a file that exists on the machine whether or not the current directory has an Expo app in it. Both CLIs resolve that file identically.

`prebuild` and `export` get none of this. They act on the project, so "there is no project CLI here" is a real answer.

`eas register` does not exist, so `register` keeps the `npx expo` rung (`project-expo` → `runner-expo` through `resolvePackageRunner`). A line on stderr names the CLI and warns about the download. The fallback's output is the EAS CLI's. The note saying which one answered is on stderr, because this CLI's own auth preflight parses stdout.

One asymmetry: `@expo/cli` also honours `__UNSAFE_EXPO_HOME_DIRECTORY` and `eas-cli` does not. Recorded rather than handled.

### Alias rule

An `expo` command that is another name for one `@expo/agent-cli` wraps is an alias of the wrapper, not a forward. [confirmed, Kudo, 2026-08-22] `expo add` and `expo install` are the same command, so `@expo/agent-cli add` must run the `install` wrapper (skill sync, impact report) rather than silently skipping it. Aliases resolve to their target's name (`commandAliases` in the registry), so the event stream and the follow-ups only ever name the command that ran.

### Grouping rule

A capability with several actions is one colon group, `<group>:<action>`, spelled the way `eas-cli` spells its own commands (`runtime:eval`, `skills:list`, `agents:setup`). [confirmed, Kudo, 2026-08-22] Membership in one of the three lists is what resolves a name, never the shape of it. `expo export:web` has a colon too. An action of a group `@expo/agent-cli` owns is never forwarded. An unknown one is an error naming the actions that exist.

The rules are data rather than string matching (`src/commandRegistry.ts`). Three lists are the whole surface: `topLevelCommands`, `commandGroups`, and `forwardedCommands`. One pure `resolveCommand(command, argv)` answers with one of five cases (`command`, `group-help`, `unknown-action`, `passthrough`, `unknown-command`) that `cli.ts` acts on without deciding anything again.

- The space form is free. `<group> <action>` resolves to the same command as `<group>:<action>` when the action is the argument right after the group. The colon is canonical. The space form is silent.
- A bare group is answerable. `@expo/agent-cli runtime` prints the group's actions and exits 0. A group that declares a `defaultAction` runs it instead, so `@expo/agent-cli skills` syncs and `@expo/agent-cli doctor` checks. `@expo/agent-cli <group> --help` is always the listing.
- A group whose actions share their options stays one module. `withAction(action, load)` hands the action back as `argv[0]`.
- The help cannot drift. `helpSections` groups the surface by the job at hand. A unit test pins that every name in all three lists appears in exactly one section. What each of those screens actually says is [[0024-cli-ui]]. The registry carries the data all of it reads: a one-line `summary` and a lazy `help` loader on every entry, and the `workflow` map.
- Adding a command is one entry. No `switch`, no CLI framework.

Implemented: `start` and `install` add skill sync and follow-ups to `expo start` and `expo install`, and forward every other argument untouched. The plan-first engine is the `dev` verb. The forwarded set runs through `src/passthrough/`, which spawns the project's `expo` CLI with stdio inherited, forwards the exit code, emits one `cli:expo_passthrough` event, and adds nothing else.

## Testing

Event-schema snapshot tests. E2E subprocess runs against fixtures, asserting event sequences. A TTY-free CI environment as the default test condition ([[0002-testing-and-evals]]).

Agent setup adds planning and installer unit tests plus subprocess e2e for home/project scope, exact installer arguments, reruns, confirmation and cancellation, missing dependencies, partial failures, JSON output, and preservation of module and generator behavior. Live installer checks use isolated configurations; new-session activation and MCP authentication require separate manual verification.
