// @ref llp/0015-backend-selection-and-config.rfc.md §Running an `eas` step
//
// `plan-test.ts` covers which plan each backend produces, and `dev-test.ts` covers what runs when
// the plan is the local one. This file is the other half of that pair: what actually runs when the
// plan chose the cloud. The two routes are the same command with different steps, so the questions
// are the same questions — the order of the invocations, the stop on a failing step, whether a
// build was recorded — asked of the CLI on the other side of the boundary.
//
// Nothing here reaches EAS. The `eas` on `PATH` is a stub bin that records every invocation, the
// same way the fixtures' `expo` bin does.
import fs from 'node:fs';
import path from 'node:path';

import {
  installStubEasAsync,
  readStubEasInvocations,
  stubEasArgs as easInvocationArgs,
} from '../stubEas';
import {
  executeAgentCliAsync,
  spawnAgentCli,
  collectOutput,
  waitForExitAsync,
  killAsync,
  installStubFingerprintAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  stubExpoEnv,
  waitForAsync,
} from '../utils';

/** The record `src/plan/lastBuild.ts` writes, relative to the project root. */
const LAST_BUILD_FILE = path.join('.expo', 'agent-cli-last-build.json');

/**
 * An `eas` that is not the EAS CLI: a wrapper that panics before it runs anything.
 *
 * This is the shape `src/utils/wrapperCrash.ts` exists for — a shim, a stale link or a binary from
 * another project sitting under the name — and the bytes it prints are not EAS output at all.
 */
const STUB_EAS_WRAPPER_CRASH = `#!/usr/bin/env node
'use strict';
process.stderr.write("thread 'main' panicked at src/main.rs:41:9:\\n");
process.stderr.write('called \`Option::unwrap()\` on a \`None\` value\\n');
process.stderr.write('Stack backtrace:\\n   0: rust_begin_unwind\\n');
process.exit(101);
`;

/**
 * Copy a fixture and install every stub bin the cloud route may reach for.
 *
 * The `eas` is the shared `e2e/stubs/eas.js` — the `STUB_EAS_*` variables the tests below set are
 * documented at the top of it — behind a stub package runner. One place, because there is one rung:
 * a `node_modules/.bin/eas` beside it would exercise nothing (`src/utils/easCli.ts`).
 */
async function setupAsync(
  fixtureName = 'dev-client-app',
  { easScript }: { easScript?: string } = {}
): Promise<string> {
  const projectRoot = await setupFixtureAsync(fixtureName);
  await installStubFingerprintAsync(projectRoot);
  await installStubEasAsync(projectRoot, { script: easScript });
  return projectRoot;
}

/** The arguments of every recorded stub `expo` invocation, in the order they happened. */
function expoInvocationArgs(projectRoot: string): string[][] {
  return readStubExpoInvocations(projectRoot).map((invocation) => invocation.args);
}

