import type { CdpTarget } from '../cdpClient';
import { resolveTargetSelectionAsync } from '../resolveTargetSelection';
import { classifyTargets, scopeJson } from '../targetSelection';
import { makeTargetSelection, makeDeviceInventory } from './targetSelectionFixtures';

// @ref llp/0005-runtime-loop-tools.rfc.md §Android — the EAS Simulator iOS session rule.
// The target an EAS Simulator iOS session registers: the project's own app id, and the cloud
// simulator's model name, which no local tool on this machine reports.
describe('classifyTargets on an EAS Simulator session', () => {
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
  const deviceInventory = makeDeviceInventory({
    booted: [{ name: 'iPhone 17 Pro', udid: 'LOCAL-1' }],
  });

  it.each([
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
      name: 'an Android session holds every target when adb was not asked',
      targets: [localEmulator, androidSession],
      platform: 'android' as const,
      eas: true,
      inventory: makeDeviceInventory({ androidDevices: null }),
      read: [],
      undetermined: [localEmulator, androidSession],
    },
  ])('$name', ({ targets, platform, eas, read, undetermined, inventory }) => {
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
      skipped: [],
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
  it("skips a target with a foreign binding's name when the simulator list could not be read", () => {
    const deviceInventory = makeDeviceInventory({
      booted: [],
      bootedStatus: 'unknown',
      iosBindings: [bound('SIM-B', '/wt/b')],
    });

    expect(
      classifyTargets(
        [ON_CLONE],
        makeTargetSelection({ platform: null, device: null }),
        deviceInventory
      )
    ).toEqual({
      read: [],
      otherPlatform: [],
      undetermined: [],
      skipped: [
        { target: ON_CLONE, classification: { group: 'other-worktree', projectRoots: ['/wt/b'] } },
      ],
    });
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Readers — a local Android device.
describe('classifyTargets on the Android device bound to this worktree', () => {
  const model = 'sdk_gphone64_arm64';
  const bound = { serial: 'emulator-5554', model };
  const twin = { serial: 'emulator-5556', model };
  const android = { appId: 'host.exp.exponent', deviceName: `${model} - 15 - API 35` } as CdpTarget;
  const onPhone = { appId: 'host.exp.exponent', deviceName: 'Pixel 9 - 15 - API 35' } as CdpTarget;
  const otherDevice = { group: 'other-device' } as const;
  const phoneSkipped = [{ target: onPhone, classification: otherDevice }];

  it.each([
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
  ])('$name', ({ androidDevices, undetermined, skipped = phoneSkipped }) => {
    expect(
      classifyTargets(
        [android, onPhone],
        makeTargetSelection({
          platform: { value: 'android', by: 'bound-device' },
          device: { backend: 'local-android', serial: bound.serial },
          bound: true,
        }),
        makeDeviceInventory({ androidDevices })
      )
    ).toEqual({ read: [], otherPlatform: [], undetermined, skipped });
  });
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

describe('scopeJson', () => {
  it.each([
    {
      device: { backend: 'local-ios' as const, udid: 'SIM-1', name: 'iPhone 17' },
      json: { backend: 'local-ios', id: 'SIM-1', name: 'iPhone 17' },
    },
    {
      device: { backend: 'local-android' as const, serial: 'emulator-5554' },
      json: { backend: 'local-android', id: 'emulator-5554', name: null },
    },
    {
      device: { backend: 'cloud' as const, deviceId: '01a15bf1' },
      json: { backend: 'cloud', id: '01a15bf1', name: null },
    },
    {
      device: { backend: 'cloud' as const, deviceId: null },
      json: { backend: 'cloud', id: null, name: null },
    },
  ])('names a $device.backend device by id and name', ({ device, json }) => {
    const scope = scopeJson(
      makeTargetSelection({
        platform: { value: device.backend === 'local-ios' ? 'ios' : 'android', by: 'bound-device' },
        device,
        bound: true,
      })
    );
    expect(scope.bound).toBe(true);
    expect(scope.device).toEqual(json);
  });

  it('names no platform and no device for a run that reads every app', () => {
    expect(scopeJson(makeTargetSelection())).toEqual({
      platform: null,
      platformFrom: null,
      bound: false,
      device: null,
    });
  });
});
