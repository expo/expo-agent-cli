// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
import type { CdpTarget } from '../../cdpClient';
import { classifyTargets, READ_EVERY_TARGET, type TargetSelection } from '../../targetSelection';
import { makeDeviceInventory } from '../../__tests__/targetSelectionFixtures';
import {
  CHURN_NOT_ASKED,
  followChurnAsync,
  rungOnePolicy,
  settleRungOne,
  type RungOneOutcome,
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
      name: 'no bundle proves a Page.reload beside an app nothing places, as well as a skipped one',
      targets: [ownAndroid, onClone, elsewhere],
      targetSelection: FLAG_ANDROID,
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

// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads — churn proves the app acted, not that it
// came back.
describe('what follows churn under auto', () => {
  const attempt = {
    method: 'dev-server' as const,
    ok: true,
    reason: 'reconnected',
    leftAppStopped: null,
  };
  const base = { attempt, churn: CHURN_NOT_ASKED };
  const churn: RungOneOutcome = { ...base, kind: 'proved', proof: 'message-socket-peers' };

  it.each<{
    name: string;
    outcome: RungOneOutcome;
    remainingMs: number;
    cameBack: boolean;
    bundleWatched?: boolean;
    windowMs: number | null;
    kind: RungOneOutcome['kind'];
  }>([
    {
      name: 'caps the window at 10 s',
      outcome: churn,
      remainingMs: 30_000,
      cameBack: false,
      windowMs: 10_000,
      kind: 'delivered',
    },
    {
      name: 'leaves the relaunch half of a short budget',
      outcome: churn,
      remainingMs: 8_000,
      cameBack: false,
      windowMs: 4_000,
      kind: 'delivered',
    },
    {
      name: 'keeps churn the app came back after',
      outcome: churn,
      remainingMs: 30_000,
      cameBack: true,
      windowMs: 10_000,
      kind: 'proved',
    },
    {
      name: 'opens no window when too little time is left for a relaunch after it',
      outcome: churn,
      remainingMs: 1_500,
      cameBack: false,
      windowMs: null,
      kind: 'proved',
    },
    {
      // A broadcast keeps the page id [observed — SDK 58 development build, RN 0.88, iOS 26.4
      // simulator, 2026-11-18], so with no captured log nothing could show the app back.
      name: 'opens no window when no bundle can be watched',
      outcome: churn,
      remainingMs: 30_000,
      cameBack: false,
      bundleWatched: false,
      windowMs: null,
      kind: 'proved',
    },
    {
      name: 'does not follow a replaced context',
      outcome: { ...base, kind: 'proved', proof: 'debugger-context-replaced' },
      remainingMs: 30_000,
      cameBack: false,
      windowMs: null,
      kind: 'proved',
    },
    {
      name: 'does not follow an acted broadcast',
      outcome: { ...base, kind: 'acted', reachedOutside: 1 },
      remainingMs: 30_000,
      cameBack: false,
      windowMs: null,
      kind: 'acted',
    },
  ])('$name', async ({ outcome, remainingMs, cameBack, bundleWatched = true, windowMs, kind }) => {
    const asked: number[] = [];
    const followed = await followChurnAsync(outcome, {
      remainingMs,
      bundleWatched,
      cameBackAsync: async (timeoutMs) => {
        asked.push(timeoutMs);
        return cameBack;
      },
    });

    expect(asked).toEqual(windowMs == null ? [] : [windowMs]);
    expect(followed.kind).toBe(kind);
    if (followed.kind === 'delivered') {
      expect(followed.attempt).toMatchObject({ ok: false, delivered: true });
      expect(followed.attempt.reason).toContain(`within ${windowMs}ms`);
    }
  });
});
