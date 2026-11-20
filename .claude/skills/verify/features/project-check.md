# Check the project

A user asks what the project is and what to run next. `status` answers in a brief or as JSON, `dev --plan` prints the steps that `dev` would run, and `typecheck` runs the project's own TypeScript check. None of them starts a server or a device.

## Sub-features

- `status-brief` prints the project, Expo Go support, freshness, installed app, dev server, device and the next command.
- `status-json` prints the same report as one JSON object.
- `dev-plan` prints the plan for a platform and runs nothing.
- `typecheck-report` lists type errors and exits 20 when there is one.

## How to get to it (user POV)

- Run `npx @expo/agent-cli status` in the project.
- Run `npx @expo/agent-cli status --json`.
- Run `npx @expo/agent-cli dev --ios --plan`, or `--android`.
- Run `npx @expo/agent-cli typecheck`.

## Driving it with verify.mjs

Preconditions:

- The baseline of [README.md](./README.md).
- No dev server runs for the app. `node $V doctor` shows `devServer.running: false`.

- **Brief.** Ask for the status. Run `node $V run --label status-brief -- status`. Exit code `0`. stdout has a `project` line with `eas-example`, `SDK 58` and `dev client`, an `expo go     not compatible` line, `dev server  not running`, and a `next` line that names a `dev` command.
- **JSON.** Ask for the object. Run `node $V run --label status-json -- status --json --no-followups`. Exit code `0`. stdout parses as one object with `project.isExpoApp: true`, `project.usesDevClient: true`, `expoGo.compatible: false` and `devServer.running: false`.
- **Plan, no build yet.** In a checkout with no build for `$PF`, run `node $V run --label dev-plan-stale-$PF -- dev --$PF --plan`. Exit code `0`. stdout starts with `Smart start plan (rule: dev-client-stale, target: dev-client)` and lists two steps: `expo prebuild --platform $PF` and `expo run:$PF`.
- **Plan, build recorded.** After [dev-server.md](./dev-server.md) `dev-first-build` for `$PF` and a `dev:stop`, run `node $V run --label dev-plan-fresh-$PF -- dev --$PF --plan`. Exit code `0`. stdout starts with `Smart start plan (rule: dev-client-fresh, target: dev-client)` and lists one step, `expo start --dev-client`.
- **Plan runs nothing.** Read the state again. Run `node $V run -- status --json --no-followups`. `devServer.running` is still `false`.
- **No type errors.** Run `node $V run --label typecheck-clean -- typecheck`. Exit code `0`. stdout has `Typecheck    no type errors`.
- **Type errors.** Add `const wrong: number = 'text';` as the last line of `APP/src/app/explore.tsx`. Run `node $V run --label typecheck-report -- typecheck`. Exit code `20`. stdout names `src/app/explore.tsx` and `TS2322`. Run `git checkout -- apps/eas-example/src/app/explore.tsx`.

## Gotchas

- `status` caches under `APP/.expo`: fingerprints for ten minutes. Pass `--no-fingerprint-cache` when the proof is about a fingerprint that moved.
- `status` always exits 0 without `--assert`. Assert on the report, not on the exit code.
- While the dev server ran right after a first build, `status` reported `installed   rebuild required` and `freshness … local stale`, on iOS and on Android. After `dev:stop`, `dev --ios --plan` reported `dev-client-fresh`. The cause is not known. Do not use the `installed` line as proof of a build without a second read.
- The `auth` line shows the EAS login of the machine. Do not put it in a report.
- `status` names a connected physical phone in its recommendations. It does not launch anything on the phone without `--device`.
- The app is linked to the `expo-ci` EAS project. `status` asks EAS for builds of the fingerprint, so its `freshness` lines need a login with access. Without one, the EAS answers are `unknown`; that is not a failure of the recipe.
