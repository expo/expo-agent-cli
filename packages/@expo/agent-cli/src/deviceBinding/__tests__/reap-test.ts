import fs from 'fs';
import path from 'path';
import { vol } from 'memfs';

import { acquireDeviceAsync } from '..';
import { deletedWorktreeSessions, reapDevicesAsync } from '../reap';
import { bindingPathFor, readBindingFile } from '../registry';
import { writeCloudBinding } from './fakeCloudBinding';
import { androidBindingFor, bindingFor, fakeTools, writeBinding } from './fakeTools';
import { mockPlatform } from '../../utils/__tests__/mockPlatform';
import { printed } from '../../utils/__tests__/printed';

const ROOT = '/work/app';
const OTHER = '/work/other';
const foreign = () => bindingPathFor(OTHER, 'ios', 'local-ios');
beforeEach(() => {
  mockPlatform('darwin');
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}', [`${OTHER}/package.json`]: '{}' });
});

it('deleted-worktree-deletes-simulator after the registry lock is released', async () => {
  const stderr = vi.spyOn(console, 'error');
  const tools = fakeTools({ simulators: [{ udid: 'OLD', name: 'old', state: 'Booted' }] });
  const file = foreign();
  writeBinding(file, bindingFor(OTHER, 'OLD'));
  fs.rmSync(OTHER, { recursive: true });
  const { reports: reaped } = await reapDevicesAsync(ROOT, { tools });
  expect(readBindingFile(file)).toEqual({ kind: 'none' });
  expect(tools.calls).toContainEqual(['delete', 'OLD']);
  expect(tools.lockedAt[tools.calls.findIndex(([command]) => command === 'delete')]).toBe(false);
  expect(reaped).toMatchObject([
    {
      id: 'OLD',
      reason: 'deleted-worktree',
      released: true,
      projectRoot: OTHER,
      devServerCleanup: 'not-checked',
    },
  ]);
  expect(printed(stderr)).toContain('Dev-server cleanup was not checked');
});

it.each(['returned', 'thrown'])('reports a %s cleanup failure as not released', async (failure) => {
  const tools = fakeTools({ simulators: [{ udid: 'OLD', name: 'old', state: 'Booted' }] });
  writeBinding(foreign(), bindingFor(OTHER, 'OLD'));
  fs.rmSync(OTHER, { recursive: true });
  tools.simctl = async () => {
    if (failure === 'thrown') throw new Error('delete failed');
    return { exitCode: 1, stdout: '', stderr: 'delete failed' };
  };
  const { reports, error } = await reapDevicesAsync(ROOT, { tools });
  expect(error).toBeNull();
  expect(reports).toMatchObject([
    {
      id: 'OLD',
      released: false,
      shutDown: false,
      error: expect.stringContaining('delete failed'),
      projectRoot: OTHER,
      devServerCleanup: 'not-checked',
    },
  ]);
  expect(tools.simulators[0]!.state).toBe('Booted');
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
  expect(await reapDevicesAsync(ROOT, { tools })).toEqual({ reports: [], error: null });
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
    const { reports, error } = await reapDevicesAsync(ROOT, { tools });
    expect(error).toBe('disk failure');
    expect(reports).toMatchObject([{ id: 'emulator-5554', released: true, shutDown: true }]);
    expect(tools.killed).toEqual([5001]);
    expect(readBindingFile(first)).toEqual({ kind: 'none' });
    expect(readBindingFile(second).kind).toBe('binding');
  } finally {
    spy.mockRestore();
  }
});

it('a reaped emulator whose pid now runs another program is reported device-gone and not killed', async () => {
  const stderr = vi.spyOn(console, 'error');
  const tools = fakeTools({ alivePids: [5001] });
  writeBinding(
    bindingPathFor(OTHER, 'android', 'local-android'),
    androidBindingFor(
      OTHER,
      'emulator-5554',
      { kind: 'spawned', avd: 'Pixel', port: 5554, emulatorPid: 5001 },
      { expiresAt: '2020-01-01T00:00:00Z' }
    )
  );
  const { reports } = await reapDevicesAsync(ROOT, { tools });
  expect(tools.killed).toEqual([]);
  expect(reports).toMatchObject([
    { id: 'emulator-5554', released: true, shutDown: false, reason: 'device-gone' },
  ]);
  expect(printed(stderr)).toContain(
    '(device-gone): pid 5001 is not the emulator instance of Pixel on port 5554 any more'
  );
});