/** Read the last-build record, or null when the run wrote none. */
function readLastBuildRecord(projectRoot: string): Record<string, string> | null {
  const filePath = path.join(projectRoot, LAST_BUILD_FILE);
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

/** Write the developer config into a copied fixture, at `package.json` › `expo` › `@expo/agent-cli`. */
async function writeAgentCliConfigAsync(projectRoot: string, config: unknown): Promise<void> {
  const file = path.join(projectRoot, 'package.json');
  const packageJson = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  packageJson.expo = { ...packageJson.expo, agentCli: config };
  await fs.promises.writeFile(file, JSON.stringify(packageJson, null, 2));
}

describe('@expo/agent-cli dev — the EAS route', () => {
  it('preserves malformed eas.json and stops before submitting a build', async () => {
    const projectRoot = await setupAsync();
    const file = path.join(projectRoot, 'eas.json');
    const contents = '{"build": {"production": {}}';
    await fs.promises.writeFile(file, contents);
    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--json'], {
      reject: false,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('EAS_JSON_INVALID');
    expect(result.stderr).toContain('Fix eas.json and retry');
    expect(await fs.promises.readFile(file, 'utf8')).toBe(contents);
    expect(easInvocationArgs(projectRoot).some((args) => args[0] === 'build')).toBe(false);
    expect(expoInvocationArgs(projectRoot).some((args) => args[0] === 'start')).toBe(false);
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §What the EAS route is made of
  // Three steps, two CLIs, one order. `dev-test.ts` asserts the same property of the local route
  // (`prebuild` then `run:ios`), and the reason it has to be asserted separately here is that the
  // steps cross a *different* process boundary: nothing in the local route spawns `eas`.
  it('runs build:configure, then the cloud build, then the dev server', async () => {
    const projectRoot = await setupAsync();

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas']);

    expect(result.exitCode).toBe(0);
    // @ref llp/0027-everything-on-eas.rfc.md — `--eas` puts the device on EAS too, so the build is
    // the simulator profile, and the finished build is named by one `build:list` so the session can
    // install it by id.
    expect(easInvocationArgs(projectRoot)).toEqual([
      ['build', '--platform', 'ios', '--profile', 'development-simulator'],
      [
        'build:list',
        '--platform',
        'ios',
        '--build-profile',
        'development-simulator',
        '--status',
        'finished',
        '--limit',
        '1',
        '--json',
        '--non-interactive',
      ],
    ]);
    // The dev server is the `expo` step that follows, because `eas build` starts none. It is
    // tunnelled, because the device is a machine on EAS that cannot reach this loopback.
    expect(expoInvocationArgs(projectRoot)).toEqual([
      ['config', '--json'],
      ['start', '--dev-client', '--tunnel'],
    ]);
  });

  // `eas build:configure` exists in the plan for exactly one reason: without an `eas.json` there is
  // no `development` profile for the build step to name. A project that has one does not get it.
  it('skips build:configure when the project already has an eas.json', async () => {
    const projectRoot = await setupAsync();
    await fs.promises.writeFile(
      path.join(projectRoot, 'eas.json'),
      JSON.stringify({ build: { development: { developmentClient: true } } }, null, 2)
    );

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas']);

    expect(result.exitCode).toBe(0);
    expect(easInvocationArgs(projectRoot).map((args) => args[0])).toEqual(['build', 'build:list']);
    expect(easInvocationArgs(projectRoot)[0]).toEqual([
      'build',
      '--platform',
      'ios',
      '--profile',
      'development-simulator',
    ]);
  });

  it('runs the android build for --android, and passes the platform through', async () => {
    const projectRoot = await setupAsync();

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--android', '--eas']);

    expect(result.exitCode).toBe(0);
    expect(easInvocationArgs(projectRoot)).toContainEqual([
      'build',
      '--platform',
      'android',
      '--profile',
      'development-simulator',
    ]);
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §What the EAS route is made of
  // `recordBuildOf` ignores `eas` steps, because the record answers "does the app *installed on a
  // device* match this project" and a cloud build ends with an artifact nothing installed. The
  // local route's own assertion is in `dev-test.ts` ("records the built fingerprint").
  it('records no build for a cloud build, which nothing installed', async () => {
    const projectRoot = await setupAsync();

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas']);

    expect(result.exitCode).toBe(0);
    expect(readLastBuildRecord(projectRoot)).toBeNull();
  });

  it('stops at a failing cloud build, forwards its exit code, and names the EAS CLI', async () => {
    const projectRoot = await setupAsync();

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas'], {
      env: { STUB_EAS_BUILD_EXIT: '3' },
      reject: false,
    });

    expect(result.exitCode).toBe(3);
    // The exit code is the EAS CLI's own, and the sentence that says so has to name the right CLI.
    expect(result.all).toContain(`the EAS CLI's own`);
    expect(result.all).not.toContain(`the Expo CLI's own`);
    // The dev server step depends on the build, so nothing after it ran.
    expect(expoInvocationArgs(projectRoot)).toEqual([['config', '--json']]);
  });

  // The configure step exists only for a build routed to EAS by *config* with the device kept
  // local: `--eas` puts the device on EAS too, and that plan writes the one profile it needs into
  // eas.json itself (llp/0027 §The build is a simulator build).
  it('stops at a failing build:configure without starting the build', async () => {
    const projectRoot = await setupAsync();
    await writeAgentCliConfigAsync(projectRoot, { buildBackend: 'eas' });

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios'], {
      env: { STUB_EAS_CONFIGURE_EXIT: '1' },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(easInvocationArgs(projectRoot)).toEqual([['build:configure']]);
  });

  // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol
  // The scenario llp/0015 names as the reason the classifier is told `tool: 'eas'`: "an `eas build`
  // that stopped for a login is a different scenario from an `expo start` that stopped for a
  // prompt". The code and the prose have to agree with that, because an agent reads both.
  it('exits 7 with the EAS login handoff when the cloud build cannot sign in', async () => {
    const projectRoot = await setupAsync();

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--json'], {
      env: {
        STUB_EAS_BUILD_EXIT: '1',
        STUB_EAS_BUILD_STDERR:
          'Either log in with "eas login" or set the EXPO_TOKEN environment variable to authenticate.',
      },
      reject: false,
    });

    expect(result.exitCode).toBe(7);
    const report = JSON.parse(result.stdout);
    expect(report.error.needsHuman).toMatchObject({
      scenario: 'eas-login',
      command: 'npx @expo/agent-cli login',
    });
    // The code is the scenario's, not the Expo CLI's prompt code: they are different stops with
    // different recoveries, and an agent that branches on the code has to be able to tell them
    // apart.
    expect(report.error.code).toBe('EAS_LOGIN_REQUIRED');
    // And the prose names the CLI that actually stopped.
    expect(report.error.message).toContain('EAS CLI');
    expect(report.error.message).not.toContain('the Expo CLI asks before');
  });

  it('exits 7 and names the EAS CLI when the cloud build asks a question', async () => {
    const projectRoot = await setupAsync();

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--json'], {
      env: {
        STUB_EAS_BUILD_EXIT: '1',
        STUB_EAS_BUILD_STDERR: 'Input is required, but is in non-interactive mode.',
      },
      reject: false,
    });

    expect(result.exitCode).toBe(7);
    const report = JSON.parse(result.stdout);
    expect(report.error.needsHuman.scenario).toBe('eas-prompt');
    expect(report.error.code).toBe('EAS_NEEDS_INPUT');
    expect(report.error.message).toContain('EAS CLI');
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §Running an `eas` step — the *throwing*
  // resolver: a plan that chose the cloud cannot do its job without the CLI. Since wave 18 the
  // ladder's third rung downloads the published one, so reaching this failure takes a `PATH` with
  // no package runner on it either — which is what the empty `.stub-bin` below is.
  it('refuses the run when neither an eas binary nor a package runner exists', async () => {
    const projectRoot = await setupFixtureAsync('dev-client-app');
    await installStubFingerprintAsync(projectRoot);

    const appFile = path.join(projectRoot, 'app.json');
    const app = JSON.parse(await fs.promises.readFile(appFile, 'utf8'));
    app.expo.extra = { eas: { projectId: 'f52a76f7-9fc7-4b59-becd-6d84e9f129d7' } };
    await fs.promises.writeFile(appFile, JSON.stringify(app));

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--json'], {
      // An empty PATH addition is not enough: the machine's own `eas` would be found. The resolver
      // takes the `PATH` it is given, and the runner puts the project's `.stub-bin` first, so a
      // project with no `eas` in either place is the case under test only when `PATH` has none.
      env: { PATH: path.join(projectRoot, '.stub-bin') },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.error.code).toBe('EAS_CLI_MISSING');
    expect(report.error.message).toContain('no package runner');
    expect(report.error.suggestedCommand).toBe('npm install --save-dev eas-cli');
  });

  // @ref llp/0001-agentic-cli-on-expo-cli.rfc.md §Constraints — the thing on the other side of the
  // spawn is whatever the machine has under that name. Quoting a wrapper's panic under "What the
  // tool printed" tells the reader the EAS CLI said it, and an agent then acts on that.
  it('names a binary that was never the EAS CLI rather than quoting its crash', async () => {
    const projectRoot = await setupAsync('dev-client-app', {
      easScript: STUB_EAS_WRAPPER_CRASH,
    });

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--json'], {
      reject: false,
    });

    expect(result.exitCode).toBe(101);
    const report = JSON.parse(result.stdout);
    expect(report.error.message).toContain('may not be the real CLI');
    expect(report.error.message).not.toContain('rust_begin_unwind');
  });

  it('prints exactly one JSON object for a cloud run that succeeded', async () => {
    const projectRoot = await setupAsync();

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--json']);

    expect(result.exitCode).toBe(0);
    // The report is the plan itself, exactly as the local route's own `--json` run prints it.
    const report = JSON.parse(result.stdout);
    // `runsOn` answers "where does this step build", so only the build step says `eas`:
    // `build:configure` writes a file on this machine and the dev server runs here too.
    expect(
      report.steps.map((step: { id: string; runsOn: string | null }) => [step.id, step.runsOn])
    ).toEqual([
      ['eas-build', 'eas'],
      ['start', null],
    ]);
    expect(report.buildLocation).toMatchObject({
      runsOn: 'eas',
      platform: 'ios',
      selection: { runsOn: 'eas', source: 'flag' },
    });
    expect(result.stdout).not.toContain('stub_expo_start');
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §Where the config lives — the per-platform override
  // exists because the case is real: iOS in the cloud where the credentials live, Android on this
  // machine where the SDK is. `plan-test.ts` pins the plan; this pins the run that follows it.
  it('follows a per-platform config into the cloud for that platform only', async () => {
    const projectRoot = await setupAsync();
    await writeAgentCliConfigAsync(projectRoot, { ios: { buildBackend: 'eas' } });

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios']);

    expect(result.exitCode).toBe(0);
    expect(easInvocationArgs(projectRoot)).toContainEqual([
      'build',
      '--platform',
      'ios',
      '--profile',
      'development',
    ]);
    // The local route's own build step is `expo run:ios`, and it is not what ran.
    expect(expoInvocationArgs(projectRoot)).toEqual([
      ['config', '--json'],
      ['start', '--dev-client'],
    ]);
  });

  it('tells the cloud build it is CI, the way every captured step is told', async () => {
    const projectRoot = await setupAsync();

    await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--json']);

    const log = readStubEasInvocations(projectRoot);
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((invocation) => invocation.ci === '1')).toBe(true);
  });
});

