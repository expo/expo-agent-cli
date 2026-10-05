# Dogfood: a Notes tab in apps/parallel-example, through the CLI only

Agent: Claude (Opus 5.5), 2026-10-05, from 12:43 CEST.
CLI: `packages/@expo/agent-cli/bin/cli.js` built at 284898f, run from `apps/parallel-example` as `agent`.
The app now lives outside this repo; the EAS project is `expo-ci/parallel-example`.
Device: one EAS Simulator session (iOS), `--eas` on every verb that takes it.
Times are wall-clock from a wrapper that prints `took=Ns`.

## Setup

- The worktree came up at aa2303f (main), not at 284898f. I ran `git reset --hard 284898f` on my own branch. This is a harness issue, not a CLI issue.

## Friction points

### 1. The first-run material has no screenshot verb and no --eas path

- **What I wanted.** To learn from the CLI's own help how to drive an EAS Simulator session and take a screenshot.
- **What I ran.** `agent --help`, `agent help workflow`, then `--help` for each runtime verb.
- **What happened.** Exit 0, 0 s. No `screenshot` verb exists. The only picture comes from `smoke --screenshot <path>`. `help workflow` never says `--eas`. `navigate`, `runtime:reload`, `smoke` and `dev:stop` take `--eas`. `runtime:tree`, `runtime:tap`, `runtime:type` and `runtime:errors` take only `--ios`/`--android`.
- **What I expected.** A `screenshot` verb that takes `--eas`, and one sentence in `help workflow` on the EAS path.
- **Severity.** `missing`

### 2. The managed block in the app's AGENTS.md is stale

- **What I wanted.** Project facts from `AGENTS.md`.
- **What I ran.** `cat apps/parallel-example/AGENTS.md`
- **What happened.** The managed block says `SDK: unknown (the expo package is not installed)` and `Dev client: expo-dev-client is not installed`. `agent status` says `SDK 57.0.26 · dev client`. The block also never mentions `--eas`, and the Commands list above it tells me to run `eas build` directly.
- **What I expected.** The block matches `status`, or says when it was generated.
- **Severity.** `wrong`

### 3. The --eas plan misreads eas.json and its follow-up drops --eas

- **What I wanted.** The plan for the EAS path.
- **What I ran.** `agent dev --ios --eas --plan`
- **What happened.** Exit 0, 6 s. The plan picks `development-simulator` and says "The development profile is a device build, and no simulator can install one". `eas.json` has `"ios": { "simulator": true }` in `development` too. `Suggested next:` prints `npx @expo/agent-cli dev --ios` with no `--eas` and with no `--detach`. Running it literally would plan a local build.
- **What I expected.** The profile read from `eas.json`, and a follow-up that keeps the flags I passed.
- **Severity.** `wrong`

### 4. Plain status recommends the local path

- **What I wanted.** To know what to run next on EAS.
- **What I ran.** `agent status` and `agent status --explain`
- **What happened.** Exit 0, 2 s and 16 s. `next` says `dev --ios → expo prebuild` (local). There is no way to tell `status` that I work on EAS, so `next` is always the local plan. `--explain` did answer the EAS question: `EAS has no finished build for this fingerprint`, fingerprint `6547eb59`.
- **What I expected.** `status --eas`, or `next` that names both paths.
- **Severity.** `unclear`

### 5. agents:setup installs nothing for this project and is silent on why

- **What I wanted.** The skills the CLI wants an agent to read.
- **What I ran.** `agent agents:setup --yes --agent claude-code --no-plugins`
- **What happened.** Exit 0, 0 s. `0 skill(s) from 0 package(s) linked`. It refreshed the AGENTS.md block (finding 2 is now fixed on disk) and created `CLAUDE.md` with `@AGENTS.md`. The refreshed block still has no `--eas` and no screenshot path. I skipped the plugin install because it writes to my user home. I did not commit the refreshed AGENTS.md or the new CLAUDE.md, to keep the feature commit to the feature.
- **What I expected.** It did what it says. The material is enough for a local simulator. It is not enough for an EAS session without this prompt.
- **Severity.** `unclear`

