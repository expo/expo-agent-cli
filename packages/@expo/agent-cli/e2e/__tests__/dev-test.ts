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
  pathEnvVars,
  readDevLockAsync,
  readStubExpoInvocations,
  setupFixtureAsync,
  spawnAgentCli,
  waitForAsync,
  waitForDevLockAsync,
} from '../utils';
import {
  EMULATOR_NAME,
  installStubAdbAsync,
  installStubEmulatorAsync,
  installStubXcrunAsync,
  killBoundEmulatorsAsync,
} from './installedAppStubs';

/** The `--port` that `dev` puts on every step that serves. Its value is whatever this machine has free. */
const PORT_ARGS = ['--port', expect.stringMatching(/^\d+$/)];

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
    expect(invocationArgs(projectRoot)).toEqual([
      ['prebuild', '--platform', 'ios'],
      ['run:ios', ...PORT_ARGS],
    ]);
  });

  describe('dev-client-app — a plan of two steps', () => {
    it('runs prebuild and the native build, in that order', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local']);

      expect(result.exitCode).toBe(0);
      expect(invocationArgs(projectRoot)).toEqual([
        ['prebuild', '--platform', 'ios'],
        ['run:ios', ...PORT_ARGS],
      ]);
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
      expect(run!.args).toEqual(['run:ios', ...PORT_ARGS]);
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
    // F120. The development build's connect URL was built out of a `--port` the plan then dropped
    // [observed — wave 29, live, `wave29-devclient/evidence/05-dev-build-ios.log`]. The URL is the
    // follow-up an agent acts on, so it names the port the step serves on: the port the plan
    // named, because `expo run:*` takes `--port` too (llp/0004 §A busy port is not a step only a
    // person can complete).
    it('names the port the plan will really serve on', async () => {
      const projectRoot = await setupAsync('dev-client-app');
      const result = await executeAgentCliAsync(projectRoot, [
        'dev',
        '--ios',
        '--local',
        '--port',
        '8901',
      ]);

      expect(result.stderr).not.toContain('were not passed on');
      expect(readStubExpoInvocations(projectRoot).at(-1)!.args).toEqual([
        'run:ios',
        '--port',
        '8901',
      ]);
      const connectLine = result.all
        .split('\n')
        .find((line) => line.includes('expo-development-client'));
      expect(connectLine).toBeDefined();
      expect(connectLine).toContain('8901');
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
      expect(invocationArgs(projectRoot)).toEqual([
        ['prebuild', '--platform', 'ios'],
        ['run:ios', ...PORT_ARGS],
      ]);
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
      expect(invocationArgs(projectRoot)).toEqual([
        ['prebuild', '--platform', 'ios'],
        ['run:ios', ...PORT_ARGS],
      ]);
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
        ['expo', 'start', '--dev-client', ...PORT_ARGS],
      ]);
    });

    it('runs only the dev server when the recorded build still matches', async () => {
      const projectRoot = await setupAsync('dev-client-fresh-app');
      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--local']);

      expect(result.exitCode).toBe(0);
      // No platform flag at all: the open is this command's own act now (llp/0026).
      expect(invocationArgs(projectRoot)).toEqual([['start', '--dev-client', ...PORT_ARGS]]);
      // Nothing was built, so the record is untouched.
      expect(readLastBuildRecord(projectRoot)).toEqual({
        ios: RECORDED_HASH,
        android: RECORDED_HASH,
      });
    });
  });

  // The loop the fingerprint record exists for [asked — Kudo, 2026-09-05]: after one recorded
  // build, `dev` knows whether the project needs a prebuild or a build, and starts the fastest way
  // that is still correct. The stub fingerprint hashes the app config, eas.json and package.json
  // here (`STUB_FINGERPRINT_HASH_FROM_PROJECT`) and emits a source per file and per dependency, so
  // editing those files moves the fingerprint the way a real hasher would — the chain under test
  // is edit → new hash → record no longer matches → the plan builds again.
  //
  // **And which plan**, which is the second question the sources answer (llp/0004 §A stale build
  // is two questions). A hash that moved says the recorded build is stale and nothing more; what
  // has to run to fix it depends on *what* moved, and the cases below are the four answers: a JS
  // edit that is not a change at all, a dependency that needs the app compiled again, an app
  // config or an SDK that needs the native project generated first, and an `eas.json` edit that
  // needs neither.
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
     * The plan `dev --plan` prints, parsed.
     *
     * `--local` pins the backend: on a CI box with no Xcode the selector would route the rebuild
     * to EAS, and these tests are about *when* a build is planned, not where it runs.
     */
    async function planAsync(projectRoot: string): Promise<{ rule: string; steps: string[][] }> {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['dev', '--plan', '--ios', '--local', '--json'],
        { env: HASH_FROM_PROJECT }
      );
      expect(result.exitCode).toBe(0);
      const plan = JSON.parse(result.stdout);
      return { rule: plan.rule, steps: plan.steps.map((step: { argv: string[] }) => step.argv) };
    }

    async function planStepsAsync(projectRoot: string): Promise<string[][]> {
      return (await planAsync(projectRoot)).steps;
    }

    /** Rewrite the project's dependencies, the way `expo install` and an SDK upgrade both do. */
    async function editDependenciesAsync(
      projectRoot: string,
      edit: (dependencies: Record<string, string>) => Record<string, string>
    ): Promise<void> {
      const packagePath = path.join(projectRoot, 'package.json');
      const packageJson = JSON.parse(await fs.promises.readFile(packagePath, 'utf8'));
      packageJson.dependencies = edit(packageJson.dependencies);
      await fs.promises.writeFile(packagePath, JSON.stringify(packageJson, null, 2));
    }

    it('starts the dev server and nothing else while nothing changed', async () => {
      const projectRoot = await recordedProjectAsync();

      expect(await planStepsAsync(projectRoot)).toEqual([
        ['expo', 'start', '--dev-client', ...PORT_ARGS],
      ]);
    });

    it('prebuilds and builds again after the app config changed, because the project is CNG', async () => {
      const projectRoot = await recordedProjectAsync();

      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.ios = { ...config.expo.ios, bundleIdentifier: 'com.example.changed' };
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));

      expect(await planStepsAsync(projectRoot)).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios', ...PORT_ARGS],
      ]);
    });

    // The reason these transitions are e2e tests at all: the whole chain — build, record with
    // sources, re-fingerprint, diff, classify, plan — runs through the published bundle, so a
    // break anywhere in it shows up as the wrong step list here.
    it('starts only the dev server when a JS file changed', async () => {
      const projectRoot = await recordedProjectAsync();

      await fs.promises.writeFile(
        path.join(projectRoot, 'index.js'),
        'console.log("edited: the fingerprint does not read JS, so the build still matches");\n'
      );

      const plan = await planAsync(projectRoot);
      expect(plan.rule).toBe('dev-client-fresh');
      expect(plan.steps).toEqual([['expo', 'start', '--dev-client', ...PORT_ARGS]]);
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §A stale build is two questions
    it('builds without prebuilding when only eas.json changed', async () => {
      const projectRoot = await recordedProjectAsync();

      await fs.promises.writeFile(
        path.join(projectRoot, 'eas.json'),
        JSON.stringify({ build: { development: { developmentClient: true } } }, null, 2)
      );

      const plan = await planAsync(projectRoot);
      expect(plan.rule).toBe('dev-client-rebuild');
      expect(plan.steps).toEqual([['expo', 'run:ios', ...PORT_ARGS]]);
    });

    // @ref ../../src/impact/classify §sourceNeedsPrebuild. The run this split was asked for
    // [Kudo, 2026-09-07]: `npx expo install expo-observe`, and then `dev --ios`. What prebuild
    // writes comes from the template, the app config and the plugins the app config applies, and a
    // new dependency is none of the three — so the prebuild it used to plan here regenerated an
    // identical `ios/`. The app still has to be compiled again, which is the step that remains.
    //
    // **`expo-observe` by name, and it is the assertion's own evidence.** The package ships no
    // config plugin — an `expo-module.config.json` and nothing else [observed — 57.0.19, 2026-09-07]
    // — so there is provably nothing for a prebuild to write differently. A stand-in package would
    // have made this a test of the rule; this makes it a test of a run somebody actually does.
    it('builds without prebuilding after a native module was installed', async () => {
      const projectRoot = await recordedProjectAsync();
      await editDependenciesAsync(projectRoot, (dependencies) => ({
        ...dependencies,
        'expo-observe': '~57.0.19',
      }));

      const plan = await planAsync(projectRoot);
      expect(plan.rule).toBe('dev-client-rebuild');
      expect(plan.steps).toEqual([['expo', 'run:ios', ...PORT_ARGS]]);
    });

    it('builds without prebuilding after a native module was removed', async () => {
      const projectRoot = await recordedProjectAsync();
      await editDependenciesAsync(projectRoot, ({ 'expo-camera': _removed, ...rest }) => rest);

      const plan = await planAsync(projectRoot);
      expect(plan.rule).toBe('dev-client-rebuild');
      expect(plan.steps).toEqual([['expo', 'run:ios', ...PORT_ARGS]]);
    });

    // The other side of the same split. An SDK upgrade moves the versions of the modules that are
    // already installed, and the prebuild template travels with the SDK — so the native project it
    // would generate really is a different one.
    it('prebuilds after the installed versions moved, which is what an SDK upgrade looks like', async () => {
      const projectRoot = await recordedProjectAsync();
      await editDependenciesAsync(projectRoot, (dependencies) =>
        Object.fromEntries(Object.keys(dependencies).map((name) => [name, '99.0.0']))
      );

      const plan = await planAsync(projectRoot);
      expect(plan.rule).toBe('dev-client-stale');
      expect(plan.steps).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios', ...PORT_ARGS],
      ]);
    });

    // @ref ../../src/impact/classify §TEMPLATE_PACKAGES — the exception, on the package it is
    // about [asked — Kudo, 2026-09-07]. Upgrading the SDK is not "a dependency moved": prebuild
    // generates the native project from the template the installed `expo` selects, so this one
    // package's own movement changes the output rather than only the inputs.
    it('prebuilds after the expo package itself was upgraded', async () => {
      const projectRoot = await recordedProjectAsync();
      await editDependenciesAsync(projectRoot, (dependencies) => ({
        ...dependencies,
        expo: '55.0.0',
      }));

      const plan = await planAsync(projectRoot);
      expect(plan.steps).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios', ...PORT_ARGS],
      ]);
    });

    // And the case that makes skipping the prebuild for an installed module safe: a package that
    // needs generated code ships a config plugin and is named in the app config to apply it, so
    // the app config moves too — and that source has always demanded a prebuild.
    it('prebuilds when the installed module came with an app config change', async () => {
      const projectRoot = await recordedProjectAsync();
      await editDependenciesAsync(projectRoot, (dependencies) => ({
        ...dependencies,
        'expo-observe': '~57.0.19',
      }));
      const configPath = path.join(projectRoot, 'app.json');
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
      config.expo.plugins = ['expo-observe'];
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));

      const plan = await planAsync(projectRoot);
      expect(plan.steps).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios', ...PORT_ARGS],
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

      expect(await planStepsAsync(projectRoot)).toEqual([['expo', 'run:ios', ...PORT_ARGS]]);
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
        // The port the plan picks, which the stub then refuses: the race between the plan's bind
        // test and the dev server's own bind, which the retry covers.
        env: { RCT_METRO_PORT: '8180', STUB_EXPO_PORT_BUSY: '8180' },
        reject: false,
      });

      expect(result.exitCode).toBe(0);
      // Said out loud, on stderr, because the dev server is not where it was asked for.
      expect(result.stderr).toContain('Port 8180 was taken before the dev server bound it');
      // Two invocations of `expo start`: the one that stopped, and the one on the port it picked.
      const starts = readStubExpoInvocations(projectRoot).filter(({ args }) => args[0] === 'start');
      expect(starts).toHaveLength(2);
      expect(starts[0]!.args).toEqual(['start', '--go', '--port', '8180']);
      expect(starts[1]!.args.filter((arg) => arg === '--port')).toHaveLength(1);
      expect(starts[1]!.args.at(-1)).not.toBe('8180');
      // Nobody was asked, so stdout is still the one plan object.
      expect(JSON.parse(result.stdout)).toMatchObject({ target: 'expo-go' });
    });

    // Two worktrees picked the same free port at once; the other one bound it first, and Metro's
    // own bind failed. The pre-resolved port is a hint, the retry is the guarantee.
    it('retries on the next free port when Metro could not bind the port it was given', async () => {
      const projectRoot = await setupAsync('go-app');

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--json'], {
        env: { RCT_METRO_PORT: '8290', STUB_EXPO_EADDRINUSE_PORT: '8290' },
        reject: false,
      });

      expect(result.exitCode, result.all).toBe(0);
      expect(result.stderr).toContain('Port 8290 was taken before the dev server bound it');
      const starts = readStubExpoInvocations(projectRoot).filter(({ args }) => args[0] === 'start');
      expect(starts.map(({ args }) => args.slice(0, 3))).toEqual([
        ['start', '--go', '--port'],
        ['start', '--go', '--port'],
      ]);
      expect(starts[0]!.args.at(-1)).toBe('8290');
      expect(Number(starts[1]!.args.at(-1))).toBeGreaterThan(8290);
      expect(starts[1]!.args.filter((arg) => arg === '--port')).toHaveLength(1);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ target: 'expo-go' });
      // The port the run ended on, not the one it planned.
      expect(report.devServerPort).toEqual({
        port: Number(starts[1]!.args.at(-1)),
        movedFrom: 8290,
        state: 'picked',
      });
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

      const result = await executeAgentCliAsync(projectRoot, ['dev', '--json', '--bogus'], {
        reject: false,
      });

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
      expect(invocationArgs(projectRoot)).toEqual([['start', '--go', '--tunnel', ...PORT_ARGS]]);
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
      expect(invocationArgs(projectRoot)).toEqual([
        ['start', '--go', '--host', 'tunnel', ...PORT_ARGS],
      ]);
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
      expect(invocationArgs(projectRoot)).toEqual([['start', '--go', ...PORT_ARGS]]);
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
  // made *of* the device's answer. Nothing here can reach a real device: `adb`, `emulator` and
  // `xcrun` are all stubs of this project's own, and `ANDROID_HOME` points at a stub SDK so a
  // runner that has a real one is not preferred over them (llp/0002 §Tier 0). The run spawns a
  // stub emulator instance and binds it (llp/0032), so the step is pinned to that instance's
  // serial; skipped on Windows, where the stub cannot be signalled.
  describe.skipIf(process.platform === 'win32')(
    'dev-client-install — the build is current and the device has not got it',
    () => {
      /** The application id the fixture is given, so there is a named app to ask a device about. */
      const APP_ID = 'com.example.devclientfreshapp';

      /** The serial of the instance the run spawns on the first free console port. */
      const SERIAL = 'emulator-5554';

      const roots: string[] = [];
      afterEach(async () => {
        for (const root of roots.splice(0)) {
          await killBoundEmulatorsAsync(`${root}.expo-home`);
        }
      });

      /**
       * A device layer with no instance up and one AVD to spawn, whose instance has not got this
       * app: `pm path` exits **1** for a package the device has not got, which is the one answer
       * that plans an install (@ref src/device/androidApps).
       */
      async function installStubDeviceAsync(projectRoot: string): Promise<Record<string, string>> {
        roots.push(projectRoot);
        const stubBin = path.join(projectRoot, '.stub-bin');
        await fs.promises.mkdir(stubBin, { recursive: true });
        const adb = await installStubAdbAsync(projectRoot, APP_ID, { attached: false });
        await installStubEmulatorAsync(projectRoot);

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

        return { ...adb.env, JAVA_HOME: jdk, AGENT_CLI_NO_DEVICE: '', STUB_ADB_INSTALLED: '0' };
      }

      /** The argv of every stub `emulator` invocation of the fixture. */
      function emulatorCalls(projectRoot: string): string[][] {
        const file = path.join(projectRoot, '.emulator-calls.jsonl');
        return fs.existsSync(file)
          ? fs
              .readFileSync(file, 'utf8')
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      }

      /**
       * The fixture, plus the one thing it lacks: an Android application id.
       *
       * A project whose config names none cannot be looked for under any name, so the probe answers
       * `unknown` and the plan is the serve-only one (@ref src/device/appPresence). Written here
       * rather than into the committed fixture, which every other test in this file reads.
       */
      async function setupInstallAsync(): Promise<{
        projectRoot: string;
        env: Record<string, string>;
      }> {
        const projectRoot = await setupAsync('dev-client-fresh-app');
        const configPath = path.join(projectRoot, 'app.json');
        const config = JSON.parse(await fs.promises.readFile(configPath, 'utf8'));
        config.expo.android = { ...config.expo.android, package: APP_ID };
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
        return { projectRoot, env: await installStubDeviceAsync(projectRoot) };
      }

      /** The install step's argv, which `dev` pins to the instance it bound. */
      const INSTALL_STEP = ['run:android', '--no-bundler', '--device', SERIAL];

      it('spawns a read-only instance, binds it, and installs the recorded build onto it before it serves', async () => {
        const { projectRoot, env } = await setupInstallAsync();

        const result = await executeAgentCliAsync(projectRoot, ['dev', '--android', '--local'], {
          env,
        });

        expect(result.exitCode).toBe(0);
        // Two steps and no build: `--no-bundler` because the dev server is the next step, and
        // `--device` because the answer that planned this install was about *that* instance — a
        // machine with two of them must not install on one and serve nothing to the other.
        expect(invocationArgs(projectRoot)).toEqual([
          INSTALL_STEP,
          ['start', '--dev-client', ...PORT_ARGS],
        ]);
        // One instance of the one AVD, read-only, on the first free console port (llp/0030
        // Decision 2), and the binding names its serial and its pid.
        expect(emulatorCalls(projectRoot)).toEqual([
          ['-list-avds'],
          ['-avd', EMULATOR_NAME, '-ports', '5554,5555', '-no-snapshot-save', '-read-only'],
        ]);
        const dir = path.join(`${projectRoot}.expo-home`, 'agent-cli', 'bindings');
        const file = fs
          .readdirSync(dir)
          .find((name) => name.endsWith('-android-local-android.json'));
        const binding = JSON.parse(fs.readFileSync(path.join(dir, file!), 'utf8'));
        expect(binding.device).toMatchObject({
          serial: SERIAL,
          origin: {
            kind: 'spawned',
            avd: EMULATOR_NAME,
            port: 5554,
            emulatorPid: expect.any(Number),
          },
        });
        expect(binding.projectRoot).toBe(fs.realpathSync.native(projectRoot));
        // The instance outlives the run: it is this worktree's device until it is let go of.
        expect(() => process.kill(binding.device.origin.emulatorPid, 0)).not.toThrow();
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
        expect(invocationArgs(projectRoot)).toEqual([
          INSTALL_STEP,
          ['start', '--dev-client', ...PORT_ARGS],
        ]);
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
    }
  );

  // @ref llp/0031-ios-binding.plan.md §Tests
  //
  // Two worktrees of one app, one stub `simctl` whose simulator state both runs share, and one
  // registry: each `dev --ios` creates its own simulator, binds it, boots it with `bootstatus -b`,
  // and pins its build to it. The `--device` on each `run:ios` is the id in that worktree's binding,
  // and the two ids differ.
  describe.skipIf(process.platform !== 'darwin')('two worktrees, two simulators', () => {
    /** Every binding in the shared registry, by the root it belongs to. */
    function readBindings(home: string): Record<string, { udid: string; name: string }> {
      const dir = path.join(home, 'agent-cli', 'bindings');
      const bindings: Record<string, { udid: string; name: string }> = {};
      for (const name of fs
        .readdirSync(dir)
        .filter((entry) => entry.endsWith('-ios-local-ios.json'))) {
        const binding = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        bindings[binding.projectRoot] = { udid: binding.device.udid, name: binding.device.name };
      }
      return bindings;
    }

    it('binds a simulator of its own to each worktree and builds onto it', async () => {
      const [first, second] = await Promise.all([
        setupAsync('dev-client-app'),
        setupAsync('dev-client-app'),
      ]);
      // One `simctl`, installed once: both runs create and boot against its one simulator state.
      const { binDir, calls: readXcrun } = await installStubXcrunAsync(first!);
      const home = `${first}.expo-home`;
      const env = {
        ...pathEnvVars(`${binDir}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`),
        __UNSAFE_EXPO_HOME_DIRECTORY: home,
        AGENT_CLI_NO_DEVICE: '0',
      };

      const results = await Promise.all(
        [first!, second!].map((root) =>
          executeAgentCliAsync(root, ['dev', '--ios', '--local'], { env })
        )
      );

      expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
      const bindings = readBindings(home);
      const udids = [first!, second!].map((root) => bindings[fs.realpathSync.native(root)]!.udid);
      expect(udids).toEqual(expect.arrayContaining(['E2E-CREATED-1', 'E2E-CREATED-2']));
      expect(new Set(udids).size).toBe(2);
      for (const [index, root] of [first!, second!].entries()) {
        expect(invocationArgs(root)).toEqual([
          ['prebuild', '--platform', 'ios'],
          ['run:ios', ...PORT_ARGS, '--device', udids[index]],
        ]);
      }
      const booted = readXcrun()
        .filter((argv) => argv[1] === 'bootstatus')
        .map((argv) => argv[2]);
      expect(new Set(booted)).toEqual(new Set(udids));
      expect(readXcrun().every((argv) => argv[1] !== 'bootstatus' || argv.includes('-b'))).toBe(
        true
      );
      expect(readXcrun().some((argv) => argv[1] === 'boot')).toBe(false);
    });
  });

  // @ref llp/0032-android-instance.plan.md §State it leaves
  //
  // Two worktrees of one app, one stub `adb` and `emulator` whose instance state both runs share,
  // and one registry: each `dev --android` spawns its own read-only instance of the one AVD on the
  // next free even console port, binds its serial and pid, and pins its build to that serial.
  describe.skipIf(process.platform === 'win32')('two worktrees, two emulator instances', () => {
    const APP_ID = 'com.example.devclientfreshapp';
    let home: string | null = null;
    afterEach(async () => {
      if (home) {
        await killBoundEmulatorsAsync(home);
        home = null;
      }
    });

    /** Every Android binding in the shared registry, by the root it belongs to. */
    function readBindings(dir: string): Record<string, { serial: string; port: number }> {
      const bindings: Record<string, { serial: string; port: number }> = {};
      for (const name of fs
        .readdirSync(path.join(dir, 'agent-cli', 'bindings'))
        .filter((entry) => entry.endsWith('-android-local-android.json'))) {
        const binding = JSON.parse(
          fs.readFileSync(path.join(dir, 'agent-cli', 'bindings', name), 'utf8')
        );
        bindings[binding.projectRoot] = {
          serial: binding.device.serial,
          port: binding.device.origin.port,
        };
      }
      return bindings;
    }

    it('spawns an instance of its own for each worktree, on 5554 and 5556, and builds onto it', async () => {
      const [first, second] = await Promise.all([
        setupAsync('dev-client-app'),
        setupAsync('dev-client-app'),
      ]);
      // One stub SDK and one instance state, installed once: both runs spawn against it.
      const adb = await installStubAdbAsync(first!, APP_ID, { attached: false });
      await installStubEmulatorAsync(first!);
      home = `${first}.expo-home`;
      const env = { ...adb.env, AGENT_CLI_NO_DEVICE: '0' };

      const results = await Promise.all(
        [first!, second!].map((root) =>
          executeAgentCliAsync(root, ['dev', '--android', '--local'], { env })
        )
      );

      expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
      const bindings = readBindings(home);
      const ports = [first!, second!].map((root) => bindings[fs.realpathSync.native(root)]!.port);
      expect(ports).toEqual(expect.arrayContaining([5554, 5556]));
      for (const [index, root] of [first!, second!].entries()) {
        expect(invocationArgs(root)).toEqual([
          ['prebuild', '--platform', 'android'],
          ['run:android', ...PORT_ARGS, '--device', `emulator-${ports[index]}`],
        ]);
      }
    });
  });
});
