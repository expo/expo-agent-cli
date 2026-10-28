import { fakeTools } from '../../deviceBinding/__tests__/fakeTools';
import { spawnCaptureAsync, type SpawnCaptureResult } from '../../utils/spawnCapture';
import { resolveTargetSelectionAsync } from '../resolveTargetSelection';
import { refreshDeviceInventoryAsync } from '../targetSelection';
import { makeDeviceInventory, makeTarget, makeTargetSelection } from './targetSelectionFixtures';

vi.mock('../../utils/spawnCapture', () => ({ spawnCaptureAsync: vi.fn() }));

const realPlatform = process.platform;
const target = makeTarget();

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vi.resetAllMocks();
});

it.each([
  { name: 'successful empty inventory', stdout: '{"devices":{}}', readable: true },
  { name: 'rejected lookup', reject: true },
  { name: 'failed command', exitCode: 1, stdout: '{"devices":{}}' },
  { name: 'timed out command', exitCode: null, stdout: '{"devices":{}}' },
  { name: 'invalid JSON', stdout: '{' },
  { name: 'null response', stdout: 'null' },
  { name: 'missing devices', stdout: '{}' },
  { name: 'invalid devices container', stdout: '{"devices":[]}' },
  { name: 'invalid runtime list', stdout: '{"devices":{"ios":null}}' },
  { name: 'incomplete device entry', stdout: '{"devices":{"ios":[{"udid":"LOCAL"}]}}' },
])('cloud attribution after $name', async ({ stdout = '', exitCode = 0, reject, readable }) => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const tools = fakeTools();
  vi.mocked(spawnCaptureAsync).mockImplementation(async (command, args) => {
    if (command !== 'xcrun') return tools.adb(args);
    if (reject) throw new Error('xcrun unavailable');
    return { stdout, stderr: '', exitCode } satisfies SpawnCaptureResult;
  });
  const { classifiedTargets } = await resolveTargetSelectionAsync({
    projectRoot: null,
    flags: { platform: 'ios', eas: true },
    targets: [target],
  });
  expect(classifiedTargets.read).toEqual(readable ? [target] : []);
  expect(classifiedTargets.undetermined).toEqual(readable ? [] : [target]);
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Which app a run reads — the device tools.
it('does not ask simctl for an --android scope because another worktree holds an iOS lease', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.mocked(spawnCaptureAsync).mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
  const selection = makeTargetSelection({ platform: { value: 'android', by: 'flag' } });
  const android = makeTarget({ appId: 'host.exp.exponent', deviceName: 'Pixel 9 - 15 - API 35' });
  const foreign = { udid: 'U9', name: 'iPhone 17', projectRoot: '/other', own: false };
  const inventory = makeDeviceInventory({ iosBindings: [foreign] });
  await refreshDeviceInventoryAsync([android], selection, inventory);
  expect(vi.mocked(spawnCaptureAsync).mock.calls.filter(([bin]) => bin === 'xcrun')).toEqual([]);
});

it('reads an Android session on a host with no adb and no simctl', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.mocked(spawnCaptureAsync).mockImplementation(async (command) => {
    if (command === 'xcrun') throw new Error('xcrun unavailable');
    return { stdout: '', stderr: '', exitCode: null, spawnError: new Error('spawn adb ENOENT') };
  });
  const session = makeTarget({ deviceName: 'sdk_gphone64_x86_64 - 15 - API 35' });
  const { classifiedTargets, deviceInventory } = await resolveTargetSelectionAsync({
    projectRoot: null,
    flags: { platform: 'android', eas: true },
    targets: [session],
  });
  expect(deviceInventory.androidDevices).toEqual([]);
  expect(classifiedTargets.read).toEqual([session]);
});

it.each(['linux', 'win32'])(
  'allows cloud attribution without local iOS support on %s',
  async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.mocked(spawnCaptureAsync).mockRejectedValue(new Error('tool unavailable'));
    const { classifiedTargets } = await resolveTargetSelectionAsync({
      projectRoot: null,
      flags: { platform: 'ios', eas: true },
      targets: [target],
    });
    expect(classifiedTargets.read).toEqual([target]);
    // A valid listing supplied by a tool shim still takes precedence over host capability.
    const tools = fakeTools({
      simulators: [{ udid: 'LOCAL', name: target.deviceName, state: 'Booted' }],
    });
    vi.mocked(spawnCaptureAsync).mockImplementation((command, args) =>
      command === 'xcrun' ? tools.simctl(args.slice(1)) : tools.adb(args)
    );
    const observed = await resolveTargetSelectionAsync({
      projectRoot: null,
      flags: { platform: 'ios', eas: true },
      targets: [target],
    });
    expect(observed.classifiedTargets.read).toEqual([]);
    expect(observed.classifiedTargets.skipped).toEqual([
      { target, classification: { group: 'other-device' } },
    ]);
  }
);

// @ref llp/0005-runtime-loop-tools.rfc.md §Which app a run reads — `--eas` with no platform.
describe('cloud attribution with no platform when adb gave no answer', () => {
  const emulator = makeTarget({
    id: '2',
    appId: 'dev.example.app',
    deviceName: 'sdk_gphone64_x86_64 - 15 - API 35',
  });

  async function classifyAsync(adbAnswers: boolean, targets: (typeof target)[]) {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(spawnCaptureAsync).mockImplementation(async (command) =>
      command === 'xcrun'
        ? { stdout: '{"devices":{}}', stderr: '', exitCode: 0 }
        : { stdout: 'List of devices attached\n', stderr: '', exitCode: adbAnswers ? 0 : 1 }
    );
    const { classifiedTargets } = await resolveTargetSelectionAsync({
      projectRoot: null,
      flags: { platform: null, eas: true },
      targets,
    });
    return classifiedTargets;
  }

  it('holds an Android-shaped target beside the session app', async () => {
    const classified = await classifyAsync(false, [emulator, target]);
    expect(classified.read).toEqual([]);
    expect(classified.undetermined).toEqual([emulator, target]);
  });

  it('holds a lone Android-shaped target', async () => {
    const classified = await classifyAsync(false, [emulator]);
    expect(classified.read).toEqual([]);
    expect(classified.undetermined).toEqual([emulator]);
  });

  it('still reads a lone unclaimed iOS target', async () => {
    const classified = await classifyAsync(false, [target]);
    expect(classified.read).toEqual([target]);
  });
});