### 6. install says "prebuild" on a CNG project that builds on EAS

- **What I wanted.** To add `expo-sqlite` and learn what it costs.
- **What I ran.** `agent install expo-sqlite`
- **What happened.** Exit 0, 47 s (44.8 s in `bun add`). The plugin went into `app.json`. Impact line: `native module: run "npx @expo/agent-cli prebuild", then build and install the app again`. The follow-up `dev --ios` is right for local work but drops the EAS context again.
- **What I expected.** "Rebuild the development build" without a prebuild step. On CNG and on EAS no prebuild runs here.
- **Severity.** `unclear`

### 7. The fingerprint saw the native change, but no gate can say so before a first build

- **What I wanted.** Proof that the CLI sees `expo-sqlite` as a native change.
- **What I ran.** `agent status --explain` before and after the install, then `agent status --assert js-only`.
- **What happened.** The fingerprint went from `6547eb59` to `2b6f55ea`, and `EAS has no finished build for this fingerprint`. That is correct. `--assert js-only` exited 22: `no build is recorded for ios, so there is nothing to compare this against`. Freshness was already `stale` before the install, so `status` alone shows no difference.
- **What I expected.** The same result. It is honest. A diff of the two fingerprints ("sources added: expo-sqlite") would make the cause visible.
- **Severity.** `nice`

### 8. dev prints "the app runs on the EAS session" before the build starts

- **What I wanted.** To start the build, the tunnel and the session in one command.
- **What I ran.** `agent dev --ios --eas` (blocking, in the background; `--detach` gives up after 120 s during a native build, already known).
- **What happened.** The plan, then `Suggested next: navigate / --eas — The dev server is tunnelled and the app runs on this project's EAS Simulator session`, printed before `eas build` was even queued. Then `Waiting for build to complete`.
- **What I expected.** Follow-ups after the step they depend on, or worded as "when this finishes".
- **Severity.** `wrong`

### 9. typecheck explains the missing expo-env.d.ts

- **What I wanted.** A typecheck before the first dev server run.
- **What I ran.** `agent typecheck`
- **What happened.** Exit 20, 1 s. Two CSS-import errors, and a clear note: `expo-env.d.ts does not exist yet ... some of the diagnostics above are about it rather than about the code`. `npx tsc --noEmit` from the app ran an unrelated `tsc` package from the registry ("This is not the tsc command you are looking for"). `./node_modules/.bin/tsc` works. That is npx in a bun workspace, not the CLI.
- **What I expected.** This. The note saved me a search.
- **Severity.** `nice`

### 10. The dev log says "Skipping dev server" and then starts one

- **What I wanted.** The dev server up after the build, with 8081 taken by another project.
- **What I ran.** `agent dev --ios --eas` (same run).
- **What happened.** The EAS build took about 7 min (12:49 to 12:56), which is EAS, not the CLI. Then the log has `Input is required, but 'npx expo' is in non-interactive mode. > Use port 8082 instead? › Skipping dev server`, then `Port 8081 was busy; started on 8082 instead`, then Metro starts. It also prints a full QR code and "Open this link on your iOS devices" for a simulator build that only the EAS session installs.
- **What I expected.** One line: "8081 is busy, using 8082". No Expo CLI prompt text, and no QR code for a simulator build.
- **Severity.** `unclear`

### 11. The whole start on EAS was one command and about 10 minutes

- **What I wanted.** Build, tunnel, session and app open, with no other tool.
- **What I ran.** `agent dev --ios --eas`
- **What happened.** 12:48 start, 12:56 build finished, 12:57:48 `Opened the app on EAS Simulator session 01a10bb5…`. The session started in about 1 min. The line says who stops the session and how.
- **What I expected.** This.
- **Severity.** `nice`

### 12. status after the EAS run: freshness unknown, the device line names the local simulator, next drops --eas

