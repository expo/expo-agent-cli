// @ref llp/0004-smart-start-and-project-state.rfc.md §Plan contract
//
// `@expo/agent-cli dev` emits the plan and then runs its steps as subprocesses. `plan-test.ts` covers
// which plan each fixture state produces; this file covers what actually runs: the order of the
// `expo` invocations, the stop on the first failing step, and the build record written after a
// successful native build.
import fs from 'node:fs';
import path from 'node:path';

import {
  executeAgentCliAsync,
  installStubBinAsync,
  installStubFingerprintAsync,
  killAsync,
  readDevLockAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  spawnAgentCli,
  waitForAsync,
  waitForDevLockAsync,
} from '../utils';

/** The record `src/plan/lastBuild.ts` writes, relative to the project root. */
const LAST_BUILD_FILE = path.join('.expo', 'agent-cli-last-build.json');

/** The hash the stub `@expo/fingerprint` bin of `dev-client-fresh-app` prints by default. */
const RECORDED_HASH = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';

/** A hash no build was made from, so the fixture reads as stale and gets rebuilt. */
const CHANGED_HASH = 'b1c2d3e4f5061728394a5b6c7d8e9f0011223344';

/** Copy a fixture and install both stub bins a plan may reach for. */
async function setupAsync(fixtureName: string): Promise<string> {
  const projectRoot = await setupFixtureAsync(fixtureName);
  await installStubFingerprintAsync(projectRoot);
  return projectRoot;
}

/** The arguments of every recorded stub `expo` invocation, in the order they happened. */
function invocationArgs(projectRoot: string): string[][] {
  return readStubExpoInvocations(projectRoot).map((invocation) => invocation.args);
}

