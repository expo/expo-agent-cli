import fs from 'fs';
import { vol } from 'memfs';

import { acquireDeviceAsync } from '../../deviceBinding';
import { fakeTools } from '../../deviceBinding/__tests__/fakeTools';
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
  tools.clock.now = new Date('2026-10-08T10:05:00Z');
  await acquireDeviceAsync(root, 'ios', { explicit: 'B', tools });
  const file = bindingPathFor(root, 'ios', 'local-ios');
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
