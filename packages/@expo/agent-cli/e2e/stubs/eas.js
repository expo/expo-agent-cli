#!/usr/bin/env node
// The one stub `eas` of the e2e tier.
//
// @ref llp/0002-testing-and-evals.plan.md §Tier 0 doubles the dev server, not the app
// @ref llp/0015-backend-selection-and-config.rfc.md §One flag for EAS
//
// Every command that takes `--eas` — `dev`, `smoke`, `navigate`, `runtime:reload`, `runtime:stop` —
// and every section that asks EAS a question (`status --explain`, the auth line) spawns the EAS CLI
// through a package runner (`npx eas-cli` / `bunx eas-cli`, `src/utils/easCli.ts`). This script is
// what that runner hands the argv to under test (`e2e/stubEas.ts` installs it). It used to be three
// scripts, one per test file, each answering the verbs its file happened to need; a command that
// reached a verb another file's stub knew got "unhandled command" and a red test about nothing.
//
// It answers every verb the CLI is known to run, in the shapes the real CLI was observed to print,
// and records every invocation as one JSON line — `{ args, cwd, ci }` — in `stub-eas-invocations.jsonl`
// under the cwd it was spawned in. The argv log is the assertion most tests are for.
//
// Steered with environment variables, so one script covers every path:
//
// Everything
// - STUB_EAS_CRASH=1 (alias STUB_SIM_CRASH): behave like a binary that is not the EAS CLI — exit
//   101 with a Rust backtrace and no Expo vocabulary (`src/utils/wrapperCrash.ts`)
//
// `whoami`
// - STUB_EAS_USER: the account named (default `e2e-user`)
// - STUB_EAS_WHOAMI_EXIT: non-zero for a signed-out machine (`Not logged in` on stderr)
//
// `build:configure`
// - STUB_EAS_CONFIGURE_EXIT: exit code (default 0). Exit 0 writes an `eas.json` with exactly the
//   profiles the real command writes (`development`, `preview`, `production`), unless one exists
//
// `build`
// - STUB_EAS_BUILD_EXIT / STUB_EAS_BUILD_STDERR: exit code, and what goes to stderr first — where
//   the real CLI puts its auth refusal and its prompt stops
// - STUB_EAS_BUILD_ID: the id of the build it reports (default `build-e2e`)
//   With `--json` it prints the array of `BuildFragment` the real command prints after `--wait`.
//   A finished build is **remembered** in `stub-eas-builds.json` under the cwd, so a later
//   `build:list` names it the way the service would — which is how `dev --eas` learns the id of
//   the build it just made.
//
// `build:list`
// - STUB_EAS_BUILD_LIST: the JSON to print verbatim (wins over the filter below)
// - STUB_EAS_BUILDS: a JSON array of builds to *filter* by the argv — `--platform`, `--status`,
//   `--fingerprint-hash`, `--build-profile`, `--limit` — the way the service does. The builds
//   `build` remembered are listed with them, newest first
// - STUB_EAS_BUILD_LIST_EXIT / STUB_EAS_BUILD_LIST_STDOUT: a refusal, on the stream the real CLI
//   uses (stdout for the explanation, one `Error:` line on stderr)
//
// `simulator:availability`
// - STUB_SIM_AVAILABLE: `false` for an account without the feature
//
// `simulator:list` / `simulator:get`
// - STUB_SIM_SESSIONS: `0` for a project with nothing running
// - STUB_SIM_ID / STUB_SIM_STATUS / STUB_SIM_PLATFORM / STUB_SIM_TYPE: the one listed session
//   (defaults `sess-e2e`, `IN_PROGRESS`, `IOS`, `agent-device`)
// - STUB_SIM_GET_EXIT / STUB_SIM_STDERR: a refusal, with the real CLI's wording on stderr
//
// `simulator` / `simulator:start`
// - STUB_SIM_START_EXIT / STUB_SIM_START_STDERR: a session that never became ready
// - STUB_SIM_START_ID: the id of the session it creates (default `sess-e2e-started`). Without
//   `--json` it writes `.env.eas-simulator`, the way the real command does; with `--json` it does
//   not, and prints the object the real command prints instead
//
// `simulator:exec`
// - STUB_SIM_EXEC_EXIT / STUB_SIM_STDERR: a verb the session refused
// - STUB_SIM_ALERT: what `alert get` answers. Unset is the controller's own empty answer — exit 1
//   and `Error (COMMAND_FAILED): alert not found` [observed — `agent-device@latest alert get`,
//   2026-08-27]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LOG_NAME = 'stub-eas-invocations.jsonl';
/** Where a finished `build` is remembered for `build:list`, under the cwd. */
const BUILDS_NAME = 'stub-eas-builds.json';
const args = process.argv.slice(2);
const cwd = process.cwd();

