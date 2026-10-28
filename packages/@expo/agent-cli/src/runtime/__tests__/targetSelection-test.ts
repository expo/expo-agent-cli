import type { CdpTarget } from '../cdpClient';
import { resolveTargetSelectionAsync } from '../resolveTargetSelection';
import { classifyTargets } from '../targetSelection';
import { makeTargetSelection } from './targetSelectionFixtures';
import { makeDeviceInventory } from './targetSelectionFixtures';

// @ref llp/0005-runtime-loop-tools.rfc.md §Android — the EAS Simulator iOS session rule.
// The target an EAS Simulator iOS session registers: the project's own app id, and the cloud
// simulator's model name, which no local tool on this machine reports.
describe('classifyTargets on an EAS Simulator session', () => {
  const cloud = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17' } as CdpTarget;
  const local = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17 Pro' } as CdpTarget;
  const expoGo = { appId: 'host.exp.Exponent', deviceName: 'iPhone 17' } as CdpTarget;
  const deviceInventory = makeDeviceInventory({
    booted: [{ name: 'iPhone 17 Pro', udid: 'LOCAL-1' }],
  });

  it.each([
    {
      name: 'reads the one unclaimed target on an iOS session',
      targets: [cloud],
      platform: 'ios' as const,
      eas: true,
      read: [cloud],
      undetermined: [],
    },
    {
      name: 'reads the one unclaimed target beside a booted local simulator',
      targets: [local, cloud],
      platform: 'ios' as const,
      eas: true,
      read: [cloud],
      skipped: [{ target: local, classification: { group: 'other-device' } }],
      undetermined: [],
    },
    {
      name: 'reads an Expo Go target that no booted local simulator has',
      targets: [expoGo],
      platform: 'ios' as const,
      eas: true,
      read: [expoGo],
      undetermined: [],
    },
    {
      name: 'reads no Expo Go target while the local simulators are unknown',
      targets: [expoGo],
      platform: 'ios' as const,
      eas: true,
      inventory: makeDeviceInventory({ bootedStatus: 'unknown' }),
      read: [],
      undetermined: [expoGo],
    },
  ])('$name', ({ targets, platform, eas, read, undetermined, skipped = [], inventory }) => {
    expect(
      classifyTargets(
        targets,
        makeTargetSelection({
          platform: { value: platform, by: 'flag' },
          device: eas ? { backend: 'cloud', deviceId: null } : null,
        }),
        inventory ?? deviceInventory
      )
    ).toEqual({
      read,
      skipped,
      otherPlatform: [],
      undetermined,
    });
  });

  // An Android session's own app is already read, so the session is not iOS, and the unclaimed
  // target may be a development build on a physical phone.
  it('reads no unclaimed target beside an Android session app, with no platform', () => {
    const androidSession = {
      appId: 'dev.vonovak.cyclable',
      deviceName: 'sdk_gphone64_x86_64 - 15 - API 35',
    } as CdpTarget;
    const unclaimed = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17' } as CdpTarget;

    expect(
      classifyTargets(
        [androidSession, unclaimed],
        makeTargetSelection({ platform: null, device: { backend: 'cloud', deviceId: null } }),
        makeDeviceInventory({ booted: [{ name: 'iPhone 17 Pro', udid: 'LOCAL-1' }] })
      )
    ).toEqual({
      read: [androidSession],
      skipped: [],
      otherPlatform: [],
      undetermined: [unclaimed],
    });
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Which app a run reads — `--eas` with no platform.
describe('resolveTargetSelectionAsync with --eas and no platform', () => {
  const session = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17' } as CdpTarget;
  const localExpoGo = { appId: 'host.exp.Exponent', deviceName: 'iPhone 17 Pro' } as CdpTarget;

  it.each([
    {
      name: 'holds every unclaimed target while the local simulators are unknown',
      inventory: makeDeviceInventory({ bootedStatus: 'unknown' }),
      read: [],
      undetermined: [localExpoGo, session],
      skipped: [],
    },
  ])('$name', async ({ inventory, read, undetermined, skipped }) => {
    const { classifiedTargets } = await resolveTargetSelectionAsync({
      projectRoot: null,
      flags: { platform: null, eas: true },
      targets: [localExpoGo, session],
      deviceInventory: inventory,
    });
    expect(classifiedTargets).toEqual({ read, undetermined, skipped, otherPlatform: [] });
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// Another worktree's clone simulator, still booted, loads its JavaScript from this port. A target
// names its device by name only; the booted simulators and the live bindings say whose it is.
const CLONE = 'agent-cli c4ed0a60';
const ON_CLONE = { appId: 'host.exp.Exponent', deviceName: CLONE } as CdpTarget;
const bound = (udid: string, projectRoot: string, own = false) => ({
  udid,
  name: CLONE,
  projectRoot,
  own,
});

describe('classifyTargets and the worktree that bound the simulator', () => {
  it.each([
    {
      name: 'skips a target when only another worktree binds its booted simulator',
      booted: ['SIM-A'],
      iosBindings: [bound('SIM-A', '/wt/legend')],
      projectRoots: ['/wt/legend'],
    },
    {
      name: 'reads a target on the simulator this worktree binds',
      booted: ['SIM-A'],
      iosBindings: [bound('SIM-A', '/wt/mapfilter', true)],
      projectRoots: null,
    },
    {
      name: 'reads a target on a simulator this worktree and another one both bind',
      booted: ['SIM-A'],
      iosBindings: [bound('SIM-A', '/wt/legend'), bound('SIM-A', '/wt/mapfilter', true)],
      projectRoots: null,
    },
    {
      name: 'reads a target on a simulator no live binding names',
      booted: ['SIM-A'],
      iosBindings: [],
      projectRoots: null,
    },
    {
      name: 'reads a target when one of two booted simulators with its name is bound elsewhere',
      booted: ['SIM-A', 'SIM-B'],
      iosBindings: [bound('SIM-A', '/wt/legend')],
      projectRoots: null,
    },
    {
      name: 'skips a target when each booted simulator with its name is bound elsewhere',
      booted: ['SIM-A', 'SIM-B'],
      iosBindings: [bound('SIM-A', '/wt/legend'), bound('SIM-B', '/wt/other')],
      projectRoots: ['/wt/legend', '/wt/other'],
    },
    {
      name: 'reads a target when no simulator with its name is booted',
      booted: [],
      iosBindings: [bound('SIM-A', '/wt/legend')],
      projectRoots: null,
    },
    {
      name: "skips a target with a foreign binding's name when the simulator list could not be read",
      booted: [],
      bootedStatus: 'unknown' as const,
      iosBindings: [bound('SIM-B', '/wt/b')],
      projectRoots: ['/wt/b'],
    },
  ])('$name', ({ booted, bootedStatus = 'observed' as const, iosBindings, projectRoots }) => {
    const deviceInventory = makeDeviceInventory({
      booted: booted.map((udid) => ({ name: CLONE, udid })),
      bootedStatus,
      iosBindings,
    });

    expect(
      classifyTargets(
        [ON_CLONE],
        makeTargetSelection({ platform: null, device: null }),
        deviceInventory
      )
    ).toEqual({
      read: projectRoots == null ? [ON_CLONE] : [],
      otherPlatform: [],
      undetermined: [],
      skipped:
        projectRoots == null
          ? []
          : [{ target: ON_CLONE, classification: { group: 'other-worktree', projectRoots } }],
    });
  });

  // Out of every scope: not read with a platform flag or without one, and on an EAS Simulator iOS
  // session it does not take the one unclaimed slot that is the session's app.
  it.each([
    {
      name: 'with no platform flag',
      targets: [ON_CLONE, android],
      platform: null,
      eas: false,
      read: [android],
    },
    {
      name: 'of its own platform',
      targets: [ON_CLONE, android],
      platform: 'ios' as const,
      eas: false,
      read: [],
    },
    {
      name: 'of an EAS Simulator iOS session',
      targets: [
        { ...ON_CLONE, appId: 'dev.vonovak.cyclable' } as CdpTarget,
        { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17' } as CdpTarget,
      ],
      platform: 'ios' as const,
      eas: true,
      read: [{ appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17' }],
    },
  ])('keeps a skipped target out of the read set $name', ({ targets, platform, eas, read }) => {
    const deviceInventory = makeDeviceInventory({
      booted: [{ name: CLONE, udid: 'SIM-A' }],
      iosBindings: [bound('SIM-A', '/wt/legend')],
    });

    const classifiedTargets = classifyTargets(
      targets,
      makeTargetSelection({
        platform: platform == null ? null : { value: platform, by: 'flag' },
        device: eas ? { backend: 'cloud', deviceId: null } : null,
      }),
      deviceInventory
    );

    expect(classifiedTargets.read).toEqual(read);
    expect(classifiedTargets.skipped.map((entry) => entry.target)).toEqual([targets[0]]);
  });
});
