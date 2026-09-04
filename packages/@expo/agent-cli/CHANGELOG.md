# Changelog

## Unpublished

### 🛠 Breaking changes

### 🎉 New features

- Initial agent-cli work. ([#49654](https://github.com/expo/expo-agent-cli/pull/1) by [@kudo](https://github.com/kudo))

### 🐛 Bug fixes

- The Expo Go check now compares native modules against a vendored autolink dump of Expo Go, and falls back to `bundledNativeModules.json` for an SDK this CLI has not recaptured. ([#3](https://github.com/expo/expo-agent-cli/pull/3) by [@kudo](https://github.com/kudo))
- `smoke` now installs Expo Go on a simulator that has not got it, rather than refusing and naming `expo start`. Only for the plan's Expo Go rule, so a project set to `dev-build` or one that cannot run in Expo Go is unaffected. The install also pre-approves Expo Go's URL schemes and marks the developer-menu onboarding seen, without which the deep link raises a dialog nobody answers and the screenshot is a picture of an onboarding sheet. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))
- `smoke` no longer trusts an installed Expo Go without checking its version. The release the project's SDK ships is compared exactly, the way `@expo/cli`'s `ExpoGoInstaller` does, and any other version — older, newer, or from another release line — is replaced with the right one rather than reported. The expected release comes from the `expo-go` CLI as a subprocess. Under `--no-start` nothing is installed and a wrong version blocks the pass instead. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))
- `smoke` and `navigate` no longer target Expo Go for a project that cannot run in it. The deep-link decision now reads the same Expo Go compatibility the plan engine and `status` read, and `smoke` will not report `passed` when the app that answered is an Expo Go the project's native code is not in. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))
- `smoke` now reloads an app that was already running onto the code on disk before it reads it, so the gate no longer passes an app whose error window and screenshot are from before the edit. A reload it cannot prove is `inconclusive` rather than `passed`, and `--no-reload` opts out. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))
- `dev --detach` no longer reports a detached dev server for a plan step that opens the app and is then refused by macOS after the lock appeared. The grace window that catches that refusal no longer requires `--wait-ready`, so a `dev --detach --ios` now spends it before reporting. ([#2](https://github.com/expo/expo-agent-cli/pull/2) by [@kudo](https://github.com/kudo))

### 💡 Others
