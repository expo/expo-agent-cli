import fs from 'fs';
import path from 'path';
import { vol } from 'memfs';

import { acquireDeviceAsync } from '..';
import { reapDevicesAsync } from '../reap';
import { bindingPathFor, readBindingFile } from '../registry';
import { androidBindingFor, bindingFor, fakeTools, writeBinding } from './fakeTools';

const host = process.platform;
afterEach(() => Object.defineProperty(process, 'platform', { value: host }));

const ROOT = '/work/app';
const OTHER = '/work/other';
const foreign = () => bindingPathFor(OTHER, 'ios', 'local-ios');
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}', [`${OTHER}/package.json`]: '{}' });
});

it('deleted-worktree-deletes-simulator after the registry lock is released', async () => {
  const tools = fakeTools({ simulators: [{ udid: 'OLD', name: 'old', state: 'Booted' }] });
  const file = foreign();
  writeBinding(file, bindingFor(OTHER, 'OLD'));
  fs.rmSync(OTHER, { recursive: true });
  const reaped = await reapDevicesAsync(ROOT, { tools });
  expect(readBindingFile(file)).toEqual({ kind: 'none' });
  expect(tools.calls).toContainEqual(['delete', 'OLD']);
  expect(tools.lockedAt[tools.calls.findIndex(([command]) => command === 'delete')]).toBe(false);
  expect(reaped).toMatchObject([{ id: 'OLD', reason: 'deleted-worktree', released: true }]);
});

it('reap reads after own write and does not park the newly created simulator', async () => {
  const tools = fakeTools({ simulators: [{ udid: 'OLD', name: 'old', state: 'Booted' }] });
  writeBinding(foreign(), bindingFor(OTHER, 'OLD', { expiresAt: '2020-01-01T00:00:00Z' }));
  await acquireDeviceAsync(ROOT, 'ios', { tools });
  expect(tools.calls).toContainEqual(['shutdown', 'OLD']);
  expect(tools.simulators.find(({ udid }) => udid === 'CREATED-1')?.state).toBe('Booted');
  expect(readBindingFile(bindingPathFor(ROOT, 'ios', 'local-ios'))).toMatchObject({
    binding: { device: { udid: 'CREATED-1' } },
  });
});

it('a refusal still reaps and kills the queued emulator', async () => {
  const tools = fakeTools({
    runtime: false,
    emulators: [
      {
        serial: 'emulator-5554',
        state: 'device',
        pid: 5001,
        command: 'emulator -avd Pixel -ports 5554,5555',
      },
    ],
  });
  const file = bindingPathFor(OTHER, 'android', 'local-android');
  writeBinding(
    file,
    androidBindingFor(
      OTHER,
      'emulator-5554',
      { kind: 'spawned', avd: 'Pixel', port: 5554, emulatorPid: 5001 },
      { expiresAt: '2020-01-01T00:00:00Z' }
    )
  );
  await expect(acquireDeviceAsync(ROOT, 'ios', { tools })).rejects.toMatchObject({
    data: { reason: 'no-ios-runtime' },
  });
  expect(readBindingFile(file)).toEqual({ kind: 'none' });
  expect(tools.killed).toEqual([5001]);
});

it('stop without inventory leaves an expired created simulator parked, and explicit devices untouched', async () => {
  const tools = fakeTools({ simulators: [{ udid: 'OLD', name: 'old', state: 'Booted' }] });
  const binding = bindingFor(OTHER, 'OLD', { expiresAt: '2020-01-01T00:00:00Z' });
  writeBinding(foreign(), binding);
  expect(await reapDevicesAsync(ROOT, { tools })).toEqual([]);
  expect(readBindingFile(foreign())).toEqual({ kind: 'binding', binding });
  expect(tools.calls).toEqual([]);
});

it('runs an already queued emulator kill when a later registry removal fails', async () => {
  const registry = await import('../registry');
  const directory = registry.registryDirectory();
  const first = path.join(directory, 'aaa-android-local-android.json');
  const second = path.join(directory, 'zzz-android-local-android.json');
  const origin = { kind: 'spawned' as const, avd: 'Pixel', port: 5554, emulatorPid: 5001 };
  const binding = androidBindingFor(OTHER, 'emulator-5554', origin, {
    expiresAt: '2020-01-01T00:00:00Z',
  });
  writeBinding(first, binding);
  writeBinding(second, {
    ...binding,
    device: {
      backend: 'local-android',
      platform: 'android',
      serial: 'emulator-5556',
      origin: { ...origin, port: 5556, emulatorPid: 5002 },
    },
  });
  const tools = fakeTools({
    emulators: [
      {
        serial: 'emulator-5554',
        state: 'device',
        pid: 5001,
        command: 'emulator -avd Pixel -ports 5554,5555',
      },
    ],
  });
  const remove = registry.removeBindingFile;
  const spy = vi.spyOn(registry, 'removeBindingFile').mockImplementation((file) => {
    if (file === second) throw new Error('disk failure');
    remove(file);
  });
  try {
    await expect(reapDevicesAsync(ROOT, { tools })).rejects.toThrow('disk failure');
    expect(tools.killed).toEqual([5001]);
    expect(readBindingFile(first)).toEqual({ kind: 'none' });
    expect(readBindingFile(second).kind).toBe('binding');
  } finally {
    spy.mockRestore();
  }
});
