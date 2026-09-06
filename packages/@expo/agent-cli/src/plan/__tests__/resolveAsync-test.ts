// @ref llp/0015-backend-selection-and-config.rfc.md §The selection
// The order the four inputs are read in — flag, config, host, probe — and the plan that comes out
// of each. The probe is stubbed; which probe answers what is `detect-test.ts`'s subject, and which
// answer wins is `selectBackend-test.ts`'s.
import { vol } from 'memfs';

import type { ProjectState } from '../../project/types';
import type { LastBuildRecord } from '../lastBuild';
import { resetSettingsCache } from '../../settings';
import { detectToolchainAsync } from '../../toolchain';
import type { ToolchainProbe, ToolchainStatus } from '../../toolchain/types';
import { resolveStartPlanAsync } from '../resolveAsync';

vi.mock('../../toolchain', async () => {
  const actual = await vi.importActual('../../toolchain');
  return { ...actual, detectToolchainAsync: vi.fn() };
});

const projectRoot = '/project';

function stubToolchain(status: ToolchainStatus, { impossible = false } = {}): void {
  vi.mocked(detectToolchainAsync).mockImplementation(
    async (platform): Promise<ToolchainProbe> => ({
      platform,
      status,
      detail: `The ${platform} toolchain is ${status}, for this test.`,
      requirement: `the ${platform} toolchain on this machine`,
      caveats: [],
      impossible,
    })
  );
}

/** A managed project that needs a development build, so every plan of it contains a build. */
function devClientState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    projectRoot,
    isExpoApp: true,
    sdkVersion: '54.0.0',
    nativeDirs: { ios: false, android: false },
    usesDevClient: true,
    hasWeb: false,
    expoGo: { compatible: false, reasons: [] },
    fingerprint: { hash: 'abc123def4567890' },
    ...overrides,
  };
}

/** A project Expo Go can run, whose plan builds nothing. */
function expoGoState(): ProjectState {
  return devClientState({ usesDevClient: false, expoGo: { compatible: true, reasons: [] } });
}

function writeProject(files: Record<string, unknown> = {}): void {
  vol.fromJSON(
    Object.fromEntries(
      Object.entries({ 'package.json': { name: 'app' }, ...files }).map(([name, contents]) => [
        `${projectRoot}/${name}`,
        typeof contents === 'string' ? contents : JSON.stringify(contents),
      ])
    )
  );
}

function argvOf(plan: { steps: { argv: string[] }[] }): string[][] {
  return plan.steps.map((step) => step.argv);
}

/** A probe that fails the test if it is called at all, for the rows about not spending it. */
const neverProbed = async (): Promise<never> => {
  throw new Error('the device was probed for a plan that has nothing to learn from it');
};

beforeEach(() => {
  resetSettingsCache();
  vol.reset();
  stubToolchain('present');
});

describe('a plan that builds nothing', () => {
  it(`asks the machine nothing at all`, async () => {
    writeProject();
    const plan = await resolveStartPlanAsync(projectRoot, expoGoState(), {
      platform: 'ios',
      probeAppPresence: neverProbed,
    });

    expect(plan.rule).toBe('expo-go');
    expect(detectToolchainAsync).not.toHaveBeenCalled();
  });
});

