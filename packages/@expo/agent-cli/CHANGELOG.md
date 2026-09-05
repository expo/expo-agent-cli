# Changelog

## Unpublished

### 🛠 Breaking changes

- `dev` now requires a platform flag (`--ios`, `--android`, or `--web`), like `smoke`. The plan always acts on the named platform: a fresh plan runs `expo start --<platform>`, which boots a simulator or an emulator and opens the app, and a stale plan prebuilds and builds through `expo run:<platform>`. A run with no platform exits 1 with a one-line usage error. Every suggestion the CLI prints now states a platform too. ([#7](https://github.com/expo/expo-agent-cli/pull/7) by [@kudo](https://github.com/kudo))

### 🎉 New features

- `dev --no-open` serves without opening the app. The platform still names what the plan builds and serves for; the flag keeps it away from `expo start`, whose open needs a macOS Automation grant. `smoke` starts its dev server this way, and the Automation-refusal error now names it as the way past. ([#7](https://github.com/expo/expo-agent-cli/pull/7) by [@kudo](https://github.com/kudo))
- Initial agent-cli work. ([#49654](https://github.com/expo/expo-agent-cli/pull/1) by [@kudo](https://github.com/kudo))

### 🐛 Bug fixes

- Commands no longer suggest a bare `smoke`, which exits 1 now that the gate requires `--ios` or `--android`. Every next-action that named it — on `dev`, `dev:logs`, `typecheck`, the interact commands, `runtime:reload`, `runtime:eval`, `navigate`, and the `AGENTS.md` written into a project — names a platform, and a lint rule fails on any printed `smoke` that does not. ([#6](https://github.com/expo/expo-agent-cli/pull/6) by [@kudo](https://github.com/kudo))
- The Expo Go check now compares native modules against a vendored autolink dump of Expo Go, and falls back to `bundledNativeModules.json` for an SDK this CLI has not recaptured. ([#3](https://github.com/expo/expo-agent-cli/pull/3) by [@kudo](https://github.com/kudo))
- `smoke` now installs Expo Go on a simulator that has not got it, rather than refusing and naming `expo start`. Only for the plan's Expo Go rule, so a project set to `dev-build` or one that cannot run in Expo Go is unaffected. The install also pre-approves Expo Go's URL schemes and marks the developer-menu onboarding seen, without which the deep link raises a dialog nobody answers and the screenshot is a picture of an onboarding sheet. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))
- `smoke` no longer trusts an installed Expo Go without checking its version. The release the project's SDK ships is compared exactly, the way `@expo/cli`'s `ExpoGoInstaller` does, and any other version — older, newer, or from another release line — is replaced with the right one rather than reported. The expected release comes from the `expo-go` CLI as a subprocess. Under `--no-start` nothing is installed and a wrong version blocks the pass instead. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))
- `smoke` and `navigate` no longer target Expo Go for a project that cannot run in it. The deep-link decision now reads the same Expo Go compatibility the plan engine and `status` read, and `smoke` will not report `passed` when the app that answered is an Expo Go the project's native code is not in. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))
- `smoke` now reloads an app that was already running onto the code on disk before it reads it, so the gate no longer passes an app whose error window and screenshot are from before the edit. A reload it cannot prove is `inconclusive` rather than `passed`, and `--no-reload` opts out. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))
- `dev --detach` no longer reports a detached dev server for a plan step that opens the app and is then refused by macOS after the lock appeared. The grace window that catches that refusal no longer requires `--wait-ready`, so a `dev --detach --ios` now spends it before reporting. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))

### 💡 Others