- **What I wanted.** To confirm the state after the build.
- **What I ran.** `agent status`
- **What happened.** Exit 0, 2 s. `freshness ios local stale · eas unknown`, though the CLI itself just built for this fingerprint on EAS. `device ios iPhone 17 Pro (26.4) (0A73…)`, the local simulator, not the session. `next npx @expo/agent-cli smoke --ios`, no `--eas`. The dev server line was right: `1 app connected · tunnel http://c-expoci-…on.expo.app`.
- **What I expected.** `eas fresh` (or "built by this CLI at 12:56"), the session on the device line, and `--eas` kept in `next`.
- **Severity.** `wrong`

### 13. navigate --eas opens the route, then reports "App not attached" after 55 s

- **What I wanted.** To open `/notes` on the session.
- **What I ran.** `agent navigate /notes --eas`
- **What happened.** Exit 22, 82 s. `App not attached · no ios app registered a debugger target on http://127.0.0.1:8082 within 56237ms`. At the same time `status` said `1 app connected` and `runtime:eval "1+1"` answered `2`. The second run did open `/notes`: `runtime:tree` then showed `testID=notes-empty`. The "How" text suggests `bunx eas-cli@latest simulator:exec npx agent-device@latest alert get`, which is a raw eas command again.
- **What I expected.** Exit 0 in a few seconds, because the app was attached before and after.
- **Severity.** `wrong`

### 14. The runtime verbs cannot place the EAS app on a platform

- **What I wanted.** To read the screen of the app on the session.
- **What I ran.** `agent runtime:tree --ios --json`
- **What happened.** Exit 1, 1 s. `NO_APP_CONNECTED`: `nothing in its target says which platform it is on ... read from the device name and the app id`. The "How" says to connect a device that `adb devices -l` or `xcrun simctl list devices booted` can see. A cloud session is neither. `runtime:tree` has no `--eas`. Without a platform flag the verb tries the one target, which is right when only one app is connected. My inference, not verified: the same scoping makes `navigate --eas` (13) and `smoke --eas` (16) wait for an attach that they never see.
- **What I expected.** `--eas` on the runtime verbs, or the session's device name in the index.
- **Severity.** `wrong`

### 15. runtime:tree fails every time its own bundle check runs

- **What I wanted.** The tree of the focused screen.
- **What I ran.** `agent runtime:tree` (6 runs), then `agent runtime:tree --no-bundle-check`.
- **What happened.** Every run with the bundle check: exit 1, 2 to 3 s, `Could not read the app's component tree ... Why: No target found` (once `The debugger connection closed before the app answered`). With `--no-bundle-check` and 5 s after the last bundle check: exit 0, 0 to 1 s, `Walked 573 fibers`. A `--no-bundle-check` run straight after a failing run also failed. So the entry-bundle request takes the debugger target away for some seconds, on this tunnelled dev server. `runtime:eval` (no bundle check) always worked. The error text says "make sure the app is open", which sent me to the wrong place.
- **What I expected.** The bundle check leaves the debugger target alone, or the verb waits for the target to come back.
- **Severity.** `wrong`

### 16. smoke --eas is the only screenshot, it costs 4 minutes, and it mislabels the picture

- **What I wanted.** A screenshot of `/notes`.
- **What I ran.** `agent smoke --ios --eas --no-reload --screenshot apps/parallel-example/.dogfood/01-notes-empty.png` (twice).
- **What happened.** Exit 22, 237 s and 238 s. `app 203.9s · parallelexample:// was opened on the device and no app had attached`. The app was attached the whole time. The screenshot row says `the dev launcher's own screen — this project's bundle never ran`. The picture shows the app's Home screen under the dev-menu onboarding sheet, so the bundle did run. Smoke also opens `parallelexample://`, which sends the app back to `/`, so it cannot photograph the route I navigated to.
- **What I expected.** A `screenshot --eas` verb that takes the picture in about 10 s (the screenshot phase itself took 11 s) and does not move the app.
- **Severity.** `blocked`. For the screens in 2 to 5 I left the CLI and ran the command smoke runs: `bunx eas-cli@latest simulator:exec npx agent-device@latest screenshot <path>`.

### 17. The dev-menu onboarding sheet covers the app, and no verb closes it

