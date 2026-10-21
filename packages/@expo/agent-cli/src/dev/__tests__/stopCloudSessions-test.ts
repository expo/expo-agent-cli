import fs from 'fs';
import path from 'path';
import { vol } from 'memfs';
import { bindingPathFor } from '../../deviceBinding/registry';
import { probeCloudSessionAsync } from '../../device/cloudSimulator';
import { stopEasSessionAsync } from '../../device/eas';
import { cloudStopCommand } from '../../deviceBinding/cleanup';
import { cloudProbe } from '../../device/__tests__/fakeCloudProbe';
import { acquireCloudBindingAsync, readCloudBindings } from '../../deviceBinding/cloud';
import { stopCloudSessionsAsync } from '../stopCloudSessions';
vi.mock('../../device/cloudSimulator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../device/cloudSimulator')>()),
  probeCloudSessionAsync: vi.fn(),
}));
vi.mock('../../device/eas', () => ({ stopEasSessionAsync: vi.fn() }));
vi.mock('../events', () => ({ debugEvent: vi.fn() }));
const root = '/cloud-project';
const bind = (id: string, platform: 'ios' | 'android' = 'ios') =>
  acquireCloudBindingAsync(root, { platform, id, origin: 'started' });
beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${root}/package.json`]: '{}' });
  vi.mocked(probeCloudSessionAsync).mockResolvedValue(
    cloudProbe.active({ id: 'A', platform: 'ios' })
  );
  vi.mocked(stopEasSessionAsync).mockResolvedValue({ ok: true, reason: null });
});
it('stops both platform bindings', async () => {
  await bind('A');
  await bind('B', 'android');
  const result = await stopCloudSessionsAsync(root);
  expect(stopEasSessionAsync).toHaveBeenCalledWith(root, 'A');
  expect(stopEasSessionAsync).toHaveBeenCalledWith(root, 'B');
  expect(result.session).toMatchObject({ id: 'A', stopped: true });
  expect(result.devices).toMatchObject([{ id: 'B', released: true }]);
  expect(readCloudBindings(root).bindings).toEqual([]);
});
it('a failed stop of a bound session reports its row and keeps its binding', async () => {
  await bind('B', 'android');
  vi.mocked(stopEasSessionAsync).mockImplementation(async (_root, id) =>
    id === 'B' ? { ok: false, reason: 'refused' } : { ok: true, reason: null }
  );
  expect(await stopCloudSessionsAsync(root)).toEqual({
    session: { id: 'A', stopped: true, reason: null, platform: 'ios' },
    devices: [
      {
        backend: 'cloud',
        platform: 'android',
        id: 'B',
        name: 'B',
        released: false,
        shutDown: false,
        reason: `refused; "${cloudStopCommand('B')}" ends it`,
      },
    ],
    deviceError: `refused; "${cloudStopCommand('B')}" ends it`,
  });
  expect(readCloudBindings(root).bindings).toMatchObject([{ device: { id: 'B' } }]);
});
it('stops the session in progress when no binding names it', async () => {
  const result = await stopCloudSessionsAsync(root);
  expect(stopEasSessionAsync).toHaveBeenCalledWith(root, 'A');
  expect(result).toEqual({
    session: { id: 'A', stopped: true, reason: null, platform: 'ios' },
    devices: [],
    deviceError: null,
  });
});
it('names an unreadable cloud binding file', async () => {
  const file = bindingPathFor(root, 'android', 'cloud');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'garbage');
  const { deviceError } = await stopCloudSessionsAsync(root);
  expect(deviceError).toContain(`The binding file ${file} does not parse`);
  expect(deviceError).toContain(`How: run "rm -f '${file}'"`);
});