try {
  fs.appendFileSync(
    path.join(cwd, LOG_NAME),
    JSON.stringify({ args, cwd, ci: process.env.CI ?? null }) + '\n'
  );
} catch {
  // A log that cannot be written costs the assertion, not the run under test.
}

const command = args[0];
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const exitWith = (stream, text, code) => {
  stream.write(text.endsWith('\n') ? text : text + '\n');
  process.exit(code);
};
const printJson = (value) => process.stdout.write(JSON.stringify(value) + '\n');

if (process.env.STUB_EAS_CRASH === '1' || process.env.STUB_SIM_CRASH === '1') {
  // What a shim, a stale link, or a binary from another project looks like: a crash with no Expo
  // vocabulary anywhere in it.
  process.stderr.write("thread 'main' panicked at src/main.rs:12:9\nStack backtrace:\n");
  process.exit(101);
}

// ---- The account --------------------------------------------------------------------------------

if (command === 'whoami') {
  const exitCode = Number(process.env.STUB_EAS_WHOAMI_EXIT || 0);
  if (exitCode !== 0) {
    exitWith(process.stderr, 'Not logged in', exitCode);
  }
  exitWith(process.stdout, process.env.STUB_EAS_USER || 'e2e-user', 0);
}

// ---- EAS Build ----------------------------------------------------------------------------------

if (command === 'build:configure') {
  const exitCode = Number(process.env.STUB_EAS_CONFIGURE_EXIT || 0);
  if (exitCode !== 0) {
    exitWith(process.stderr, 'build:configure failed', exitCode);
  }
  const easJson = path.join(cwd, 'eas.json');
  if (!fs.existsSync(easJson)) {
    // Exactly the profiles the real command writes [observed — eas-cli 23.2 `build/configure.ts`
    // EAS_JSON_DEFAULT] — and so **no** simulator dev-client profile: `development` is a device
    // build, and adding the simulator one is `dev --eas`'s own act (`src/utils/easJson.ts`).
    fs.writeFileSync(
      easJson,
      JSON.stringify(
        {
          cli: { version: '>= 23.0.0', appVersionSource: 'remote' },
          build: {
            development: { developmentClient: true, distribution: 'internal' },
            preview: { distribution: 'internal' },
            production: { autoIncrement: true },
          },
          submit: { production: {} },
        },
        null,
        2
      ) + '\n'
    );
  }
  exitWith(process.stdout, 'eas.json written', 0);
}

/** One finished build in the `BuildFragment` shape, for the platform and profile of the argv. */
function stubBuild() {
  const platform = valueOf('--platform') || valueOf('-p') || 'ios';
  const id = process.env.STUB_EAS_BUILD_ID || 'build-e2e';
  return {
    id,
    status: 'FINISHED',
    platform: platform.toUpperCase(),
    buildProfile: valueOf('--profile') || valueOf('-e') || 'development',
    createdAt: '2026-09-01T10:00:00.000Z',
    artifacts: {
      applicationArchiveUrl: `https://expo.dev/artifacts/eas/${id}.tar.gz`,
      buildUrl: `https://expo.dev/accounts/e2e-user/projects/e2e/builds/${id}`,
    },
  };
}

