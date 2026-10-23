// @ref llp/0035-one-device-per-worktree.rfc.md §Readers
// The registry lock is a directory rename, which memfs lets replace a non-empty directory and the
// kernel refuses, so this suite runs on the real disk.
import fs from 'fs';
import path from 'path';

import { cloudProbe } from '../../device/__tests__/fakeCloudProbe';
import { probeCloudSessionAsync } from '../../device/cloudSimulator';
import * as Log from '../../log';
import { cloudRungAsync } from '../cloudRung';
import { bindingPathFor, readBindingFile, registryDirectory } from '../registry';
import { writeCloudBinding } from './fakeCloudBinding';
import { fakeTools } from './fakeTools';

vi.unmock('fs');
vi.unmock('node:fs');
vi.mock('../../log');
vi.mock('../../device/cloudSimulator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../device/cloudSimulator')>()),
  probeCloudSessionAsync: vi.fn(),
}));
const os = await vi.importActual<typeof import('os')>('os');

let home: string;
let root: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-rung-'));
  root = path.join(home, 'app');
  fs.mkdirSync(root);
  process.env.__UNSAFE_EXPO_HOME_DIRECTORY = home;
  vi.mocked(Log.warn).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.__UNSAFE_EXPO_HOME_DIRECTORY;
  fs.rmSync(home, { recursive: true, force: true });
});

it('warns and goes on when the registry is locked', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'));
  writeCloudBinding(root, 'ios', 'sess-1', { expiresAt: '2026-10-08T10:20:00.000Z' });
  fs.mkdirSync(path.join(registryDirectory(), '.lock'), { recursive: true });
  fs.writeFileSync(path.join(registryDirectory(), '.lock', 'pid-424242-abcd'), '');
  vi.mocked(probeCloudSessionAsync).mockResolvedValue(
    cloudProbe.active({ id: 'sess-1', platform: 'ios' })
  );
  const tools = { ...fakeTools(), isPidAlive: () => true };

  const pending = cloudRungAsync(root, 'ios', 'required', tools);
  await vi.advanceTimersByTimeAsync(6_000);
  const rung = await pending;

  expect(rung).toMatchObject({ kind: 'device', device: { platform: 'ios', id: 'sess-1' } });
  expect(Log.warn).toHaveBeenCalledWith(expect.stringContaining('registry is locked'));
  const read = readBindingFile(bindingPathFor(root, 'ios', 'cloud'));
  expect(read.kind === 'binding' && read.binding.expiresAt).toBe('2026-10-08T10:20:00.000Z');
});
