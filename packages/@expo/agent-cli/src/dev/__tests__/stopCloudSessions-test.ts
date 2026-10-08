import { vol } from 'memfs';
import { probeCloudSessionAsync } from '../../device/cloudSimulator';
import { stopEasSessionAsync } from '../../device/eas';
import { acquireCloudBindingAsync, ownCloudBindings } from '../../deviceBinding/cloud';
import { stopCloudSessionsAsync } from '../stopCloudSessions';
vi.mock('../../device/cloudSimulator', () => ({ probeCloudSessionAsync: vi.fn() }));
vi.mock('../../device/eas', () => ({ stopEasSessionAsync: vi.fn() }));
vi.mock('../events', () => ({ debugEvent: vi.fn() }));
const root = '/cloud-project';
const bind = (id: string, platform: 'ios' | 'android' = 'ios') =>
  acquireCloudBindingAsync(root, { platform, id, origin: 'started' });
beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${root}/package.json`]: '{}' });
  vi.mocked(probeCloudSessionAsync).mockResolvedValue({
    state: 'active',
    sessionId: 'A',
    platform: 'ios',
    reason: null,
  } as any);
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
  expect(ownCloudBindings(root, true)).toEqual([]);
});
it('a successful stop of A keeps a replacement B written during the stop', async () => {
  await bind('A');
  vi.mocked(stopEasSessionAsync).mockImplementation(async () => {
    await bind('B');
    return { ok: true, reason: null };
  });
  await stopCloudSessionsAsync(root);
  expect(ownCloudBindings(root, true)).toMatchObject([{ device: { id: 'B' } }]);
});
it('a failed stop keeps A for retry', async () => {
  await bind('A');
  vi.mocked(stopEasSessionAsync).mockResolvedValue({ ok: false, reason: 'refused' });
  expect(await stopCloudSessionsAsync(root)).toMatchObject({
    deviceError: 'refused',
    session: { stopped: false },
  });
  expect(ownCloudBindings(root, true)).toMatchObject([{ device: { id: 'A' } }]);
});