// @ref llp/0004-smart-start-and-project-state.rfc.md §A current build is not an installed app
//
// Where the two subprocesses of the device probe are spent, and where they are not. The rule is
// narrow on purpose: only a plan that *does not build* has anything to learn from the device,
// because a plan that builds ends in `expo run:*` and that command installs what it built.
describe('the device probe', () => {
  /** A project whose recorded build matches, which is the state that makes the device the question. */
  function freshProject(): { state: ProjectState; lastBuild: LastBuildRecord } {
    const state = devClientState();
    return { state, lastBuild: { ios: { hash: state.fingerprint.hash!, sources: null } } };
  }

  it(`installs before the dev server when the device has not got the app`, async () => {
    writeProject();
    const { state, lastBuild } = freshProject();

    const plan = await resolveStartPlanAsync(projectRoot, state, {
      platform: 'ios',
      requestedPlatform: 'ios',
      lastBuild,
      probeAppPresence: async () => ({ presence: 'missing', installDevice: null }),
    });

    expect(plan.rule).toBe('dev-client-install');
    expect(argvOf(plan)).toEqual([
      ['expo', 'run:ios', '--no-bundler'],
      ['expo', 'start', '--dev-client'],
    ]);
  });

  // In the argv itself, not added at run time: the plan approved is the plan run.
  it(`pins the install to the device the probe asked`, async () => {
    writeProject();
    const { state, lastBuild } = freshProject();

    const plan = await resolveStartPlanAsync(projectRoot, state, {
      platform: 'ios',
      requestedPlatform: 'ios',
      lastBuild,
      probeAppPresence: async () => ({ presence: 'missing', installDevice: 'UDID-1' }),
    });

    expect(argvOf(plan)[0]).toEqual(['expo', 'run:ios', '--no-bundler', '--device', 'UDID-1']);
  });

  it(`starts the dev server alone when the device has it`, async () => {
    writeProject();
    const { state, lastBuild } = freshProject();

    const plan = await resolveStartPlanAsync(projectRoot, state, {
      platform: 'ios',
      requestedPlatform: 'ios',
      lastBuild,
      probeAppPresence: async () => ({ presence: 'present', installDevice: null }),
    });

    expect(plan.rule).toBe('dev-client-fresh');
    expect(argvOf(plan)).toEqual([['expo', 'start', '--dev-client']]);
  });

  it(`asks about the platform the plan targets`, async () => {
    writeProject();
    const { state } = freshProject();
    const asked: string[] = [];

    await resolveStartPlanAsync(projectRoot, state, {
      platform: 'android',
      requestedPlatform: 'android',
      lastBuild: { android: { hash: state.fingerprint.hash!, sources: null } },
      probeAppPresence: async (_root, platform) => {
        asked.push(platform);
        return { presence: 'present', installDevice: null };
      },
    });

    expect(asked).toEqual(['android']);
  });

  // The install exists to serve the open. A --no-open caller — `smoke`, which installs the app in
  // its own phase, or an agent that opens with `navigate` — said it manages the device itself, so
  // `dev` must not touch one on the way to the dev server.
  it(`is not spent when the run opens nothing`, async () => {
    writeProject();
    const { state, lastBuild } = freshProject();

    const plan = await resolveStartPlanAsync(projectRoot, state, {
      platform: 'ios',
      requestedPlatform: 'ios',
      open: false,
      lastBuild,
      probeAppPresence: neverProbed,
    });

    expect(plan.rule).toBe('dev-client-fresh');
  });

  // `status` resolves the plan without a requestedPlatform, and must keep doing so: its report
  // promises to be instant, and a probe here would also make its `next` line disagree with the
  // sections that never probe.
  it(`is not spent without a typed platform flag, which is how status calls this`, async () => {
    writeProject();
    const { state, lastBuild } = freshProject();

    const plan = await resolveStartPlanAsync(projectRoot, state, {
      platform: 'ios',
      lastBuild,
      probeAppPresence: neverProbed,
    });

    expect(plan.rule).toBe('dev-client-fresh');
  });

  // `expo run:* --no-bundler` compiles when the toolchain cache is cold; a caller who routed
  // builds to EAS did not ask for a local compile on the way to a dev server.
  it(`is not spent when the caller routed builds to EAS`, async () => {
    writeProject();
    const { state, lastBuild } = freshProject();

    const plan = await resolveStartPlanAsync(projectRoot, state, {
      platform: 'ios',
      requestedPlatform: 'ios',
      lastBuild,
      requestedBackend: 'eas',
      probeAppPresence: neverProbed,
    });

    expect(plan.rule).toBe('dev-client-fresh');
  });

  // The install needs the toolchain even when nothing compiles: `expo run:ios` runs through Xcode
  // either way. A machine without it keeps the serve-only plan rather than gaining a step that can
  // only fail.
  it(`keeps the serve-only plan when this machine cannot run the install`, async () => {
    writeProject();
    stubToolchain('missing');
    const { state, lastBuild } = freshProject();

    const plan = await resolveStartPlanAsync(projectRoot, state, {
      platform: 'ios',
      requestedPlatform: 'ios',
      lastBuild,
      probeAppPresence: async () => ({ presence: 'missing', installDevice: null }),
    });

    expect(plan.rule).toBe('dev-client-fresh');
    expect(argvOf(plan)).toEqual([['expo', 'start', '--dev-client']]);
  });

  // The cost rule. A build installs what it builds, so the answer would change nothing and the
  // subprocesses would be spent on every stale run.
  it(`is not spent on a plan that builds`, async () => {
    writeProject();

    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), {
      platform: 'ios',
      requestedPlatform: 'ios',
      probeAppPresence: neverProbed,
    });

    expect(plan.rule).toBe('dev-client-stale');
  });

  it.each([
    ['an Expo Go project, whose runtime expo start installs itself', 'ios' as const],
    ['web, which opens a browser', 'web' as const],
  ])(`is not spent on %s`, async (_case, platform) => {
    writeProject();

    await resolveStartPlanAsync(projectRoot, expoGoState(), {
      platform,
      requestedPlatform: platform,
      probeAppPresence: neverProbed,
    });
  });
});

