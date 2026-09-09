# @expo/agent-cli

Agent-native CLI on top of the Expo CLI family. Coding agents (and humans) use it to run Expo workflows and get machine-readable answers. It runs `expo`, `eas-cli`, `expo-doctor`, and friends as subprocesses. It does not import their internals.

Design documents: `llp/0001-agentic-cli-on-expo-cli.rfc.md` and its child LLPs in this package.

## Start here

| Step                         | Command                                   | Gets you                                       |
| ---------------------------- | ----------------------------------------- | ---------------------------------------------- |
| 1. Check the project         | `npx @expo/agent-cli status`              | what this project is, and what to run next     |
| 2. Start the app             | `npx @expo/agent-cli dev --ios --detach`  | the dev server starts, the terminal comes back |
|                              | `npx @expo/agent-cli navigate /`          | the app opens a route, on a device             |
| 3. Edit and reload           | `npx @expo/agent-cli runtime:reload`      | after your edit, the app runs the code on disk |
|                              | `npx @expo/agent-cli runtime:errors`      | what it threw, over a time window              |
|                              | `npx @expo/agent-cli runtime:tree`        | what is on screen, and its testIDs             |
| 4. Verify before you're done | `npx @expo/agent-cli smoke --ios`         | the app on the code on disk, and one exit code |
|                              | `npx @expo/agent-cli typecheck`           | the type errors neither of those can see       |
| 5. Release                   | `npx @expo/agent-cli deploy`              | the web app to EAS Hosting                     |
| One-time setup               | `npx @expo/agent-cli new my-app`          | create a project                               |
|                              | `npx @expo/agent-cli install expo-sqlite` | add a package at the version this SDK wants    |
|                              | `npx @expo/agent-cli agents:setup`        | confirm agent setup for a project or user home         |

`npx @expo/agent-cli help workflow` is this loop in one screen, plus exit codes, `--json`, and what to do when a command fails.

`npx @expo/agent-cli -h` lists every command. Each command's `--help` has the same shape: purpose, options, examples, what to run next, and the `--json` keys.

## Commands

| Command                                                        | What it does                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `new`                                                          | Create a project without prompts                                    |
| `install` / `add`                                              | Run `expo install`, then sync that package's skills                 |
| `status`                                                       | What this project is, whether a rebuild is needed, what to run next |
| `dev`                                                          | Plan how to get the app on a device, then do it. `--eas` does it all on EAS |
| `start`                                                        | `expo start` and nothing else, then sync skills                     |
| `dev:logs` / `dev:stop`                                        | Read or stop a detached dev server                                  |
| `navigate`                                                     | Open a route on a simulator, a device, or EAS Simulator (`--eas`) |
| `runtime:reload`                                               | Put the running app back on the code on disk                        |
| `runtime:errors` / `runtime:eval`                              | Read runtime errors, or evaluate JS in the running app              |
| `runtime:tree` / `runtime:tap` / `runtime:type`                | Drive the app by `testID`                                           |
| `runtime:stop`                                                 | Stop the app on the device                                          |
| `smoke`                                                        | Reload onto the code on disk, open a route, check for errors        |
| `typecheck`                                                    | The project's own `tsc --noEmit`                                    |
| `doctor`                                                       | `expo-doctor`, normalized                                           |
| `deploy`                                                       | Ship the web app to EAS Hosting, or the native app with `--native`  |
| `inspect:build-log`                                            | Find the line in a native build log that says why it failed         |
| `inspect:config-plugins`                                       | What the config plugins produced. Experimental                      |
| `agents:setup`                                                 | Set up Expo agents in a project or user home                             |
| `skills:sync` / `skills:list` / `skills:show` / `skills:clean` | Discover and link skills shipped by installed modules               |

Grouped commands use `group:action`, the way `eas-cli` does. The space form is the same command: `skills list` is `skills:list`. Bare `skills` syncs, bare `doctor` checks, bare `dev` runs the plan.