/** Read the last-build record, or null when the run wrote none. */
function readLastBuildRecord(projectRoot: string): Record<string, string> | null {
  const filePath = path.join(projectRoot, LAST_BUILD_FILE);
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

describe('@expo/agent-cli dev', () => {
  it('documents the plan flags in `dev:run --help`', async () => {
    const projectRoot = await setupAsync('go-app');
    const result = await executeAgentCliAsync(projectRoot, ['dev:run', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('--plan');
    expect(result.all).toContain('--detach');
    // The plain `expo start` wrapper is a command of its own now, and is named here.
    expect(result.all).toContain('npx @expo/agent-cli start');
  });

  // `dev` became a group so `dev:stop` and `dev:logs` could join it, and a group asked for help lists its actions
  // (llp/0010 §Registry rules). Because the bare name runs `dev:run`, the listing is followed by
  // that action's options: a caller reading `dev --help` before running `dev` has to be able to
  // learn that `--plan` exists.
  it('lists the actions of the group for `dev --help`, then the default action’s options', async () => {
    const projectRoot = await setupAsync('go-app');
    const result = await executeAgentCliAsync(projectRoot, ['dev', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('dev:run');
    expect(result.all).toContain('dev:logs');
    expect(result.all).toContain('npx @expo/agent-cli dev runs dev:run');
    // The options of the action the bare name runs, in the listing's own output.
    expect(result.all).toContain('--plan');
    expect(result.all).toContain('--port');
    // The listing comes first: the options belong to the action it just named.
    expect(result.all.indexOf('dev:logs')).toBeLessThan(result.all.indexOf('--plan'));
  });

  it('does not accept the flags that moved off `start`', async () => {
    // `--smart` and `--passthrough` are gone: this command is the plan engine, and `expo start`
    // rejects the flags it does not know, from the step the plan ends with.
    const projectRoot = await setupAsync('go-app');
    const result = await executeAgentCliAsync(projectRoot, ['dev:run', '--help']);

    expect(result.all).not.toContain('--smart');
    expect(result.all).not.toContain('--passthrough');
  });

  // @ref llp/0008-guardrails.rfc.md §The plan is announced, not negotiated
  it('runs a plan that builds, with no terminal watching it go by', async () => {
    // Every caller gets the plan and its execution. There used to be a stop here for a person
    // watching a terminal — a question before wave 41, a `Nothing ran` re-run hint after it — and
    // neither survives: `dev` runs the plan it printed, and `--plan` is the run that stops. No e2e
    // could reach the interactive branch anyway (`spawnAgentCli` closes stdin, pipes stdout and
    // sets `CI=1`), so the terminal half is pinned in `src/dev/__tests__/devAsync-test.ts`.
    const projectRoot = await setupAsync('dev-client-app');
    const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local']);

    expect(result.all).not.toContain('Run this plan?');
    expect(result.all).not.toContain('Nothing ran');
    // Not merely un-asked: the plan it printed is the plan it ran.
    expect(invocationArgs(projectRoot)).toEqual([['prebuild', '--platform', 'ios'], ['run:ios']]);
  });

  describe('dev-client-app — a plan of two steps', () => {
    it('runs prebuild and the native build, in that order', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local']);

      expect(result.exitCode).toBe(0);
      expect(invocationArgs(projectRoot)).toEqual([['prebuild', '--platform', 'ios'], ['run:ios']]);
    });

    // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol
    // `CI=1` makes the Expo CLI's prompts fail fast *and* turns Metro's file watcher off, and only
    // the first was ever wanted. A dev server with no watcher serves the code it read at start-up
    // forever, so `dev:wait` certified a project the caller had already broken [observed —
    // friction run 2, 2026-08-23]. The prompts still fail fast because the other half is the pipe:
    // the CLI's `isInteractive()` also requires a TTY on stdout, and a captured child never has one.
    it('tells prebuild it is CI, and leaves the dev-server step alone', async () => {
      const projectRoot = await setupAsync('dev-client-app');

      // `CI` unset for this run only, so what the wrapper sets is told apart from what it inherits.
      await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local'], {
        env: { CI: undefined },
      });

      const [prebuild, run] = readStubExpoInvocations(projectRoot);
      expect(prebuild!.args).toEqual(['prebuild', '--platform', 'ios']);
      expect(prebuild!.ci).toBe('1');
      expect(run!.args).toEqual(['run:ios']);
      // Nothing set, rather than `CI=0`: a machine whose own environment says CI keeps saying it.
      expect(run!.ci).toBeNull();
      // Both steps are non-interactive whatever `CI` says, because neither owns a terminal.
      expect(prebuild!.isTTY).toBe(false);
      expect(run!.isTTY).toBe(false);
    });

    it('emits the plan before the first step runs', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local']);

      // The stub `expo` bin announces itself on stdout, and the plan shares that stream, so the
      // plan-first contract is observable in the output order.
      const planAt = result.stdout.indexOf('Smart start plan');
      const firstStepAt = result.stdout.indexOf('stub_expo_start');
      expect(planAt).toBeGreaterThanOrEqual(0);
      expect(firstStepAt).toBeGreaterThan(planAt);
    });

    it('stops at the first failing step and forwards its exit code', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local'], {
        env: { STUB_EXPO_EXIT_CODE: '3' },
        reject: false,
      });

      expect(result.exitCode).toBe(3);
      // The native build depends on the prebuild, so it never runs.
      expect(invocationArgs(projectRoot)).toEqual([['prebuild', '--platform', 'ios']]);
    });

    // @ref llp/0005-runtime-loop-tools.rfc.md §Pointing an app at this dev server
    // F120. A plan that ends in `expo run:ios` cannot forward `--port`, and this command says so
    // out loud — and then built the development build's connect URL out of the flag it had just
    // announced it was dropping. One run, two answers about the same port, twenty lines apart
    // [observed — wave 29, live, `wave29-devclient/evidence/05-dev-build-ios.log`: the warning
    // named `--port 8901` and the follow-up printed
    // `dcapp://expo-development-client/?url=http%3A%2F%2F192.168.1.233%3A8901`, while
    // `expo run:ios` was about to serve on 8081]. The URL is the follow-up an agent acts on, so
    // the wrong half is the dangerous half.
    it('names the port the plan will really serve on, not one it dropped', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'dev',
        '--ios',
        '--local',
        '--port',
        '8901',
      ]);

      // The flag reached nothing: the last step is `expo run:ios`, which this plan does not forward
      // to. That warning is correct and stays.
      expect(result.stderr).toContain('were not passed on: --port 8901');
      expect(readStubExpoInvocations(projectRoot).at(-1)!.args).not.toContain('--port');
      // So no line of the report may name 8901 as somewhere a device can reach this dev server.
      const connectLine = result.all
        .split('\n')
        .find((line) => line.includes('expo-development-client'));
      expect(connectLine).toBeDefined();
      expect(connectLine).not.toContain('8901');
      expect(connectLine).toContain('8081');
    });

    it('records no build when the fingerprint is unavailable', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local']);

      // This fixture ships no fingerprint CLI, so there is no hash to record the build against,
      // and an unrecorded build is planned again next time.
      expect(readLastBuildRecord(projectRoot)).toBeNull();
    });
  });

  describe('dev-client-fresh-app — a rebuild after the native surface changed', () => {
    it('records the built fingerprint, keeping the other platform', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local'], {
        env: { STUB_FINGERPRINT_HASH: CHANGED_HASH },
      });

      expect(result.exitCode).toBe(0);
      expect(invocationArgs(projectRoot)).toEqual([['prebuild', '--platform', 'ios'], ['run:ios']]);
      // Only the platform that was built is updated, and it is recorded in the v2 shape: the
      // whole fingerprint, so a later `@expo/agent-cli impact` can diff against it and say *what* changed
      // rather than only that something did (llp/0011 §The record has to hold the sources). The
      // other platform is rewritten in the v2 spelling with the same meaning it had: a bare
      // string said "only a hash was recorded", and `sources: null` says exactly that. Reading
      // normalizes, so one platform's write migrates the other's spelling and nothing else.
      expect(readLastBuildRecord(projectRoot)).toEqual({
        ios: { hash: CHANGED_HASH, sources: [] },
        android: { hash: RECORDED_HASH, sources: null },
      });
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
    // F121, end to end and in the order it bit: build, install, launch failure, then the next
    // plan. `expo run:*` is one subprocess doing all three, and the fifteen minutes it spends are
    // the compiler's — so a plan that runs it a second time because the *launch* failed is the
    // whole cost of this bug [observed — wave 29, `evidence/08-plan-after-successful-build.txt`].
    it('records the build when the launch after it failed, so the next plan skips it', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const env = { STUB_FINGERPRINT_HASH: CHANGED_HASH, STUB_EXPO_RUN_LAUNCH_FAILS: '1' };

      const built = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local'], {
        env,
        reject: false,
      });

      // The launch failure is still reported as one: the exit code is the Expo CLI's own, and the
      // build being kept does not make a failed step a success.
      expect(built.exitCode).toBe(1);
      expect(invocationArgs(projectRoot)).toEqual([['prebuild', '--platform', 'ios'], ['run:ios']]);
      expect(readLastBuildRecord(projectRoot)).toMatchObject({
        ios: { hash: CHANGED_HASH },
      });

      const next = await executeAgentCliAsync(projectRoot, ['dev', '--plan', '--ios', '--json'], {
        env,
      });
      expect(next.exitCode).toBe(0);
      const plan = JSON.parse(next.stdout);
      // The whole point: one step, and it is the dev server.
      expect(plan.steps.map((step: { argv: string[] }) => step.argv)).toEqual([
        ['expo', 'start', '--dev-client'],
      ]);
    });

    it('runs only the dev server when the recorded build still matches', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local']);

      expect(result.exitCode).toBe(0);
      // No platform flag at all: the open is this command's own act now (llp/0026).
      expect(invocationArgs(projectRoot)).toEqual([['start', '--dev-client']]);
      // Nothing was built, so the record is untouched.
      expect(readLastBuildRecord(projectRoot)).toEqual({
        ios: RECORDED_HASH,
        android: RECORDED_HASH,
      });
    });
  });

  // The loop the fingerprint record exists for [asked — Kudo, 2026-09-05]: after one recorded
  // build, `dev` knows whether the project needs a prebuild or a build, and starts the fastest way
  // that is still correct. The stub fingerprint hashes the app config and package.json here
  // (`STUB_FINGERPRINT_HASH_FROM_PROJECT`), so editing those files moves the fingerprint the way a
  // real hasher would — the chain under test is edit → new hash → record no longer matches → the
  // plan builds again.
  describe('the plan after the project changes', () => {
    const HASH_FROM_PROJECT = { STUB_FINGERPRINT_HASH_FROM_PROJECT: '1' };

    /** Build once, so the record matches the project exactly as it is on disk now. */
    async function recordedProjectAsync(): Promise<string> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const built = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local'], {
        env: HASH_FROM_PROJECT,
      });
      expect(built.exitCode).toBe(0);
      return projectRoot;
    }

    /**
     * The steps `dev --plan` would run, as argv lists.
     *
     * `--local` pins the backend: on a CI box with no Xcode the selector would route the rebuild
     * to EAS, and these tests are about *when* a build is planned, not where it runs.
     */
    async function planStepsAsync(projectRoot: string): Promise<string[][]> {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--plan', '--ios', '--local', '--json'],
        { env: HASH_FROM_PROJECT }
      );
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout).steps.map((step: { argv: string[] }) => step.argv);
    }

    it('starts the dev server and nothing else while nothing changed', async () => {
      const projectRoot = await recordedProjectAsync();

      expect(await planStepsAsync(projectRoot)).toEqual([['expo', 'start', '--dev-client']]);
    });

    it('prebuilds and builds again after the app config changed, because the project is CNG', async () => {
      const projectRoot = await recordedProjectAsync();

      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.ios = { ...config.expo.ios, bundleIdentifier: 'com.example.changed' };
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));

      expect(await planStepsAsync(projectRoot)).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios'],
      ]);
    });

    it('builds again after a dependency changed the fingerprint', async () => {
      const projectRoot = await recordedProjectAsync();

      const packagePath = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(await fs.promises.readFile(packagePath, 'utf8'));
      packageJson.dependencies = { ...packageJson.dependencies, 'react-native-mmkv': '^3.0.0' };
      await fs.promises.writeFile(packagePath, JSON.stringify(packageJson, null, 2));

      expect(await planStepsAsync(projectRoot)).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios'],
      ]);
    });

    it('builds without a prebuild on a bare project, whose native directories are checked in', async () => {
      const projectRoot = await recordedProjectAsync();
      await fs.promises.mkdir(path.join(projectRoot, 'ios'), { recursive: true });
      await fs.promises.writeFile(
        path.join(projectRoot, 'ios', 'Podfile'),
        "platform :ios, '15.1'\n"
      );

      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.ios = { ...config.expo.ios, bundleIdentifier: 'com.example.changed' };
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));

      expect(await planStepsAsync(projectRoot)).toEqual([['expo', 'run:ios']]);
    });
  });

  // @ref llp/0010-agent-conventions.rfc.md §The `--json` error envelope, §Needs-human protocol
  // `@expo/agent-cli dev` is the documented non-interactive entry point. On a busy port it started
  // nothing, appended the subprocess log to its own JSON, exited 1, and told its caller to open a
  // dev server it had not started [observed — friction run, 2026-08-23].
  describe('a run with no terminal', () => {
    /**
     * The non-interactive stop of the Expo CLI, verbatim, on a question only a person can answer.
     *
     * Deliberately not the port question any more: that one is recognised and retried before the
     * needs-human classifier sees it (F41), and it has tests of its own below.
     */
    const NEEDS_INPUT =
      "Input is required, but 'npx expo' is in non-interactive mode.\nRequired input:\n> Which development build would you like to use?";

    it('prints exactly one JSON object, with no subprocess output after it', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--json']);

      expect(result.exitCode).toBe(0);
      // The property, checked as the property: the stub writes its own lines on stdout, and this
      // is what used to make `JSON.parse` fail at the byte after the closing brace.
      expect(JSON.parse(result.stdout)).toMatchObject({ target: 'expo-go', rule: 'expo-go' });
      expect(result.stdout).not.toContain('stub_expo_start');
    });

    it('exits 7 with the handoff when the Expo CLI needs an answer', async () => {
      const projectRoot = await setupAsync('go-app');
      const eventsFile = path.join(projectRoot, 'events.jsonl');

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--json'], {
        env: { STUB_EXPO_EXIT_CODE: '1', STUB_EXPO_STDERR: NEEDS_INPUT, LOG_EVENTS: eventsFile },
        reject: false,
      });

      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain('Needs a human   expo-prompt');
      // The recovery is the person, at a terminal — not a flag this CLI could have passed.
      expect(result.stderr).toContain('run the command above in a terminal once and answer it');
      // And the same failure as data, since JSON was asked for.
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: 'EXPO_NEEDS_INPUT',
        needsHuman: { scenario: 'expo-prompt' },
      });
      const events = fs
        .readFileSync(eventsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(events.find((entry) => entry._e === 'cli:needs_human')).toMatchObject({
        scenario: 'expo-prompt',
      });
    });

    // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — the port carve-out (F41).
    // A busy port used to be exit 7 with `needsHuman.scenario: "expo-prompt"` and a `How:` line
    // naming the very flag the caller had passed. Nothing about it needs a person.
    it('starts on a free port it picks when the port is busy and none was named', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--json'], {
        env: { STUB_EXPO_PORT_BUSY: '8180' },
        reject: false,
      });

      expect(result.exitCode).toBe(0);
      // Said out loud, on stderr, because the dev server is not where it was asked for.
      expect(result.stderr).toContain('Port 8180 was busy');
      // Two invocations of `expo start`: the one that stopped, and the one with the port on it.
      const starts = readStubExpoInvocations(projectRoot).filter(({ args }) => args[0] === 'start');
      expect(starts).toHaveLength(2);
      expect(starts[0]!.args).not.toContain('--port');
      expect(starts[1]!.args).toContain('--port');
      // Nobody was asked, so stdout is still the one plan object.
      expect(JSON.parse(result.stdout)).toMatchObject({ target: 'expo-go' });
    });

    // A port the caller named is a requirement. Exit 20 is "the outcome failed", never 7, and the
    // recovery is never the command that just failed.
    it('exits 20 when the port the caller demanded is taken', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--json', '--port', '8180'],
        { env: { STUB_EXPO_PORT_BUSY: '8180' }, reject: false }
      );

      expect(result.exitCode).toBe(20);
      const { error } = JSON.parse(result.stdout);
      expect(error.code).toBe('PORT_IN_USE');
      expect(error.needsHuman).toBeNull();
      expect(error.suggestedCommand).not.toContain('--port 8180');
      // One attempt: it was not quietly moved somewhere else.
      const starts = readStubExpoInvocations(projectRoot).filter(({ args }) => args[0] === 'start');
      expect(starts).toHaveLength(1);
    });

    it('exits 7 in human mode too, where the output is still captured', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios'], {
        env: { STUB_EXPO_EXIT_CODE: '1', STUB_EXPO_STDERR: NEEDS_INPUT },
        reject: false,
      });

      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain('Needs a human   expo-prompt');
      // The tool's own output still reaches the terminal as it arrives.
      expect(result.stdout).toContain('stub_expo_start');
    });

    // @ref llp/0010-agent-conventions.rfc.md §Exit codes
    // A run that started nothing has no plan to report and no dev server to point at. It used to
    // print the plan object with its success-shaped follow-ups and let the exit code be the only
    // thing that disagreed [observed — friction run 2, 2026-08-23].
    it('reports a failed step as a failure, and names no dev server', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--json'], {
        env: { STUB_EXPO_EXIT_CODE: '9' },
        reject: false,
      });

      // The subprocess's own code, forwarded exactly as it always was.
      expect(result.exitCode).toBe(9);
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        error: { code: 'PLAN_STEP_FAILED', needsHuman: null },
      });
      expect(payload.steps).toBeUndefined();
      expect(payload.followups).toBeUndefined();
      expect(result.stdout).not.toContain('exp://');
    });
  });

  // @ref llp/0010-agent-conventions.rfc.md §Needs-human protocol — the documented way to avoid the
  // port question entirely.
  // @ref llp/0010-agent-conventions.rfc.md §The `--json` error envelope — friction run 5, F48-3.
  // An option neither CLI has used to reach `expo start`, which meant the plan had already been
  // decided, printed and started before anything said the command line was wrong.
  describe('an option neither CLI has', () => {
    it('is refused before anything runs, with the --json envelope', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--json', '--bogus'],
        {
          reject: false,
        }
      );

      expect(result.exitCode).toBe(1);
      const { error } = JSON.parse(result.stdout);
      expect(error.code).toBe('BAD_ARGS');
      expect(error.message).toContain('--bogus');
      expect(error.suggestedCommand).toBe('npx @expo/agent-cli dev --help');
      // Nothing was planned and nothing was spawned: the point of checking before the plan.
      expect(invocationArgs(projectRoot)).toEqual([]);
    });

    it('still accepts the options expo start owns', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--json', '--go', '--offline', '--clear'],
        { reject: false }
      );

      expect(result.exitCode).toBe(0);
      const start = invocationArgs(projectRoot).find((args) => args[0] === 'start');
      expect(start).toEqual(expect.arrayContaining(['--offline', '--clear']));
    });
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §Where a device reaches the dev server
  //
  // `--tunnel` belongs to `expo start`, and this wrapper's job is to hand it over unchanged. Pinned
  // because a dogfood session ran the whole loop through `start --tunnel --go` [observed —
  // 2026-08-24], and because `assertKnownDevFlags` is a list a flag has to be *on* — a `--tunnel`
  // dropped from it would turn a working command into `unknown or unexpected option`.
  describe('--tunnel', () => {
    it('forwards --tunnel to the expo start step', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--json', '--tunnel', '--go'],
        {
          env: { STUB_EXPO_DEV_SERVER_PORT: '8081' },
        }
      );

      expect(result.exitCode).toBe(0);
      // `--go` appears once: the plan's own step already carries it, and the wrapper does not
      // repeat a flag the caller passed as well.
      expect(invocationArgs(projectRoot)).toEqual([['start', '--go', '--tunnel']]);
    });

    it('forwards --host tunnel too, which is the option --tunnel sets', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--json', '--host', 'tunnel'],
        {
          env: { STUB_EXPO_DEV_SERVER_PORT: '8081' },
        }
      );

      expect(result.exitCode).toBe(0);
      expect(invocationArgs(projectRoot)).toEqual([['start', '--go', '--host', 'tunnel']]);
    });

    // A tunnelled run has no LAN URL worth naming: the point of the flag is a device that is not
    // on this network, and `exp://192.168.x.x:8081` is unreachable from one.
    it('never names the LAN URL in the follow-ups of a tunnelled run', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--json', '--tunnel'],
        {
          env: { STUB_EXPO_DEV_SERVER_PORT: '8081' },
        }
      );

      const followups = JSON.parse(result.stdout).followups as { id: string; command: string }[];
      expect(followups.some((followup) => followup.command.startsWith('exp://'))).toBe(false);
      expect(followups.map((followup) => followup.id)).toContain('real-device-tunnel');
    });
  });

  describe('--port', () => {
    it('forwards the port to the dev server and names it in the follow-ups', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--ios', '--json', '--port', '8124'],
        { env: { STUB_EXPO_DEV_SERVER_PORT: '8124' } }
      );

      expect(result.exitCode).toBe(0);
      expect(invocationArgs(projectRoot)).toEqual([['start', '--go', '--port', '8124']]);
      const followups = JSON.parse(result.stdout).followups as { command: string }[];
      expect(followups.some((followup) => followup.command.endsWith(':8124'))).toBe(true);
    });

    // @ref llp/0009-smart-followups.rfc.md §Examples per command — the web ladder.
    // A web run used to inherit the native rungs and offer `runtime:errors` (no debugger target
    // attaches from a browser) and `eas build:configure` (a cloud native build it did not need),
    // while naming neither the site nor a way to check it [observed — friction run 2, 2026-08-23].
    it('leads a web run with the site URL and the check that proves it compiles', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--json', '--web', '--port', '8124'],
        {
          env: { STUB_EXPO_DEV_SERVER_PORT: '8124' },
        }
      );

      expect(result.exitCode).toBe(0);
      const followups = JSON.parse(result.stdout).followups as { id: string; command: string }[];
      expect(followups.map((followup) => followup.id)).toEqual([
        'web-url',
        'web-typecheck',
        'deploy-web',
      ]);
      expect(followups[0]!.command).toBe('http://localhost:8124');
      expect(result.stdout).not.toContain('eas build:configure');
    });

    it('rejects a value that is not a port, before anything runs', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--port', 'abc'], {
        reject: false,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--port must be a port number');
      expect(invocationArgs(projectRoot)).toEqual([]);
    });
  });

  describe('go-app — a plan of one step', () => {
    it('starts the dev server for Expo Go', async () => {
      const projectRoot = await setupAsync('go-app');
      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios']);

      expect(result.exitCode).toBe(0);
      expect(invocationArgs(projectRoot)).toEqual([['start', '--go']]);
      // The dev server step runs through the same wrapper as `@expo/agent-cli start`, whose skill sync is
      // covered by `wrapper-test.ts`.
      expect(result.stdout).toContain('stub_expo_dev_server_ready');
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Status
    it('publishes the dev server it started on the project lock', async () => {
      // The dev-server step of a plan is the same wrapper `@expo/agent-cli start` uses, so it takes the
      // same lock — a `dev` run has to be findable exactly like a `start` run.
      const projectRoot = await setupAsync('go-app');
      const child = spawnAgentCli(projectRoot, ['dev', '--ios'], {
        env: { STUB_EXPO_DELAY_MS: '30000', STUB_EXPO_DEV_SERVER_PORT: '8088' },
      });
      try {
        expect(await waitForDevLockAsync(projectRoot)).toMatchObject({
          url: 'http://127.0.0.1:8088',
          port: 8088,
          pid: child.pid,
        });
      } finally {
        await killAsync(child);
      }

      expect(await readDevLockAsync(projectRoot)).toBeNull();
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
  //
  // The `*-install` plan, in the process that runs it. A fingerprint that matches the recorded
  // build proves the build is current and says nothing about **where** it is, so the plan asks a
  // device and puts an install in front of the dev server when the answer is "not here". Unit tests
  // cover the decision; what only a subprocess can show is what the execution does with it: the
  // install runs first and pinned to the device that was asked, no dev-server lock is published
  // while it runs, and a launch that fails after the app is on the device does not fail the plan.
  //
  // This is the one block in this tier that turns `AGENT_CLI_NO_DEVICE` off, because the plan is
  // made *of* the device's answer. Nothing here can reach a real device: `adb` and `xcrun` are both
  // stubs of this project's own, and `ANDROID_HOME` points at a stub SDK so a runner that has a
  // real one is not preferred over them (llp/0002 §Tier 0).
  describe('dev-client-install — the build is current and the device has not got it', () => {
    /** The application id the fixture is given, so there is a named app to ask a device about. */
    const APP_ID = 'com.example.devclientfreshapp';

    /** What the stub `adb` answers `emu avd name` with, and so what the install is pinned to. */
    const AVD_NAME = 'Pixel_7_API_36';

    /** The serial the stub `adb` lists. `emulator-` is what makes the name an AVD name. */
    const SERIAL = 'emulator-5554';

    /**
     * A device layer that answers "one emulator, and it has not got this app".
     *
     * Three questions, and the stub answers each the way the real tool does — the exit codes are
     * the whole protocol here (@ref src/device/androidApps): `pm path` exits **1** for a package
     * the device has not got, which is the one answer that plans an install.
     */
    async function installStubDeviceAsync(projectRoot: string): Promise<Record<string, string>> {
      const stubBin = path.join(projectRoot, '.stub-bin');
      const adbScript = path.join(stubBin, 'adb-stub.js');
      await fs.promises.mkdir(stubBin, { recursive: true });
      await fs.promises.writeFile(
        adbScript,
        [
          `const args = process.argv.slice(2);`,
          `if (args[0] === 'devices') {`,
          `  process.stdout.write('List of devices attached\\n${SERIAL}       device product:sdk_gphone64_arm64 model:Pixel_7 device:emu64a transport_id:1\\n');`,
          `  process.exit(0);`,
          `}`,
          // The console protocol answers with the name and then its own `OK`.
          `if (args.includes('emu') && args.includes('avd')) {`,
          `  process.stdout.write('${AVD_NAME}\\nOK\\n');`,
          `  process.exit(0);`,
          `}`,
          // The app is not on this device, which is the whole fixture.
          `if (args.includes('pm') && args.includes('path')) { process.exit(1); }`,
          `process.exit(0);`,
        ].join('\n')
      );
      await installStubBinAsync(stubBin, 'adb', adbScript);
      // `ANDROID_HOME` beats `PATH`, so a runner with a real SDK would otherwise reach a real
      // device instead of the stub above (@ref src/device/adb §resolveAdb).
      const sdk = path.join(projectRoot, '.stub-android-sdk');
      await installStubBinAsync(path.join(sdk, 'platform-tools'), 'adb', adbScript);

      // An `xcrun` that reports no simulator, so the probe this run makes cannot reach the iOS
      // devices of the machine the suite happens to be running on.
      const xcrunScript = path.join(stubBin, 'xcrun-stub.js');
      await fs.promises.writeFile(
        xcrunScript,
        [
          `const args = process.argv.slice(2);`,
          `if (args[1] === 'list') { process.stdout.write(JSON.stringify({ devices: {} })); }`,
          `process.exit(0);`,
        ].join('\n')
      );
      await installStubBinAsync(stubBin, 'xcrun', xcrunScript);

      // A JVM, because the install is planned only where it could be **run**: `expo run:android`
      // goes through Gradle whether or not anything compiles, so a machine with no Java runtime
      // keeps the serve-only plan rather than gaining a step that can only fail
      // (@ref src/plan/resolveAsync). `JAVA_HOME` is what the probe asks first, so the answer here
      // is the same on a runner with a JDK and on one without.
      const jdk = path.join(projectRoot, '.stub-jdk');
      const javaScript = path.join(stubBin, 'java-stub.js');
      await fs.promises.writeFile(
        javaScript,
        // `java -version` writes to **stderr**, which is where every JDK has always put it.
        `process.stderr.write('openjdk version "17.0.11" 2026-04-16\\n');\nprocess.exit(0);\n`
      );
      await installStubBinAsync(path.join(jdk, 'bin'), 'java', javaScript);

      return { ANDROID_HOME: sdk, JAVA_HOME: jdk, AGENT_CLI_NO_DEVICE: '' };
    }

    /**
     * The fixture, plus the one thing it lacks: an Android application id.
     *
     * A project whose config names none cannot be looked for under any name, so the probe answers
     * `unknown` and the plan is the serve-only one (@ref src/device/appPresence). Written here
     * rather than into the committed fixture, which every other test in this file reads.
     */
    async function setupInstallAsync(): Promise<{ projectRoot: string; env: Record<string, string> }> {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.android = { ...config.expo.android, package: APP_ID };
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
      return { projectRoot, env: await installStubDeviceAsync(projectRoot) };
    }

    /** The install step's argv, which the plan pins to the device the probe asked. */
    const INSTALL_STEP = ['run:android', '--no-bundler', '--device', AVD_NAME];

    it('installs the recorded build before it serves, on the device it asked', async () => {
      const { projectRoot, env } = await setupInstallAsync();

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--android', '--local'], {
        env,
      });

      expect(result.exitCode).toBe(0);
      // Two steps and no build: `--no-bundler` because the dev server is the next step, and
      // `--device` because the answer that planned this install was about *that* device — a
      // machine with two of them must not install on one and serve nothing to the other.
      expect(invocationArgs(projectRoot)).toEqual([INSTALL_STEP, ['start', '--dev-client']]);
      // The record still names the build this plan was made from. Nothing was compiled — the step
      // installed what was already built — so a hash that moved here would mean the next run
      // planned a rebuild for work this one did not do.
      expect(readLastBuildRecord(projectRoot)).toMatchObject({
        android: { hash: RECORDED_HASH },
      });
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
    // The other half of F121, on the step it was found on. `expo run:*` installs the app and then
    // launches it, and on a Mac without the Automation grant the launch is what fails — after the
    // install this step exists for has already succeeded. The dev server still to come deep-links
    // into the app itself, so failing the plan here would stop the one step the caller waited for.
    it('keeps going when the install put the app on the device and the launch failed', async () => {
      const { projectRoot, env } = await setupInstallAsync();

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--android', '--local'], {
        env: { ...env, STUB_EXPO_RUN_LAUNCH_FAILS: '1' },
      });

      // Exit 0: the step failed and the plan did not, and the report says which of the two.
      expect(result.exitCode).toBe(0);
      expect(result.all).toContain('most likely the launch');
      expect(invocationArgs(projectRoot)).toEqual([INSTALL_STEP, ['start', '--dev-client']]);
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization — F125.
    //
    // The lock is what every other command finds a dev server by, and it names a port. The install
    // step serves nothing — that is what `--no-bundler` says — so a lock taken for it would name a
    // port nothing will listen on for as long as the install takes, and `status`, `smoke` and
    // `dev:stop` would all be answering about a dev server that does not exist.
    it('publishes no dev-server lock while the install runs, and one when it serves', async () => {
      const { projectRoot, env } = await setupInstallAsync();
      // Long enough that the read below lands inside the install by a wide margin, and paid only
      // once: the run is killed as soon as the dev server it is waiting for has published.
      const child = spawnAgentCli(projectRoot, ['dev', '--android', '--local'], {
        env: { ...env, STUB_EXPO_DELAY_MS: '5000', STUB_EXPO_DEV_SERVER_PORT: '8097' },
      });

      try {
        // The install has started — the step records itself before it sleeps — and it is still
        // running, so this is the window the finding is about.
        expect(
          await waitForAsync(
            () => invocationArgs(projectRoot).some((args) => args[0] === 'run:android'),
            30_000
          )
        ).toBe(true);
        expect(await readDevLockAsync(projectRoot)).toBeNull();

        // And the step that does serve takes it, which is the same lock a plain `dev` run takes.
        expect(await waitForDevLockAsync(projectRoot, 30_000)).toMatchObject({
          url: 'http://127.0.0.1:8097',
          port: 8097,
          pid: child.pid,
        });
      } finally {
        await killAsync(child);
      }
    });

    // @ref ./childVerdict.ts §parseDetachedChildPhase — the other side of F125. The child's log
    // holds a `run:android` row for the whole run, and a parser that read it alone would report
    // `building` about a dev server that is up and answering. What ends the building half is the
    // install's own marker, which is the same evidence F121 reads.
    it('reports a detached install plan as serving once the app is on the device', async () => {
      const { projectRoot, env } = await setupInstallAsync();

      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--android', '--local', '--detach', '--json'],
        {
          env: {
            ...env,
            // The install prints what it installed and then fails its launch, which is the shape
            // that leaves a `run:android` row above a dev server that is serving.
            STUB_EXPO_RUN_LAUNCH_FAILS: '1',
            STUB_EXPO_DELAY_MS: '20000',
            STUB_EXPO_DEV_SERVER_PORT: '8098',
          },
          reject: false,
        }
      );

      try {
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ port: 8098, phase: 'serving' });
      } finally {
        await executeAgentCliAsync(projectRoot, ['dev:stop', '--json'], { reject: false });
      }
    });
  });
});
