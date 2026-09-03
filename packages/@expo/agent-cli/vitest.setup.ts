import Module from 'node:module';
import path from 'node:path';
import { vi } from 'vitest';

import { resetInvokerCache } from './src/utils/invoker';

const { fsMock, promisesMock, childProcessMock } = vi.hoisted(() => {
  const { fs } = require('memfs') as typeof import('memfs');
  return {
    fsMock: {
      ...fs,
      default: fs,
      promises: fs.promises,
    },
    promisesMock: { ...fs.promises, default: fs.promises },
    childProcessMock: {
      execSync: vi.fn(),
      spawn: vi.fn(),
      spawnSync: vi.fn(),
      execFileSync: vi.fn(),
    },
  };
});

delete process.env.npm_config_user_agent;
delete process.env.npm_execpath;
resetInvokerCache();

vi.mock('fs', () => fsMock);
vi.mock('node:fs', () => fsMock);
vi.mock('fs/promises', () => promisesMock);
vi.mock('node:fs/promises', () => promisesMock);
vi.mock('child_process', () => ({ ...childProcessMock, default: childProcessMock }));
vi.mock('node:child_process', () => ({ ...childProcessMock, default: childProcessMock }));

vi.mock('os', async (importOriginal) => {
  const os = await importOriginal<typeof import('os')>();
  const fs = await vi.importActual<typeof import('fs')>('node:fs');

  // POSIX paths stay POSIX so Darwin/Linux assertions stay stable. Windows cannot mkdir
  // `/tmp`, so those two answers are real directories under the runner's temp folder.
  function existingDir(posixPath: string, winName: string): string {
    if (process.platform !== 'win32') {
      return posixPath;
    }
    const dir = path.join(os.tmpdir(), winName);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // A copy, not a mutation: overwriting the actual module's properties would poison
  // `vi.importActual('os')` for every test that needs the real tmpdir (observed on
  // the Windows runner, where the lock tests must create real directories).
  const mocked = {
    ...os,
    // Keep the POSIX home so memfs fixtures planted at `/home/...` still match. Only tmpdir
    // has to exist on the real disk, because `mkdtempSync` is used against it.
    homedir: vi.fn(() => '/home'),
    tmpdir: vi.fn(() => existingDir('/tmp', 'agent-cli-mock-tmp')),
  };
  return { ...mocked, default: mocked };
});
vi.mock('node:os', async () => import('os'));

// `require('fs')` in tests and in lazy CJS-style loads bypasses `vi.mock`. Jest's automock
// hooked this; keep the same object the ESM mock uses.
const originalLoad = (Module as unknown as { _load: Function })._load;
(Module as unknown as { _load: Function })._load = function (
  request: string,
  parent: NodeModule,
  isMain: boolean
) {
  if (request === 'fs' || request === 'node:fs') {
    return fsMock;
  }
  if (request === 'fs/promises' || request === 'node:fs/promises') {
    return promisesMock;
  }
  if (request === 'child_process' || request === 'node:child_process') {
    return childProcessMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};
