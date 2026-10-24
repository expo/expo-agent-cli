import type { CdpTarget } from '../cdpClient';
import { placeTargets, scopeOfPlatformFlag } from '../runScope';
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
      placeTargets([...LIVE_TARGETS, unknown], scopeOfPlatformFlag(platform), makeDeviceFacts())
    ).toEqual({ read, otherPlatform, undetermined });
  });
});
