# Navigate

A user opens a route of the app on the device. `navigate <route>` checks the route against the project's routes, opens the link in the development build on the device bound to the project, and waits for the app to attach to the dev server.

## Sub-features

- `navigate-open` opens the root route in the development build and reports that the app attached.
- `navigate-route` opens a second route in the running app.
- `navigate-unknown` refuses a route that the project does not have.
- `navigate-unbound` refuses a platform that has no device bound to the project.

## How to get to it (user POV)

- Run `npx @expo/agent-cli navigate /`.
- Run `npx @expo/agent-cli navigate /explore --ios`, or `--android`.
- Run the `next` command that `status` prints when a dev server runs with no app connected.

## Driving it with verify.mjs

Preconditions:

- The baseline of [README.md](./README.md).
- [dev-server.md](./dev-server.md) `dev-start` is done for `$PF`. `status` shows `bundler ready`.

- **Open.** Open the root route. Run `node $V run --label navigate-open-$PF -- navigate / --$PF --json`. Exit code `0`. The object has `exitCode: 0`, `attached: true`, `routeCheck.matched: "/"`, and a target of `dev-build`. The `command` starts with `xcrun simctl openurl` on iOS and with `adb -s emulator-… shell am start` on Android.
- **Second view.** Wait for the first screen. Run `node $V run --until "EAS Example home" --timeout 240 -- runtime:tree --all --$PF`. The untrusted block has `screen=index`.
- **Other route.** Open the second screen. Run `node $V run --label navigate-route-$PF -- navigate /explore --$PF`. Exit code `0`. Then run `node $V run --until "EAS Example explore" -- runtime:tree --all --$PF`. It matches, with `screen=explore`.
- **Unknown route.** Open a route that has no file. Run `node $V run --label navigate-unknown-$PF -- navigate /nope --$PF`. Exit code `1`. stderr has `"/nope" is not a route of this project, so nothing was opened.` and lists `/, /_sitemap, /explore`.
- **Unbound platform.** With only the Android emulator bound, run `node $V run --label navigate-unbound -- navigate / --ios`. Exit code `20`. stderr has `No ios device is bound to this worktree.` Run this one only in a project that never ran `dev --ios`.

## Gotchas

- Right after a full Android build, the emulator is slow. `navigate-open` then gave exit `22` with `attached: false`, and the first screen came about a minute later. On a quiet machine it gave exit `0` and the screen came at once. Keep the `--timeout 240`, and report an exit `22` here with the machine state.
- An Expo Go on the same device that is connected to the dev server becomes the target: `navigate --json` then reports `expo-go` and opens an `exp://` link. Check the target in every `navigate-open` proof.
- `status` reports `0 apps connected` until the first `navigate`.
- `--no-route-check` opens any link. A proof of `navigate-unknown` must not pass it.
- The `screen=` value in `runtime:tree` is the proof of the route. The `navigate` exit code alone proves only that the link opened.
