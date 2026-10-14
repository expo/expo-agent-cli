import { vol } from 'memfs';
import path from 'path';

import { projectSdkVersionAsync, readSdkVersionAsync } from '../nodeModules';

const projectRoot = path.resolve('/project/app');

afterEach(() => vol.reset());

function writeProject(packageJson: object, installedVersion?: string) {
  vol.fromJSON({
    [path.join(projectRoot, 'package.json')]: JSON.stringify(packageJson),
    ...(installedVersion && {
      [path.join(projectRoot, 'node_modules', 'expo', 'package.json')]: JSON.stringify({
        version: installedVersion,
      }),
    }),
  });
}

describe(projectSdkVersionAsync, () => {
  it('prefers the installed version over the declared range', async () => {
    writeProject({ dependencies: { expo: '^55.0.1' } }, '56.0.3');
    await expect(projectSdkVersionAsync(projectRoot)).resolves.toBe('56.0.3');
  });

  it('finds an installed Expo in an ancestor directory', async () => {
    writeProject({ dependencies: { expo: '^55.0.1' } });
    vol.fromJSON({
      [path.resolve(projectRoot, '..', 'node_modules', 'expo', 'package.json')]: JSON.stringify({
        version: '56.0.3',
      }),
    });
    await expect(projectSdkVersionAsync(projectRoot)).resolves.toBe('56.0.3');
  });

  it.each([
    ['^55.0.1', '55.0.1'],
    ['>=54.0.0 <55.0.0', '54.0.0'],
    ['~ 54.0.0', '54.0.0'],
    ['=54.0.0', '54.0.0'],
    ['54.x', '54.0.0'],
    ['^54.0.0 || ^55.0.0', '54.0.0'],
    ['^55.0.0-beta.1', '55.0.0-beta.1'],
    ['*', '0.0.0'],
    ['>=54 <54', null],
    ['latest', null],
    ['file:../expo', null],
    ['git+https://example.test/expo.git', null],
    ['workspace:*', null],
    ['npm:expo@54', null],
    ['', null],
    ['  ', null],
    [undefined, null],
    [54, null],
  ])('resolves declared Expo %j to %j without an installation', async (expo, expected) => {
    writeProject({ dependencies: { expo } });
    await expect(projectSdkVersionAsync(projectRoot)).resolves.toBe(expected);
  });

  it('uses devDependencies when dependencies does not declare Expo', async () => {
    writeProject({ devDependencies: { expo: '~ 54.0.0' } });
    await expect(projectSdkVersionAsync(projectRoot)).resolves.toBe('54.0.0');
  });

  it('prefers the dependency declaration over the devDependency', async () => {
    writeProject({ dependencies: { expo: '^55.0.1' }, devDependencies: { expo: '^54.0.0' } });
    await expect(projectSdkVersionAsync(projectRoot)).resolves.toBe('55.0.1');
  });

  it.each([null, '{invalid json', '{}'])(
    'returns null for missing or unusable metadata %j',
    async (contents) => {
      if (contents !== null) vol.fromJSON({ [path.join(projectRoot, 'package.json')]: contents });
      await expect(projectSdkVersionAsync(projectRoot)).resolves.toBeNull();
    }
  );
});

it('keeps readSdkVersionAsync installed-only when Expo is declared', async () => {
  writeProject({ dependencies: { expo: '^55.0.1' } });
  await expect(readSdkVersionAsync(projectRoot)).resolves.toBeNull();
});
