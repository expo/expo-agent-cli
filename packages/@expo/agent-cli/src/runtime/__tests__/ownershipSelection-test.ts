import { vol } from 'memfs';
import type WebSocket from 'ws';

import { fakeTools, seedIosBinding } from '../../deviceBinding/__tests__/fakeTools';
import { spawnCaptureAsync } from '../../utils/spawnCapture';
import { CdpClient } from '../cdpClient';
import { resolveTargetSelectionAsync } from '../resolveTargetSelection';
import { MockWebSocket } from './MockWebSocket';
import { makeTarget } from './targetSelectionFixtures';

vi.mock('../../utils/spawnCapture', () => ({ spawnCaptureAsync: vi.fn() }));

const ownRoot = '/wt/own';
const foreignRoot = '/wt/foreign';
const android = makeTarget({ appId: 'host.exp.exponent', deviceName: 'Pixel - 15 - API 35' });

beforeEach(() => {
  vol.fromJSON({ [`${ownRoot}/package.json`]: '{}', [`${foreignRoot}/package.json`]: '{}' });
  seedIosBinding(foreignRoot, 'FOREIGN-UDID', 'Original name');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vol.reset();
});

// The resolver and debugger client share an observation, while Metro may return a different list.
it.each(['another app', 'no apps'] as const)(
  'refuses a foreign app listed after %s before opening its debugger',
  async (scenario) => {
    const foreign = makeTarget({
      appId: 'host.exp.Exponent',
      deviceName: 'Original name',
    });
    const tools = fakeTools({
      simulators: [{ udid: 'FOREIGN-UDID', name: foreign.deviceName, state: 'Booted' }],
    });
    vi.mocked(spawnCaptureAsync).mockImplementation((command, args) =>
      command === 'xcrun' ? tools.simctl(args.slice(1)) : tools.adb(args)
    );
    const scope = await resolveTargetSelectionAsync({
      projectRoot: ownRoot,
      flags: { platform: undefined, eas: false },
      targets: scenario === 'another app' ? [android] : [],
    });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([foreign])));
    const createWebSocket = vi.fn(
      (url: string) =>
        new MockWebSocket(url, (request, socket) => {
          socket.emit(
            'message',
            JSON.stringify({
              id: request.id,
              result: { result: { type: 'number', value: 42 } },
            })
          );
        }) as unknown as WebSocket
    );
    const client = new CdpClient({ metroUrl: 'http://localhost:8081', ...scope, createWebSocket });
    await expect(client.evaluateAsync('42')).rejects.toThrow(foreignRoot);
    expect(createWebSocket).not.toHaveBeenCalled();
  }
);
