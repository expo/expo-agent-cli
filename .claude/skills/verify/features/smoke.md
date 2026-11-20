# Smoke

A user asks one question before the work is done: does the app boot on the code on disk? `smoke --ios` or `smoke --android` runs nine phases, from the dev server to a screenshot, and answers with one exit code: 0 passed, 20 failed, 22 no conclusion.

## Sub-features

- `smoke-pass` passes on a healthy app, with a reload that is proven and a screenshot.
- `smoke-broken-bundle` fails at the `bundle` phase when the entry bundle does not compile.
- `smoke-start` starts the dev server and the device itself, and stops what it started.
- `smoke-no-platform` refuses a run with no platform flag.

## How to get to it (user POV)

- Run `npx @expo/agent-cli smoke --ios` or `smoke --android` with nothing running.
- Run `npx @expo/agent-cli smoke --ios --no-start` against the dev server that is already up.
- Run `npx @expo/agent-cli smoke --android --route /explore` for one route.

## Driving it with verify.mjs

Preconditions:

- The baseline of [README.md](./README.md).
- For `smoke-pass` and `smoke-broken-bundle`: [dev-server.md](./dev-server.md) `dev-start` and [navigate.md](./navigate.md) `navigate-open` are done for `$PF`, and the first screen is up.
- For `smoke-start`: the development build for `$PF` exists from an earlier `dev-start`, and no dev server runs for the app.

- **Pass.** Gate the running app. Run `node $V run --label smoke-pass-$PF -- smoke --$PF --no-start --json --no-followups`. Exit code `0`. The object has `ok: true`, `outcome: "passed"`, `platform` equal to `$PF`, `errors.count: 0` and `screenshot.ok: true` with a `screenshot.path` under `APP/.expo/agent-cli/`.
- **Second view.** Open the PNG at `screenshot.path`. It shows the app's first screen, not the splash and not the dev launcher. `node $V cleanup` copies it to the evidence directory.
- **Broken bundle.** Add `const broken = ;` as the last line of `APP/src/app/index.tsx`. Run `node $V run --label smoke-broken-bundle-$PF -- smoke --$PF --no-start --no-followups`. Exit code `20`. stdout has `failed            bundle`, names `src/app/index.tsx` with `SyntaxError`, and marks the later phases `skipped`. stderr has `The smoke gate failed at "bundle".`
- **Restore.** Run `git checkout -- apps/eas-example/src/app/index.tsx`, then `node $V run -- runtime:reload --$PF`. Exit code `0`.
- **No platform.** Run `node $V run --label smoke-no-platform -- smoke --no-start`. Exit code `1`. stderr has `Missing platform.`
- **Start.** With no dev server up, run `node $V run --label smoke-start-$PF -- smoke --$PF --json --no-followups`. Exit code `0`, with `ok: true` and `outcome: "passed"`. Then `node $V run -- status --no-followups` shows `dev server  not running`: the run stopped the server that it started.

## Gotchas

- On the Android emulator under load, `smoke` gave `outcome: "inconclusive"`, exit `22`, when its reload did not reconnect within 8 seconds. A second `smoke` on the settled app passed. On an idle emulator `smoke` passed in 7 seconds. Report the first result too; do not hide it behind the retry.
- `reload.disposition` is `reloaded` when smoke reloaded the app, and `not-needed` when the app was launched after the last edit. Both are a pass.
- `smoke` without `--no-start` starts a dev server when none is up, on 8081 or the next free port, and stops it after the run.
- `--no-reload` reads the app where it is, and then a pass says nothing about the code on disk.
- The screenshot goes into `APP/.expo/agent-cli/`, which is git-ignored. `node $V cleanup` copies it to the evidence directory.
- Exit `22` is not a failure and not a pass. Report it as no conclusion.
- `smoke` does not run on web.
