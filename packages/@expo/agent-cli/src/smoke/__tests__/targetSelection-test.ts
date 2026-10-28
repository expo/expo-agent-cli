import { createServer, type Server } from 'http';
import { vol } from 'memfs';
import type { AddressInfo } from 'net';

import { fakeTools, seedIosBinding } from '../../deviceBinding/__tests__/fakeTools';
import type { CdpTarget } from '../../runtime/cdpClient';
import { spawnCaptureAsync } from '../../utils/spawnCapture';
import { resolveSmokeOptions } from '../resolveOptions';
import { buildSmokeDeps } from '../smokeAsync';
import { buildSmokeTargetSelection } from '../targetSelection';

vi.mock('../../utils/spawnCapture', () => ({ spawnCaptureAsync: vi.fn() }));
vi.mock('../../log');

const projectRoot = '/project';
const realPlatform = process.platform;
const servers: Server[] = [];

function target(overrides: Partial<CdpTarget> = {}): CdpTarget {
  return {
    id: 'page-1',
    title: 'App',
    description: '',
    type: 'node',
    appId: 'com.example',
    deviceName: 'My iPhone',
    devtoolsFrontendUrl: '',
    webSocketDebuggerUrl: 'ws://localhost/inspector',
    ...overrides,
  };
}

async function serverAsync(targets: () => CdpTarget[]): Promise<string> {
  const server = createServer((request, response) => {
    response.end(
      request.url === '/json/list' ? JSON.stringify(targets()) : 'packager-status:running'
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vol.reset();
  vol.fromJSON({ '/project/package.json': '{"dependencies":{"expo":"57.0.0"}}' });
  vi.stubEnv('AGENT_CLI_NO_DEVICE', '');
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vol.reset();
});

function inventory() {
  const tools = fakeTools({ simulators: [{ udid: 'IOS-1', name: 'My iPhone', state: 'Booted' }] });
  vi.mocked(spawnCaptureAsync).mockImplementation((command, args) =>
    command === 'xcrun' ? tools.simctl(args.slice(1)) : tools.adb(args)
  );
  return tools;
}

it('reclassifies an unchanged target after a failed inventory read recovers', async () => {
  const url = await serverAsync(() => [target()]);
  const selection = buildSmokeTargetSelection(projectRoot, resolveSmokeOptions(['--ios']));
  vi.mocked(spawnCaptureAsync).mockResolvedValue({
    exitCode: 1,
    stdout: '',
    stderr: 'unavailable',
  });
  expect((await selection.targetSelectionAsync(url)).classifiedTargets.undetermined).toHaveLength(
    1
  );
  inventory();
  expect(
    (await selection.targetSelectionAsync(url)).classifiedTargets.read.map((app) => app.id)
  ).toEqual(['page-1']);
});

it('retries a failed device lookup, shares concurrent discovery, and retains the successful choice', async () => {
  seedIosBinding(projectRoot, 'IOS-1', 'My iPhone');
  const selection = buildSmokeTargetSelection(projectRoot, resolveSmokeOptions(['--ios']));
  vi.mocked(spawnCaptureAsync).mockResolvedValue({
    exitCode: 1,
    stdout: '',
    stderr: 'unavailable',
  });
  expect((await selection.deviceAsync()).device).toBeNull();
  const tools = inventory();
  const [first, second] = await Promise.all([selection.deviceAsync(), selection.deviceAsync()]);
  expect(first.device?.deviceId).toBe('IOS-1');
  expect(second.device).toEqual(first.device);
  expect(tools.calls.filter((args) => args[0] === 'list')).toHaveLength(1);
  tools.simulators.length = 0;
  expect((await selection.deviceAsync()).device).toEqual(first.device);
  expect(tools.calls.filter((args) => args[0] === 'list')).toHaveLength(1);
});

it('publishes an acquired device to subsequent phases without another lookup', async () => {
  seedIosBinding(projectRoot, 'IOS-1', 'My iPhone');
  const tools = inventory();
  tools.simulators[0]!.state = 'Shutdown';
  const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios']));
  const boot = await deps.bootDevice();
  expect(boot.ok).toBe(true);
  tools.simulators.length = 0;
  expect(await deps.probeDevice()).toMatchObject({
    deviceId: 'IOS-1',
    backend: 'local-ios',
    reason: null,
  });
});

it('places a development-build target that appears after the first empty wait probe', async () => {
  inventory();
  let reads = 0;
  const url = await serverAsync(() => (++reads === 1 ? [] : [target()]));
  const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios']));
  expect(await deps.waitForAppConnection(url, 600)).toMatchObject({
    appsConnected: 1,
    timedOut: false,
  });
});

it('asks the device tools once for a list that does not change', async () => {
  const tools = inventory();
  const url = await serverAsync(() => [
    target({ appId: 'com.example.app', deviceName: 'Ada’s phone' }),
  ]);
  const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios']));
  expect(await deps.waitForAppConnection(url, 600)).toMatchObject({
    appsConnected: 0,
    timedOut: true,
    undeterminedApps: 1,
  });
  expect(tools.calls.filter((args) => args[0] === 'list')).toHaveLength(1);
});

it.each(['Booted', 'Shutdown'] as const)(
  'scopes a wait on an initially empty list to the %s simulator bound to this worktree',
  async (state) => {
    seedIosBinding(projectRoot, 'IOS-A', 'Device A');
    const tools = fakeTools({
      simulators: [
        { udid: 'IOS-A', name: 'Device A', state },
        { udid: 'IOS-B', name: 'Device B', state: 'Booted' },
      ],
    });
    vi.mocked(spawnCaptureAsync).mockImplementation((command, args) =>
      command === 'xcrun' ? tools.simctl(args.slice(1)) : tools.adb(args)
    );
    let reads = 0;
    const url = await serverAsync(() =>
      ++reads === 1 ? [] : [target({ deviceName: 'Device B' })]
    );
    const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios']));
    expect(await deps.waitForAppConnection(url, 350)).toMatchObject({
      appsConnected: 0,
      timedOut: true,
    });
  }
);

it('refreshes failed local exclusion evidence before counting a cloud attachment', async () => {
  const url = await serverAsync(() => [target()]);
  const tools = fakeTools();
  let simulatorReads = 0;
  vi.mocked(spawnCaptureAsync).mockImplementation(async (command, args) => {
    if (command !== 'xcrun') return tools.adb(args);
    if (++simulatorReads === 1) return { exitCode: 1, stdout: '', stderr: 'unavailable' };
    return tools.simctl(args.slice(1));
  });
  const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios', '--eas']));
  expect(await deps.waitForAppConnection(url, 1500)).toMatchObject({
    appsConnected: 1,
    timedOut: false,
    undeterminedApps: 0,
  });
  expect(simulatorReads).toBeGreaterThan(1);
});

it('asks a failing simctl again at most once a second while the wait polls', async () => {
  const url = await serverAsync(() => [target()]);
  const tools = fakeTools();
  let simulatorLists = 0;
  vi.mocked(spawnCaptureAsync).mockImplementation(async (command, args) => {
    if (command !== 'xcrun') return tools.adb(args);
    if (args[1] === 'list') simulatorLists++;
    return { exitCode: 1, stdout: '', stderr: 'unavailable' };
  });
  const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios', '--eas']));
  expect(await deps.waitForAppConnection(url, 2200)).toMatchObject({
    appsConnected: 0,
    timedOut: true,
  });
  expect(simulatorLists).toBeGreaterThan(1);
  expect(simulatorLists).toBeLessThanOrEqual(3);
});

it.each([
  { case: 'after an empty first list', firstList: [] as string[] },
  { case: 'after a local simulator boots during the wait', firstList: ['My iPhone'] },
])('does not count a local Expo Go app as the cloud session $case', async ({ firstList }) => {
  const tools = inventory();
  const expoGo = (deviceName: string) =>
    target({ id: deviceName, appId: 'host.exp.Exponent', deviceName });
  let reads = 0;
  const url = await serverAsync(() => {
    if (++reads <= 2) return firstList.map(expoGo);
    if (!tools.simulators.some((simulator) => simulator.name === 'Second iPhone')) {
      tools.simulators.push({ udid: 'IOS-2', name: 'Second iPhone', state: 'Booted' });
    }
    return [...firstList, 'Second iPhone'].map(expoGo);
  });
  const deps = buildSmokeDeps(projectRoot, resolveSmokeOptions(['--ios', '--eas']));
  expect(await deps.waitForAppConnection(url, 600)).toMatchObject({
    appsConnected: 0,
    timedOut: true,
  });
});
