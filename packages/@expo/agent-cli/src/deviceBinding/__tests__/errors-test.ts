// @ref llp/0030-one-device-per-worktree.rfc.md §Output and errors
import { deviceUnavailableError, noBoundDeviceError, registryLockedError } from '../errors';

// exit-codes-per-reason
describe('exit codes per reason', () => {
  it.each([
    ['NO_BOUND_DEVICE', 'none', 20, noBoundDeviceError('none', { platform: 'ios' })],
    [
      'NO_BOUND_DEVICE',
      'gone',
      20,
      noBoundDeviceError('gone', { platform: 'ios', cause: 'expired' }),
    ],
    ['NO_BOUND_DEVICE', 'not-up', 20, noBoundDeviceError('not-up', { platform: 'ios' })],
    ['NO_BOUND_DEVICE', 'unknown', 22, noBoundDeviceError('unknown', { platform: 'ios' })],
    [
      'NO_BOUND_DEVICE',
      'unreadable',
      7,
      noBoundDeviceError('unreadable', { platform: 'ios', path: '/p' }),
    ],
    [
      'DEVICE_UNAVAILABLE',
      'unreadable',
      7,
      deviceUnavailableError('unreadable', { platform: 'ios', path: '/p' }),
    ],
    [
      'DEVICE_UNAVAILABLE',
      'no-ios-runtime',
      7,
      deviceUnavailableError('no-ios-runtime', { platform: 'ios' }),
    ],
    [
      'DEVICE_UNAVAILABLE',
      'not-reusable',
      20,
      deviceUnavailableError('not-reusable', { platform: 'ios' }),
    ],
    [
      'DEVICE_UNAVAILABLE',
      'create-timeout',
      22,
      deviceUnavailableError('create-timeout', { platform: 'ios' }),
    ],
    [
      'DEVICE_UNAVAILABLE',
      'boot-failed',
      20,
      deviceUnavailableError('boot-failed', { platform: 'ios' }),
    ],
    [
      'DEVICE_REGISTRY_LOCKED',
      'locked',
      22,
      registryLockedError({ pid: 7, ageMs: 4_000, command: 'node' }),
    ],
  ])('%s %s exits %i', (code, reason, exitCode, error) => {
    expect(error.code).toBe(code);
    expect(error.data).toEqual({ reason });
    expect(error.exitCode).toBe(exitCode);
    expect(error.message.split('\n').at(-1)).toMatch(/^How: /);
  });

  it('names the dev command as the How line of a read refusal', () => {
    const error = noBoundDeviceError('none', { platform: 'android' });
    expect(error.message).toContain('npx @expo/agent-cli dev --android --detach --wait-ready');
    expect(error.suggestedCommand).toBe('npx @expo/agent-cli dev --android --detach --wait-ready');
  });
});