// @ref llp/0027-everything-on-eas.rfc.md
//
// `--eas` puts the *device* on EAS as well as the build. What crosses the process boundary here and
// nowhere else: the profile the `eas build` is asked for, the `eas.json` write that precedes it, the
// `build:list` that names the finished build, `--tunnel` on the dev server, and the `eas simulator`
// start with the app and the tunnelled URL on its command line — plus the reuse of a session that
// is up and of a build EAS already has.
describe('@expo/agent-cli dev --eas — the device on EAS', () => {
  /** How long the stub dev server stays up: long enough for the child's open to reach the stub eas. */
  const STUB_ALIVE_MS = '20000';
  const TUNNEL_HOST = 'abc.tunnel.example';

  /** A stub dev server that binds, advertises a tunnel, and stays up; and a stub eas with no session. */
  function easRunEnv(projectRoot: string, port: number): Record<string, string> {
    return {
      ...stubExpoEnv(projectRoot),
      STUB_EXPO_DEV_SERVER_PORT: String(port),
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DELAY_MS: STUB_ALIVE_MS,
      STUB_EXPO_TUNNEL_HOST: TUNNEL_HOST,
      STUB_EXPO_TUNNEL_DELAY_MS: '200',
      STUB_SIM_SESSIONS: '0',
    };
  }

  /** Stop whatever the test started, so a failed assertion never leaves a process behind. */
  async function cleanUpAsync(projectRoot: string): Promise<void> {
    await executeAgentCliAsync(projectRoot, ['dev:stop', '--json'], {
      env: stubExpoEnv(projectRoot),
      reject: false,
    });
  }

  /** Give the fixture a scheme, which a development build's launch URL is built from. */
  async function writeSchemeAsync(projectRoot: string, scheme: string): Promise<void> {
    const file = path.join(projectRoot, 'app.json');
    const appJson = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    appJson.expo.scheme = scheme;
    await fs.promises.writeFile(file, JSON.stringify(appJson, null, 2));
  }

  /** The recorded `eas` invocations, once one starting with `verb` has been recorded. */
  async function easInvocationsAfterAsync(projectRoot: string, verb: string): Promise<string[][]> {
    await waitForAsync(() => easInvocationArgs(projectRoot).some((args) => args[0] === verb), 15_000);
    return easInvocationArgs(projectRoot);
  }

  it('plans the simulator profile, the tunnel, and says the profile is added first', async () => {
    const projectRoot = await setupAsync();

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--plan', '--json']);

    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout);
    // No `build:configure`: `dev` writes the one profile the build needs into eas.json itself.
    expect(plan.steps.map((step: { argv: string[] }) => step.argv)).toEqual([
      ['eas', 'build', '--platform', 'ios', '--profile', 'development-simulator'],
      ['expo', 'start', '--dev-client', '--tunnel'],
    ]);
    expect(plan.reasons.join('\n')).toContain(
      'This project has no eas.json, so @expo/agent-cli writes one with the "development-simulator" profile'
    );
    expect(plan.steps[1].reason).toContain('EAS Simulator session is started with that build');
    // A plan runs nothing. The one thing it may ask EAS — whether a finished build of this
    // fingerprint exists — needs a per-platform fingerprint, and this fixture ships no fingerprint
    // tool, so nothing is asked (`src/plan/easBuildLookup.ts` answers null before spawning).
    expect(easInvocationArgs(projectRoot)).toEqual([]);
  });

  it('refuses --web and a host the session cannot reach, before anything runs', async () => {
    const projectRoot = await setupAsync();

    const web = await executeAgentCliAsync(projectRoot, ['dev', '--web', '--eas', '--json'], {
      reject: false,
    });
    expect(web.exitCode).toBe(1);
    expect(JSON.parse(web.stdout).error.message).toContain('--eas and --web');

    const lan = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--lan', '--json'], {
      reject: false,
    });
    expect(lan.exitCode).toBe(1);
    expect(JSON.parse(lan.stdout).error.suggestedCommand).toBe('npx @expo/agent-cli dev --ios --eas');
    expect(easInvocationArgs(projectRoot)).toEqual([]);
    expect(expoInvocationArgs(projectRoot)).toEqual([]);
  });

  it('builds the simulator profile, adds it to eas.json, names the build, and starts a session with it', async () => {
    const projectRoot = await setupAsync();
    await writeSchemeAsync(projectRoot, 'devclient');

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--eas', '--detach', '--wait-ready', '--json'],
        { env: easRunEnv(projectRoot, 8531) }
      );
      expect(result.exitCode).toBe(0);

      // The write this CLI does itself, right before `build`: the file did not exist, and no
      // `build:configure` ran — the profile this build needs is the whole of what is written.
      const easJson = JSON.parse(await fs.promises.readFile(path.join(projectRoot, 'eas.json'), 'utf8'));
      expect(easJson.build.development).toBeUndefined();
      expect(easJson.build['development-simulator']).toEqual({
        developmentClient: true,
        distribution: 'internal',
        ios: { simulator: true },
      });

      const invocations = await easInvocationsAfterAsync(projectRoot, 'simulator');
      expect(invocations.map((args) => args[0])).not.toContain('build:configure');
      expect(invocations).toContainEqual([
        'build',
        '--platform',
        'ios',
        '--profile',
        'development-simulator',
      ]);
      // The build that just finished, named by asking EAS for the newest finished one of its profile.
      expect(invocations).toContainEqual([
        'build:list',
        '--platform',
        'ios',
        '--build-profile',
        'development-simulator',
        '--status',
        'finished',
        '--limit',
        '1',
        '--json',
        '--non-interactive',
      ]);
      // The session, with the build and the tunnelled launch URL on its command line.
      const start = invocations.find((args) => args[0] === 'simulator')!;
      expect(start.slice(0, 7)).toEqual([
        'simulator',
        '--platform',
        'ios',
        '--type',
        'agent-device',
        '--build-id',
        'build-e2e',
      ]);
      expect(start[start.indexOf('--open-url') + 1]).toBe(
        `devclient://expo-development-client/?url=${encodeURIComponent(`https://${TUNNEL_HOST}`)}`
      );
      expect(start).toContain('--non-interactive');
      // The dev server was tunnelled, which is what makes that URL reachable.
      expect(expoInvocationArgs(projectRoot)).toContainEqual(['start', '--dev-client', '--tunnel']);
      // The stub wrote the dotenv the real command writes, so every later `--eas` finds the session.
      expect(
        await fs.promises.readFile(path.join(projectRoot, '.env.eas-simulator'), 'utf8')
      ).toContain('EAS_SIMULATOR_SESSION_ID=sess-e2e-started');
    } finally {
      await cleanUpAsync(projectRoot);
    }
  });

  it('cleans up its EAS session when the dev server exits normally', async () => {
    const projectRoot = await setupAsync('go-app');
    await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas'], {
      env: easRunEnv(projectRoot, 8589),
    });
    expect(easInvocationArgs(projectRoot)).toContainEqual([
      'simulator:stop', '--id', 'sess-e2e-started', '--non-interactive',
    ]);
  });

  it.skipIf(process.platform === 'win32').each(['ready', 'starting', 'reused', 'failed'] as const)(
    'SIGINT cleans up an owned session (%s)', async (state) => {
      const script = await fs.promises.readFile(path.join(__dirname, '../stubs/eas.js'), 'utf8');
      const projectRoot = await setupAsync('go-app', { easScript: state === 'starting'
        ? script.replace("const exitCode = Number(process.env.STUB_SIM_START_EXIT || 0);",
            "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); const exitCode = 0;")
        : script });
      const child = spawnAgentCli(projectRoot, ['dev', '--ios', '--eas'], {
        env: { ...easRunEnv(projectRoot, 8588), STUB_SIM_SESSIONS: state === 'reused' ? '1' : '0', STUB_SIM_START_EXIT: state === 'failed' ? '1' : '0' },
      });
      const output = collectOutput(child);
      const exited = waitForExitAsync(child, output);
      try {
        expect(await waitForAsync(() => state === 'starting'
          ? easInvocationArgs(projectRoot).some((args) => args[0] === 'simulator')
          : output.stderr.includes(state === 'failed' ? 'The app was not opened on an EAS Simulator session' : 'Opened the app on EAS Simulator session'), 10000)).toBe(true);
        child.kill('SIGINT');
        await exited;
        const stops = easInvocationArgs(projectRoot).filter((args) => args[0] === 'simulator:stop');
        expect(stops).toEqual(state === 'reused' ? [] : [
          ['simulator:stop', '--id', 'sess-e2e-started', '--non-interactive'],
        ]);
      } finally {
        await killAsync(child);
      }
    }
  );

  it('starts a session running Expo Go for a project Expo Go can run, and builds nothing', async () => {
    const projectRoot = await setupAsync('go-app');

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--eas', '--detach', '--wait-ready', '--json'],
        { env: easRunEnv(projectRoot, 8532) }
      );
      expect(result.exitCode).toBe(0);

      const invocations = await easInvocationsAfterAsync(projectRoot, 'simulator');
      expect(invocations.map((args) => args[0])).not.toContain('build');
      const start = invocations.find((args) => args[0] === 'simulator')!;
      expect(start).toContain('--expo-go');
      expect(start[start.indexOf('--open-url') + 1]).toBe(`exp://${TUNNEL_HOST}`);
      expect(expoInvocationArgs(projectRoot)).toContainEqual(['start', '--go', '--tunnel']);
    } finally {
      await cleanUpAsync(projectRoot);
    }
  });

  it('reuses the session this project already has, and opens the app on it instead of starting one', async () => {
    const projectRoot = await setupAsync('go-app');

    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--eas', '--detach', '--wait-ready', '--json'],
        // The stub's default session: `sess-e2e`, iOS, in progress.
        { env: { ...easRunEnv(projectRoot, 8533), STUB_SIM_SESSIONS: '1' } }
      );
      expect(result.exitCode).toBe(0);

      const invocations = await easInvocationsAfterAsync(projectRoot, 'simulator:exec');
      expect(invocations.map((args) => args[0])).not.toContain('simulator');
      const open = invocations.find((args) => args[0] === 'simulator:exec')!;
      expect(open.slice(0, 4)).toEqual(['simulator:exec', 'npx', 'agent-device@latest', 'open']);
      expect(open[4]).toMatch(new RegExp(`^exp://${TUNNEL_HOST.replace(/\./g, '\\.')}/--/\\??$`));
    } finally {
      await cleanUpAsync(projectRoot);
    }
  });

  it('rests on a finished EAS build of this fingerprint and skips the build', async () => {
    const projectRoot = await setupAsync('dev-client-fresh-app');
    const hash = 'feedfacefeedfacefeedfacefeedfacefeedface';

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--plan', '--json'], {
      env: {
        // A fingerprint that no longer matches the recorded local build, so the plan would build…
        STUB_FINGERPRINT_HASH: hash,
        // …except that EAS has a finished simulator build of exactly it.
        STUB_EAS_BUILDS: JSON.stringify([
          {
            id: 'build-reuse',
            platform: 'IOS',
            status: 'FINISHED',
            fingerprintHash: hash,
            buildProfile: 'development-simulator',
          },
        ]),
      },
    });

    expect(result.exitCode).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.rule).toBe('dev-client-fresh');
    expect(plan.easBuild).toEqual({ id: 'build-reuse', profile: 'development-simulator' });
    expect(plan.steps.map((step: { argv: string[] }) => step.argv)).toEqual([
      ['expo', 'start', '--dev-client', '--tunnel'],
    ]);
    expect(plan.reasons).toContain(
      'EAS already has a finished "development-simulator" build for this fingerprint (build-reuse), so nothing is built: the EAS Simulator session installs that build.'
    );
    // The lookup that found it, narrowed to the one kind of build a session can install.
    expect(easInvocationArgs(projectRoot)).toContainEqual([
      'build:list',
      '--platform',
      'ios',
      '--fingerprint-hash',
      hash,
      '--status',
      'finished',
      '--build-profile',
      'development-simulator',
      '--limit',
      '1',
      '--json',
      '--non-interactive',
    ]);
  });

  it('builds when EAS has a finished build of another fingerprint only', async () => {
    const projectRoot = await setupAsync('dev-client-fresh-app');

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--plan', '--json'], {
      env: {
        STUB_FINGERPRINT_HASH: 'feedfacefeedfacefeedfacefeedfacefeedface',
        STUB_EAS_BUILDS: JSON.stringify([
          {
            id: 'build-old',
            platform: 'IOS',
            status: 'FINISHED',
            fingerprintHash: 'other',
            buildProfile: 'development-simulator',
          },
        ]),
      },
    });

    const plan = JSON.parse(result.stdout);
    expect(plan.easBuild).toBeUndefined();
    expect(plan.steps.map((step: { argv: string[] }) => step.argv[1])).toContain('build');
  });
});