Commands this CLI does not wrap go to the project's `expo` CLI: `run`, `run:ios`, `run:android`, `prebuild`, `config`, `export`, `export:web`, `export:embed`, `serve`, `customize`, `lint`, `login`, `logout`, `register`, `whoami`.

## Set up a coding agent

Run `npx @expo/agent-cli agents:setup` to select agents, review the commands, and confirm installation into your user home. It works both inside an Expo app and before creating one. Pass `--project` to install plugins/skills in the current Expo project instead; this flag requires an Expo app. Package skill synchronization and instruction-file setup still run in that app, even when the plugin installation targets your home.

Use the arrow keys to navigate, Space to toggle agents, and Enter to continue. Detected or previously configured agents start selected. Escape or Ctrl-C cancels setup before installation; the final confirmation defaults to No.

- Claude Code uses `expo@claude-plugins-official` with an explicit user/project scope. The official marketplace must already be registered; for a fresh Claude configuration, run `claude plugin marketplace add anthropics/claude-plugins-official` first.
- Codex user setup registers `expo/skills` at `main` and installs `expo@expo-plugins`. Codex's plugin CLI has no project scope, so `--project` installs Expo skills for Codex instead.
- Other agents use `bunx skills add expo/skills --skill '*'` (or `npx` when Bun is unavailable), with the selected agent and scope passed explicitly.
- Grok Build uses `--agent grok` and `.grok/skills` for package skill links. Setup detects `.grok` in the project or user home (respecting `GROK_HOME`), and the `grok` executable. Grok reads `AGENTS.md` directly.

For automation, accept the plan explicitly:

```sh
npx @expo/agent-cli agents:setup --yes --agent codex --json
npx @expo/agent-cli agents:setup --yes --project --agent claude-code --json
```

`--json` alone does not accept setup. Without a terminal, omit `--yes` to receive a confirmation-required error without installing anything. Declining the interactive confirmation leaves files unchanged.

Use `--no-plugins` to skip official plugin/skills installation, `--no-agent-skills` to skip package skill synchronization, and `--no-agents-md` to skip all instruction-file writes. Existing installations are inspected and retained; setup does not run broad updates or replace skills from another source. Use each plugin marketplace or the skills CLI to manage updates. Start a new agent session after installation; MCP tools may require sign-in separately.

The JSON report includes the selected `scope`, `cancelled`, per-agent `plugins`, and `errors`, alongside the project results, including `agentsMd` and `claudeMd` file actions. Outside a project, `projectRoot`, `skills`, `agentsMd`, and `claudeMd` are null. If an installer fails, independent project setup still runs; the final report preserves completed steps and exits with code 20. Invalid arguments or missing noninteractive confirmation exit with code 1; declining confirmation exits with code 0 and `cancelled: true`.

### Shared project instructions

Setup creates or updates the Expo managed block in the project-root `AGENTS.md`. It also rewrites Expo command examples to agent-cli for wrapped commands (`install`, `start`, and `add`) and every registered Expo passthrough command, such as `prebuild`, `export`, `run:ios`, and `lint`. The rewrite keeps supported `npx`/`bunx` runner options and command arguments. Bare commands at the start of a line or quoted example use `npx`; `expo-doctor` and `expo-doctor@latest` become agent-cli `doctor`. Unknown commands and other template and user instructions are preserved. The block directs agents to use agent-cli for equivalent Expo install/start/lint, TypeScript, and expo-doctor operations, including commands suggested by loaded skills; it retains Expo's SDK-compatible package installation and the template's `bunx` convention for projects with `bun.lock`.

`new` writes these same instructions and rewrites the template's Expo command examples after creating a project, including with `--no-install`. It does not install agent plugins or ask setup questions. Its JSON report includes `agentsMd` and `errors`; if instruction generation fails after scaffolding succeeds, `created` remains true and the command exits with code 20. Run `agents:setup` in the new project to retry instructions and configure agent skills.

