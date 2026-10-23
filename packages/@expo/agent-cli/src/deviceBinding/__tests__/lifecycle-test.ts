import { vol } from 'memfs';

import { releaseWorktreeDevicesAsync } from '..';
import { deviceCommand } from '../errors';
import { EXTEND_EVERY_MS, LEASE_MS } from '../lease';
import { withLeaseExtendedAsync } from '../renew';
import { bindingPathFor, readBindingFile } from '../registry';
import { writeCloudBinding } from './fakeCloudBinding';
import { bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';
const file = () => bindingPathFor(ROOT, 'ios', 'local-ios');

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
});
afterEach(() => vi.useRealTimers());

it('explicit-expires-keeps-file and explicit-never-shut-down', async () => {
  const tools = fakeTools({ simulators: [{ udid: 'HUMAN', name: 'human', state: 'Booted' }] });
  const binding = bindingFor(ROOT, 'HUMAN');
  binding.device = {
    backend: 'local-ios',
    platform: 'ios',
    udid: 'HUMAN',
    name: 'human',
    origin: 'explicit',
  };
  writeBinding(file(), binding);
  await releaseWorktreeDevicesAsync(ROOT, { tools });
  expect(readBindingFile(file())).toMatchObject({
    kind: 'binding',
    binding: { expiresAt: tools.now().toISOString() },
  });
  expect(tools.calls.some(([command]) => ['shutdown', 'delete'].includes(command!))).toBe(false);
});

it('timer picks up late cloud files, warns lost once, and resumes revived files', async () => {
  vi.useFakeTimers();
  const tools = fakeTools();
  const warn = vi.fn();
  let finish!: () => void;
  const work = withLeaseExtendedAsync(
    ROOT,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    { tools, warn }
  );
  const cloudFile = bindingPathFor(ROOT, 'android', 'cloud');
  const cloud = writeCloudBinding(ROOT, 'android', 'session');
  tools.clock.now = new Date(tools.now().getTime() + EXTEND_EVERY_MS);
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  expect(readBindingFile(cloudFile)).toMatchObject({
    binding: { expiresAt: new Date(tools.now().getTime() + LEASE_MS).toISOString() },
  });
  tools.clock.now = new Date(tools.now().getTime() + LEASE_MS + 1);
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS * 2);
  expect(warn).toHaveBeenCalledTimes(1);
  writeBinding(cloudFile, {
    ...cloud,
    expiresAt: new Date(tools.now().getTime() + LEASE_MS).toISOString(),
  });
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  tools.clock.now = new Date(tools.now().getTime() + LEASE_MS + 1);
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  expect(warn).toHaveBeenCalledTimes(2);
  finish();
  await work;
  expect(vi.getTimerCount()).toBe(0);
});

it('foreground-exit-touches-no-binding', async () => {
  const binding = bindingFor(ROOT, 'OLD');
  writeBinding(file(), binding);
  await withLeaseExtendedAsync(ROOT, async () => {}, { tools: fakeTools() });
  expect(readBindingFile(file())).toEqual({ kind: 'binding', binding });
});

it('a lost lease names the dev command, with --eas for a cloud file', async () => {
  vi.useFakeTimers();
  const tools = fakeTools();
  const warn = vi.fn();
  writeBinding(file(), bindingFor(ROOT, 'SIM'));
  writeCloudBinding(ROOT, 'android', 'session');
  let finish!: () => void;
  const work = withLeaseExtendedAsync(
    ROOT,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    { tools, warn }
  );
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  tools.clock.now = new Date(tools.now().getTime() + LEASE_MS + 1);
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  finish();
  await work;
  expect(warn.mock.calls.map(([message]) => message)).toEqual([
    expect.stringContaining(`"${deviceCommand('ios')}"`),
    expect.stringContaining('dev --android --eas --detach --wait-ready'),
  ]);
});