it('a simulator whose delete failed is deleted by the next reap', async () => {
  const stderr = vi.spyOn(console, 'error');
  const tools = fakeTools({ simulators: [{ udid: 'OLD', name: 'old', state: 'Booted' }] });
  writeBinding(foreign(), bindingFor(OTHER, 'OLD'));
  fs.rmSync(OTHER, { recursive: true });
  const simctl = tools.simctl;
  let failing = true;
  tools.simctl = async (args, options) =>
    failing && args[0] === 'delete'
      ? { stdout: '', stderr: 'delete failed', exitCode: 1 }
      : simctl(args, options);
  const first = await reapDevicesAsync(ROOT, { tools });
  failing = false;
  const second = await reapDevicesAsync(ROOT, { tools });
  expect(first.reports).toMatchObject([{ id: 'OLD', released: false }]);
  expect(second.reports).toMatchObject([{ id: 'OLD', released: true }]);
  expect(readBindingFile(foreign())).toEqual({ kind: 'none' });
  expect(tools.simulators).toEqual([]);
  expect(first.reports[0]!.error).toBe(
    'simctl delete OLD exited 1: delete failed\nHow: run "xcrun simctl delete OLD".'
  );
  expect(printed(stderr)).not.toContain('How:');
});

it('an emulator whose kill threw is killed by the next reap', async () => {
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
  const kill = tools.kill;
  let failing = true;
  tools.kill = (pid) => {
    if (failing) throw new Error('kill EPERM');
    kill(pid);
  };
  const first = await reapDevicesAsync(ROOT, { tools });
  failing = false;
  const second = await reapDevicesAsync(ROOT, { tools });
  expect(first.reports).toMatchObject([{ id: 'emulator-5554', released: false }]);
  expect(second.reports).toMatchObject([{ id: 'emulator-5554', released: true, shutDown: true }]);
  expect(readBindingFile(file)).toEqual({ kind: 'none' });
  expect(tools.killed).toEqual([5001]);
  expect(first.reports[0]!.error).toBe('kill EPERM\nHow: run "kill 5001".');
});

it('a later reap of a session stopped by hand stops it again with no error and forgets it', async () => {
  const stderr = vi.spyOn(console, 'error');
  const tools = fakeTools();
  writeCloudBinding(OTHER, 'ios', 'A');
  fs.rmSync(OTHER, { recursive: true });
  // `eas simulator:stop --id` by hand leaves the binding file; the service call it makes,
  // `ensureDeviceRunSessionStopped`, answers a stopped session as stopped.
  const stopped = await tools.stopCloud(ROOT, 'A');
  const first = await reapDevicesAsync(ROOT, { tools });
  const second = await reapDevicesAsync(ROOT, { tools });
  expect(stopped).toEqual({ ok: true, reason: null });
  expect(first).toMatchObject({ error: null, reports: [{ id: 'A', released: true }] });
  expect(first.reports[0]!.error).toBeUndefined();
  expect(second).toEqual({ reports: [], error: null });
  expect(printed(stderr)).not.toContain('Could not release');
});

describe('deletedWorktreeSessions', () => {
  const now = new Date('2026-10-08T10:00:00.000Z');
  const GONE = '/work/gone';

  it('names the started session of a deleted worktree, which the reap stops', () => {
    vol.mkdirSync(GONE, { recursive: true });
    const binding = writeCloudBinding(GONE, 'android', 'A');
    fs.rmSync(GONE, { recursive: true });
    expect(deletedWorktreeSessions(ROOT, now)).toEqual([binding]);
  });

  it('skips its own, a live root, a dotenv origin and a session past the cap', () => {
    writeCloudBinding(ROOT, 'ios', 'OWN');
    writeCloudBinding(OTHER, 'ios', 'LIVE-ROOT');
    vol.mkdirSync(GONE, { recursive: true });
    writeCloudBinding(GONE, 'ios', 'DOTENV', { origin: 'dotenv' });
    writeCloudBinding(GONE, 'android', 'CAPPED', { boundAt: '2026-10-08T07:00:00.000Z' });
    fs.rmSync(GONE, { recursive: true });
    expect(deletedWorktreeSessions(ROOT, now)).toEqual([]);
  });
});
