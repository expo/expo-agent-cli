import fs from 'node:fs';
import path from 'node:path';

import { acquireDeviceAsync } from '..';
import { bindingPathFor, readBindingFile, withRegistryLockAsync } from '../registry';
import { fakeTools } from './fakeTools';

vi.unmock('fs');
vi.unmock('node:fs');
const os = await vi.importActual<typeof import('os')>('os');
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-cancel-'));
  vi.stubEnv('__UNSAFE_EXPO_HOME_DIRECTORY', path.join(root, 'home'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(['ios', 'android'] as const)(
  'cancels queued %s acquisition before any binding or boot',
  async (platform) => {
    const tools = fakeTools();
    let unhold!: () => void;
    let queued = false;
    const held = withRegistryLockAsync(() => new Promise<void>((resolve) => (unhold = resolve)), {
      tools,
      waitMs: 2000,
    });
    tools.isPidAlive = () => {
      queued = true;
      return true;
    };
    const controller = new AbortController();
    const acquired = acquireDeviceAsync(root, platform, { tools, signal: controller.signal }).catch(
      (error: unknown) => error
    );
    try {
      await vi.waitFor(() => expect(queued).toBe(true));
      controller.abort(new Error('cancelled while queued'));
    } finally {
      unhold();
      await held;
    }
    expect(await acquired).toMatchObject({ message: 'cancelled while queued' });
    expect(
      readBindingFile(
        bindingPathFor(root, platform, platform === 'ios' ? 'local-ios' : 'local-android')
      )
    ).toEqual({ kind: 'none' });
    expect(tools.calls.some(([command]) => command === 'create' || command === 'bootstatus')).toBe(
      false
    );
    expect(tools.spawned).toHaveLength(0);
  }
);

it('captures a committed binding before cancellation can skip its boot', async () => {
  const tools = fakeTools();
  const controller = new AbortController();
  let captured: unknown;
  await expect(
    acquireDeviceAsync(root, 'ios', {
      tools,
      signal: controller.signal,
      onBound(binding) {
        captured = binding;
        controller.abort(new Error('cancelled after allocation'));
      },
    })
  ).rejects.toThrow('cancelled after allocation');
  expect(captured).toMatchObject({ device: { udid: 'CREATED-1' } });
  expect(tools.calls.some(([command]) => command === 'bootstatus')).toBe(false);
});
