// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
import type { CdpTarget } from '../../cdpClient';
import { placeTargets, scopeOfBoundDevice, scopeOfFlags, type RunScope } from '../../runScope';
import { makeDeviceFacts } from '../../__tests__/runScopeFixtures';
import { rungOnePolicy } from '../rungOne';

const CLONE = 'agent-cli c4ed0a60';
const facts = makeDeviceFacts({
  booted: [
    { name: CLONE, udid: 'SIM-LEGEND' },
    { name: 'iPhone 17', udid: 'SIM-OWN' },
  ],
  iosBindings: [{ udid: 'SIM-LEGEND', name: CLONE, projectRoot: '/wt/legend', own: false }],
});

function target(id: string, deviceName: string): CdpTarget {
  return { id, deviceName, appId: 'dev.example.app' } as CdpTarget;
}
const ownIos = target('own-ios', 'iPhone 17');
const ownAndroid = target('own-android', 'sdk_gphone64_arm64 - 15 - API 35');
const onClone = target('clone-1', CLONE);
/** A device no rule places, which a scope on another simulator skips. */
const elsewhere = target('far-1', 'Ada’s phone');

const ANY: RunScope = scopeOfFlags({ platform: null, eas: false });
const BOUND_SIMULATOR: RunScope = scopeOfBoundDevice(
  { backend: 'local-ios', platform: 'ios', udid: 'SIM-OWN', name: 'iPhone 17', origin: 'created' },
  'bound-device'
);

describe('what rung 1 does, and which bundle proves it', () => {
  it.each([
    {
      name: 'broadcasts, and any bundle proves, when no app is skipped',
      targets: [ownIos, ownAndroid],
      scope: ANY,
      mechanism: 'broadcast',
      bundlePlatforms: 'any',
    },
    {
      name: "broadcasts, and only the scope's platform proves, when no app is skipped",
      targets: [ownIos],
      scope: BOUND_SIMULATOR,
      mechanism: 'broadcast',
      bundlePlatforms: ['ios'],
    },
    {
      name: "an iOS bundle does not prove the own iOS app beside another worktree's iOS app",
      targets: [ownIos, onClone],
      scope: BOUND_SIMULATOR,
      mechanism: 'page-reload',
      bundlePlatforms: [],
    },
    {
      name: 'an Android bundle proves, with own iOS and Android apps beside a skipped iOS app',
      targets: [ownIos, ownAndroid, onClone],
      scope: ANY,
      mechanism: 'page-reload',
      bundlePlatforms: ['android'],
    },
    {
      name: 'no bundle proves beside a skipped app whose platform is unknown',
      targets: [ownIos, elsewhere],
      scope: BOUND_SIMULATOR,
      mechanism: 'page-reload',
      bundlePlatforms: [],
    },
  ])('$name', ({ targets, scope, mechanism, bundlePlatforms }) => {
    const policy = rungOnePolicy(placeTargets(targets, scope, facts), scope, facts);

    expect({ mechanism: policy.mechanism, bundlePlatforms: policy.bundlePlatforms }).toEqual({
      mechanism,
      bundlePlatforms,
    });
  });

  // The fresh-target wait reads targets the placement never saw: a page that re-registered has a
  // new id. So a target is skipped by its device, the key the placement used.
  it(`skips a new page of a skipped device, and counts a new page of an own device`, () => {
    const policy = rungOnePolicy(
      placeTargets([ownIos, onClone], BOUND_SIMULATOR, facts),
      BOUND_SIMULATOR,
      facts
    );

    expect(policy.isSkipped(target('clone-2', CLONE))).toBe(true);
    expect(policy.isSkipped(target('own-ios-2', 'iPhone 17'))).toBe(false);
  });
});
