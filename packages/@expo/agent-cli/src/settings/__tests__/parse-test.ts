// @ref llp/0015-backend-selection-and-config.rfc.md §Validation
// Every value the config takes, and every value it refuses. Pure: no file, no project.
import {
  parseAgentCliSettings,
  resolveDeviceBackend,
  settingsAreEmpty,
  settingsBuildBackend,
  settingsDeviceBackend,
  settingsPutDeviceOnEas,
} from '../parse';
import { EMPTY_SETTINGS } from '../types';

const WHERE = '"expo.agent-cli" in package.json';

function parse(raw: unknown) {
  return parseAgentCliSettings(raw, WHERE);
}

describe('an absent config', () => {
  it(`reads as nothing configured`, () => {
    expect(parse(undefined)).toEqual(EMPTY_SETTINGS);
    expect(parse(null)).toEqual(EMPTY_SETTINGS);
    expect(settingsAreEmpty(parse(undefined))).toBe(true);
  });

  it(`reads an empty object as nothing configured too`, () => {
    expect(parse({})).toEqual(EMPTY_SETTINGS);
    expect(settingsAreEmpty(parse({}))).toBe(true);
  });
});

describe('the values the config takes', () => {
  it.each(['expo-go', 'dev-build'])(`accepts target: %s`, (target) => {
    expect(parse({ target }).target).toBe(target);
  });

  it.each(['local', 'eas'])(`accepts buildBackend: %s`, (buildBackend) => {
    expect(parse({ buildBackend }).buildBackend).toBe(buildBackend);
  });

  it(`accepts a per-platform buildBackend`, () => {
    const settings = parse({ buildBackend: 'local', ios: { buildBackend: 'eas' } });
    expect(settings.ios).toEqual({ buildBackend: 'eas', deviceBackend: null });
    expect(settings.android).toBeNull();
  });

  it.each(['local', 'eas'])(`accepts deviceBackend: %s`, (deviceBackend) => {
    expect(parse({ deviceBackend }).deviceBackend).toBe(deviceBackend);
  });

  it(`is not empty once anything is set`, () => {
    expect(settingsAreEmpty(parse({ android: { buildBackend: 'eas' } }))).toBe(false);
    expect(settingsAreEmpty(parse({ ios: { deviceBackend: 'eas' } }))).toBe(false);
  });
});

describe('resolving the backend for one platform', () => {
  it(`prefers the platform's own answer over the shared one`, () => {
    const settings = parse({ buildBackend: 'local', ios: { buildBackend: 'eas' } });
    expect(settingsBuildBackend(settings, 'ios')).toBe('eas');
    expect(settingsBuildBackend(settings, 'android')).toBe('local');
  });

  it(`falls back to the shared answer, then to nothing`, () => {
    expect(settingsBuildBackend(parse({ buildBackend: 'eas' }), 'android')).toBe('eas');
    expect(settingsBuildBackend(parse({}), 'ios')).toBeNull();
  });

  it(`treats a platform entry that names no backend as saying nothing`, () => {
    expect(settingsBuildBackend(parse({ buildBackend: 'eas', ios: {} }), 'ios')).toBe('eas');
  });
});

// @ref llp/0015-backend-selection-and-config.rfc.md §The device backend
describe('resolving the device backend for one platform', () => {
  it(`prefers the platform's own answer over the shared one`, () => {
    const settings = parse({ deviceBackend: 'eas', android: { deviceBackend: 'local' } });
    expect(settingsDeviceBackend(settings, 'ios')).toBe('eas');
    expect(settingsDeviceBackend(settings, 'android')).toBe('local');
  });

  it(`puts the build on EAS when the device is there and no build backend is named`, () => {
    expect(settingsBuildBackend(parse({ deviceBackend: 'eas' }), 'ios')).toBe('eas');
    expect(settingsBuildBackend(parse({ ios: { deviceBackend: 'eas' } }), 'android')).toBeNull();
  });

  it(`lets a flag name both backends over the config`, () => {
    const settings = parse({ deviceBackend: 'eas' });
    expect(resolveDeviceBackend('local', settings, 'ios')).toBe('local');
    expect(resolveDeviceBackend('eas', parse({}), 'ios')).toBe('eas');
    expect(resolveDeviceBackend(null, settings, 'ios')).toBe('eas');
    expect(resolveDeviceBackend(null, parse({}), 'ios')).toBe('local');
  });

  it(`keeps the web local, because it has no device`, () => {
    expect(resolveDeviceBackend(null, parse({ deviceBackend: 'eas' }), 'web')).toBe('local');
    expect(settingsPutDeviceOnEas(parse({ deviceBackend: 'eas' }), 'web')).toBe(false);
  });

  it(`puts a device command with no platform on EAS only when both platforms are`, () => {
    expect(settingsPutDeviceOnEas(parse({ deviceBackend: 'eas' }))).toBe(true);
    expect(settingsPutDeviceOnEas(parse({ ios: { deviceBackend: 'eas' } }))).toBe(false);
    expect(settingsPutDeviceOnEas(parse({ ios: { deviceBackend: 'eas' } }), 'ios')).toBe(true);
  });
});

