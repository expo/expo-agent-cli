import { vol } from 'memfs';
import path from 'path';

import { lockfileInstall } from '../lockfile';

beforeEach(() => {
  vol.reset();
});

describe(lockfileInstall, () => {
  const workspace = path.resolve('/workspace');
  const app = path.join(workspace, 'apps', 'mobile');

  it.each([
    ['bun.lock', 'bun', ['install', '--frozen-lockfile']],
    ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
    ['yarn.lock', 'yarn', ['install']],
    ['package-lock.json', 'npm', ['ci']],
  ])(`should run %s's frozen install in the workspace root of a package`, (file, command, args) => {
    vol.fromJSON({ [path.join(workspace, file)]: '', [path.join(app, 'package.json')]: '{}' });

    expect(lockfileInstall(app)).toEqual({ command, args, cwd: workspace, lockfile: file });
  });

  it(`should prefer bun over npm in one directory`, () => {
    vol.fromJSON({
      [path.join(workspace, 'bun.lock')]: '',
      [path.join(workspace, 'package-lock.json')]: '{}',
    });

    expect(lockfileInstall(workspace).command).toBe('bun');
  });

  it(`should run npm install in the project when there is no lockfile`, () => {
    vol.fromJSON({ [path.join(app, 'package.json')]: '{}' });

    expect(lockfileInstall(app)).toEqual({
      command: 'npm',
      args: ['install'],
      cwd: app,
      lockfile: null,
    });
  });
});
