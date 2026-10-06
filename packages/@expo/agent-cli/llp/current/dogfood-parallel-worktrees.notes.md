# Dogfood: three agents, three worktrees, three simulators, through the CLI only

Agents: three Claude (Opus 5.5) delegates, 2026-10-07 from 00:50 CEST, one per git worktree, each
on its own feature of the Notes app (edit, search, pin). A fourth delegate then verified the
composed app alone. A coordinator (Claude Fable 5.1) wrote the briefs, reviewed the diffs and stacked
the branches.
CLI: `packages/@expo/agent-cli/bin/cli.js` built in each worktree at 1f43a33 (PR #100 rebased on
main a1c1b29, PR #108 on top, the fixes layer of PR #107 dropped), run from `apps/eas-example`.
App: `apps/eas-example`, SDK 58, dev client built locally by `dev --ios`.
Devices: local iOS simulators, one claim per worktree in `~/.expo/agent-cli/devices/`. No EAS.
Host: Xcode 27.1, 10 CPUs, 64 GB; the three Xcode builds ran at the same time, load average above
800 while they did.

## What the claims did

Each worktree got its own simulator, and `dev:stop` released only its own:

| worktree | simulator                    | how it got it              |
| -------- | ---------------------------- | -------------------------- |
| edit     | iPhone Duo `16A9E3E4`        | booted, the first free one |
| search   | iPhone 18 Pro `9F1000B4`     | created for the worktree   |
| pin      | iPhone 18 Pro Max `8C9C5147` | booted, the next free one  |

Every runtime verb that found this worktree's server drove the right simulator; the exception is
4, where a verb read a sibling's server. The claims dir was empty after the last `dev:stop`. One
claim kept the pid of a run that had exited (12).

## Friction points

### 1. `dev --ios --plan` exits 1 when a booted simulator belongs to a sibling

- **What I wanted.** The plan before the first run.
- **What I ran.** `dev --ios --plan` (search, pin)
- **What happened.** Exit 1, 5 to 20 s. "Every booted iOS simulator is claimed by another worktree.
  How: name a device with --device <id>, raise EXPO_AGENT_MAX_DEVICES, or run dev:stop in a worktree
  above." The cap on this host is 5, one or two were claimed. The real run then booted or created a
  free simulator without trouble. `--plan` resolves the device with boot disabled, so "would boot one"
  turns into an error.
- **What I expected.** A plan whose device step says "boot or create a simulator for this worktree".
  The recovery must not send an agent to stop another agent's server.
- **Severity.** `wrong`

### 2. `pod install` fails under a non-UTF-8 shell, and the recovery points at the Expo CLI

- **What I wanted.** The first dev client build.
- **What I ran.** `dev --ios --detach --wait-ready` (all three; the agent shells had `LANG` unset)
- **What happened.** Exit 1, 51 to 114 s. The error tail is a Ruby backtrace ("Unicode Normalization
  not appropriate for ASCII-8BIT"). The line that names the cause ("CocoaPods requires your terminal
  to be using UTF-8 encoding ... export LANG=en_US.UTF-8") shows only in `dev:logs`. The `Try:` is
  `npx expo run:ios --device <udid>`, which would fail the same way. All three agents set
  `LANG=en_US.UTF-8` and reran `dev`.
- **What I expected.** The CLI recognizes this CocoaPods failure and says to set the locale, or sets
  it for its child. A `Try:` that hands an agent to the Expo CLI contradicts the CLI's purpose.
- **Severity.** `blocked`

### 3. `--wait-ready` gives up at 120 s during a cold build, with exit 1

- **What I wanted.** One call that returns when the app is up.
- **What I ran.** `LANG=en_US.UTF-8 dev --ios --detach --wait-ready` (all three)
- **What happened.** Exit 1 at 120 s every time: "The detached dev server did not start (pid N) ...
  still running 119999ms later without having published one". The detached process went on: pods,
  Xcode build, "Build Succeeded", install, open, Metro. The server came up 2 to 4 minutes later. `dev`
  has no `--timeout`. Each agent polled `status` or `dev:logs` by hand.
- **What I expected.** The wait covers a native build the plan itself scheduled (smoke allows up to
  30 m), or exit 22 "still building, pid alive, run status". Exit 1 means "running the same line again
  changes nothing", and that was false. PR #114 on main is this fix; it was in the dropped fixes layer
  of this stack.
- **Severity.** `wrong`

### 4. The server that outlives the wait never publishes its lock, so verbs fall back to a sibling's 8081

- **What I wanted.** `navigate /`, `runtime:tree` and `dev:stop` against this worktree's server.
- **What I ran.** `status`, `navigate /`, `runtime:tree`, `dev:stop` (edit, search)
- **What happened.** After 3, edit's Metro listened on 8082 and `.expo/dev/` held only `logs/`.
  `status` said "dev server running on http://127.0.0.1:8081 · via lock · serves another project".
  `runtime:tree` then read "Notes (2)" from 8081, which `lsof` showed was pin's server. A
  `runtime:tap` there would have driven another agent's app. `dev:stop` in edit did SIGTERM its own
  pid and release the claim, but printed "Port 8081 · still answering, by something else" and
  suggested `dev:stop --port 8081`, pin's server. In search, `dev:stop` exited 0 with "Stopped no ...
  no dev-server lock answered" and the server kept running; only `dev:stop --port 8083 --force`
  stopped it.
- **What I expected.** No lock for this project means the runtime verbs refuse (exit 1, `Try: dev`)
  instead of reading a port `status` already knows serves another project. `dev:stop` stops the
  server this worktree's `dev` started, and never names a sibling's port.
- **Severity.** `wrong`

### 5. The dev client build collides on 8081 with a sibling, and `--port` is dropped

- **What I wanted.** Three worktrees, three Metros.
- **What I ran.** `dev --ios --detach --wait-ready`, then with `--port 8084` (search)
- **What happened.** The Xcode build succeeded, then "Error: listen EADDRINUSE: address already in
  use :::8081". The CLI had not chosen a free port, and the run was lost. With `--port 8084` the log
  said "these options were not passed on: --port 8084"; the Expo CLI picked 8083 itself. Edit's third
  run with `--port 8085` on a recorded build was ready in 25 s.
- **What I expected.** A free port per worktree chosen by the CLI, and `--port` on every step that
  serves. PR #115 on main is this fix; it was the dropped fixes layer of this stack.
- **Severity.** `wrong`

### 6. `status` lists the devices other worktrees claimed, and does not mark this worktree's

- **What I wanted.** The device this worktree uses.
- **What I ran.** `status` (pin)
- **What happened.** Exit 0. "device ios iPhone Duo (16A9E3E4...)", which edit held. A later run
  listed all three booted simulators with no mark on this worktree's claim.
- **What I expected.** The device line names this worktree's claim. Known follow-up of llp/0030.
- **Severity.** `wrong`

### 7. `runtime:tree` right after `navigate /` reports no DevTools hook

- **What I wanted.** The screen after navigate.
- **What I ran.** `navigate /` (exit 0, "App attached ... after 244ms"), then `runtime:tree` (pin)
- **What happened.** Exit 1: "has no React DevTools hook ... a production bundle is expected not to".
  One second later the suggested `runtime:eval` returned `object` and `runtime:tree` worked.
- **What I expected.** The verb waits for the bundle, or exits 22 "runtime not ready yet". The
  production-bundle text misleads.
- **Severity.** `wrong`

### 8. `runtime:reload` relaunches the app and then loses it

- **What I wanted.** Reload after an edit.
- **What I ran.** `runtime:reload` (search)
- **What happened.** Exit 22, 30 s: "the reload was broadcast ... no client reconnected within
  8000ms", a relaunch, "it had not reconnected to the dev server 30000ms later". The next
  `runtime:tree` exited 22 "no app is connected". `smoke --ios` reinstalled the app and reopened it;
  after that everything worked. Edit and pin reloaded in 1 to 2 s with no problem.
- **What I expected.** The broadcast reaches the app `navigate` attached, or the relaunch reattaches.
- **Severity.** `wrong`

### 9. `smoke --ios` passes while its screenshot shows the dev menu over the app

- **What I wanted.** A picture of the app as proof.
- **What I ran.** `smoke --ios` (all three)
- **What happened.** Exit 0, every phase ok. The dev-client tools sheet covers the lower half of the
  screenshot. Reproduces run 1, finding 11. The edit agent rated this `wrong`, the other two
  `unclear`.
- **What I expected.** The sheet dismissed before the capture, or a note that an overlay was on screen.
- **Severity.** `unclear`

### 10. `dev` runs prebuild, which rewrites the committed `package.json` scripts

- **What I wanted.** No tracked change from running the app.
- **What I ran.** `dev --ios ...` (all three)
- **What happened.** `"ios": "expo start --ios"` became `"expo run:ios"`, the same for android. The
  CLI said nothing. Each agent reverted it before committing.
- **What I expected.** The plan step says it edits `package.json`, or the committed example already
  matches what prebuild writes.
- **Severity.** `unclear`

### 11. `dev:logs` opens with "Suggested next: the dev server is up" before anything ran

- **What I wanted.** Why the run failed.
- **What I ran.** `dev:logs` (edit, search)
- **What happened.** The log starts with the plan, then "Suggested next: navigate / — The dev server
  is up but opens nothing", then the prebuild and the pod failure.
- **What I expected.** Follow-ups after the outcome, not before it.
- **Severity.** `unclear`

### 12. The device claim keeps the pid of the run that died

- **What I wanted.** Which process holds the simulator.
- **What I ran.** `cat ~/.expo/agent-cli/devices/*.json` after the second `dev` (edit)
- **What happened.** The claim still said the pid of the first run, which had exited, while the
  second run's pid owned the simulator. After the third run the pid was right.
- **What I expected.** The claim's pid updated by the run that reuses it.
- **Severity.** `unclear`

### 13. `--plan` does not say which simulator or port it will use

- **What I wanted.** The device and port before the run, since three worktrees share one host.
- **What I ran.** `dev --ios --plan` (edit)
- **What happened.** Steps and build location only. The simulator appeared first in the failure
  text of 2.
- **What I expected.** The device and the port in the plan.
- **Severity.** `missing`

### 14. `status` and `dev --plan` take 20 s cold

- **What I wanted.** A quick read.
- **What I ran.** `status`, `dev --ios --plan` (search, pin)
- **What happened.** 20 to 25 s with no progress line. Later calls took 1 to 3 s.
- **What I expected.** A few seconds, or a line that says what it waits on.
- **Severity.** `slow`

### 15. Builds share one DerivedData folder across worktrees

- **What I wanted.** Isolated builds for parallel agents.
- **What I ran.** `dev --ios ...` (search)
- **What happened.** The log shows `DerivedData/EASExample-<hash>`; the hash comes from the project
  name, not the path. No collision was seen in this run.
- **What I expected.** Recorded as a risk only.
- **Severity.** `unclear`

### 16. Every tap and type prints the same two-line warning about the synthetic event

- **What I wanted.** Seven form steps.
- **What I ran.** `runtime:tap`, `runtime:type` (search)
- **What happened.** Correct, and noise after the first time.
- **What I expected.** Once, or behind `--verbose`.
- **Severity.** `fine`

## The composed app, verified alone

A fourth delegate ran the stacked branch (edit, search and pin together) on one simulator with no
sibling, through the same verbs. All six checks passed: two notes created, one edited and showing
`detail-edited`, one pinned and sorting first with `pinned-<id>`, search narrowing to one card and
to `no-matches`, the state surviving `runtime:reload`, then `runtime:errors`, `smoke --ios`,
`typecheck` and `dev:stop` all exit 0. Four more findings came from that run:

### 17. `smoke --ios` passes with a solid black screenshot

- **What I ran.** `smoke --ios` (verify)
- **What happened.** Exit 0, "screenshot ok". The picture is black. `runtime:tree` one second
  later showed the full list.
- **What I expected.** A screenshot phase that notices an empty picture, or says the capture is
  unverified.
- **Severity.** `wrong`

### 18. The build a detached `dev` made is not recorded

- **What I ran.** `dev --ios --detach --wait-ready`, then `status`, then `smoke --ios` (verify)
- **What happened.** `status` still says "no recorded build"; smoke reinstalled the app (29 s).
  Edit's third run did find a recorded build, so the record depends on how the run ended. Reproduces
  run 1, finding 9, for the local path.
- **What I expected.** The build recorded when it succeeds, whatever the parent process did.
- **Severity.** `wrong`

### 19. The detached `dev` exits 20 for the same timeout that gave the others exit 1

- **What I ran.** `dev --ios --detach --wait-ready` (verify)
- **What happened.** Exit 20 after 120 s, "gave up after 34961ms". The three parallel runs got
  exit 1 for the same wait (3). Neither is 22, "a wait expired".
- **Severity.** `unclear`

### 20. No verb resets the app's data on a claimed simulator

- **What I ran.** `navigate /` (verify)
- **What happened.** The simulator still held a note from an earlier worktree's run, so the ids and
  the count in the scenario were off by one. The rules forbade `simctl` by hand.
- **What I expected.** A way to start from a clean app, or a note in `dev --plan` that the device
  carries old data.
- **Severity.** `missing`

The `--verify` diff pairing unrelated texts by position (run 1, finding 15) reproduced.

## What worked

- Three worktrees got three distinct simulators from the registry, with no flag and no config. One
  was created for the worktree that found none free. `dev:stop` released and shut down only its own.
- After a server was found, every runtime verb took about 1 s and exited 0. `runtime:tap --verify`
  printed exact tree diffs; each agent proved its feature from those alone, with no screenshot.
- `runtime:type` says plainly that it calls `onChangeText`, not the keyboard.
- `dev:logs` showed the true cause of the pod failure on the first try.
- `navigate /` noticed no app was attached, opened the dev-launcher URL first, and attached in 3 to
  11 s.
- `dev --port <free>` on a recorded build: plan `dev-client-fresh`, ready in 25 s.
- `typecheck` in under 6 s, and the follow-ups of `runtime:errors` and `typecheck` say what each
  one cannot see.

## Outside the CLI

- `export LANG=en_US.UTF-8` in the agent shells (2).
- `lsof` on the Metro ports, to prove whose server answered on 8081 (4). No device action.
- `cat ~/.expo/agent-cli/devices/*.json` to read the claims (12).
- `git checkout -- package.json` after prebuild (10).

## Severity counts

| Severity | Count | Entries                     |
| -------- | ----- | --------------------------- |
| blocked  | 1     | 2                           |
| wrong    | 9     | 1, 3, 4, 5, 6, 7, 8, 17, 18 |
| slow     | 1     | 14                          |
| unclear  | 6     | 9, 10, 11, 12, 15, 19       |
| missing  | 2     | 13, 20                      |
| fine     | 1     | 16                          |