describe('what the config refuses', () => {
  it(`refuses a value that is not an object, and names the location`, () => {
    expect(() => parse('eas')).toThrow(/"expo.agent-cli" in package.json is "eas"/);
    expect(() => parse(['eas'])).toThrow(/is an array, and it has to be an object/);
  });

  it(`refuses an unknown key rather than ignoring it`, () => {
    expect(() => parse({ backend: 'eas' })).toThrow(/does not know: "backend"/);
    // The reason is the whole point of refusing: a dropped preference is an unasked-for plan.
    expect(() => parse({ backend: 'eas' })).toThrow(/silently dropped/);
  });

  it(`names the key a typo looks like`, () => {
    expect(() => parse({ buildbackend: 'eas' })).toThrow(
      /"buildbackend" looks like "buildBackend"/
    );
    expect(() => parse({ 'build-backend': 'eas' })).toThrow(
      /"build-backend" looks like "buildBackend"/
    );
  });

  it(`lists the keys this version takes`, () => {
    expect(() => parse({ nope: 1 })).toThrow(
      /"target", "buildBackend", "deviceBackend", "ios", "android"/
    );
  });

  it(`refuses a value outside the set, and lists the set`, () => {
    expect(() => parse({ buildBackend: 'cloud' })).toThrow(
      /buildBackend is "cloud", and the only values it takes are "local", "eas"/
    );
    expect(() => parse({ target: 'devbuild' })).toThrow(/"expo-go", "dev-build"/);
    expect(() => parse({ buildBackend: 1 })).toThrow(/is 1 \(a number\)/);
  });

  it(`refuses a platform entry that is not an object`, () => {
    expect(() => parse({ ios: 'eas' })).toThrow(/› ios is "eas", and it has to be an object/);
  });

  it(`refuses an unknown key inside a platform entry`, () => {
    expect(() => parse({ ios: { target: 'dev-build' } })).toThrow(
      /› ios names a key this version of @expo\/agent-cli does not know: "target"/
    );
  });

  it(`refuses a device on EAS with a build on this machine, for the platform that has both`, () => {
    expect(() => parse({ deviceBackend: 'eas', buildBackend: 'local' })).toThrow(
      /puts the ios device on EAS .* and the ios build on this machine/
    );
    expect(() => parse({ deviceBackend: 'eas', android: { buildBackend: 'local' } })).toThrow(
      /the android build on this machine/
    );
    expect(() =>
      parse({ buildBackend: 'local', ios: { deviceBackend: 'eas', buildBackend: 'eas' } })
    ).not.toThrow();
  });

  it(`carries the BAD_AGENT_CLI_CONFIG code and no suggested command`, () => {
    expect.assertions(2);
    try {
      parse({ buildBackend: 'cloud' });
    } catch (error: any) {
      expect(error.code).toBe('BAD_AGENT_CLI_CONFIG');
      // The fix is an edit; every command that reads the config stops in the same place until it
      // is made, so there is no command to suggest.
      expect(error.suggestedCommand).toBeUndefined();
    }
  });

  it(`says what, why and how`, () => {
    expect.assertions(3);
    try {
      parse({ buildBackend: 'cloud' });
    } catch (error: any) {
      const [what, why, how] = String(error.message).split('\n');
      expect(what).toContain('"expo.agent-cli" in package.json');
      expect(why).toMatch(/^Why: /);
      expect(how).toMatch(/^How: /);
    }
  });
});
