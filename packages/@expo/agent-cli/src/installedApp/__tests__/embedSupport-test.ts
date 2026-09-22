// @ref llp/0004-smart-start-and-project-state.rfc.md §What this cannot see
import { vol } from 'memfs';

import { readFingerprintEmbedSupport } from '../embedSupport';

const projectRoot = '/project';

function constants(root: string, version: string) {
  return {
    [`${root}/node_modules/expo-constants/package.json`]: JSON.stringify({
      name: 'expo-constants',
      version,
    }),
  };
}

beforeEach(() => vol.reset());

describe(readFingerprintEmbedSupport, () => {
  it.each(['58.0.5', '58.0.6', '59.0.0', '60.0.0-canary-20270101'])(
    `answers supported for expo-constants %s`,
    (version) => {
      vol.fromJSON(constants(projectRoot, version));
      expect(readFingerprintEmbedSupport(projectRoot)).toEqual({ supported: true, version });
    }
  );

  // SDK 57 and earlier, and a 58 older than the release that added the build phase.
  it.each(['18.0.0', '57.0.19', '58.0.4', '58.0.0-canary-20260901'])(
    `answers unsupported, with the version, for expo-constants %s`,
    (version) => {
      vol.fromJSON(constants(projectRoot, version));
      expect(readFingerprintEmbedSupport(projectRoot)).toEqual({ supported: false, version });
    }
  );

  it(`answers unsupported with no version when expo-constants is not installed`, () => {
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });
    expect(readFingerprintEmbedSupport(projectRoot)).toEqual({ supported: false, version: null });
  });

  // pnpm keeps a transitive dependency beside `expo` in its store, not under the project.
  it(`finds the package beside expo when the project does not hoist it`, () => {
    vol.fromJSON({
      [`${projectRoot}/node_modules/expo/package.json`]: JSON.stringify({ name: 'expo' }),
      ...constants(`${projectRoot}/node_modules/expo`, '58.0.5'),
    });
    expect(readFingerprintEmbedSupport(projectRoot).supported).toBe(true);
  });
});