- **What I wanted.** The app's screen with nothing on top.
- **What I ran.** `agent runtime:eval "globalThis.expo.modules.ExpoDevMenu.closeMenu()"` and `agent runtime:eval "globalThis.expo.modules.DevMenuPreferences.setPreferencesAsync({isOnboardingFinished:true})"`.
- **What happened.** Both returned (exit 0, 1 s). The sheet came back in the next smoke picture, after smoke reopened the app. `runtime:tap` reaches only React elements, and the sheet is native.
- **What I expected.** `dev` or `smoke` on a fresh dev build marks the onboarding as done, the way it already answers system alerts.
- **Severity.** `missing`

### 18. runtime:tap, runtime:type and --verify drove every screen in 0 to 2 s

- **What I wanted.** To create, open and delete notes and to switch the theme, by testID.
- **What I ran.** `agent runtime:tap new-note --verify --no-bundle-check`, `agent runtime:type "Groceries" --testID note-title --no-bundle-check`, `agent runtime:tap save-note --verify --no-bundle-check`, `agent runtime:tap delete-note --verify --no-bundle-check`, `agent runtime:tap theme-dark --verify --no-bundle-check`.
- **What happened.** Exit 0 every time, 0 to 2 s. `--verify` printed `~ theme-current: "Theme: System" -> "Theme: Dark"`, which proved the change in one line. The first Save showed a real bug at once (19).
- **What I expected.** This. It is the best part of the CLI on EAS.
- **Severity.** `nice`

### 19. --verify dumps a whole LogBox, and runtime:errors then explains it well

- **What I wanted.** To save the first note.
- **What I ran.** `agent runtime:tap save-note --verify --no-bundle-check`, then `agent runtime:errors --duration 1s`.
- **What happened.** `--verify` listed about 200 `+ RCTVirtualText` lines, one per token of the LogBox code frame. The fact I needed was in one of them: `[expo-router]: You are passing an array of styles to a child of <Slot>`. `runtime:errors` then gave that message and a stack mapped onto my files, from an error raised before its 1 s window opened. The cause was my `Link asChild` around a `Pressable` with a style array. I fixed it with `router.push`.
- **What I expected.** `--verify` to say "a render error appeared: <message>" and stop, and point to `runtime:errors`.
- **Severity.** `unclear`

### 20. --verify diffs text by position, so a delete reads as a rename

- **What I wanted.** To prove that Delete removed the note.
- **What I ran.** `agent runtime:tap delete-note --verify --no-bundle-check`
- **What happened.** Exit 0, 1 s. `- Pressable testID=note-row-2` was right. Then `~ @RCTText: "Dogfood findings" -> "Groceries"` and four more `~` lines, which are the remaining row moving up, not a text change. `runtime:tree` on the detail screen also listed the list screen's rows under the same `screen=notes`, so "the focused screen" is the tab, not the top of the stack.
- **What I expected.** Removed and kept elements matched by testID, and the stack's top screen as the focus.
- **Severity.** `unclear`

### 21. runtime:reload on EAS always falls back to a relaunch, takes 35 to 38 s, and can exit 22 after it worked

- **What I wanted.** The app on the code on disk after an edit.
- **What I ran.** `agent runtime:reload --eas --route /notes` (three times).
- **What happened.** Each time: `dev-server: the reload was broadcast, but no client reconnected within 8000ms`, then a relaunch through `simulator:exec npx agent-device@latest open … --relaunch`. 38 s exit 0, 38 s exit 22, 35 s exit 22. The exit 22 says `nothing was observed to confirm it reloaded` because the dev server runs in a terminal and writes no log file. The app did run the new code each time (the screenshot after the second one showed the header fix). Each relaunch also brought the dev-menu sheet back (17). The relaunch clears JS state, which is fine here and said out loud.
- **What I expected.** A Fast Refresh or a dev-server reload in a few seconds. Given the relaunch, exit 0 when the route opened and the app answered `runtime:eval`.
- **Severity.** `slow`

### 22. Follow-ups suggest commands that fail on the EAS session

