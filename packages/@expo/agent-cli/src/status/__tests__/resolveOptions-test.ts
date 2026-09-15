// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// The flags `status` grew when it absorbed `@expo/agent-cli impact`. Pure, so every combination is here
// rather than in an end-to-end run.

import { IMPACT_CLASS_ORDER } from '../../impact/types';
import { CommandError } from '../../utils/errors';
import { resolveAssertClass, resolveBuildId } from '../resolveOptions';

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