if (command === 'build') {
  if (process.env.STUB_EAS_BUILD_STDERR) {
    process.stderr.write(process.env.STUB_EAS_BUILD_STDERR + '\n');
  }
  const exitCode = Number(process.env.STUB_EAS_BUILD_EXIT || 0);
  if (exitCode !== 0) {
    process.stdout.write('Build failed\n');
    process.exit(exitCode);
  }
  const build = stubBuild();
  // Remembered, newest first, so `build:list` answers about it the way the service would.
  let remembered = [];
  try {
    remembered = JSON.parse(fs.readFileSync(path.join(cwd, BUILDS_NAME), 'utf8'));
  } catch {
    remembered = [];
  }
  fs.writeFileSync(path.join(cwd, BUILDS_NAME), JSON.stringify([build, ...remembered]));
  if (has('--json')) {
    // `--json` puts the progress on stderr and one array on stdout [observed — eas-cli 23.2
    // `runBuildAndSubmit.ts`, `printJsonOnlyOutput(builds)` after the wait].
    process.stderr.write('Build finished\n');
    printJson([build]);
    process.exit(0);
  }
  process.stdout.write(`Build finished\n\n🍎 iOS app:\n${build.artifacts.applicationArchiveUrl}\n`);
  process.exit(0);
}

if (command === 'build:list') {
  const exitCode = Number(process.env.STUB_EAS_BUILD_LIST_EXIT || 0);
  if (exitCode !== 0) {
    // The explanation goes to stdout and one summary line to stderr — the real CLI's own order
    // [observed — live against an unlinked project, 2026-08-26].
    process.stdout.write((process.env.STUB_EAS_BUILD_LIST_STDOUT || 'refused') + '\n');
    exitWith(process.stderr, '    Error: build:list command failed.', exitCode);
  }
  if (process.env.STUB_EAS_BUILD_LIST) {
    exitWith(process.stdout, process.env.STUB_EAS_BUILD_LIST, 0);
  }
  let builds = [];
  try {
    builds = JSON.parse(process.env.STUB_EAS_BUILDS || '[]');
  } catch {
    builds = [];
  }
  try {
    builds = [...JSON.parse(fs.readFileSync(path.join(cwd, BUILDS_NAME), 'utf8')), ...builds];
  } catch {
    // No build was made under this cwd.
  }
  const platform = valueOf('--platform');
  const status = valueOf('--status');
  const fingerprint = valueOf('--fingerprint-hash');
  const profile = valueOf('--build-profile') || valueOf('--profile');
  const limit = Number(valueOf('--limit') || builds.length || 0);
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const listed = builds.filter(
    (build) =>
      (!platform || same(build.platform, platform)) &&
      (!status || same(build.status, status)) &&
      (!fingerprint || build.fingerprintHash === fingerprint) &&
      (!profile || build.buildProfile === profile)
  );
  printJson(limit > 0 ? listed.slice(0, limit) : listed);
  process.exit(0);
}

// ---- EAS Simulator ------------------------------------------------------------------------------

/** The session `simulator:list` and `simulator:get` describe. */
function stubSession() {
  return {
    id: process.env.STUB_SIM_ID || 'sess-e2e',
    name: 'e2e session',
    type: process.env.STUB_SIM_TYPE || 'agent-device',
    status: process.env.STUB_SIM_STATUS || 'IN_PROGRESS',
    platform: process.env.STUB_SIM_PLATFORM || 'IOS',
    createdAt: '2026-08-26T10:00:00.000Z',
  };
}

/** What the real command writes into `.env.eas-simulator` for an agent-device session. */
function writeSessionEnv(sessionId) {
  fs.writeFileSync(
    path.join(cwd, '.env.eas-simulator'),
    [
      '# Do not commit this file.',
      '# Do not modify these values manually. They are managed by eas-cli.',
      '# It holds configuration only for the current simulator session.',
      '',
      'AGENT_DEVICE_DAEMON_BASE_URL=https://stub-daemon.example',
      'AGENT_DEVICE_DAEMON_AUTH_TOKEN=stub-token',
      `EAS_SIMULATOR_SESSION_ID=${sessionId}`,
      '',
    ].join('\n')
  );
}

if (command === 'simulator:availability') {
  const available = process.env.STUB_SIM_AVAILABLE !== 'false';
  printJson({
    available,
    accountName: process.env.STUB_EAS_USER || 'e2e-user',
    ...(available ? {} : { waitlistUrl: 'https://expo.dev/services/simulators' }),
  });
  process.exit(0);
}