// @ref llp/0027-everything-on-eas.rfc.md §What EAS said
describe('@expo/agent-cli dev --eas on a project EAS does not know', () => {
  it('names eas init as the fix when the cloud build stops on an unlinked project', async () => {
    const projectRoot = await setupAsync();

    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--json'], {
      env: {
        STUB_EAS_BUILD_EXIT: '1',
        STUB_EAS_BUILD_STDERR: [
          'EAS project not configured. This command cannot configure it in non-interactive mode. Run one of the following, then re-run this command:',
          '  eas init --account <account-name> --non-interactive',
          'Accounts you can create projects in: e2e-user',
        ].join('\n'),
      },
      reject: false,
    });

    // A person's decision — which account — so the handoff band, with its own scenario rather than
    // the generic prompt one that used to answer for it (exit 7 telling the caller to answer a
    // question in a terminal).
    expect(result.exitCode).toBe(7);
    const report = JSON.parse(result.stdout);
    expect(report.error.code).toBe('EAS_PROJECT_NOT_LINKED');
    expect(report.error.needsHuman).toMatchObject({
      scenario: 'eas-project-unlinked',
      command: 'npx --yes eas-cli@latest init --account e2e-user --non-interactive',
    });
    expect(report.error.message).toContain('not linked to an EAS project');
    expect(report.error.message).not.toContain('needed an answer');
    // The fix, not the command that just failed.
    expect(report.error.suggestedCommand).toBe('npx --yes eas-cli@latest init --account e2e-user --non-interactive');
    expect(expoInvocationArgs(projectRoot)).toEqual([['config', '--json']]);
  });
});
