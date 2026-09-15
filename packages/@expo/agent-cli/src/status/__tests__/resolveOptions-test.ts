// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// The flags `status` grew when it absorbed `@expo/agent-cli impact`. Pure, so every combination is here
// rather than in an end-to-end run.

import { IMPACT_CLASS_ORDER } from '../../impact/types';
import { CommandError } from '../../utils/errors';
import {
  resolveAssertClass,
  resolveBuildId,
  resolveDeviceFlag,
  resolveDeviceTimeoutFlag,
} from '../resolveOptions';

describe(resolveAssertClass, () => {
  it(`should answer null when the flag was not given`, () => {
    expect(resolveAssertClass(undefined)).toBeNull();
    expect(resolveAssertClass(null)).toBeNull();
  });

  it.each(IMPACT_CLASS_ORDER)(`should accept %s`, (impactClass) => {
    expect(resolveAssertClass(impactClass)).toBe(impactClass);
  });

  it(`should reject a class this does not report, naming the ones it does`, () => {
    expect(() => resolveAssertClass('native')).toThrow(CommandError);
    try {
      resolveAssertClass('native');
    } catch (error) {
      const message = (error as CommandError).message;
      expect(message).toContain('--assert native is not one of the classes');
      expect(message).toContain('js-only, dev-client-compatible, needs-native-build');
    }
  });
});

describe(resolveBuildId, () => {
  it(`should answer null when the flag was not given`, () => {
    expect(resolveBuildId(undefined)).toBeNull();
  });

  // Naming a build is the ask: the flag used to require `--explain` as the word for "you may spend
  // a round trip", and there is no such word now.
  it(`should accept an id on its own, trimmed`, () => {
    expect(resolveBuildId('  build-1  ')).toBe('build-1');
  });

  it(`should refuse an empty id rather than asking the service about nothing`, () => {
    try {
      resolveBuildId('   ');
      throw new Error('should have thrown');
    } catch (error) {
      const commandError = error as CommandError;
      expect(commandError).toBeInstanceOf(CommandError);
      expect(commandError.message).toContain('--build needs the id');
      expect(commandError.message).toContain('npx @expo/agent-cli status --build <id>');
    }
  });
});

describe(resolveDeviceFlag, () => {
  it(`is null when the flag is absent`, () => {
    expect(resolveDeviceFlag(undefined, { explain: false })).toBeNull();
  });

  it(`returns the trimmed name under --explain`, () => {
    expect(resolveDeviceFlag('  iPhone 17 Pro  ', { explain: true })).toBe('iPhone 17 Pro');
  });

  it(`rejects an empty value`, () => {
    expect(() => resolveDeviceFlag('   ', { explain: true })).toThrow(/needs a simulator name/);
  });

  it(`rejects --device without --explain, which is where the installed section lives`, () => {
    expect(() => resolveDeviceFlag('iPhone 17', { explain: false })).toThrow(/needs --explain/);
  });
});

describe(resolveDeviceTimeoutFlag, () => {
  it(`is null when the flag is absent`, () => {
    expect(resolveDeviceTimeoutFlag(undefined, { explain: true })).toBeNull();
  });

  it(`reads seconds and returns milliseconds`, () => {
    expect(resolveDeviceTimeoutFlag('45', { explain: true })).toBe(45_000);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['fractional', '1.5'],
    ['words', 'soon'],
    ['empty', '  '],
    ['out of range', '9999'],
  ])(`rejects %s`, (_description, value) => {
    expect(() => resolveDeviceTimeoutFlag(value, { explain: true })).toThrow(/--device-timeout/);
  });

  it(`needs --explain, like --device`, () => {
    expect(() => resolveDeviceTimeoutFlag('45', { explain: false })).toThrow(/--explain/);
  });
});
