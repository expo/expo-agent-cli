import { navigateDeviceOf } from '../../navigate/device';
import { selectedDeviceOf } from '../targetSelection';
import type { CdpTarget } from '../cdpClient';
import { resolveTargetSelectionAsync } from '../resolveTargetSelection';
import { classifyTargets } from '../targetSelection';
import {
  makeTargetSelection,
  makeDeviceInventory,
  makeBoundDevice,
} from './targetSelectionFixtures';

// @ref llp/0005-runtime-loop-tools.rfc.md §Android — the EAS Simulator iOS session rule.
// The target an EAS Simulator iOS session registers: the project's own app id, and the cloud
// simulator's model name, which no local tool on this machine reports.
describe('classifyTargets on an EAS Simulator session', () => {
  const cloud = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17' } as CdpTarget;
  const local = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17 Pro' } as CdpTarget;
  const expoGo = { appId: 'host.exp.Exponent', deviceName: 'iPhone 17' } as CdpTarget;
  // An EAS Android session runs an x86_64 image; a local emulator on Apple Silicon is arm64.
  const androidSession = {
    appId: 'dev.vonovak.cyclable',
    deviceName: 'sdk_gphone64_x86_64 - 15 - API 35',
  } as CdpTarget;
  const localEmulator = {
    appId: 'dev.vonovak.cyclable',
    deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
  } as CdpTarget;
  const attachedEmulator = { serial: 'emulator-5554', model: 'sdk_gphone64_arm64' };
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
    {
      name: 'an Android session skips the attached emulator of that model and reads its own target',
      targets: [localEmulator, androidSession],
      platform: 'android' as const,
      eas: true,
      inventory: makeDeviceInventory({ androidDevices: [attachedEmulator] }),
      read: [androidSession],
      skipped: [{ target: localEmulator, classification: { group: 'other-device' } }],
      undetermined: [],
    },
    {
      name: 'an Android session holds every target when adb was not asked',
      targets: [localEmulator, androidSession],
      platform: 'android' as const,
      eas: true,
      inventory: makeDeviceInventory({ androidDevices: null }),
      read: [],
      undetermined: [localEmulator, androidSession],
    },
    {
      name: 'an Android session reads its own target when simctl failed',
      targets: [androidSession],
      platform: 'android' as const,
      eas: true,
      inventory: makeDeviceInventory({ bootedStatus: 'unknown', androidDevices: [] }),
      read: [androidSession],
      undetermined: [],
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
      name: 'reads a target on the simulator this worktree binds',
      booted: ['SIM-A'],
      iosBindings: [bound('SIM-A', '/wt/mapfilter', true)],
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
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Readers
// The device bound to this worktree is the scope of a read with no flag. A local Android target
// carries only the model, so an Android device scopes the platform; a local simulator's targets
// carry its name, so a simulator scopes the device too.
describe('classifyTargets on the device bound to this worktree', () => {
  const onOwn = { appId: 'host.exp.Exponent', deviceName: 'iPhone 17 Pro' } as CdpTarget;
  const onOther = { appId: 'host.exp.Exponent', deviceName: 'iPhone 16' } as CdpTarget;
  const onSession = { appId: 'dev.vonovak.cyclable', deviceName: 'iPhone 17' } as CdpTarget;

  it.each([
    {
      name: 'a local simulator reads only the target that carries its name',
      device: makeBoundDevice('local-ios'),
      targets: [onOther, onOwn, android],
      read: [onOwn],
      otherPlatform: [{ target: android, platform: 'android' }],
      undetermined: [],
      skipped: [{ target: onOther, classification: { group: 'other-device' } }],
    },
    {
      name: 'a local Android device reads the target of its model',
      device: makeBoundDevice('local-android'),
      targets: [ios, android],
      read: [android],
      otherPlatform: [{ target: ios, platform: 'ios' }],
      undetermined: [],
      skipped: [],
    },
    {
      name: 'an EAS Simulator iOS session reads its one unclaimed target',
      device: makeBoundDevice('cloud'),
      targets: [onSession, android],
      read: [onSession],
      otherPlatform: [{ target: android, platform: 'android' }],
      undetermined: [],
      skipped: [],
    },
  ])('$name', ({ device, targets, read, otherPlatform, undetermined, skipped }) => {
    expect(
      classifyTargets(
        targets,
        makeTargetSelection({
          platform: { value: device.platform, by: 'bound-device' },
          device: selectedDeviceOf(navigateDeviceOf(device)),
          bound: true,
        }),
        makeDeviceInventory({
          androidDevices: [{ serial: 'emulator-5554', model: 'sdk_gphone64_arm64' }],
        })
      )
    ).toEqual({
      read,
      otherPlatform,
      undetermined,
      skipped,
    });
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Readers — a local Android device.
describe('classifyTargets on the Android device bound to this worktree', () => {
  const model = 'sdk_gphone64_arm64';
  const bound = { serial: 'emulator-5554', model };
  const twin = { serial: 'emulator-5556', model };
  const phone = { serial: 'R5CR10ABCDE', model: 'Pixel_9' };
  const onPhone = { appId: 'host.exp.exponent', deviceName: 'Pixel 9 - 15 - API 35' } as CdpTarget;
  const otherDevice = { group: 'other-device' } as const;
  const phoneSkipped = [{ target: onPhone, classification: otherDevice }];

  it.each([
    {
      name: 'reads the target of a model no other attached device has',
      androidDevices: [bound, phone],
      read: [android],
    },
    {
      name: 'reads the target of a shared model when only the bound device reverses this port',
      androidDevices: [bound, twin],
      androidReverse: { port: 8081, serials: [bound.serial] },
      read: [android],
    },
    {
      name: 'holds the target of a shared model when another device reverses this port too',
      androidDevices: [bound, twin],
      androidReverse: { port: 8081, serials: [bound.serial, twin.serial] },
      undetermined: [android],
    },
    {
      name: 'holds the target of a shared model when no device reverses this port',
      androidDevices: [bound, twin],
      androidReverse: { port: 8081, serials: [] },
      undetermined: [android],
    },
    {
      name: 'holds the target of a shared model when adb reverse was not read',
      androidDevices: [bound, twin],
      undetermined: [android],
    },
    {
      name: 'holds every target when adb was not read',
      androidDevices: null,
      undetermined: [android, onPhone],
      skipped: [],
    },
    {
      name: 'skips every target when the bound device is not attached',
      androidDevices: [phone],
      skipped: [
        { target: android, classification: otherDevice },
        { target: onPhone, classification: otherDevice },
      ],
    },
  ])(
    '$name',
    ({
      androidDevices,
      androidReverse = null,
      read = [],
      undetermined = [],
      skipped = phoneSkipped,
    }) => {
      expect(
        classifyTargets(
          [android, onPhone],
          makeTargetSelection({
            platform: { value: 'android', by: 'bound-device' },
            device: { backend: 'local-android', serial: bound.serial },
            bound: true,
          }),
          makeDeviceInventory({ androidDevices, androidReverse })
        )
      ).toEqual({ read, otherPlatform: [], undetermined, skipped });
    }
  );
});

// React Native Android names the device by `Build.MODEL`; `adb devices -l` prints the model with
// some characters replaced by `_`. Both sides are compared in one spelling.
describe('classifyTargets on a bound phone whose model adb spells differently', () => {
  it.each([
    { name: 'a model with a space', deviceName: 'Pixel 9 - 15 - API 35', model: 'Pixel_9' },
    { name: 'a model with a dash', deviceName: 'SM-A525F - 13 - API 33', model: 'SM_A525F' },
    {
      name: 'a model whose dash adb keeps',
      deviceName: 'SM-A525F - 13 - API 33',
      model: 'SM-A525F',
    },
  ])('reads the target of $name', ({ deviceName, model }) => {
    const target = { appId: 'com.example.app', deviceName } as CdpTarget;
    expect(
      classifyTargets(
        [target],
        makeTargetSelection({
          platform: { value: 'android', by: 'bound-device' },
          device: { backend: 'local-android', serial: 'R58M1234567' },
          bound: true,
        }),
        makeDeviceInventory({ androidDevices: [{ serial: 'R58M1234567', model }] })
      ).read
    ).toEqual([target]);
  });
});
