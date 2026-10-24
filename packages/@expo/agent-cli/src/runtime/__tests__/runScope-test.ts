import type { CdpTarget } from '../cdpClient';
import { placeTargets, scopeOfFlags } from '../runScope';
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
    ).toEqual({ read, otherPlatform, undetermined });
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
    });
  });
});
