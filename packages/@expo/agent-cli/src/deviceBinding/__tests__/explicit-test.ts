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
const named = (query: string, rerun = ['--ios']) => ({ query, rerun });

it('device-over-own-created-deletes, while explicit-never-shut-down', async () => {
  const tools = fakeTools({
    simulators: [human, { udid: 'OLD', name: 'agent-cli old', state: 'Booted' }],
  });
  writeBinding(file(), bindingFor(ROOT, 'OLD'));
  expect(
    await acquireDeviceAsync(ROOT, 'ios', { explicit: named('my iphone'), tools })
  ).toMatchObject({
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
      acquireDeviceAsync(ROOT, 'ios', { explicit: named('HUMAN'), tools })
    ).rejects.toMatchObject({ data: { reason: 'explicit-bound' }, exitCode: 20 });
    expect(readBindingFile(file())).toEqual({ kind: 'none' });
  }
);

it('transfers an expired foreign explicit device and reuses it on the next dev', async () => {
  const tools = fakeTools({ simulators: [human] });
  const binding = bindingFor(OTHER, 'HUMAN', { expiresAt: '2020-01-01T00:00:00Z' });
  if (binding.device.backend === 'local-ios') binding.device.origin = 'explicit';
  writeBinding(file(OTHER), binding);
  await acquireDeviceAsync(ROOT, 'ios', { explicit: named('human'), tools });
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
    acquireDeviceAsync(ROOT, 'ios', { explicit: named(human.name), tools })
  ).rejects.toMatchObject({
    data: { reason: 'explicit-not-found', matches: ['HUMAN', 'SECOND'] },
    exitCode: 1,
  });
  await expect(
    acquireDeviceAsync(ROOT, 'ios', { explicit: named('LEAK'), tools })
  ).rejects.toMatchObject({
    data: { reason: 'explicit-not-found' },
  });
  writeBinding(file(), bindingFor(ROOT, 'SECOND'));
  await expect(
    acquireDeviceAsync(ROOT, 'ios', { explicit: named('HUMAN'), reuseOnly: true, tools })
  ).rejects.toMatchObject({
    data: { reason: 'not-reusable' },
    exitCode: 20,
    message:
      'The running dev server uses agent-cli 0000; --device names My iPhone.\nHow: run "npx @expo/agent-cli dev:stop", then this command again.',
  });
  expect(readBindingFile(file())).toMatchObject({ binding: { device: { udid: 'SECOND' } } });
});

it("refusals' How lines repeat the caller's flags, and an ambiguous name names a match", async () => {
  const tools = fakeTools({ simulators: [human, { ...human, udid: 'SECOND' }] });
  const rerun = ['--ios', '--detach', '--wait-ready', '--port', '8082'];
  writeBinding(file(OTHER), bindingFor(OTHER, 'SECOND'));
  await expect(
    acquireDeviceAsync(ROOT, 'ios', { explicit: named('SECOND', rerun), tools })
  ).rejects.toMatchObject({
    message:
      'My iPhone is bound to the worktree /work/other.\nHow: remove --device, then run "npx @expo/agent-cli dev --ios --detach --wait-ready --port 8082".',
    suggestedCommand: 'npx @expo/agent-cli dev --ios --detach --wait-ready --port 8082',
  });
  await expect(
    acquireDeviceAsync(ROOT, 'ios', { explicit: named('my iphone', rerun), tools })
  ).rejects.toMatchObject({
    message:
      'No device uniquely matches "my iphone"; matches: HUMAN, SECOND.\nHow: run "npx @expo/agent-cli dev --ios --detach --wait-ready --port 8082 --device HUMAN", or pass another match to --device.',
    suggestedCommand:
      'npx @expo/agent-cli dev --ios --detach --wait-ready --port 8082 --device HUMAN',
  });
  await expect(
    acquireDeviceAsync(ROOT, 'ios', { explicit: named('nope', rerun), tools })
  ).rejects.toMatchObject({
    message:
      'No device uniquely matches "nope".\nHow: run "xcrun simctl list devices available", then pass a listed name or UDID to --device.',
    suggestedCommand: 'xcrun simctl list devices available',
  });
  await expect(
    acquireDeviceAsync(ROOT, 'android', { explicit: named('nope', ['--android']), tools })
  ).rejects.toMatchObject({
    message:
      'No device uniquely matches "nope".\nHow: run "adb devices", then pass a listed serial to --device.',
  });
});

