// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
import type { CdpTarget } from '../../cdpClient';
import { classifyTargets, READ_EVERY_TARGET, type TargetSelection } from '../../targetSelection';
import { makeDeviceInventory } from '../../__tests__/targetSelectionFixtures';
import { rungOnePolicy } from '../rungOne';

const CLONE = 'agent-cli c4ed0a60';
const deviceInventory = makeDeviceInventory({
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
const expoGoIos = { ...target('go-ios', 'iPhone 17'), appId: 'host.exp.Exponent' };
const expoGoAndroid = {
  ...target('go-android', 'sdk_gphone64_arm64 - 15 - API 35'),
  appId: 'host.exp.exponent',
};

const ANY: TargetSelection = READ_EVERY_TARGET;
const BOUND_SIMULATOR: TargetSelection = {
  platform: { value: 'ios', by: 'bound-device' },
  device: { backend: 'local-ios', name: 'iPhone 17' },
  bound: true,
};
const FLAG_IOS: TargetSelection = {
  platform: { value: 'ios', by: 'flag' },
  device: null,
  bound: false,
};
const FLAG_ANDROID: TargetSelection = {
  platform: { value: 'android', by: 'flag' },
  device: null,
  bound: false,
};

describe('what rung 1 does, and which bundle proves it', () => {
  it.each([
    {
      name: 'broadcasts, and any bundle proves, when no app is skipped',
      targets: [ownIos, ownAndroid],
      targetSelection: ANY,
      mechanism: 'broadcast',
      bundlePlatforms: 'any',
    },
    {
      name: "broadcasts, and only the scope's platform proves, when no app is skipped",
      targets: [ownIos],
      targetSelection: BOUND_SIMULATOR,
      mechanism: 'broadcast',
      bundlePlatforms: ['ios'],
    },
    {
      name: "broadcasts beside Expo Go on the other platform, and the scope's bundle proves",
      targets: [expoGoAndroid, expoGoIos],
      targetSelection: FLAG_ANDROID,
      mechanism: 'broadcast',
      bundlePlatforms: ['android'],
    },
    {
      name: 'a broadcast beside an app nothing places: no bundle proves it',
      targets: [ownIos, elsewhere],
      targetSelection: FLAG_IOS,
      mechanism: 'broadcast',
      bundlePlatforms: [],
    },
    {
      name: 'an Android bundle proves, with own iOS and Android apps beside a skipped iOS app',
      targets: [ownIos, ownAndroid, onClone],
      targetSelection: ANY,
      mechanism: 'page-reload',
      bundlePlatforms: ['android'],
    },
    {
      name: 'no bundle proves beside a skipped app whose platform is unknown',
      targets: [ownIos, elsewhere],
      targetSelection: BOUND_SIMULATOR,
      mechanism: 'page-reload',
      bundlePlatforms: [],
    },
  ])('$name', ({ targets, targetSelection, mechanism, bundlePlatforms }) => {
    const policy = rungOnePolicy(
      classifyTargets(targets, targetSelection, deviceInventory),
      targetSelection,
      deviceInventory
    );

    expect({ mechanism: policy.mechanism, bundlePlatforms: policy.bundlePlatforms }).toEqual({
      mechanism,
      bundlePlatforms,
    });
  });
});
