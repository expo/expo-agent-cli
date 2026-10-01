import { env, isTelemetryDisabled } from '../env';
import { CommandError } from '../errors';

beforeEach(() => {
  for (const name of ['EXPO_NO_TELEMETRY', 'DO_NOT_TRACK', 'EXPO_STAGING', 'EXPO_LOCAL']) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => vi.unstubAllEnvs());

describe.each(['EXPO_STAGING', 'EXPO_LOCAL'] as const)('%s', (name) => {
  it.each([
    [undefined, false],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['1', true],
    ['true', true],
    ['TRUE', true],
  ])('keeps strict boolish parsing for %s', (value, expected) => {
    vi.stubEnv(name, value);
    expect(env[name]).toBe(expected);
  });

  it.each(['', 'yes', 'no', '2', ' false ', 'invalid'])(
    'reports an actionable command error for %j',
    (value) => {
      vi.stubEnv(name, value);
      expect(() => env[name]).toThrow(CommandError);
      expect(() => env[name]).toThrow(
        expect.objectContaining({
          code: 'BAD_ENV',
          message: `Invalid value for ${name}. Expected 0, 1, false, or true.`,
        })
      );
    }
  );
});

describe('telemetry privacy flags', () => {
  it.each(['EXPO_NO_TELEMETRY', 'DO_NOT_TRACK'])(
    'allows telemetry only when %s is unset or explicitly false',
    (name) => {
      for (const value of [undefined, '0', 'false', 'FALSE', 'FaLsE']) {
        vi.stubEnv(name, value);
        expect(isTelemetryDisabled()).toBe(false);
      }
    }
  );

  it.each(['EXPO_NO_TELEMETRY', 'DO_NOT_TRACK'])(
    'treats every other present %s value as an opt-out without throwing',
    (name) => {
      for (const value of ['', '1', 'true', 'TRUE', 'yes', 'no', '2', ' false ', 'undefined']) {
        vi.stubEnv(name, value);
        expect(isTelemetryDisabled()).toBe(true);
      }
    }
  );

  it('keeps the EXPO_NO_TELEMETRY accessor consistent with the shared privacy check', () => {
    vi.stubEnv('EXPO_NO_TELEMETRY', 'yes');
    expect(env.EXPO_NO_TELEMETRY).toBe(true);
    vi.stubEnv('EXPO_NO_TELEMETRY', 'FALSE');
    expect(env.EXPO_NO_TELEMETRY).toBe(false);
  });

  it.each([
    ['false', ''],
    ['0', 'yes'],
    ['', 'false'],
    ['yes', '0'],
  ])('honors either opt-out when the other explicitly allows telemetry', (expo, standard) => {
    vi.stubEnv('EXPO_NO_TELEMETRY', expo);
    vi.stubEnv('DO_NOT_TRACK', standard);
    expect(isTelemetryDisabled()).toBe(true);
  });
});
