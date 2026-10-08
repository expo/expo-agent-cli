// @ref llp/0031-ios-binding.plan.md §Tests
import { vol } from 'memfs';

import { bindingPathFor } from '../registry';
import { findBoundDeviceAsync } from '../rungs';
import { androidBindingFor, bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';
const file = () => bindingPathFor(ROOT, 'ios', 'local-ios');
const androidFile = () => bindingPathFor(ROOT, 'android', 'local-android');
const EXPLICIT = { kind: 'explicit' } as const;

/** An emulator instance `adb` lists as up, bound to the worktree, booked before the simulator. */
function bindEmulatorUp(tools: ReturnType<typeof fakeTools>): void {
  tools.emulators.push({ serial: 'emulator-5554', state: 'device' });
  writeBinding(
    androidFile(),
    androidBindingFor(ROOT, 'emulator-5554', EXPLICIT, { boundAt: '2026-10-08T08:00:00.000Z' })
  );
}

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
});

describe(findBoundDeviceAsync, () => {
  // any-up-wins-across-platforms
  it('takes any up binding without a platform flag, the newer boundAt first', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }] });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1'));
    bindEmulatorUp(tools);

    const ios = await findBoundDeviceAsync(ROOT, { extend: false, tools, hostPlatform: 'darwin' });
    expect(ios.device).toMatchObject({ udid: 'SIM-1' });

    tools.simulators[0]!.state = 'Shutdown';
    const android = await findBoundDeviceAsync(ROOT, {
      extend: false,
      tools,
      hostPlatform: 'darwin',
    });
    expect(android.device).toMatchObject({ serial: 'emulator-5554' });
  });

  it('inspects only the named platform with a flag', async () => {
    const tools = fakeTools();
    bindEmulatorUp(tools);

    const found = await findBoundDeviceAsync(ROOT, { platform: 'android', extend: true, tools });

    expect(found.device).toMatchObject({ serial: 'emulator-5554' });
    expect(tools.calls).toEqual([['-s', 'emulator-5554', 'get-state']]);
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

    const fell = await findBoundDeviceAsync(ROOT, { extend: false, tools, hostPlatform: 'darwin' });

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
      hostPlatform: 'darwin',
    }).catch((e) => e);

    expect(error.code).toBe('NO_BOUND_DEVICE');
    expect(error.data).toEqual({ reason: 'not-up' });
    expect(error.suggestedCommand).toBe('npx @expo/agent-cli dev --ios --detach --wait-ready');
  });

  it('refuses a gone simulator and a not-up instance naming Android', async () => {
    const tools = fakeTools({ emulators: [{ serial: 'emulator-5554', state: 'offline' }] });
    writeBinding(file(), bindingFor(ROOT, 'GONE'));
    writeBinding(androidFile(), androidBindingFor(ROOT, 'emulator-5554', EXPLICIT));

    const error = await findBoundDeviceAsync(ROOT, {
      extend: false,
      tools,
      hostPlatform: 'darwin',
    }).catch((e) => e);

    expect(error.data).toEqual({ reason: 'not-up' });
    expect(error.message).toContain('android');
  });

  it('names the host platform when every state is none', async () => {
    const tools = fakeTools();

    const mac = await findBoundDeviceAsync(ROOT, { extend: false, tools, hostPlatform: 'darwin' });
    const linux = await findBoundDeviceAsync(ROOT, { extend: false, tools, hostPlatform: 'linux' });

    expect(mac.refusal?.message).toContain('No ios device is bound');
    expect(linux.refusal?.message).toContain('No android device is bound');
    expect(tools.calls).toEqual([]);
  });

  // platform-flag-throws-tool-error-first
  it('throws the tool error at once with a platform flag, and after the loop without one', async () => {
    const tools = fakeTools({ spawnError: true, adbSpawnError: true });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1'));
    writeBinding(androidFile(), androidBindingFor(ROOT, 'emulator-5554', EXPLICIT));

    const flagged = await findBoundDeviceAsync(ROOT, {
      platform: 'ios',
      extend: false,
      tools,
    }).catch((e) => e);
    expect(flagged.code).toBe('XCRUN_NOT_RUNNABLE');

    const unflagged = await findBoundDeviceAsync(ROOT, {
      extend: false,
      tools,
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
