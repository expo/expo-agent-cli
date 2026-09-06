import type { FingerprintSource } from '../../project/fingerprint';
import type { ProjectState } from '../../project/types';
import type { BuildBackendChoice } from '../../toolchain/selectBackend';
import { decideStartPlan } from '../decide';
import type { LastBuildRecord } from '../lastBuild';
import type { NativePlatform } from '../types';
import type { RunTargetChoice } from '../runTarget';

/**
 * A recorded build that stored only a hash, which is what an older CLI wrote.
 *
 * The default for every row that is about *freshness*: with no `sources` there is nothing to diff,
 * so the table cannot tell what moved and keeps the prebuild it always planned. The rows that are
 * about the newer question pass sources through {@link recordedWithSources}.
 */
function recorded(platform: NativePlatform, hash: string): LastBuildRecord {
  return { [platform]: { hash, sources: null } };
}

/** The app config, which prebuild reads and writes native code from. */
function appConfig(hash: string): FingerprintSource {
  return { type: 'file', filePath: 'app.json', reasons: ['expoConfig'], hash };
}

/** `eas.json`, which moves the fingerprint without changing what prebuild would write. */
function easJson(hash: string): FingerprintSource {
  return { type: 'file', filePath: 'eas.json', reasons: ['easBuild'], hash };
}

/** A recorded build whose sources can be diffed against the probed ones. */
function recordedWithSources(
  platform: NativePlatform,
  hash: string,
  sources: FingerprintSource[]
): LastBuildRecord {
  return { [platform]: { hash, sources } };
}

function createState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectRoot: '/project',
    isExpoApp: true,
    sdkVersion: '54.0.0',
    nativeDirs: { ios: false, android: false },
    usesDevClient: false,
    hasWeb: true,
    expoGo: { compatible: true, reasons: [] },
    fingerprint: { hash: 'abc123def4567890' },
    ...overrides,
  };
}

/** The state of a managed project that needs a development build. */
function createDevClientState(overrides: Partial<ProjectState> = {}): ProjectState {
  return createState({
    usesDevClient: true,
    expoGo: {
      compatible: false,
      reasons: [
        {
          kind: 'unbundled-native-module',
          packageName: 'react-native-mmkv',
          detail: 'react-native-mmkv is not bundled in Expo Go',
        },
      ],
    },
    ...overrides,
  });
}

function argvOf(steps: { argv: string[] }[]): string[][] {
  return steps.map((step) => step.argv);
}

/** A resolved backend, as `selectBuildBackend` hands one to the table. */
function backend(
  runsOn: 'local' | 'eas',
  overrides: Partial<BuildBackendChoice> = {}
): BuildBackendChoice {
  const because = 'this is a test.';
  return {
    runsOn,
    source: runsOn === 'eas' ? 'toolchain' : 'default',
    because,
    why: `Building ${runsOn === 'eas' ? 'in the cloud on EAS' : 'on this machine'}: ${because}`,
    doomed: false,
    ...overrides,
  };
}

/** A run target somebody asked for, as `selectRunTarget` hands one to the table. */
function runTarget(
  target: 'expo-go' | 'dev-build',
  source: 'flag' | 'config' = 'config'
): RunTargetChoice {
  return { target, source, why: `${target} was asked for, for this test.` };
}

