import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { recordCommand } from '..';

describe('command telemetry handoff', () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });

  beforeEach(() => {
    vi.stubEnv('EXPO_NO_TELEMETRY', '0');
    vi.stubEnv('DO_NOT_TRACK', undefined);
    vi.stubEnv('EXPO_OFFLINE', '0');
    child.removeAllListeners();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('hands off one small command record without pipes or waiting for the worker', () => {
    expect(recordCommand('runtime:eval', '1.2.3')).toBeUndefined();

    expect(spawn).toHaveBeenCalledOnce();
    const [executable, argv, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(argv![0]).toMatch(/[\\/]telemetry[\\/]index\.js$/);
    expect(JSON.parse(argv![1]!)).toEqual({
      command: 'runtime:eval',
      version: '1.2.3',
      timestamp: expect.any(String),
    });
    expect(options).toEqual({
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.each(['EXPO_NO_TELEMETRY', 'DO_NOT_TRACK', 'EXPO_OFFLINE'])(
    'does no work with %s enabled',
    (key) => {
      vi.stubEnv(key, 'true');
      recordCommand('status', '1.2.3');
      expect(spawn).not.toHaveBeenCalled();
    }
  );

  describe.each(['EXPO_NO_TELEMETRY', 'DO_NOT_TRACK'])('%s privacy handling', (key) => {
    it.each(['', '1', 'true', 'TRUE', 'yes', 'no', '2', ' false '])(
      'does not spawn for the opt-out value %j',
      (value) => {
        vi.stubEnv(key, value);
        expect(() => recordCommand('status', '1.2.3')).not.toThrow();
        expect(spawn).not.toHaveBeenCalled();
      }
    );

    it.each([undefined, '0', 'false', 'FALSE'])(
      'allows the worker when the privacy flag is %j',
      (value) => {
        vi.stubEnv(key, value);
        recordCommand('status', '1.2.3');
        expect(spawn).toHaveBeenCalledOnce();
      }
    );
  });

  it('leaves the command alone if spawning fails synchronously', () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('cannot spawn');
    });
    expect(() => recordCommand('status', '1.2.3')).not.toThrow();
  });

  it('handles asynchronous spawn failures without an uncaught error', () => {
    recordCommand('status', '1.2.3');
    expect(() => child.emit('error', new Error('cannot spawn'))).not.toThrow();
  });
});
