// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
import type { CdpTarget } from '../../cdpClient';
import { classifyTargets, READ_EVERY_TARGET, type TargetSelection } from '../../targetSelection';
import { makeDeviceInventory } from '../../__tests__/targetSelectionFixtures';
import { CHURN_NOT_ASKED, rungOnePolicy, settleRungOne, type RungOneOutcome } from '../rungOne';

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
  device: { backend: 'local-ios', udid: 'SIM-1', name: 'iPhone 17' },
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
    {
      name: 'sends nothing when the fresh read failed and no app is skipped',
      targets: [ownIos],
      targetSelection: BOUND_SIMULATOR,
      unread: 'the target list could not be read again',
      mechanism: 'none',
      bundlePlatforms: ['ios'],
    },
    {
      name: 'keeps Page.reload beside a skipped app when the fresh read failed',
      targets: [ownIos, onClone],
      targetSelection: ANY,
      unread: 'the target list could not be read again',
      mechanism: 'page-reload',
      bundlePlatforms: ['android'],
    },
  ])('$name', ({ targets, targetSelection, unread = null, mechanism, bundlePlatforms }) => {
    const policy = rungOnePolicy(
      classifyTargets(targets, targetSelection, deviceInventory),
      targetSelection,
      deviceInventory,
      unread
    );

    expect({ mechanism: policy.mechanism, bundlePlatforms: policy.bundlePlatforms }).toEqual({
      mechanism,
      bundlePlatforms,
    });
  });
});

describe('what rung 1 leaves for the rest of the run', () => {
  const attempt = { method: 'dev-server' as const, ok: false, reason: 'x', leftAppStopped: null };
  const base = { attempt, churn: CHURN_NOT_ASKED };
  it.each<{ outcome: RungOneOutcome; settled: ReturnType<typeof settleRungOne> }>([
    {
      outcome: { ...base, kind: 'proved', proof: 'message-socket-peers' },
      settled: { ran: true, proof: 'message-socket-peers', relaunchWhy: null },
    },
    {
      outcome: { ...base, kind: 'acted', reachedOutside: 1 },
      settled: { ran: true, proof: null, relaunchWhy: null },
    },
    {
      outcome: { ...base, kind: 'delivered', relaunchWhy: 'why' },
      settled: { ran: true, proof: null, relaunchWhy: 'why' },
    },
    {
      outcome: { ...base, kind: 'not-delivered', relaunchWhy: 'why' },
      settled: { ran: false, proof: null, relaunchWhy: 'why' },
    },
    {
      outcome: { ...base, kind: 'unprovable', relaunchWhy: 'why' },
      settled: { ran: false, proof: null, relaunchWhy: 'why' },
    },
  ])('$outcome.kind', ({ outcome, settled }) => {
    expect(settleRungOne(outcome)).toEqual(settled);
  });
});