- **What I wanted.** To run the suggested next step.
- **What I ran.** `agent runtime:errors --ios --fail-on-error`, as `runtime:reload --eas` suggested.
- **What happened.** Exit 1, `No app connected ... could be shown to be running on ios` (14). The other suggestions in this run also lose context. `runtime:tap --verify` suggests `runtime:tree` without `--no-bundle-check` (15). `runtime:reload` suggests `bunx eas-cli@latest simulator:exec npx agent-device@latest screenshot screen.png`, a raw eas command, and says it is "the one thing no gate in this CLI can read". `dev:stop --eas` suggests `dev --ios`.
- **What I expected.** Follow-ups that keep `--eas` and that run as printed.
- **Severity.** `wrong`

### 23. lint installs eslint, writes a config and rewrites the monorepo lockfile

- **What I wanted.** A lint pass before commit, as AGENTS.md asks.
- **What I ran.** `agent lint`
- **What happened.** Exit 1, 15 s. One error in a file I did not touch (`use-color-scheme.web.ts`, `react-hooks/set-state-in-effect`). It also added `eslint` and `eslint-config-expo` to `package.json`, created `eslint.config.js` and changed about 200 lines of the root `bun.lock`, including eslint downgrades. The output I read did not mention it. `lint` is the `expo lint` passthrough, so this is Expo CLI behavior, but `help workflow` puts no warning on it. I reverted all three and regenerated the lockfile with `bun install`. My own files lint clean.
- **What I expected.** A refusal or a plan line ("lint will install eslint and write eslint.config.js"), as `dev` prints for its steps.
- **Severity.** `wrong`

### 24. dev:stop --eas says "Session none in progress" when the session it owned had just been stopped

- **What I wanted.** Proof that billing stopped.
- **What I ran.** `agent dev:stop --eas`
- **What happened.** Exit 0, 17 s. `Stopped yes · Session none in progress for this project`. The dev process log says `Stopped EAS Simulator session 01a10bb5…, created by this run`, so the SIGTERM made the dev process stop it, and `dev:stop` then found nothing. A second `dev:stop --eas --json` gave `"session": {"id": null, "stopped": false}`.
- **What I expected.** `Session 01a10bb5… stopped (by the dev server, on SIGTERM)`. "None in progress" reads like "there never was one".
- **Severity.** `unclear`

## Severity counts

| Severity | Count | Entries                         |
| -------- | ----- | ------------------------------- |
| blocked  | 1     | 16                              |
| wrong    | 9     | 2, 3, 8, 12, 13, 14, 15, 22, 23 |
| slow     | 1     | 21                              |
| unclear  | 7     | 4, 5, 6, 10, 19, 20, 24         |
| missing  | 2     | 1, 17                           |
| nice     | 4     | 7, 9, 11, 18                    |

## What worked well

- `help workflow` is a short, ordered page. The exit-code table is clear.
- `status --explain` gave the fingerprint and the EAS build state in one call.
- `dev --ios --eas` did the build, the tunnel, the session and the open in one command, and it named the session and how to stop it.
- `runtime:tap`, `runtime:type` and `--verify` are fast (0 to 2 s on a cloud session) and exact. They found a real bug on the first Save.
- `runtime:errors` mapped stacks onto my files, and it kept an error raised before its window.
- `runtime:eval` worked every time, which made it the escape hatch: it closed the dev menu (`ExpoDevMenu.hideMenu()`) after each relaunch.
- `navigate --eas --no-wait-attach` opened a route in 15 to 18 s.
- The `BEGIN/END UNTRUSTED APP OUTPUT` markers make it clear which text came from the app.

## Known issues hit

- `dev --detach` gives up after 120 s during a native build. I ran `dev --ios --eas` blocking in the background instead.
- None of the other three known issues showed up.

## Outside the CLI

- `bunx eas-cli@latest simulator:exec npx agent-device@latest screenshot <path>` for thirteen screenshots (16). Each took about 11 s.
- `./node_modules/.bin/tsc --noEmit`, because `npx tsc` resolved an unrelated registry package (9).
- `bun install` at the root, to put `bun.lock` back after `lint` (23).
- I read CLI source (`src/runtime/cdpClient.ts`, `src/device/cloudSimulator.ts`) to find the screenshot command and to understand "No target found". An agent without the source would not have found `--no-bundle-check` as the workaround: the error text does not point to it.