For selected Claude Code agents, setup creates `CLAUDE.md` with `@AGENTS.md`, or appends that import to an existing regular file. A plain mention such as “See AGENTS.md” is not a file import. Existing active imports and `CLAUDE.md` symlinks to `AGENTS.md` are retained. The reverse layout, `AGENTS.md` symlinked directly to a regular project-root `CLAUDE.md`, also shares one managed block without adding a self-import. Other instruction-file symlinks are not written through. See [Claude's shared instruction documentation](https://code.claude.com/docs/en/memory#agentsmd).

The managed block points agents to `expo-overview`, when available in their skill list, as the entry point for choosing an Expo or EAS skill. It refers to the skill by name without copying its routing map or embedding installation paths. A Package / Skill / Read table follows for verified, linked package skills. Links are project-relative and point to `SKILL.md`; missing links, user-owned conflicts, and losing duplicate names are omitted. Multiple skills from one package get separate rows. Plugins and standalone skills installed from `expo/skills` remain owned by their installers and are outside this package-skill index.

After setup creates the index, `skills:sync`, automatic skill sync during install/start/dev, and `skills:clean` refresh only its marked section. Other instructions and project facts stay unchanged. Dry runs never refresh it, and these commands do not create instruction files or add an index to a file that setup has not opted in. Rerunning setup upgrades an older managed block to include the index.

## Config

Flags beat `package.json`. `package.json` beats detection. Unknown keys are errors.

```json
{
  "expo": {
    "agentCli": {
      "target": "dev-build",
      "buildBackend": "eas",
      "android": { "buildBackend": "local" }
    }
  }
}
```

`target` is `expo-go` or `dev-build`. `buildBackend` is `local` or `eas`. An `ios` or `android` key overrides the backend for that platform.

## Notes

- A machine that cannot build locally (no Xcode, no Android SDK, a Windows host asked for iOS) is never routed to EAS on its own: `dev` and `smoke` stop and name `--eas`, because an EAS build and an EAS Simulator session use EAS credits. Pass `--eas`, or set `buildBackend: "eas"` in the config, to take that route.
- `smoke --ios --eas` gates the app on this project's EAS Simulator session: it reuses the session in progress, or starts one with Expo Go or the finished EAS build of this fingerprint and ends it afterwards (`start-session` phase). It never builds; a development build with nothing finished on EAS is a failure naming `dev --ios --eas`. `dev:stop --eas` ends the session too.
- `dev --ios --eas` runs everything on EAS: the dev server is tunnelled, a build (when one is needed) is the `development-simulator` profile on EAS Build — added to `eas.json` when missing, skipped when EAS already has a finished build of this fingerprint — and the app is opened on this project's EAS Simulator session, which is started with Expo Go or that build when none is up. A session bills until `npx --yes eas-cli@latest simulator:stop`. `--eas` on `smoke`, `navigate`, `runtime:reload` and `runtime:stop` names that session as the device.
- Expo Go on Android has no debugger. Use a development build to drive the app there.
- `runtime:tree`, `runtime:tap`, and `runtime:type` call the app's props. They do not touch the screen. They need a development bundle.
- `smoke` reloads an app that is already running before it reads it, because that app is holding the bundle from before your edit. A reload it cannot prove is exit 22, never a pass. Pass `--no-reload` to read the app where it is.
- `smoke` makes sure the simulator has the Expo Go your SDK ships, for a project that runs in Expo Go and is not set to `dev-build`. Missing, older or newer all get replaced with the right release, the way `expo start` does. Under `--no-start` nothing is installed, and a wrong version is reported instead of a pass.
- `smoke` checks that the app that answered is one your project can actually run. Expo Go holding a project whose native code its runtime does not have, or an Expo Go from a different SDK release line, is exit 22 with the build command named — never a pass. An Expo Go an update behind on the same line is reported and does not fail the run.
- `smoke` does not run on web. A browser is not in the debugger target list.
- A cloud simulator needs a tunnelled dev server. Localhost is refused.

The rest of the limits live in each command's `--help`.

## Status

Experimental. Commands and output formats may change.
