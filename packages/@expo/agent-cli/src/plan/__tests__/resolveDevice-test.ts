// @ref llp/0035-one-device-per-worktree.rfc.md §How `dev` uses it
// Where the resolver binds the device, and what it hands the presence probe.
import { vol } from 'memfs';

import type { AcquireResult } from '../../deviceBinding';
import { resetSettingsCache } from '../../settings';
import { detectToolchainAsync } from '../../toolchain';
import type { ToolchainProbe } from '../../toolchain/types';
import { resolveStartPlanAsync, type ResolveStartPlanOptions } from '../resolveAsync';
import { makeProjectState } from '../../project/__tests__/projectStateFixture';

vi.mock('../../toolchain', async () => {
  const actual = await vi.importActual('../../toolchain');
  return { ...actual, detectToolchainAsync: vi.fn() };
});

const projectRoot = '/project';

const ACQUIRED: AcquireResult = {
  device: {
    backend: 'local-ios',
    platform: 'ios',
    udid: 'SIM-1',
    name: 'agent-cli 0000',
    origin: 'created',
  },
  justBooted: true,
  action: 'created',
};

/** A managed project whose recorded iOS build matches: the draft serves and asks the device. */
function freshDevClient() {
  const project = makeProjectState({
    usesDevClient: true,
    expoGo: { compatible: false, reasons: [] },
  });
  return { state: project, lastBuild: { ios: { hash: project.fingerprint.hash!, sources: null } } };
}

function options(overrides: Partial<ResolveStartPlanOptions> = {}): ResolveStartPlanOptions {
  return {
    platform: 'ios',
    requestedPlatform: 'ios',
    probeAppPresence: async () => ({ presence: 'unknown' }),
    ...overrides,
  };
}

beforeEach(() => {
  resetSettingsCache();
  vol.reset();
  vol.fromJSON({ [`${projectRoot}/package.json`]: JSON.stringify({ name: 'app' }) });
  vi.mocked(detectToolchainAsync).mockImplementation(async (platform): Promise<ToolchainProbe> => ({
    platform,
    status: 'present',
    detail: '',
    requirement: '',
    caveats: [],
    impossible: false,
  }));
});

describe('the device the resolver binds', () => {
  // expo-go-and-bare-drafts-acquire
  it.each([
    ['expo-go', makeProjectState()],
    ['dev-client', freshDevClient().state],
    [
      'bare',
      makeProjectState({
        nativeDirs: { ios: true, android: true },
        expoGo: { compatible: false, reasons: [] },
      }),
    ],
  ])(`binds for an %s draft`, async (_target, project) => {
    const acquireDevice = vi.fn(async () => ACQUIRED);

    const { acquired } = await resolveStartPlanAsync(projectRoot, project, {
      ...options({ acquireDevice }),
      lastBuild: { ios: { hash: project.fingerprint.hash!, sources: null } },
    });

    expect(acquireDevice).toHaveBeenCalledTimes(1);
    expect(acquired).toBe(ACQUIRED);
  });

  it(`binds before the --no-open exit, so the install step can be pinned`, async () => {
    const acquireDevice = vi.fn(async () => ACQUIRED);
    const probeAppPresence = vi.fn(async () => ({
      presence: 'unknown' as const,
    }));

    const { plan, acquired } = await resolveStartPlanAsync(projectRoot, freshDevClient().state, {
      ...options({ acquireDevice, probeAppPresence, open: false }),
      lastBuild: freshDevClient().lastBuild,
    });

    expect(acquired).toBe(ACQUIRED);
    expect(probeAppPresence).not.toHaveBeenCalled();
    expect(plan.rule).toBe('dev-client-fresh');
  });

  it.each([
    [
      'a web draft',
      makeProjectState(),
      { platform: 'web' as const, requestedPlatform: 'web' as const },
    ],
    ['no requested platform', makeProjectState(), { requestedPlatform: undefined }],
    ['--eas', makeProjectState(), { deviceBackend: 'eas' as const }],
  ])(`binds nothing for %s`, async (_case, project, overrides) => {
    const acquireDevice = vi.fn(async () => ACQUIRED);

    const { acquired } = await resolveStartPlanAsync(
      projectRoot,
      project,
      options({ acquireDevice, ...overrides })
    );

    expect(acquireDevice).not.toHaveBeenCalled();
    expect(acquired).toBeNull();
  });

  it(`binds nothing for a draft that builds, which dev binds after its refusals`, async () => {
    const acquireDevice = vi.fn(async () => ACQUIRED);

    const { plan, acquired } = await resolveStartPlanAsync(
      projectRoot,
      makeProjectState({ usesDevClient: true, expoGo: { compatible: false, reasons: [] } }),
      options({ acquireDevice })
    );

    expect(plan.buildLocation).not.toBeNull();
    expect(acquireDevice).not.toHaveBeenCalled();
    expect(acquired).toBeNull();
  });

  // created-device-plans-install
  it(`hands the probe the bound device and its action, and plans the install it answers`, async () => {
    const probeAppPresence = vi.fn(async () => ({
      presence: 'missing' as const,
    }));
    const { state: project, lastBuild } = freshDevClient();

    const { plan } = await resolveStartPlanAsync(projectRoot, project, {
      ...options({ acquireDevice: async () => ACQUIRED, probeAppPresence }),
      lastBuild,
    });

    expect(probeAppPresence).toHaveBeenCalledWith(projectRoot, 'ios', {
      device: ACQUIRED.device,
      action: 'created',
    });
    expect(plan.rule).toBe('dev-client-install');
    expect(plan.steps.map((step) => step.argv)).toEqual([
      ['expo', 'run:ios', '--no-bundler'],
      ['expo', 'start', '--dev-client'],
    ]);
  });

  it(`hands the probe no device when nothing bound one`, async () => {
    const probeAppPresence = vi.fn(async () => ({
      presence: 'unknown' as const,
    }));
    const { state: project, lastBuild } = freshDevClient();

    await resolveStartPlanAsync(projectRoot, project, {
      ...options({ probeAppPresence }),
      lastBuild,
    });

    expect(probeAppPresence).toHaveBeenCalledWith(projectRoot, 'ios', {
      device: null,
      action: null,
    });
  });
});
