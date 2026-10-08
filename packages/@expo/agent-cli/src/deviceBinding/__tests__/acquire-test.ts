// @ref llp/0031-ios-binding.plan.md §Tests
import { vol } from 'memfs';

import { acquireDeviceAsync, releaseWorktreeDevicesAsync } from '..';
import { bindingPathFor, readBindingFile } from '../registry';
import { bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
});

const file = () => bindingPathFor(ROOT, 'ios', 'local-ios');

describe(acquireDeviceAsync, () => {
  it('creates a simulator on the newest iPhone runtime and binds its real udid', async () => {
    const tools = fakeTools();

    const result = await acquireDeviceAsync(ROOT, 'ios', { tools });

    expect(result).toMatchObject({ action: 'created', justBooted: true });
    expect(result.device).toMatchObject({ udid: 'CREATED-1', origin: 'created' });
    expect(tools.calls).toContainEqual([
      'create',
      expect.stringMatching(/^agent-cli [0-9a-f]{8}$/),
      expect.stringContaining('iPhone'),
      expect.stringContaining('iOS-26-0'),
    ]);
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.device).toMatchObject({ udid: 'CREATED-1' });
    expect(read.kind === 'binding' && read.binding.projectRoot).toBe(ROOT);
  });

  // bootstatus-b-not-boot
  it('boots with bootstatus -b, never simctl boot', async () => {
    const tools = fakeTools();

    await acquireDeviceAsync(ROOT, 'ios', { tools });

    expect(tools.calls).toContainEqual(['bootstatus', 'CREATED-1', '-b']);
    expect(tools.calls.some((call) => call[0] === 'boot')).toBe(false);
    expect(tools.simulators[0]).toMatchObject({ udid: 'CREATED-1', state: 'Booted' });
  });

  // boot-always-runs
  it('boots on a reuse too, whatever the inventory said', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }] });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1'));

    const result = await acquireDeviceAsync(ROOT, 'ios', { tools });

    expect(result).toMatchObject({ action: 'reused', justBooted: false });
    expect(tools.calls).toContainEqual(['bootstatus', 'SIM-1', '-b']);
  });

  it('reuses a parked simulator and renews the lease', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Shutdown' }] });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1', { expiresAt: '2026-10-08T09:30:00.000Z' }));

    const result = await acquireDeviceAsync(ROOT, 'ios', { tools });

    expect(result).toMatchObject({ action: 'reused', justBooted: true });
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.expiresAt).toBe('2026-10-08T11:00:00.000Z');
    expect(read.kind === 'binding' && read.binding.boundAt).toBe('2026-10-08T10:00:00.000Z');
  });

  // only-create-and-spawn-under-lock
  it('runs simctl create under the lock and every other device call after it', async () => {
    const tools = fakeTools();

    await acquireDeviceAsync(ROOT, 'ios', { tools });

    const locked = tools.calls.map((call, index) => [call[0], tools.lockedAt[index]]);
    expect(locked).toEqual([
      ['list', false],
      ['list', false],
      ['create', true],
      ['bootstatus', false],
    ]);
  });

  // failed-boot-lets-go
  it('lets go of the binding when the boot fails', async () => {
    const tools = fakeTools({ bootFails: true });

    const error = await acquireDeviceAsync(ROOT, 'ios', { tools }).catch((e) => e);

    expect(error.code).toBe('DEVICE_UNAVAILABLE');
    expect(error.data).toEqual({ reason: 'boot-failed' });
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.expiresAt).toBe('2026-10-08T10:00:00.000Z');
  });

  // agent-cli-name-needs-binding
  it('never adopts an agent-cli simulator no binding names', async () => {
    const tools = fakeTools({
      simulators: [{ udid: 'LEAKED', name: 'agent-cli deadbeef', state: 'Shutdown' }],
    });

    const result = await acquireDeviceAsync(ROOT, 'ios', { tools });

    expect(result.device).toMatchObject({ udid: 'CREATED-1' });
  });

  it('removes an own binding whose simulator is gone and creates again', async () => {
    const tools = fakeTools();
    writeBinding(file(), bindingFor(ROOT, 'GONE'));

    const result = await acquireDeviceAsync(ROOT, 'ios', { tools });

    expect(result).toMatchObject({ action: 'created' });
    expect(result.device).toMatchObject({ udid: 'CREATED-1' });
  });

  it('refuses not-reusable with reuseOnly and nothing to reuse', async () => {
    const tools = fakeTools();

    const error = await acquireDeviceAsync(ROOT, 'ios', { tools, reuseOnly: true }).catch((e) => e);

    expect(error.code).toBe('DEVICE_UNAVAILABLE');
    expect(error.data).toEqual({ reason: 'not-reusable' });
    expect(error.exitCode).toBe(20);
    expect(tools.calls.some((call) => call[0] === 'create')).toBe(false);
  });

  it('refuses no-ios-runtime before any create', async () => {
    const tools = fakeTools({ runtime: false });

    const error = await acquireDeviceAsync(ROOT, 'ios', { tools }).catch((e) => e);

    expect(error.data).toEqual({ reason: 'no-ios-runtime' });
    expect(error.exitCode).toBe(7);
  });

  it('refuses an own file that does not parse', async () => {
    const tools = fakeTools();
    vol.fromJSON({ [file()]: '{not json' });

    const error = await acquireDeviceAsync(ROOT, 'ios', { tools }).catch((e) => e);

    expect(error.data).toEqual({ reason: 'unreadable' });
    expect(error.message).toContain(`rm -f '${file()}'`);
  });

  it('throws the tool error when xcrun cannot run', async () => {
    const tools = fakeTools({ spawnError: true });

    const error = await acquireDeviceAsync(ROOT, 'ios', { tools }).catch((e) => e);

    expect(error.code).toBe('XCRUN_NOT_RUNNABLE');
  });
});

describe(releaseWorktreeDevicesAsync, () => {
  it('parks a created simulator and shuts it down after the section', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }] });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1'));

    const released = await releaseWorktreeDevicesAsync(ROOT, { tools });

    expect(released).toEqual([
      {
        backend: 'local-ios',
        platform: 'ios',
        id: 'SIM-1',
        name: 'agent-cli 0000',
        released: true,
        shutDown: true,
        reason: null,
      },
    ]);
    const shutdownAt = tools.calls.findIndex((call) => call[0] === 'shutdown');
    expect(tools.lockedAt[shutdownAt]).toBe(false);
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.expiresAt).toBe('2026-10-08T10:00:00.000Z');
  });

  it('removes the file of a simulator the inventory does not list', async () => {
    const tools = fakeTools();
    writeBinding(file(), bindingFor(ROOT, 'GONE'));

    await releaseWorktreeDevicesAsync(ROOT, { tools });

    expect(readBindingFile(file())).toEqual({ kind: 'none' });
    expect(tools.calls.some((call) => call[0] === 'shutdown')).toBe(false);
  });

  it('does nothing for a worktree with no binding', async () => {
    const tools = fakeTools();

    expect(await releaseWorktreeDevicesAsync(ROOT, { tools })).toEqual([]);
    expect(tools.calls).toEqual([]);
  });
});
