// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
import type { CdpTarget } from '../../cdpClient';
import { classifyTargets, READ_EVERY_TARGET, type TargetSelection } from '../../targetSelection';
import { makeDeviceInventory } from '../../__tests__/targetSelectionFixtures';
import type { ReloadMethod } from '../resolveOptions';
import {
  CHURN_NOT_ASKED,
  rungOnePolicy,
  settleRungOne,
  type RungOneOutcome,
  type RungOnePolicy,
} from '../rungOne';

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
const CLOUD_IOS: TargetSelection = {
  platform: { value: 'ios', by: 'bound-device' },
  device: { backend: 'cloud', deviceId: 'sess-1' },
  bound: true,
};
const CLOUD_ANDROID: TargetSelection = {
  platform: { value: 'android', by: 'bound-device' },
  device: { backend: 'cloud', deviceId: 'sess-2' },
  bound: true,
};
/** The session's app: its device name is the cloud simulator's model, which no local tool reports. */
const onCloudIos = target('cloud-ios', 'iPhone 17 Pro');
const onCloudAndroid = target('cloud-android', 'sdk_gphone64_arm64 - 16 - API 36');
const FLAG_ANDROID: TargetSelection = {
  platform: { value: 'android', by: 'flag' },
  device: null,
  bound: false,
};

describe('what rung 1 does, and which bundle proves it', () => {
  it.each<{
    name: string;
    targets: CdpTarget[];
    targetSelection: TargetSelection;
    unread?: string;
    method?: ReloadMethod;
    policy: RungOnePolicy;
  }>([
    {
      name: 'broadcasts, and any bundle proves, when no app is skipped',
      targets: [ownIos, ownAndroid],
      targetSelection: ANY,
      policy: { mechanism: 'broadcast', reachedOutside: 0, bundlePlatforms: 'any' },
    },
    {
      name: "broadcasts, and only the scope's platform proves, when no app is skipped",
      targets: [ownIos],
      targetSelection: BOUND_SIMULATOR,
      policy: { mechanism: 'broadcast', reachedOutside: 0, bundlePlatforms: ['ios'] },
    },
    {
      name: "broadcasts beside Expo Go on the other platform, and the scope's bundle proves",
      targets: [expoGoAndroid, expoGoIos],
      targetSelection: FLAG_ANDROID,
      policy: { mechanism: 'broadcast', reachedOutside: 1, bundlePlatforms: ['android'] },
    },
    {
      name: 'a broadcast beside an app nothing places: no bundle proves it',
      targets: [ownIos, elsewhere],
      targetSelection: FLAG_IOS,
      policy: { mechanism: 'broadcast', reachedOutside: 1, bundlePlatforms: [] },
    },
    {
      // `--method device` sends nothing on rung 1; its bundle rule is the broadcast's.
      name: 'a pinned --method device beside an app nothing places: no bundle proves it',
      targets: [ownIos, elsewhere],
      targetSelection: FLAG_IOS,
      method: 'device',
      policy: { mechanism: 'broadcast', reachedOutside: 1, bundlePlatforms: [] },
    },
    {
      name: 'an Android bundle proves, with own iOS and Android apps beside a skipped iOS app',
      targets: [ownIos, ownAndroid, onClone],
      targetSelection: ANY,
      policy: { mechanism: 'page-reload', trigger: 'skipped-app', bundlePlatforms: ['android'] },
    },
    {
      name: 'no bundle proves beside a skipped app whose platform is unknown',
      targets: [ownIos, elsewhere],
      targetSelection: BOUND_SIMULATOR,
      policy: { mechanism: 'page-reload', trigger: 'skipped-app', bundlePlatforms: [] },
    },
    {
      name: 'sends nothing when the fresh read failed and no app is skipped',
      targets: [ownIos],
      targetSelection: BOUND_SIMULATOR,
      unread: 'the target list could not be read again',
      policy: {
        mechanism: 'none',
        unread: 'the target list could not be read again',
        bundlePlatforms: ['ios'],
      },
    },
    {
      // The older observation may miss an app a broadcast would reach, so none counts.
      name: 'sends nothing beside an app nothing places when the fresh read failed: no bundle proves',
      targets: [ownIos, elsewhere],
      targetSelection: FLAG_IOS,
      unread: 'the target list could not be read again',
      policy: {
        mechanism: 'none',
        unread: 'the target list could not be read again',
        bundlePlatforms: [],
      },
    },
    {
      name: 'keeps Page.reload beside a skipped app when the fresh read failed',
      targets: [ownIos, onClone],
      targetSelection: ANY,
      unread: 'the target list could not be read again',
      policy: { mechanism: 'page-reload', trigger: 'skipped-app', bundlePlatforms: ['android'] },
    },
    // @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — an iOS EAS session.
    {
      name: 'sends Page.reload, not the broadcast, on an iOS EAS session',
      targets: [onCloudIos],
      targetSelection: CLOUD_IOS,
      policy: { mechanism: 'page-reload', trigger: 'ios-eas-session', bundlePlatforms: ['ios'] },
    },
    {
      name: 'broadcasts on an Android EAS session',
      targets: [onCloudAndroid],
      targetSelection: CLOUD_ANDROID,
      policy: { mechanism: 'broadcast', reachedOutside: 0, bundlePlatforms: ['android'] },
    },
    {
      // `--method runtime` reloads only `read`: an app nothing places cannot fetch for it.
      name: 'a pinned --method runtime beside an app nothing places: its own bundle proves',
      targets: [ownIos, elsewhere],
      targetSelection: FLAG_IOS,
      method: 'runtime',
      unread: 'the target list could not be read again',
      policy: { mechanism: 'runtime', bundlePlatforms: ['ios'] },
    },
  ])('$name', ({ targets, targetSelection, unread = null, method = 'auto', policy }) => {
    expect(
      rungOnePolicy(
        classifyTargets(targets, targetSelection, deviceInventory),
        targetSelection,
        deviceInventory,
        { method, unread }
      )
    ).toEqual(policy);
  });
});

describe('what rung 1 leaves for the rest of the run', () => {
  const attempt = { method: 'dev-server' as const, ok: false, reason: 'x', leftAppStopped: null };
  const base = { attempt, churn: CHURN_NOT_ASKED };
  it.each<{ outcome: RungOneOutcome; settled: ReturnType<typeof settleRungOne> }>([
    {
      outcome: { ...base, kind: 'proved', proof: 'message-socket-peers' },
      settled: { kind: 'proved', method: 'dev-server', proof: 'message-socket-peers' },
    },
    {
      outcome: { ...base, kind: 'acted', reachedOutside: 1 },
      settled: { kind: 'observe', method: 'dev-server' },
    },
    {
      outcome: { ...base, kind: 'delivered', relaunchWhy: 'why' },
      settled: { kind: 'unproved', method: 'dev-server', clause: 'why' },
    },
    {
      outcome: {
        ...base,
        attempt: { method: 'runtime', ok: false, reason: 'x', leftAppStopped: null, outcomes: [] },
        kind: 'delivered',
        relaunchWhy: 'why',
      },
      settled: { kind: 'unproved', method: 'runtime', clause: 'why' },
    },
    {
      outcome: { ...base, kind: 'not-delivered', relaunchWhy: 'why' },
      settled: { kind: 'unproved', method: null, clause: 'why' },
    },
    {
      outcome: { ...base, kind: 'unprovable', relaunchWhy: 'why' },
      settled: { kind: 'unproved', method: null, clause: 'why' },
    },
  ])('$outcome.kind by $outcome.attempt.method', ({ outcome, settled }) => {
    expect(settleRungOne(outcome)).toEqual(settled);
  });
});