if (command === 'simulator:list') {
  const exitCode = Number(process.env.STUB_SIM_GET_EXIT || 0);
  if (exitCode !== 0) {
    exitWith(process.stderr, process.env.STUB_SIM_STDERR || 'Session not found', exitCode);
  }
  const sessions = process.env.STUB_SIM_SESSIONS === '0' ? [] : [stubSession()];
  printJson({ sessions, pageInfo: { hasNextPage: false } });
  process.exit(0);
}

if (command === 'simulator:get') {
  const exitCode = Number(process.env.STUB_SIM_GET_EXIT || 0);
  if (exitCode !== 0) {
    exitWith(process.stderr, process.env.STUB_SIM_STDERR || 'Session not found', exitCode);
  }
  const session = stubSession();
  printJson({
    ...session,
    remoteConfig: {
      __typename: 'AgentDeviceRunSessionRemoteConfig',
      agentDeviceRemoteSessionUrl: 'https://stub-daemon.example',
      agentDeviceRemoteSessionToken: 'stub-token',
    },
  });
  process.exit(0);
}

if (command === 'simulator' || command === 'simulator:start') {
  const exitCode = Number(process.env.STUB_SIM_START_EXIT || 0);
  const id = process.env.STUB_SIM_START_ID || 'sess-e2e-started';
  if (exitCode !== 0) {
    // The session is created before the wait for readiness, so a start that fails still names the
    // id it billed [observed — expo-ci, 2026-09-06].
    process.stderr.write(`Simulator session created (id: ${id})\n`);
    exitWith(
      process.stderr,
      process.env.STUB_SIM_START_STDERR ||
        `Timed out after 600s waiting for agent-device session to be ready.`,
      exitCode
    );
  }
  const json = has('--json');
  if (!json) {
    // `--json` suppresses the dotenv write [observed — eas-cli 23.2 `simulator/index.ts`].
    writeSessionEnv(id);
  }
  process.stderr.write(`Simulator session created (id: ${id}) https://expo.dev/accounts/e2e-user/projects/e2e/simulator-sessions/${id}\n`);
  if (json) {
    printJson({
      id,
      name: valueOf('--name') ?? null,
      type: valueOf('--type') || 'agent-device',
      deviceRunSessionUrl: `https://expo.dev/accounts/e2e-user/projects/e2e/simulator-sessions/${id}`,
      remoteConfig: {
        __typename: 'AgentDeviceRunSessionRemoteConfig',
        agentDeviceRemoteSessionUrl: 'https://stub-daemon.example',
        agentDeviceRemoteSessionToken: 'stub-token',
      },
    });
  } else {
    process.stdout.write(`When you are done, stop the session with: eas simulator:stop --id ${id}\n`);
  }
  process.exit(0);
}

if (command === 'simulator:stop') {
  exitWith(process.stdout, 'Simulator session stopped', 0);
}

if (command === 'simulator:exec') {
  const exitCode = Number(process.env.STUB_SIM_EXEC_EXIT || 0);
  if (exitCode !== 0) {
    exitWith(process.stderr, process.env.STUB_SIM_STDERR || 'Remote daemon is unavailable', exitCode);
  }
  // What the real controller answers a `close`, verbatim, whatever id it is given [observed — live
  // session 01a03d80, 2026-08-26]. It is the reason `wasRunning` is null on this backend, so the
  // stub has to say it rather than something more convenient.
  if (has('close')) {
    printJson({ success: true, data: { session: 'default', message: 'Closed: default' } });
    process.exit(0);
  }
  // The alert verbs. `get` on a device with nothing on screen is a **refusal**, verbatim, which is
  // what makes it safe to ask speculatively: the read costs a non-zero exit rather than an action.
  if (has('alert')) {
    if (args[args.length - 1] === 'get') {
      if (!process.env.STUB_SIM_ALERT) {
        exitWith(process.stderr, 'Error (COMMAND_FAILED): alert not found', 1);
      }
      exitWith(process.stdout, process.env.STUB_SIM_ALERT, 0);
    }
    printJson({ success: true, data: { message: 'Accepted' } });
    process.exit(0);
  }
  if (has('install-from-source') || has('install')) {
    printJson({ success: true, data: { message: 'Installed' } });
    process.exit(0);
  }
  exitWith(process.stdout, 'opened', 0);
}

exitWith(process.stderr, 'stub eas: unhandled command ' + args.join(' '), 1);
