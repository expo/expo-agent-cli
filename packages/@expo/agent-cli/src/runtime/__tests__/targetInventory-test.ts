import { fakeTools } from '../../deviceBinding/__tests__/fakeTools';
import { spawnCaptureAsync, type SpawnCaptureResult } from '../../utils/spawnCapture';
import { resolveTargetSelectionAsync } from '../resolveTargetSelection';
import { classifyTargets, EMPTY_DEVICE_INVENTORY } from '../targetSelection';
import { makeTarget, makeTargetSelection } from './targetSelectionFixtures';

vi.mock('../../utils/spawnCapture', () => ({ spawnCaptureAsync: vi.fn() }));

const realPlatform = process.platform;
const target = makeTarget();
const cloud = makeTargetSelection({
  platform: { value: 'ios', by: 'flag' },
  device: { backend: 'cloud', deviceId: 'session' },
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vi.resetAllMocks();
});

it('does not attribute an unclaimed target before inspecting local simulators', () => {
  expect(classifyTargets([target], cloud, EMPTY_DEVICE_INVENTORY).undetermined).toEqual([target]);
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