describe(decideStartPlan, () => {
  // @ref llp/0004-smart-start-and-project-state.rfc.md §Not an Expo app
  describe('rule: not-expo-app', () => {
    it(`should plan nothing for a directory that declares no expo dependency`, () => {
      const plan = decideStartPlan(createState({ isExpoApp: false }));

      expect(plan.rule).toBe('not-expo-app');
      expect(plan.target).toBe('none');
      expect(plan.steps).toEqual([]);
      expect(plan.buildLocation).toBeNull();
      expect(plan.reasons.join(' ')).toContain('not an Expo app');
    });

    // The trap this row exists for: the table used to read "no `expo` dependency" as "lacks a dev
    // client" and planned an install into whatever repository the caller was standing in.
    it(`should never plan an install into a directory that is not an Expo app`, () => {
      const plan = decideStartPlan(
        createDevClientState({ isExpoApp: false, usesDevClient: false })
      );

      expect(argvOf(plan.steps)).toEqual([]);
    });

    it(`should outrank the web short-circuit, which is also about an app that is not here`, () => {
      const plan = decideStartPlan(createState({ isExpoApp: false }), { platform: 'web' });

      expect(plan.rule).toBe('not-expo-app');
      expect(plan.steps).toEqual([]);
    });

    it(`should outrank checked-in native directories`, () => {
      const plan = decideStartPlan(
        createState({ isExpoApp: false, nativeDirs: { ios: true, android: true } })
      );

      expect(plan.rule).toBe('not-expo-app');
      expect(plan.steps).toEqual([]);
    });
  });

  describe('rule: web', () => {
    it(`should start the dev server for web when the web platform is requested`, () => {
      const plan = decideStartPlan(createState(), { platform: 'web' });

      expect(plan.rule).toBe('web');
      expect(plan.target).toBe('web');
      expect(argvOf(plan.steps)).toEqual([['expo', 'start', '--web']]);
      expect(plan.steps[0]!.timeClass).toBe('seconds');
    });

    it(`should choose web over every native rule`, () => {
      const plan = decideStartPlan(
        createDevClientState({ nativeDirs: { ios: true, android: true } }),
        { platform: 'web' }
      );

      expect(plan.rule).toBe('web');
    });

    it(`should warn when the project has no react-native-web dependency`, () => {
      const plan = decideStartPlan(createState({ hasWeb: false }), { platform: 'web' });

      expect(plan.rule).toBe('web');
      expect(plan.reasons.join('\n')).toMatch(/react-native-web is not a dependency/);
    });
  });

  describe('rule: expo-go', () => {
    it(`should only start the dev server for an Expo Go compatible project`, () => {
      const plan = decideStartPlan(createState(), { platform: 'ios' });

      expect(plan.rule).toBe('expo-go');
      expect(plan.target).toBe('expo-go');
      expect(argvOf(plan.steps)).toEqual([['expo', 'start', '--go']]);
      expect(plan.steps[0]!.timeClass).toBe('seconds');
      expect(plan.reasons.join('\n')).toMatch(/Expo Go can run this project/);
    });

    it(`should not choose Expo Go when the project depends on expo-dev-client`, () => {
      const plan = decideStartPlan(createState({ usesDevClient: true }), { platform: 'ios' });

      expect(plan.rule).not.toBe('expo-go');
    });

    it(`should not choose Expo Go when native directories are checked in`, () => {
      const plan = decideStartPlan(createState({ nativeDirs: { ios: true, android: false } }), {
        platform: 'ios',
      });

      expect(plan.rule).not.toBe('expo-go');
    });

    // The plan used to say "Opens the project in Expo Go", which `expo start --go` does not do:
    // it serves a bundle and waits. Following the plan left an agent with a dev server and no way
    // to reach the app, and `--ios` changed nothing in the argv even though it is forwarded.
    it(`should not claim to open anything when no platform flag was typed`, () => {
      const reason = decideStartPlan(createState(), { platform: 'ios' }).steps[0]!.reason;

      expect(reason).not.toMatch(/^Opens/);
      expect(reason).toContain('opens nothing on its own');
      expect(reason).toContain('@expo/agent-cli navigate /');
    });

    it.each([
      ['ios', 'an iOS simulator'],
      ['android', 'an Android device or emulator'],
    ] as const)(`should plan and describe the open that --%s performs`, (platform, device) => {
      const plan = decideStartPlan(createState(), {
        platform,
        requestedPlatform: platform,
      });

      // The open is `dev`'s own act now (llp/0026), so the flag never reaches `expo start` — the
      // argv stays clean and the reason is what promises the open.
      expect(argvOf(plan.steps)).toEqual([['expo', 'start', '--go']]);
      expect(plan.steps[0]!.reason).toContain(`opened on ${device}`);
      expect(plan.steps[0]!.reason).not.toContain('opens nothing');
    });

    // The platform to *build* for is always resolved; only a typed flag reaches `expo start`.
    it(`should not invent a flag from the platform it fell back to`, () => {
      const plan = decideStartPlan(createState(), { platform: 'ios' });

      expect(argvOf(plan.steps)).toEqual([['expo', 'start', '--go']]);
    });

    // `--web` serves a browser; the native rows have no business opening one.
    it(`should not put --web on a native start step`, () => {
      const plan = decideStartPlan(createState(), { platform: 'ios', requestedPlatform: 'web' });

      expect(argvOf(plan.steps)).toEqual([['expo', 'start', '--go']]);
    });
  });

  describe('rule: dev-client-fresh', () => {
    it(`should only start the dev server when the fingerprint matches the last build`, () => {
      const state = createDevClientState();
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recorded('ios', state.fingerprint.hash!),
      });

      expect(plan.rule).toBe('dev-client-fresh');
      expect(plan.target).toBe('dev-client');
      expect(argvOf(plan.steps)).toEqual([['expo', 'start', '--dev-client']]);
      expect(plan.steps[0]!.timeClass).toBe('seconds');
      // A dev server opens nothing, whichever runtime it serves.
      expect(plan.steps[0]!.reason).toContain('opens nothing on its own');
    });

    it(`should plan the open a development build gets from --ios`, () => {
      const state = createDevClientState();
      const plan = decideStartPlan(state, {
        platform: 'ios',
        requestedPlatform: 'ios',
        lastBuild: recorded('ios', state.fingerprint.hash!),
      });

      expect(argvOf(plan.steps)).toEqual([['expo', 'start', '--dev-client']]);
      expect(plan.steps[0]!.reason).toContain(
        'development build is then opened on an iOS simulator'
      );
    });

    it(`should ignore a matching hash recorded for another platform`, () => {
      const state = createDevClientState();
      const plan = decideStartPlan(state, {
        platform: 'android',
        lastBuild: recorded('ios', state.fingerprint.hash!),
      });

      expect(plan.rule).toBe('dev-client-stale');
    });

    it(`should start Expo Go compatible projects in the dev client when one is a dependency`, () => {
      const state = createState({ usesDevClient: true });
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recorded('ios', state.fingerprint.hash!),
      });

      expect(plan.rule).toBe('dev-client-fresh');
    });
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Decision table
  //
  // The row this split was made for. The fingerprint moved, so the build is stale and something has
  // to run — but what moved is `eas.json`, which prebuild does not write, so regenerating an
  // identical `ios/` would spend a minute to produce the file already there.
  describe('rule: dev-client-rebuild', () => {
    it(`should build without prebuilding when only the build config moved`, () => {
      const state = createDevClientState({
        fingerprint: { hash: 'head', sources: [appConfig('a'), easJson('changed')] },
      });
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recordedWithSources('ios', 'base', [appConfig('a'), easJson('a')]),
      });

      expect(plan.rule).toBe('dev-client-rebuild');
      expect(plan.target).toBe('dev-client');
      expect(argvOf(plan.steps)).toEqual([['expo', 'run:ios']]);
      expect(plan.reasons.join('\n')).toMatch(/Nothing that prebuild writes has changed/);
    });

    it(`should say what moved, so the skipped prebuild is not a silent decision`, () => {
      const state = createDevClientState({
        fingerprint: { hash: 'head', sources: [easJson('changed')] },
      });
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recordedWithSources('ios', 'base', [easJson('a')]),
      });

      expect(plan.reasons.join('\n')).toMatch(/build configuration changed/);
      expect(plan.reasons.join('\n')).toMatch(/prebuild is not needed/);
    });

    it(`should still be a build, so a plan that runs on EAS keeps its build location`, () => {
      const state = createDevClientState({
        fingerprint: { hash: 'head', sources: [easJson('changed')] },
      });
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recordedWithSources('ios', 'base', [easJson('a')]),
      });

      expect(plan.buildLocation).not.toBeNull();
    });
  });

  describe('rule: dev-client-stale', () => {
    it(`should prebuild and build when no build was recorded`, () => {
      const plan = decideStartPlan(createDevClientState(), { platform: 'ios' });

      expect(plan.rule).toBe('dev-client-stale');
      expect(plan.target).toBe('dev-client');
      expect(argvOf(plan.steps)).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios'],
      ]);
      expect(plan.steps.map((step) => step.timeClass)).toEqual(['a-minute', 'many-minutes']);
      expect(plan.reasons.join('\n')).toMatch(/No development build recorded for ios/);
    });

    it(`should prebuild and build when the fingerprint changed`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'android',
        lastBuild: recorded('android', 'a-different-hash'),
      });

      expect(plan.rule).toBe('dev-client-stale');
      expect(argvOf(plan.steps)).toEqual([
        ['expo', 'prebuild', '--platform', 'android'],
        ['expo', 'run:android'],
      ]);
      expect(plan.reasons.join('\n')).toMatch(/differs from the last recorded build/);
    });

    // @ref llp/0004-smart-start-and-project-state.rfc.md §Decision table
    //
    // The conservative half of the split, and the one that has to keep working: a record with no
    // `sources` is what every older CLI wrote, and there is nothing to diff against it. The table
    // cannot tell what moved, so it plans the prebuild it always planned.
    it(`should still prebuild when the record stored only a hash`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        lastBuild: recorded('ios', 'a-different-hash'),
      });

      expect(plan.rule).toBe('dev-client-stale');
      expect(argvOf(plan.steps)).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios'],
      ]);
      expect(plan.reasons.join('\n')).toMatch(/stored only a hash/);
    });

    // Found by `e2e/__tests__/dev-test.ts` before this row existed here: the stub fingerprint
    // returns `sources: []`, so the hash moved over a diff that explains nothing — and the split
    // read "no source prebuild owns changed" out of a list it never saw, and skipped the prebuild.
    // A change nobody can account for is the case the conservative default is *for*.
    it(`should prebuild when the hash moved but the diff explains nothing`, () => {
      const state = createDevClientState({ fingerprint: { hash: 'head', sources: [] } });
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recordedWithSources('ios', 'base', []),
      });

      expect(plan.rule).toBe('dev-client-stale');
      expect(argvOf(plan.steps)).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios'],
      ]);
    });

    it(`should prebuild when the app config is what moved`, () => {
      const state = createDevClientState({
        fingerprint: { hash: 'head', sources: [appConfig('changed'), easJson('a')] },
      });
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recordedWithSources('ios', 'base', [appConfig('a'), easJson('a')]),
      });

      expect(plan.rule).toBe('dev-client-stale');
      expect(argvOf(plan.steps)).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios'],
      ]);
      expect(plan.reasons.join('\n')).toMatch(/app config changed/);
    });

    it(`should prebuild when one source of a mixed diff is one prebuild owns`, () => {
      const state = createDevClientState({
        fingerprint: { hash: 'head', sources: [appConfig('changed'), easJson('changed')] },
      });
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recordedWithSources('ios', 'base', [appConfig('a'), easJson('a')]),
      });

      expect(plan.rule).toBe('dev-client-stale');
      expect(argvOf(plan.steps)[0]).toEqual(['expo', 'prebuild', '--platform', 'ios']);
    });

    it(`should build when the fingerprint could not be computed`, () => {
      const state = createDevClientState({
        fingerprint: { hash: null, error: 'fingerprint exited with code 1' },
      });
      const plan = decideStartPlan(state, { platform: 'ios', lastBuild: recorded('ios', 'any-hash') });

      expect(plan.rule).toBe('dev-client-stale');
      expect(plan.reasons).toContain('Fingerprint error: fingerprint exited with code 1');
      // The error can be long, so it stays out of the step reason.
      expect(plan.steps[1]!.reason).not.toMatch(/exited with code 1/);
      expect(plan.steps[1]!.reason).toMatch(/fingerprint is unavailable/i);
    });

    it(`should build when the fingerprint is missing without an error`, () => {
      const state = createDevClientState({ fingerprint: { hash: null } });
      const plan = decideStartPlan(state, { platform: 'ios', lastBuild: recorded('ios', 'any-hash') });

      expect(plan.rule).toBe('dev-client-stale');
      expect(plan.reasons.join('\n')).toMatch(/fingerprint is unavailable/i);
    });
  });

  describe('rule: bare-stale', () => {
    it(`should build without prebuilding when native directories are checked in`, () => {
      const plan = decideStartPlan(
        createDevClientState({ nativeDirs: { ios: true, android: false } }),
        { platform: 'ios' }
      );

      expect(plan.rule).toBe('bare-stale');
      expect(plan.target).toBe('bare');
      expect(argvOf(plan.steps)).toEqual([['expo', 'run:ios']]);
      expect(plan.steps[0]!.timeClass).toBe('many-minutes');
    });

    it(`should build a bare project that has no expo-dev-client dependency`, () => {
      const plan = decideStartPlan(createState({ nativeDirs: { ios: false, android: true } }), {
        platform: 'android',
      });

      expect(plan.rule).toBe('bare-stale');
      expect(argvOf(plan.steps)).toEqual([['expo', 'run:android']]);
    });

    it(`should build the requested platform when both native directories exist`, () => {
      const plan = decideStartPlan(
        createDevClientState({ nativeDirs: { ios: true, android: true } }),
        { platform: 'android' }
      );

      expect(plan.rule).toBe('bare-stale');
      expect(argvOf(plan.steps)).toEqual([['expo', 'run:android']]);
    });

    it(`should default to iOS when both native directories exist and no platform is requested`, () => {
      const plan = decideStartPlan(
        createDevClientState({ nativeDirs: { ios: true, android: true } })
      );

      expect(argvOf(plan.steps)).toEqual([['expo', 'run:ios']]);
    });

    it(`should infer the platform from the only native directory`, () => {
      const plan = decideStartPlan(
        createDevClientState({ nativeDirs: { ios: false, android: true } })
      );

      expect(argvOf(plan.steps)).toEqual([['expo', 'run:android']]);
    });
  });

  describe('rule: bare-fresh', () => {
    it(`should only start the dev server when the fingerprint matches the last build`, () => {
      const state = createDevClientState({ nativeDirs: { ios: true, android: false } });
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recorded('ios', state.fingerprint.hash!),
      });

      expect(plan.rule).toBe('bare-fresh');
      expect(plan.target).toBe('bare');
      expect(argvOf(plan.steps)).toEqual([['expo', 'start', '--dev-client']]);
    });
  });

  describe('rule: needs-dev-client', () => {
    it(`should install expo-dev-client, prebuild, and build`, () => {
      const state = createDevClientState({ usesDevClient: false });
      const plan = decideStartPlan(state, { platform: 'ios' });

      expect(plan.rule).toBe('needs-dev-client');
      expect(plan.target).toBe('dev-client');
      expect(argvOf(plan.steps)).toEqual([
        ['expo', 'install', 'expo-dev-client'],
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios'],
      ]);
      expect(plan.steps.map((step) => step.timeClass)).toEqual([
        'a-minute',
        'a-minute',
        'many-minutes',
      ]);
      expect(plan.reasons.join('\n')).toMatch(/react-native-mmkv is not bundled in Expo Go/);
    });

    it(`should install expo-dev-client even when the fingerprint matches a recorded build`, () => {
      const state = createDevClientState({ usesDevClient: false });
      const plan = decideStartPlan(state, {
        platform: 'ios',
        lastBuild: recorded('ios', state.fingerprint.hash!),
      });

      expect(plan.rule).toBe('needs-dev-client');
    });

    it(`should report an unknown SDK version as the reason it cannot use Expo Go`, () => {
      const state = createState({
        sdkVersion: null,
        expoGo: {
          compatible: false,
          reasons: [{ kind: 'unknown-sdk', detail: 'Could not resolve the expo package version' }],
        },
      });
      const plan = decideStartPlan(state, { platform: 'ios' });

      expect(plan.rule).toBe('needs-dev-client');
      expect(plan.reasons.join('\n')).toMatch(/Expo SDK version is unknown/);
      expect(plan.reasons.join('\n')).toMatch(/Could not resolve the expo package version/);
    });
  });

  describe('plan shape', () => {
    const cases: [string, ProjectState, Parameters<typeof decideStartPlan>[1]][] = [
      ['web', createState(), { platform: 'web' }],
      ['expo-go', createState(), {}],
      [
        'dev-client-fresh',
        createDevClientState(),
        { platform: 'ios', lastBuild: recorded('ios', 'abc123def4567890') },
      ],
      ['dev-client-stale', createDevClientState(), { platform: 'ios' }],
      ['bare-stale', createDevClientState({ nativeDirs: { ios: true, android: false } }), {}],
      [
        'bare-fresh',
        createDevClientState({ nativeDirs: { ios: true, android: false } }),
        { lastBuild: recorded('ios', 'abc123def4567890') },
      ],
      ['needs-dev-client', createDevClientState({ usesDevClient: false }), { platform: 'ios' }],
    ];

    it.each(cases)(`should describe every step of the %s plan`, (rule, state, options) => {
      const plan = decideStartPlan(state, options);

      expect(plan.rule).toBe(rule);
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.reasons.length).toBeGreaterThan(0);
      expect(new Set(plan.steps.map((step) => step.id)).size).toBe(plan.steps.length);
      for (const step of plan.steps) {
        expect(step.argv[0]).toBe('expo');
        expect(step.reason).not.toBe('');
        expect(step.timeClass).toBeTruthy();
      }
    });

    it(`should report the probed facts as reasons`, () => {
      const plan = decideStartPlan(createDevClientState(), { platform: 'ios' });

      expect(plan.reasons).toEqual([
        'Expo SDK 54.0.0.',
        'No platform was named; this host suggests ios, and the plan builds for it.',
        'No bare native directories, so the native project comes from prebuild (CNG).',
        'expo-dev-client is a dependency.',
        'Expo Go cannot run this project: react-native-mmkv is not bundled in Expo Go.',
        'No development build recorded for ios, so a build is needed.',
      ]);
    });
  });

  // The reason list used to say `Target platform: ios.` whether or not anyone had named a platform
  // and whether or not the plan did anything with it, so an agent read "the target is iOS" beside
  // an argv that opens nothing on iOS [observed — friction run 2, 2026-08-23].
  describe('the platform reason', () => {
    it(`should say so when the caller named the platform`, () => {
      const plan = decideStartPlan(createState(), {
        platform: 'ios',
        requestedPlatform: 'ios',
      });

      expect(plan.reasons).toContain('Target platform: ios, named on the command line.');
    });

    it(`should name the inference, and say the plan opens nothing on it`, () => {
      const plan = decideStartPlan(createState(), { platform: 'ios' });

      expect(plan.steps[0]!.argv).toEqual(['expo', 'start', '--go']);
      expect(plan.reasons).toContain(
        'No platform was named; this host suggests ios, and the plan opens nothing on it — pass --ios or --android, or run "@expo/agent-cli navigate /" once the dev server is up.'
      );
    });

    it(`should say the plan builds for an inferred platform when a step does`, () => {
      const plan = decideStartPlan(createDevClientState(), { platform: 'android' });

      expect(plan.steps.at(-1)!.argv).toEqual(['expo', 'run:android']);
      expect(plan.reasons).toContain(
        'No platform was named; this host suggests android, and the plan builds for it.'
      );
    });
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §The selection
  describe('the EAS backend', () => {
    it(`should replace prebuild and run:* with one cloud build and a dev server`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        buildBackend: backend('eas'),
      });

      expect(argvOf(plan.steps)).toEqual([
        ['eas', 'build', '--platform', 'ios', '--profile', 'development'],
        ['expo', 'start', '--dev-client'],
      ]);
      expect(plan.rule).toBe('dev-client-stale');
      expect(plan.target).toBe('dev-client');
    });

    it(`should label the cloud build as running on eas and the dev server as running nowhere`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        buildBackend: backend('eas'),
      });

      expect(plan.steps.map((step) => [step.id, step.runsOn])).toEqual([
        ['eas-build', 'eas'],
        ['start', null],
      ]);
    });

    it(`should point the plan's build location at the cloud, with the local build as the alternative`, () => {
      const chosen = backend('eas');
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'android',
        buildBackend: chosen,
      });

      expect(plan.buildLocation).toMatchObject({
        runsOn: 'eas',
        platform: 'android',
        alternativeCommand: 'npx expo run:android',
        selection: chosen,
      });
    });

    it(`should say why the backend was chosen, in the plan's own reasons`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        buildBackend: backend('eas', {
          why: 'Building in the cloud on EAS: this host runs linux.',
        }),
      });

      expect(plan.reasons).toContain('Building in the cloud on EAS: this host runs linux.');
      expect(plan.reasons).toContain(
        'The cloud build generates the native project itself, so this plan has no prebuild step.'
      );
    });

    it(`should tell the reader that the artifact has to be installed before the dev server helps`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        buildBackend: backend('eas'),
      });

      expect(plan.steps[0]!.reason).toContain('npx eas build:run --platform ios --latest');
      expect(plan.steps[1]!.reason).toContain('serves nothing until the artifact is installed');
    });

    it(`should configure eas.json first when the project has none`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        buildBackend: backend('eas'),
        easJson: false,
      });

      expect(argvOf(plan.steps)[0]).toEqual(['eas', 'build:configure']);
      expect(plan.reasons).toContain(
        'This project has no eas.json, so the plan configures one first; that step may ask which platforms to set up.'
      );
    });

    it(`should not configure eas.json when the project already has one`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        buildBackend: backend('eas'),
        easJson: true,
      });

      expect(argvOf(plan.steps)[0]).toEqual([
        'eas',
        'build',
        '--platform',
        'ios',
        '--profile',
        'development',
      ]);
    });

    it(`should keep the install step of a project that has no expo-dev-client yet`, () => {
      const state = createState({ expoGo: { compatible: false, reasons: [] } });
      const plan = decideStartPlan(state, { platform: 'ios', buildBackend: backend('eas') });

      expect(plan.rule).toBe('needs-dev-client');
      expect(argvOf(plan.steps)).toEqual([
        ['expo', 'install', 'expo-dev-client'],
        ['eas', 'build', '--platform', 'ios', '--profile', 'development'],
        ['expo', 'start', '--dev-client'],
      ]);
    });

    it(`should take a bare project to the cloud without touching its native directories`, () => {
      const state = createDevClientState({ nativeDirs: { ios: true, android: false } });
      const plan = decideStartPlan(state, { platform: 'ios', buildBackend: backend('eas') });

      expect(plan.rule).toBe('bare-stale');
      expect(argvOf(plan.steps)).toEqual([
        ['eas', 'build', '--platform', 'ios', '--profile', 'development'],
        ['expo', 'start', '--dev-client'],
      ]);
    });

    it(`should leave a plan that builds nothing alone`, () => {
      const plan = decideStartPlan(createState(), {
        platform: 'ios',
        buildBackend: backend('eas'),
      });

      expect(plan.rule).toBe('expo-go');
      expect(argvOf(plan.steps)).toEqual([['expo', 'start', '--go']]);
      expect(plan.buildLocation).toBeNull();
    });
  });

  describe('the local backend', () => {
    it(`should keep the steps it has always had, and carry the choice on the plan`, () => {
      const chosen = backend('local');
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        buildBackend: chosen,
      });

      expect(argvOf(plan.steps)).toEqual([
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios'],
      ]);
      expect(plan.buildLocation).toMatchObject({ runsOn: 'local', selection: chosen });
      expect(plan.reasons).toContain(chosen.why);
    });

    it(`should say out loud that an explicit local build cannot work on this host`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        buildBackend: backend('local', { source: 'config', doomed: true }),
      });

      expect(plan.reasons).toContain(
        'That was asked for explicitly, so the plan above is the plan that runs — and its build step will fail, because nothing on this host can perform it. Remove the choice, or pass --eas, to build for ios in the cloud on EAS instead.'
      );
    });
  });

  // @ref llp/0015-backend-selection-and-config.rfc.md §The run target
  describe('the run target', () => {
    it(`should plan a development build for a project Expo Go could run`, () => {
      const plan = decideStartPlan(createState(), {
        platform: 'ios',
        runTarget: runTarget('dev-build'),
      });

      expect(plan.rule).toBe('needs-dev-client');
      expect(plan.target).toBe('dev-client');
      expect(argvOf(plan.steps)).toEqual([
        ['expo', 'install', 'expo-dev-client'],
        ['expo', 'prebuild', '--platform', 'ios'],
        ['expo', 'run:ios'],
      ]);
    });

    it(`should label the plan it changed`, () => {
      const plan = decideStartPlan(createState(), {
        platform: 'ios',
        runTarget: runTarget('dev-build'),
      });

      expect(plan.reasons).toContain(
        'dev-build was asked for, for this test. Expo Go could run this project, and the plan builds one anyway.'
      );
    });

    it(`should change nothing for a project that already needs a development build`, () => {
      const withTarget = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        runTarget: runTarget('dev-build'),
      });
      const without = decideStartPlan(createDevClientState(), { platform: 'ios' });

      expect(argvOf(withTarget.steps)).toEqual(argvOf(without.steps));
      expect(withTarget.reasons).toContain(
        'dev-build was asked for, for this test. Expo Go could not have run this project in any case.'
      );
    });

    it(`should keep the Expo Go plan when Expo Go was asked for and can run it`, () => {
      const plan = decideStartPlan(createState(), {
        platform: 'ios',
        runTarget: runTarget('expo-go'),
      });

      expect(plan.rule).toBe('expo-go');
      expect(plan.reasons).toContain(
        'expo-go was asked for, for this test. Expo Go can run this project, so that is what the plan uses.'
      );
    });

    it(`should not pretend a project Expo Go cannot run will run in it`, () => {
      const plan = decideStartPlan(createDevClientState(), {
        platform: 'ios',
        runTarget: runTarget('expo-go'),
      });

      expect(plan.rule).toBe('dev-client-stale');
      expect(plan.reasons).toContain(
        'expo-go was asked for, for this test. Expo Go cannot run this project, so the plan is a development build regardless — the reasons are above.'
      );
    });
  });
});
