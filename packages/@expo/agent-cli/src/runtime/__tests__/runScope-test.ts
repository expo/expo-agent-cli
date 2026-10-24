import type { CdpTarget } from '../cdpClient';
import type { BoundDevice } from '../../deviceBinding/types';
import { placeTargets, scopeOfBoundDevice, scopeOfFlags } from '../runScope';
import { makeDeviceFacts } from './runScopeFixtures';

/** One dev server with an iOS simulator and an Android emulator attached [captured — 2026-08-25]. */
const LIVE_TARGETS: CdpTarget[] = require('./fixtures/json-list-ios-and-android.json');

const ios = LIVE_TARGETS.find((target) => target.appId === 'host.exp.Exponent')!;
const android = LIVE_TARGETS.find((target) => target.appId === 'host.exp.exponent')!;
const unknown = { appId: 'com.example.app', deviceName: 'Ada’s phone' } as CdpTarget;

describe(placeTargets, () => {
  it.each([
    {
      name: 'a platform scope keeps an undetermined target out of the read set',
      platform: 'android' as const,
      read: [android],
      otherPlatform: [{ target: ios, platform: 'ios' }],
      undetermined: [unknown],
    },
    {
      name: 'a scope with no platform reads every target',
      platform: null,
      read: [...LIVE_TARGETS, unknown],
      otherPlatform: [],
      undetermined: [],
    },
  ])('$name', ({ platform, read, otherPlatform, undetermined }) => {
    expect(
      placeTargets(
        [...LIVE_TARGETS, unknown],
        scopeOfFlags({ platform, eas: false }),
        makeDeviceFacts()
      )
    ).toEqual({ read, otherPlatform, undetermined, skipped: [] });
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Android — the EAS Simulator iOS session rule.
// The target an EAS Simulator iOS session registers: the project's own app id, and the cloud
// simulator's model name, which no local tool on this machine reports.
describe('placeTargets on an EAS Simulator session', () => {
  const cloud = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17' } as CdpTarget;
  const secondCloud = { appId: 'dev.vonovak.cyclable', deviceName: 'iPad Air' } as CdpTarget;
  const local = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17 Pro' } as CdpTarget;
  const facts = makeDeviceFacts({ booted: [{ name: 'iPhone 17 Pro', udid: 'LOCAL-1' }] });

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
      read: [local, cloud],
      undetermined: [],
    },
    {
      name: 'reads neither of two unclaimed targets',
      targets: [cloud, secondCloud],
      platform: 'ios' as const,
      eas: true,
      read: [],
      undetermined: [cloud, secondCloud],
    },
    {
      name: 'reads no unclaimed target on a run without --eas',
      targets: [cloud],
      platform: 'ios' as const,
      eas: false,
      read: [],
      undetermined: [cloud],
    },
    {
      name: 'reads no unclaimed target on an Android session, whose names have their own rule',
      targets: [cloud],
      platform: 'android' as const,
      eas: true,
      read: [],
      undetermined: [cloud],
    },
  ])('$name', ({ targets, platform, eas, read, undetermined }) => {
    expect(placeTargets(targets, scopeOfFlags({ platform, eas }), facts)).toEqual({
      read,
      otherPlatform: [],
      undetermined,
      skipped: [],
    });
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

describe('placeTargets and the worktree that bound the simulator', () => {
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
  ])('$name', ({ booted, iosBindings, projectRoots }) => {
    const facts = makeDeviceFacts({
      booted: booted.map((udid) => ({ name: CLONE, udid })),
      iosBindings,
    });

    expect(placeTargets([ON_CLONE], scopeOfFlags({ platform: null, eas: false }), facts)).toEqual({
      read: projectRoots == null ? [ON_CLONE] : [],
      otherPlatform: [],
      undetermined: [],
      skipped:
        projectRoots == null
          ? []
          : [{ target: ON_CLONE, placement: { group: 'other-worktree', projectRoots } }],
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
    const facts = makeDeviceFacts({
      booted: [{ name: CLONE, udid: 'SIM-A' }],
      iosBindings: [bound('SIM-A', '/wt/legend')],
    });

    const placed = placeTargets(targets, scopeOfFlags({ platform, eas }), facts);

    expect(placed.read).toEqual(read);
    expect(placed.skipped.map((entry) => entry.target)).toEqual([targets[0]]);
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Readers
// The device bound to this worktree is the scope of a read with no flag. A local Android target
// carries only the model, so an Android device scopes the platform; a local simulator's targets
// carry its name, so a simulator scopes the device too.
describe('placeTargets on the device bound to this worktree', () => {
  const onOwn = { appId: 'host.exp.Exponent', deviceName: 'iPhone 17 Pro' } as CdpTarget;
  const onOther = { appId: 'host.exp.Exponent', deviceName: 'iPhone 16' } as CdpTarget;
  const onSession = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17' } as CdpTarget;

  it.each([
    {
      name: 'a local simulator reads only the target that carries its name',
      device: {
        backend: 'local-ios',
        platform: 'ios',
        udid: 'SIM-OWN',
        name: 'iPhone 17 Pro',
        origin: 'created',
      } as BoundDevice,
      targets: [onOther, onOwn, android],
      read: [onOwn],
      otherPlatform: [{ target: android, platform: 'android' }],
      undetermined: [],
      skipped: [{ target: onOther, placement: { group: 'other-device' } }],
    },
    {
      name: 'a local Android device reads every target of its platform',
      device: {
        backend: 'local-android',
        platform: 'android',
        serial: 'emulator-5554',
        origin: { kind: 'explicit' },
      } as BoundDevice,
      targets: [ios, android, unknown],
      read: [android],
      otherPlatform: [{ target: ios, platform: 'ios' }],
      undetermined: [unknown],
      skipped: [],
    },
    {
      name: 'an EAS Simulator iOS session reads its one unclaimed target',
      device: {
        backend: 'cloud',
        platform: 'ios',
        id: '01a15bf1',
        origin: 'started',
      } as BoundDevice,
      targets: [onSession, android],
      read: [onSession],
      otherPlatform: [{ target: android, platform: 'android' }],
      undetermined: [],
      skipped: [],
    },
  ])('$name', ({ device, targets, read, otherPlatform, undetermined, skipped }) => {
    expect(placeTargets(targets, scopeOfBoundDevice(device), makeDeviceFacts())).toEqual({
      read,
      otherPlatform,
      undetermined,
      skipped,
    });
  });
});