it("a refusal's How runs a foreground caller's command detached, without --plan", async () => {
  const tools = fakeTools({ simulators: [human] });
  writeBinding(file(OTHER), bindingFor(OTHER, 'HUMAN'));
  await expect(
    acquireDeviceAsync(ROOT, 'ios', {
      explicit: named('HUMAN', ['--local', '--plan', '--ios', '--port', '8082']),
      tools,
    })
  ).rejects.toMatchObject({
    suggestedCommand: 'npx @expo/agent-cli dev --ios --local --port 8082 --detach --wait-ready',
  });
});

it('preview refuses not-reusable as the run does while the own dev server runs', async () => {
  const { previewExplicitDeviceAsync } = await import('../preview');
  const tools = fakeTools({
    simulators: [human, { udid: 'OLD', name: 'agent-cli 0000', state: 'Booted' }],
  });
  writeBinding(file(), bindingFor(ROOT, 'OLD'));
  await expect(
    previewExplicitDeviceAsync(ROOT, 'ios', named('HUMAN'), true, tools)
  ).rejects.toMatchObject({
    data: { reason: 'not-reusable' },
    message: expect.stringContaining(
      'The running dev server uses agent-cli 0000; --device names My iPhone.'
    ),
  });
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
    acquireDeviceAsync(ROOT, 'android', { explicit: named('emulator-5556'), tools })
  ).rejects.toMatchObject({ data: { reason: 'own-explicit-over-owned' }, exitCode: 1 });
  expect(readBindingFile(file)).toEqual({ kind: 'binding', binding });
  expect(tools.killed).toEqual([]);
});

it('preview reports a foreign owner without changing its expired binding or running cleanup', async () => {
  const { previewExplicitDeviceAsync } = await import('../preview');
  const tools = fakeTools({ simulators: [human] });
  const binding = bindingFor(OTHER, 'HUMAN', { expiresAt: '2020-01-01T00:00:00Z' });
  writeBinding(file(OTHER), binding);
  await expect(
    previewExplicitDeviceAsync(ROOT, 'ios', named('HUMAN'), false, tools)
  ).rejects.toThrow('bound to the worktree /work/other');
  expect(readBindingFile(file(OTHER))).toEqual({ kind: 'binding', binding });
  expect(readBindingFile(file())).toEqual({ kind: 'none' });
  expect(tools.calls.every(([command]) => command === 'list')).toBe(true);
});

it('preview says which device it binds, whose expired binding it takes, and what it deletes', async () => {
  const { previewExplicitDeviceAsync } = await import('../preview');
  const tools = fakeTools({
    simulators: [human, { udid: 'OLD', name: 'agent-cli 0000', state: 'Booted' }],
  });
  const own = bindingFor(ROOT, 'OLD');
  const foreign = bindingFor(OTHER, 'HUMAN', { expiresAt: '2020-01-01T00:00:00Z' });
  if (foreign.device.backend === 'local-ios') foreign.device.origin = 'explicit';
  writeBinding(file(), own);
  writeBinding(file(OTHER), foreign);
  expect(
    (await previewExplicitDeviceAsync(ROOT, 'ios', named('my iphone'), false, tools)).summary
  ).toBe(
    'Will bind My iPhone (HUMAN), taken over from /work/other (lease expired); will delete agent-cli 0000 (replaced by --device).'
  );
  expect(readBindingFile(file())).toEqual({ kind: 'binding', binding: own });
  expect(readBindingFile(file(OTHER))).toEqual({ kind: 'binding', binding: foreign });
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
    await acquireDeviceAsync(ROOT, 'android', { explicit: named('emulator-5554'), tools })
  ).toMatchObject({ action: 'reused', device: binding.device });
  expect(tools.spawned).toEqual([]);
});

it('explicit-android-needs-only-adb', async () => {
  const { previewExplicitDeviceAsync } = await import('../preview');
  const tools = fakeTools({ emulators: [{ serial: 'R58N123', state: 'device' }] });
  tools.emulatorList = vi.fn(async () => ({
    stdout: '',
    stderr: '',
    exitCode: null,
    spawnError: Object.assign(new Error('spawn emulator ENOENT'), { code: 'ENOENT' }),
  }));
  expect(
    (await previewExplicitDeviceAsync(ROOT, 'android', named('R58N123'), false, tools)).device
  ).toMatchObject({
    serial: 'R58N123',
    origin: { kind: 'explicit' },
  });
  expect(
    await acquireDeviceAsync(ROOT, 'android', { explicit: named('R58N123'), tools })
  ).toMatchObject({
    action: 'explicit',
    device: { serial: 'R58N123' },
  });
  expect(readBindingFile(bindingPathFor(ROOT, 'android', 'local-android'))).toMatchObject({
    binding: { device: { serial: 'R58N123', origin: { kind: 'explicit' } } },
  });
  expect(tools.emulatorList).not.toHaveBeenCalled();
  expect(tools.calls.some(([command]) => command === 'emulator')).toBe(false);
});