describe('detection', () => {
  it(`builds here when this machine has the toolchain`, async () => {
    writeProject();
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), { platform: 'ios' });

    expect(argvOf(plan)).toEqual([
      ['expo', 'prebuild', '--platform', 'ios'],
      ['expo', 'run:ios'],
    ]);
    expect(plan.buildLocation).toMatchObject({ runsOn: 'local' });
  });

  it(`builds on EAS when this machine does not`, async () => {
    writeProject({ 'eas.json': { build: {} } });
    stubToolchain('missing');
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), { platform: 'ios' });

    expect(argvOf(plan)).toEqual([
      ['eas', 'build', '--platform', 'ios', '--profile', 'development'],
      ['expo', 'start', '--dev-client'],
    ]);
    expect(plan.buildLocation).toMatchObject({ runsOn: 'eas', selection: { source: 'toolchain' } });
  });

  it(`blames the host, not the install, when no install could help`, async () => {
    writeProject({ 'eas.json': { build: {} } });
    stubToolchain('missing', { impossible: true });
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), {
      platform: 'ios',
      hostPlatform: 'linux',
    });

    expect(plan.buildLocation).toMatchObject({ runsOn: 'eas', selection: { source: 'host' } });
    expect(plan.buildLocation!.selection!.why).toContain('this host runs linux');
  });

  it(`keeps the local plan when the probe established nothing`, async () => {
    writeProject();
    stubToolchain('unknown');
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), { platform: 'ios' });

    expect(plan.buildLocation).toMatchObject({ runsOn: 'local' });
  });

  it(`configures eas.json first when the cloud route is taken and the project has none`, async () => {
    writeProject();
    stubToolchain('missing');
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), { platform: 'ios' });

    expect(argvOf(plan)[0]).toEqual(['eas', 'build:configure']);
  });

  it(`skips that step when the project already has an eas.json`, async () => {
    writeProject({ 'eas.json': { build: {} } });
    stubToolchain('missing');
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), { platform: 'ios' });

    expect(argvOf(plan)[0]).toEqual([
      'eas',
      'build',
      '--platform',
      'ios',
      '--profile',
      'development',
    ]);
  });

  it(`carries the probe's caveats into a plan that still builds here`, async () => {
    writeProject();
    vi.mocked(detectToolchainAsync).mockResolvedValue({
      platform: 'android',
      status: 'present',
      detail: 'Android SDK at /sdk.',
      requirement: 'the Android SDK on this machine',
      caveats: ['adb is not on PATH, though it is at /sdk/platform-tools.'],
      impossible: false,
    });
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), {
      platform: 'android',
    });

    expect(plan.reasons).toContain('adb is not on PATH, though it is at /sdk/platform-tools.');
  });
});

