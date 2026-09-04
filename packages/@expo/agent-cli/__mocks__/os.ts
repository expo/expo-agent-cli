import path from 'node:path';
import { vi } from 'vitest';

const os = await vi.importActual<typeof import('os')>('os');
const fs = await vi.importActual<typeof import('fs')>('fs');

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

const mocked = {
  ...os,
  // Keep the POSIX home so memfs fixtures planted at `/home/...` still match. Only tmpdir
  // has to exist on the real disk, because `mkdtempSync` is used against it.
  homedir: vi.fn(() => '/home'),
  tmpdir: vi.fn(() => existingDir('/tmp', 'agent-cli-mock-tmp')),
};

export default mocked;
export const homedir = mocked.homedir;
export const tmpdir = mocked.tmpdir;
