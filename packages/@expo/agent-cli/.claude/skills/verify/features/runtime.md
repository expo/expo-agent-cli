# Runtime

A user reads and drives the running app from the terminal. `runtime:reload` puts the app on the code on disk, `runtime:tree` lists what is on screen, `runtime:tap` calls a handler by `testID`, `runtime:eval` evaluates JavaScript in the app, and `runtime:errors` reads what the app threw.

## Sub-features

- `runtime-reload` reloads the app and proves that it reconnected.
- `runtime-tree` lists the elements with a handler or a `testID`.
- `runtime-tree-all` lists labels, roles and text as well.
- `runtime-tap` calls the `onPress` of the element with a `testID`.
- `runtime-tap-missing` fails for a `testID` that no element has.
- `runtime-eval` prints the value of an expression in the app.
- `runtime-errors` reports the errors of a time window.

## How to get to it (user POV)

- Run `npx @expo/agent-cli runtime:reload` after an edit.
- Run `npx @expo/agent-cli runtime:tree`, with `--all` for text.
- Run `npx @expo/agent-cli runtime:tap <testID>`, with `--verify` for a before-and-after diff.
- Run `npx @expo/agent-cli runtime:eval '<expression>'`.
- Run `npx @expo/agent-cli runtime:errors`.
- Add `--ios` or `--android` to any of them to name the device.

## Driving it with verify.mjs

Preconditions:

- The baseline of [README.md](./README.md).
- [dev-server.md](./dev-server.md) `dev-start` and [navigate.md](./navigate.md) `navigate-open` are done for `$PF`. `runtime:tree --all --$PF` shows `EAS Example home`.

- **Interactive tree.** List what can be driven. Run `node $V run --label runtime-tree-$PF -- runtime:tree --$PF`. Exit code `0`. stdout has `Scoped to $PF`, and the untrusted block has `testID=home-title`, `testID=counter-button  onPress`, `testID=counter-value` with `text="Count: 0"`, and `testID=explore-link  onPress`.
- **Full tree.** Read the text too. Run `node $V run --label runtime-tree-all-$PF -- runtime:tree --all --$PF`. Exit code `0`. stdout has `full projection` and `screen=index`.
- **Tap.** Call the handler and read the change. Run `node $V run --label runtime-tap-$PF -- runtime:tap counter-button --$PF --verify`. Exit code `0`. The untrusted block has `called onPress on Pressable` and `~ counter-value: "Count: 0" -> "Count: 1"`.
- **Second view.** Run `node $V run --until "Count: 1" -- runtime:tree --all --$PF`. It matches.
- **Missing testID.** Tap an element that does not exist. Run `node $V run --label runtime-tap-missing-$PF -- runtime:tap nope --$PF`. Exit code `20`. stderr has `No element carrying the testID nope was found, so nothing was tapped`.
- **Eval.** Evaluate an expression. Run `node $V run --label runtime-eval-$PF -- runtime:eval '1 + 1' --$PF`. Exit code `0`. stdout has `Result type: number.` and `2` in the untrusted block.
- **Edit.** In `APP/src/app/index.tsx`, replace `EAS Example home` with `Verify marker 42`.
- **Reload.** Put the app on the edit. Run `node $V run --label runtime-reload-$PF -- runtime:reload --$PF --json`. Exit code `0`. The object has `method: "dev-server"`.
- **Second view.** Run `node $V run --until "Verify marker 42" -- runtime:tree --all --$PF`. It matches. The counter is back at `Count: 0`: a reload resets the app state.
- **Errors.** Read the error window. Run `node $V run --label runtime-errors-$PF -- runtime:errors --$PF --json`. Exit code `0` on the healthy app.
- **Restore.** Run `git checkout -- apps/eas-example` from the repository root, then `node $V run -- runtime:reload --$PF`, then `node $V run --until "EAS Example home" --timeout 240 -- runtime:tree --all --$PF`.

## Gotchas

- Seen once, not reproduced: on the Android emulator (AVD `TestingAVD`, API 29), the app stopped answering after one `runtime:reload` that reported `method: "dev-server"` and exit `0`. Then `runtime:tree` took about 7 minutes for each call, and a second `runtime:reload` took 16 minutes before exit `22`. The emulator's Android system restarted itself during that time. A later run on a new project did five reloads in about 2 seconds each with no failure. When a command after an Android reload is slow or killed, report the evidence file and run the cycle again.
- On the Android emulator, a reload can exceed the 8 seconds that `runtime:reload` waits for the app to reconnect. The command then reports `method: "device"`: it stopped and relaunched the app. The exit code is still `0`, but the relaunch is a cold start of about two minutes. Record which method the proof saw. A proof of the dev-server reload needs `method: "dev-server"`.
- On iOS, every reload reported `method: "dev-server"` in under one second.
- `runtime:tap` calls the prop. It does not touch the screen. `runtime:tap --verify` reports `nothing in the interactive projection changed` for a handler that changes nothing in the component tree.
- `runtime:eval` of an expression that throws exits `1` and prints the error in the untrusted block.
- `runtime:errors` reads a window that opens when the command starts. An error thrown before it is not there. Reproduce the error while a longer window listens: `--duration 4000`.
- The app resumes on the route it was launched with after a reload. Run `navigate` again when the recipe needs another screen.