describe('the project config', () => {
  it(`moves a build to EAS on a machine that could do it here`, async () => {
    writeProject({ 'package.json': { name: 'app', expo: { agentCli: { buildBackend: 'eas' } } } });
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), { platform: 'ios' });

    expect(plan.buildLocation).toMatchObject({ runsOn: 'eas', selection: { source: 'config' } });
    expect(plan.reasons).toContain(
      'Building in the cloud on EAS: the @expo/agent-cli config asks for it — "expo.agentCli" in package.json.'
    );
  });

  it(`asks this machine nothing when it already said "the cloud"`, async () => {
    writeProject({ 'package.json': { name: 'app', expo: { agentCli: { buildBackend: 'eas' } } } });
    await resolveStartPlanAsync(projectRoot, devClientState(), { platform: 'ios' });

    // Two subprocesses that cannot change the answer are two subprocesses not spawned.
    expect(detectToolchainAsync).not.toHaveBeenCalled();
  });

  it(`applies a per-platform choice to that platform only`, async () => {
    writeProject({
      'package.json': {
        name: 'app',
        expo: { agentCli: { ios: { buildBackend: 'eas' } } },
      },
    });

    const ios = await resolveStartPlanAsync(projectRoot, devClientState(), { platform: 'ios' });
    const android = await resolveStartPlanAsync(projectRoot, devClientState(), {
      platform: 'android',
    });

    expect(ios.buildLocation).toMatchObject({ runsOn: 'eas' });
    expect(android.buildLocation).toMatchObject({ runsOn: 'local' });
  });

  it(`plans a development build for a project Expo Go could run`, async () => {
    writeProject({ 'package.json': { name: 'app', expo: { agentCli: { target: 'dev-build' } } } });
    const plan = await resolveStartPlanAsync(projectRoot, expoGoState(), { platform: 'ios' });

    expect(plan.rule).toBe('needs-dev-client');
    expect(plan.reasons).toContain(
      'The @expo/agent-cli config asks for a development build. Expo Go could run this project, and the plan builds one anyway.'
    );
  });

  it(`refuses a config it cannot read, rather than planning as though it were absent`, async () => {
    writeProject({
      'package.json': { name: 'app', expo: { agentCli: { buildBackend: 'cloud' } } },
    });

    await expect(
      resolveStartPlanAsync(projectRoot, devClientState(), { platform: 'ios' })
    ).rejects.toThrow(/"expo.agentCli" in package.json/);
  });
});

describe('a flag on the command line', () => {
  it(`beats a config that says the opposite`, async () => {
    writeProject({ 'package.json': { name: 'app', expo: { agentCli: { buildBackend: 'eas' } } } });
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), {
      platform: 'ios',
      requestedBackend: 'local',
    });

    expect(plan.buildLocation).toMatchObject({ runsOn: 'local', selection: { source: 'flag' } });
  });

  it(`beats detection, and is honoured even where it cannot work`, async () => {
    writeProject();
    stubToolchain('missing', { impossible: true });
    const plan = await resolveStartPlanAsync(projectRoot, devClientState(), {
      platform: 'ios',
      hostPlatform: 'win32',
      requestedBackend: 'local',
    });

    expect(argvOf(plan)).toEqual([
      ['expo', 'prebuild', '--platform', 'ios'],
      ['expo', 'run:ios'],
    ]);
    expect(plan.buildLocation!.selection).toMatchObject({ source: 'flag', doomed: true });
    expect(plan.reasons).toContain(
      'That was asked for explicitly, so the plan above is the plan that runs — and its build step will fail, because nothing on this host can perform it. Remove the choice, or pass --eas, to build for ios in the cloud on EAS instead.'
    );
  });

  it(`beats a config that asks for Expo Go`, async () => {
    writeProject({ 'package.json': { name: 'app', expo: { agentCli: { target: 'expo-go' } } } });
    const plan = await resolveStartPlanAsync(projectRoot, expoGoState(), {
      platform: 'ios',
      requestedTarget: 'dev-build',
    });

    expect(plan.rule).toBe('needs-dev-client');
    expect(plan.reasons).toContain(
      '--dev-client asked for a development build. Expo Go could run this project, and the plan builds one anyway.'
    );
  });
});
