import { vol } from 'memfs';

import { acquireDeviceAsync, releaseWorktreeDevicesAsync } from '..';
import { EXTEND_EVERY_MS, LEASE_MS } from '../lease';
import { withLeaseExtendedAsync } from '../renew';
import { bindingPathFor, readBindingFile } from '../registry';
import { bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';
const file = () => bindingPathFor(ROOT, 'ios', 'local-ios');

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
});
afterEach(() => vi.useRealTimers());

it('release-leaves-replacement-binding', async () => {
  const tools = fakeTools({ simulators: [{ udid: 'OLD', name: 'old', state: 'Booted' }] });
  writeBinding(file(), bindingFor(ROOT, 'OLD'));
  const replacement = bindingFor(ROOT, 'NEW');
  const simctl = tools.simctl;
  tools.simctl = async (...args) => {
    const result = await simctl(...args);
    writeBinding(file(), replacement);
    return result;
  };
  expect(await releaseWorktreeDevicesAsync(ROOT, { tools })).toEqual([]);
  expect(readBindingFile(file())).toEqual({ kind: 'binding', binding: replacement });
  expect(tools.calls.some(([command]) => command === 'shutdown')).toBe(false);
});

it('failed-boot-leaves-replacement-binding', async () => {
  const tools = fakeTools({ bootFails: true });
  const replacement = bindingFor(ROOT, 'NEW');
  const simctl = tools.simctl;
  tools.simctl = async (...args) => {
    const result = await simctl(...args);
    if (args[0][0] === 'bootstatus') writeBinding(file(), replacement);
    return result;
  };
  await expect(acquireDeviceAsync(ROOT, 'ios', { tools })).rejects.toMatchObject({
    data: { reason: 'boot-failed' },
  });
  expect(readBindingFile(file())).toEqual({ kind: 'binding', binding: replacement });
});

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
  const cloud = {
    ...bindingFor(ROOT, 'unused'),
    device: {
      backend: 'cloud' as const,
      platform: 'android' as const,
      id: 'session',
      origin: 'started' as const,
    },
  };
  writeBinding(cloudFile, cloud);
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

it('release validates the Android pid even when its serial did not change', async () => {
  const registry = await import('../registry');
  const { androidBindingFor } = await import('./fakeTools');
  const androidFile = bindingPathFor(ROOT, 'android', 'local-android');
  const old = androidBindingFor(ROOT, 'emulator-5554', {
    kind: 'spawned',
    avd: 'Pixel',
    port: 5554,
    emulatorPid: 77,
  });
  const replacement = androidBindingFor(ROOT, 'emulator-5554', {
    kind: 'spawned',
    avd: 'Pixel',
    port: 5554,
    emulatorPid: 88,
  });
  writeBinding(androidFile, old);
  const lock = registry.withRegistryLockAsync;
  const replaced = vi
    .spyOn(registry, 'withRegistryLockAsync')
    .mockImplementation(async (work, options) => {
      writeBinding(androidFile, replacement);
      return lock(work, options);
    });
  const tools = fakeTools({ alivePids: [77, 88] });
  try {
    expect(await releaseWorktreeDevicesAsync(ROOT, { tools, platform: 'android' })).toEqual([]);
    expect(readBindingFile(androidFile)).toEqual({ kind: 'binding', binding: replacement });
    expect(tools.killed).toEqual([]);
  } finally {
    replaced.mockRestore();
  }
});
