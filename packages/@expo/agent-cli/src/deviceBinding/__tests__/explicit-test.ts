import { vol } from 'memfs';

import { acquireDeviceAsync, releaseWorktreeDevicesAsync } from '..';
import { bindingPathFor, readBindingFile } from '../registry';
import { androidBindingFor, bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';
const OTHER = '/work/other';
const file = (root = ROOT) => bindingPathFor(root, 'ios', 'local-ios');
beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}', [`${OTHER}/package.json`]: '{}' });
});
const human = { udid: 'HUMAN', name: 'My iPhone', state: 'Shutdown' as const };

it('device-over-own-created-deletes, while explicit-never-shut-down', async () => {
  const tools = fakeTools({
    simulators: [human, { udid: 'OLD', name: 'agent-cli old', state: 'Booted' }],
  });
  writeBinding(file(), bindingFor(ROOT, 'OLD'));
  expect(await acquireDeviceAsync(ROOT, 'ios', { explicit: 'my iphone', tools })).toMatchObject({
    action: 'explicit',
    device: { udid: 'HUMAN', origin: 'explicit' },
  });
  expect(tools.calls).toContainEqual(['delete', 'OLD']);
  expect(tools.lockedAt[tools.calls.findIndex(([command]) => command === 'delete')]).toBe(false);
  await releaseWorktreeDevicesAsync(ROOT, { tools });
  expect(tools.calls).not.toContainEqual(['shutdown', 'HUMAN']);
  expect(readBindingFile(file())).toMatchObject({ binding: { device: { udid: 'HUMAN' } } });
});

it.each(['2999-01-01T00:00:00Z', '2020-01-01T00:00:00Z'])(
  'explicit-bound-live-or-stale (%s)',
  async (expiresAt) => {
    const tools = fakeTools({ simulators: [human] });
    writeBinding(file(OTHER), bindingFor(OTHER, 'HUMAN', { expiresAt }));
    await expect(
      acquireDeviceAsync(ROOT, 'ios', { explicit: 'HUMAN', tools })
    ).rejects.toMatchObject({ data: { reason: 'explicit-bound' }, exitCode: 20 });
    expect(readBindingFile(file())).toEqual({ kind: 'none' });
  }
);

it('transfers an expired foreign explicit device and reuses it on the next dev', async () => {
  const tools = fakeTools({ simulators: [human] });
  const binding = bindingFor(OTHER, 'HUMAN', { expiresAt: '2020-01-01T00:00:00Z' });
  if (binding.device.backend === 'local-ios') binding.device.origin = 'explicit';
  writeBinding(file(OTHER), binding);
  await acquireDeviceAsync(ROOT, 'ios', { explicit: 'human', tools });
  expect(readBindingFile(file(OTHER))).toEqual({ kind: 'none' });
  expect(await acquireDeviceAsync(ROOT, 'ios', { tools })).toMatchObject({
    action: 'reused',
    device: { udid: 'HUMAN', origin: 'explicit' },
  });
});

it('refuses ambiguous names, leaked creates, and reuseOnly replacement without changing the own binding', async () => {
  const tools = fakeTools({
    simulators: [
      human,
      { ...human, udid: 'SECOND' },
      { udid: 'LEAK', name: 'agent-cli lost', state: 'Shutdown' },
    ],
  });
  await expect(
    acquireDeviceAsync(ROOT, 'ios', { explicit: human.name, tools })
  ).rejects.toMatchObject({
    data: { reason: 'explicit-not-found', matches: ['HUMAN', 'SECOND'] },
    exitCode: 1,
  });
  await expect(acquireDeviceAsync(ROOT, 'ios', { explicit: 'LEAK', tools })).rejects.toMatchObject({
    data: { reason: 'explicit-not-found' },
  });
  writeBinding(file(), bindingFor(ROOT, 'SECOND'));
  await expect(
    acquireDeviceAsync(ROOT, 'ios', { explicit: 'HUMAN', reuseOnly: true, tools })
  ).rejects.toMatchObject({ data: { reason: 'not-reusable' } });
  expect(readBindingFile(file())).toMatchObject({ binding: { device: { udid: 'SECOND' } } });
});

it('will not orphan an own spawned emulator when asked to use another serial', async () => {
  const tools = fakeTools({
    emulators: [
      { serial: 'emulator-5554', state: 'device', pid: 4001 },
      { serial: 'emulator-5556', state: 'device' },
    ],
  });
  const file = bindingPathFor(ROOT, 'android', 'local-android');
  const binding = androidBindingFor(ROOT, 'emulator-5554', {
    kind: 'spawned',
    avd: 'Pixel',
    port: 5554,
    emulatorPid: 4001,
  });
  writeBinding(file, binding);
  await expect(
    acquireDeviceAsync(ROOT, 'android', { explicit: 'emulator-5556', tools })
  ).rejects.toMatchObject({ data: { reason: 'own-explicit-over-owned' }, exitCode: 1 });
  expect(readBindingFile(file)).toEqual({ kind: 'binding', binding });
  expect(tools.killed).toEqual([]);
});

it('preview reports a foreign owner without changing its expired binding or running cleanup', async () => {
  const { previewExplicitDeviceAsync } = await import('../preview');
  const tools = fakeTools({ simulators: [human] });
  const binding = bindingFor(OTHER, 'HUMAN', { expiresAt: '2020-01-01T00:00:00Z' });
  writeBinding(file(OTHER), binding);
  await expect(previewExplicitDeviceAsync(ROOT, 'ios', 'HUMAN', tools)).rejects.toThrow(
    'bound to the worktree /work/other'
  );
  expect(readBindingFile(file(OTHER))).toEqual({ kind: 'binding', binding });
  expect(readBindingFile(file())).toEqual({ kind: 'none' });
  expect(tools.calls.every(([command]) => command === 'list')).toBe(true);
});

it('reuses an explicitly named owned Android instance while adb still lists it offline', async () => {
  const tools = fakeTools({
    emulators: [{ serial: 'emulator-5554', state: 'offline', pid: 4001 }],
  });
  const file = bindingPathFor(ROOT, 'android', 'local-android');
  const binding = androidBindingFor(ROOT, 'emulator-5554', {
    kind: 'spawned',
    avd: 'Pixel',
    port: 5554,
    emulatorPid: 4001,
  });
  writeBinding(file, binding);
  expect(
    await acquireDeviceAsync(ROOT, 'android', { explicit: 'emulator-5554', tools })
  ).toMatchObject({ action: 'reused', device: binding.device });
  expect(tools.spawned).toEqual([]);
});
