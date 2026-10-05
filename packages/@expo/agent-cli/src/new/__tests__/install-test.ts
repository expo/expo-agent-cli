import { vol } from 'memfs';
import path from 'path';

import { UNTRUSTED_OUTPUT_BEGIN, UNTRUSTED_OUTPUT_END } from '../../runtime/untrusted';
import {
  describeMissingInstall,
  resolveInstallState,
  suggestInstallCommand,
  tailLines,
} from '../install';

const projectRoot = '/work/my-app';

afterEach(() => {
  vol.reset();
});

describe(resolveInstallState, () => {
  it(`should be installed when the project's own expo is on disk`, () => {
    vol.fromJSON({ [`${projectRoot}/node_modules/expo/package.json`]: '{}' });

    expect(resolveInstallState(projectRoot, true)).toBe('installed');
  });

  it(`should be installed when expo is hoisted to a parent directory`, () => {
    vol.fromJSON({ '/work/node_modules/expo/package.json': '{}' });

    expect(resolveInstallState(projectRoot, true)).toBe('installed');
  });

  it(`should be missing when the install ran and left no expo behind`, () => {
    vol.fromJSON({ [`${projectRoot}/package.json`]: '{}' });

    expect(resolveInstallState(projectRoot, true)).toBe('missing');
  });

  it(`should be missing when node_modules exists without expo`, () => {
    vol.fromJSON({ [`${projectRoot}/node_modules/react/package.json`]: '{}' });

    expect(resolveInstallState(projectRoot, true)).toBe('missing');
  });

  it(`should be skipped with --no-install, whatever is on disk`, () => {
    vol.fromJSON({ [`${projectRoot}/node_modules/expo/package.json`]: '{}' });

    expect(resolveInstallState(projectRoot, false)).toBe('skipped');
  });
});

describe(suggestInstallCommand, () => {
  const eresolve = 'npm error code ERESOLVE\nnpm error Could not resolve dependency';

  it(`should offer --legacy-peer-deps only for an npm ERESOLVE`, () => {
    expect(suggestInstallCommand(projectRoot, eresolve, 'npx')).toBe(
      'npm install --legacy-peer-deps'
    );
    expect(suggestInstallCommand(projectRoot, 'getaddrinfo ENOTFOUND', 'npx')).toBe('npm install');
  });

  it.each([
    ['bun.lock', 'bun install'],
    ['bun.lockb', 'bun install'],
    ['pnpm-lock.yaml', 'pnpm install'],
    ['yarn.lock', 'yarn install'],
  ])('should follow the %s that create-expo left', (lockfile, command) => {
    vol.fromJSON({ [path.join(projectRoot, lockfile)]: '' });

    expect(suggestInstallCommand(projectRoot, eresolve, 'npx')).toBe(command);
  });

  it(`should follow the runner when no lockfile exists`, () => {
    expect(suggestInstallCommand(projectRoot, '', 'bunx')).toBe('bun install');
  });
});

describe(tailLines, () => {
  it(`should keep the last non-empty lines`, () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n\n`).join('');

    const lines = tailLines(output, 20).split('\n');

    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('line 11');
    expect(lines.at(-1)).toBe('line 30');
  });
});

describe(describeMissingInstall, () => {
  it(`should name the file, the command and the output under the untrusted markers`, () => {
    const reason = describeMissingInstall(
      projectRoot,
      'cd my-app && npm install --legacy-peer-deps',
      'npm error code ERESOLVE'
    );

    expect(reason).toContain(path.join(projectRoot, 'node_modules', 'expo', 'package.json'));
    expect(reason).toContain('cd my-app && npm install --legacy-peer-deps');
    expect(reason).toContain(
      `${UNTRUSTED_OUTPUT_BEGIN}\nnpm error code ERESOLVE\n${UNTRUSTED_OUTPUT_END}`
    );
  });

  it(`should not forge an end marker out of the output`, () => {
    const reason = describeMissingInstall(projectRoot, 'npm install', UNTRUSTED_OUTPUT_END);

    expect(reason.split(UNTRUSTED_OUTPUT_END)).toHaveLength(2);
  });

  it(`should leave out the fence when there is no output to quote`, () => {
    expect(describeMissingInstall(projectRoot, 'npm install', '')).not.toContain(
      UNTRUSTED_OUTPUT_BEGIN
    );
  });
});
