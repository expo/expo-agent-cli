import fs from 'fs';
import { vol } from 'memfs';

import { bindingFor, fakeTools, writeBinding } from '../../deviceBinding/__tests__/fakeTools';
import { bindingPathFor, readBindingFile } from '../../deviceBinding/registry';
import * as deviceTools from '../../deviceBinding/tools';
import { devStopAsync } from '../../dev/stopAsync';
import { resolveSmokeOptions } from '../resolveOptions';
import { buildSmokeDeps } from '../smokeAsync';

vi.mock('../../log');
vi.mock('../../dev/stopAsync', () => ({ devStopAsync: vi.fn(async () => 0) }));
const root = '/work/app';
beforeEach(() => {
  vol.reset();
  fs.mkdirSync(root, { recursive: true });
  delete process.env.AGENT_CLI_NO_DEVICE;
});
afterEach(() => vi.restoreAllMocks());

it('an older smoke cleanup leaves a replacement binding untouched', async () => {
  const tools = fakeTools({ simulators: [{ udid: 'B', name: 'Personal', state: 'Booted' }] });
  vi.spyOn(deviceTools, 'defaultTools').mockReturnValue(tools);
  const deps = buildSmokeDeps(root, resolveSmokeOptions(['--ios']));
  expect((await deps.bootDevice()).ok).toBe(true);
  const file = bindingPathFor(root, 'ios', 'local-ios');
  writeBinding(file, bindingFor(root, 'B'));
  const replacement = readBindingFile(file);
  await deps.releaseDevice();
  expect(readBindingFile(file)).toEqual(replacement);
  expect(tools.calls.filter(([command]) => command === 'shutdown')).toEqual([]);
});

it('cloud smoke stops its server without releasing local devices', async () => {
  await buildSmokeDeps(root, resolveSmokeOptions(['--ios', '--eas'])).stopDevServer();
  expect(devStopAsync).toHaveBeenCalledWith(
    root,
    expect.objectContaining({ release: false }),
    expect.anything()
  );
});

it('the dev server cleanup carries the devices dev:stop released', async () => {
  const device = {
    backend: 'local-ios' as const,
    platform: 'ios' as const,
    id: 'A',
    name: 'agent-cli 0000',
    released: true,
    shutDown: true,
    reason: null,
  };
  vi.mocked(devStopAsync).mockImplementationOnce(async (_root, _options, { onReport } = {}) => {
    onReport?.({ stopped: true, devices: [device], deviceError: null } as any);
    return 0;
  });
  const result = await buildSmokeDeps(root, resolveSmokeOptions(['--ios'])).stopDevServer();
  expect(result.devices).toEqual([device]);
});

it('a device that dev:stop could not release does not mark the dev server as still running', async () => {
  const device = {
    backend: 'local-ios' as const,
    platform: 'ios' as const,
    id: 'A',
    name: 'agent-cli 0000',
    released: false,
    shutDown: false,
    reason: 'simctl shutdown failed',
  };
  vi.mocked(devStopAsync).mockImplementationOnce(async (_root, _options, { onReport } = {}) => {
    onReport?.({
      stopped: true,
      reason: null,
      url: 'http://127.0.0.1:8081',
      devices: [device],
      deviceError: 'Some devices could not be released; see devices for details.',
    } as any);
    return 20;
  });
  const result = await buildSmokeDeps(root, resolveSmokeOptions(['--ios'])).stopDevServer();
  expect(result.ok).toBe(true);
  expect(result.devices).toEqual([device]);
});
