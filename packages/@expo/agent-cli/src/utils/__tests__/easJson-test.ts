import { vol } from 'memfs';

import { ensureSimulatorProfileSync, hasBuildProfileSync, readEasJsonSync } from '../easJson';

const projectRoot = '/project';

beforeEach(() => {
  vol.reset();
});

function easJson(): any {
  return JSON.parse(vol.readFileSync(`${projectRoot}/eas.json`, 'utf8') as string);
}

describe(hasBuildProfileSync, () => {
  it(`is false with no file, an unreadable file, and a file without the profile`, () => {
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });
    expect(hasBuildProfileSync(projectRoot, 'development-simulator')).toBe(false);
    vol.writeFileSync(`${projectRoot}/eas.json`, '{not json');
    expect(hasBuildProfileSync(projectRoot, 'development-simulator')).toBe(false);
    expect(readEasJsonSync(projectRoot)).toBeNull();
    vol.writeFileSync(`${projectRoot}/eas.json`, JSON.stringify({ build: { development: {} } }));
    expect(hasBuildProfileSync(projectRoot, 'development-simulator')).toBe(false);
    expect(hasBuildProfileSync(projectRoot, 'development')).toBe(true);
  });
});

describe(ensureSimulatorProfileSync, () => {
  it(`adds the profile and keeps every other key of the file`, () => {
    vol.fromJSON({
      [`${projectRoot}/eas.json`]: JSON.stringify({
        cli: { version: '>= 23.0.0' },
        build: { development: { developmentClient: true, distribution: 'internal' } },
        submit: { production: {} },
      }),
    });

    expect(ensureSimulatorProfileSync(projectRoot)).toBe(true);
    expect(easJson()).toEqual({
      cli: { version: '>= 23.0.0' },
      build: {
        development: { developmentClient: true, distribution: 'internal' },
        'development-simulator': {
          developmentClient: true,
          distribution: 'internal',
          ios: { simulator: true },
        },
      },
      submit: { production: {} },
    });
  });

  it(`changes nothing when the profile is there, whatever it says`, () => {
    vol.fromJSON({
      [`${projectRoot}/eas.json`]: JSON.stringify({
        build: { 'development-simulator': { developmentClient: true, ios: { simulator: true } } },
      }),
    });
    const before = vol.readFileSync(`${projectRoot}/eas.json`, 'utf8');

    expect(ensureSimulatorProfileSync(projectRoot)).toBe(false);
    expect(vol.readFileSync(`${projectRoot}/eas.json`, 'utf8')).toBe(before);
  });

  it(`creates the file with only the profile when there is none`, () => {
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });

    expect(ensureSimulatorProfileSync(projectRoot)).toBe(true);
    expect(easJson()).toEqual({
      build: {
        'development-simulator': {
          developmentClient: true,
          distribution: 'internal',
          ios: { simulator: true },
        },
      },
    });
  });
});
