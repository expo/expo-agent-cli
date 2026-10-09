// @ref llp/0031-ios-binding.plan.md §Tests
import { vol } from 'memfs';

import { CommandError } from '../../utils/errors';
import { bindingPathFor } from '../registry';
import { findBoundDeviceAsync, type AndroidRung } from '../rungs';
import type { BoundDevice } from '../types';
import { bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';
const file = () => bindingPathFor(ROOT, 'ios', 'local-ios');

const EMULATOR: BoundDevice = {
  backend: 'local-android',
  platform: 'android',
  serial: 'emulator-5554',
  origin: { kind: 'explicit' },
};
const androidUp: AndroidRung = async () => ({ device: EMULATOR });
const androidNone: AndroidRung = async () => ({ device: null });
const adbBroken = new CommandError('ADB_NOT_RUNNABLE', 'adb could not be run');
const androidBroken: AndroidRung = async () => ({ device: null, toolError: adbBroken });

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
});

describe(findBoundDeviceAsync, () => {
  // any-up-wins-across-platforms
  it('takes any up binding without a platform flag, the newer boundAt first', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }] });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1'));

    const ios = await findBoundDeviceAsync(ROOT, {
      extend: false,
      tools,
      android: androidUp,
      hostPlatform: 'darwin',
    });
    expect(ios.device).toMatchObject({ udid: 'SIM-1' });

    tools.simulators[0]!.state = 'Shutdown';
    const android = await findBoundDeviceAsync(ROOT, {
      extend: false,
      tools,
      android: androidUp,
      hostPlatform: 'darwin',
    });
    expect(android.device).toBe(EMULATOR);
  });

  it('inspects only the named platform with a flag', async () => {
    const tools = fakeTools();
    const android = vi.fn(androidUp);

    const found = await findBoundDeviceAsync(ROOT, {
      platform: 'android',
      extend: true,
      tools,
      android,
    });

    expect(found.device).toBe(EMULATOR);
    expect(tools.calls).toEqual([]);
  });

  it('extends the winner once', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }] });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1', { expiresAt: '2026-10-08T10:30:00.000Z' }));

    await findBoundDeviceAsync(ROOT, { platform: 'ios', extend: true, tools });

    expect(tools.calls).toEqual([['list', 'devices', '-j']]);
    const written = JSON.parse(vol.readFileSync(file(), 'utf8') as string);
    expect(written.expiresAt).toBe('2026-10-08T11:00:00.000Z');
  });

  // rung-refusal-reports-first-state
  it('refuses with the first state that is not none, in iOS then Android order', async () => {
    const tools = fakeTools();
    writeBinding(file(), bindingFor(ROOT, 'GONE'));

    const fell = await findBoundDeviceAsync(ROOT, {
      extend: false,
      tools,
      android: androidNone,
      hostPlatform: 'darwin',
    });

    expect(fell.device).toBeNull();
    expect(fell.refusal?.data).toEqual({ reason: 'gone' });
    expect(fell.refusal?.message).toContain('iOS'.toLowerCase());
    expect(fell.toolError).toBeNull();
  });

  it('refuses not-up at once, naming the platform', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Shutdown' }] });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1'));

    const error = await findBoundDeviceAsync(ROOT, {
      extend: false,
      tools,
      android: androidNone,
      hostPlatform: 'darwin',
    }).catch((e) => e);

    expect(error.code).toBe('NO_BOUND_DEVICE');
    expect(error.data).toEqual({ reason: 'not-up' });
    expect(error.suggestedCommand).toBe('npx @expo/agent-cli dev --ios --detach --wait-ready');
  });

  it('names the host platform when every state is none', async () => {
    const tools = fakeTools();

    const mac = await findBoundDeviceAsync(ROOT, { extend: false, tools, hostPlatform: 'darwin' });
    const linux = await findBoundDeviceAsync(ROOT, { extend: false, tools, hostPlatform: 'linux' });

    expect(mac.refusal?.message).toContain('No ios device is bound');
    expect(linux.refusal?.message).toContain('No android device is bound');
  });

  // platform-flag-throws-tool-error-first
  it('throws the tool error at once with a platform flag, and after the loop without one', async () => {
    const tools = fakeTools({ spawnError: true });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1'));

    const flagged = await findBoundDeviceAsync(ROOT, {
      platform: 'ios',
      extend: false,
      tools,
    }).catch((e) => e);
    expect(flagged.code).toBe('XCRUN_NOT_RUNNABLE');

    const unflagged = await findBoundDeviceAsync(ROOT, {
      extend: false,
      tools,
      android: androidBroken,
      hostPlatform: 'darwin',
    });
    expect(unflagged.device).toBeNull();
    expect(unflagged.toolError?.code).toBe('XCRUN_NOT_RUNNABLE');
  });

  it('refuses the timed-out check with exit 22', async () => {
    const tools = fakeTools({ listTimesOut: true });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1'));

    const error = await findBoundDeviceAsync(ROOT, { platform: 'ios', extend: false, tools }).catch(
      (e) => e
    );

    expect(error.data).toEqual({ reason: 'unknown' });
    expect(error.exitCode).toBe(22);
  });
});
