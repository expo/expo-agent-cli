// @ref llp/0030-one-device-per-worktree.rfc.md §Lock
import fs from 'fs';
import path from 'path';

import {
  readBindingFile,
  registryDirectory,
  withRegistryLockAsync,
  writeBindingFile,
} from '../registry';
import { bindingFor } from './fakeTools';

// The lock is a directory rename, which memfs lets replace a non-empty directory and the kernel
// refuses, so this suite runs on the real disk.
vi.unmock('fs');
vi.unmock('node:fs');
const os = await vi.importActual<typeof import('os')>('os');

const ROOT = '/work/app';
const lock = () => path.join(registryDirectory(), '.lock');
const alive = { isPidAlive: () => true };
const dead = { isPidAlive: () => false };

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-registry-'));
  process.env.__UNSAFE_EXPO_HOME_DIRECTORY = home;
});
afterEach(() => {
  delete process.env.__UNSAFE_EXPO_HOME_DIRECTORY;
  fs.rmSync(home, { recursive: true, force: true });
});

describe(withRegistryLockAsync, () => {
  it('holds a lock that names this pid while work runs, and gives it up after', async () => {
    let markers: string[] = [];

    await withRegistryLockAsync(
      async () => {
        markers = fs.readdirSync(lock());
      },
      { waitMs: 100, tools: alive }
    );

    expect(markers).toEqual([expect.stringMatching(new RegExp(`^pid-${process.pid}-[0-9a-f]+$`))]);
    expect(fs.existsSync(lock())).toBe(false);
    expect(fs.readdirSync(registryDirectory())).toEqual([]);
  });

  it('waits for a live holder and refuses DEVICE_REGISTRY_LOCKED when the wait runs out', async () => {
    fs.mkdirSync(lock(), { recursive: true });
    fs.writeFileSync(path.join(lock(), 'pid-424242-abcd'), '');

    const error = await withRegistryLockAsync(async () => 'ran', {
      waitMs: 250,
      tools: alive,
    }).catch((e) => e);

    expect(error.code).toBe('DEVICE_REGISTRY_LOCKED');
    expect(error.exitCode).toBe(22);
    expect(error.message).toContain('pid 424242');
    expect(fs.existsSync(path.join(lock(), 'pid-424242-abcd'))).toBe(true);
  });

  it("removes a dead holder's lock and takes it", async () => {
    fs.mkdirSync(lock(), { recursive: true });
    fs.writeFileSync(path.join(lock(), 'pid-424242-abcd'), '');

    const result = await withRegistryLockAsync(async () => 'ran', { waitMs: 1_000, tools: dead });

    expect(result).toBe('ran');
    expect(fs.existsSync(lock())).toBe(false);
  });

  it('removes a lock with no marker', async () => {
    fs.mkdirSync(lock(), { recursive: true });

    const result = await withRegistryLockAsync(async () => 'ran', { waitMs: 1_000, tools: alive });

    expect(result).toBe('ran');
  });

  it('serializes two sections of one process', async () => {
    const order: string[] = [];
    const first = withRegistryLockAsync(
      async () => {
        order.push('first-in');
        await new Promise((resolve) => setTimeout(resolve, 150));
        order.push('first-out');
      },
      { waitMs: 1_000, tools: alive }
    );
    const second = withRegistryLockAsync(
      async () => {
        order.push('second-in');
      },
      { waitMs: 1_000, tools: alive }
    );

    await Promise.all([first, second]);

    expect(order).toEqual(['first-in', 'first-out', 'second-in']);
  });

  // Windows refuses the rename onto a held lock with EPERM or EACCES, where POSIX says ENOTEMPTY.
  it.each(['EPERM', 'EACCES'])(
    'waits on a rename refused with %s, as Windows refuses one',
    async (code) => {
      const renameSync = fs.renameSync;
      let refused = 0;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (refused < 2) {
          refused += 1;
          throw Object.assign(new Error(`${code}: operation not permitted`), { code });
        }
        return renameSync(from, to);
      });

      try {
        const result = await withRegistryLockAsync(async () => 'ran', {
          waitMs: 2_000,
          tools: alive,
        });
        expect(result).toBe('ran');
        expect(refused).toBe(2);
      } finally {
        vi.restoreAllMocks();
      }
      expect(fs.existsSync(lock())).toBe(false);
    }
  );

  it('gives the lock up when work throws', async () => {
    await expect(
      withRegistryLockAsync(
        async () => {
          throw new Error('boom');
        },
        { waitMs: 100, tools: alive }
      )
    ).rejects.toThrow('boom');

    expect(fs.existsSync(lock())).toBe(false);
  });
});

describe(readBindingFile, () => {
  const file = () => path.join(registryDirectory(), 'x-ios-local-ios.json');

  it('round-trips a binding through tmp+rename', () => {
    const binding = bindingFor(ROOT, 'SIM-1');

    writeBindingFile(file(), binding);

    expect(readBindingFile(file())).toEqual({ kind: 'binding', binding });
    expect(fs.readdirSync(registryDirectory())).toEqual(['x-ios-local-ios.json']);
  });

  it('reports none for a missing file and unreadable for one that does not parse', () => {
    expect(readBindingFile(file())).toEqual({ kind: 'none' });
    fs.mkdirSync(registryDirectory(), { recursive: true });

    fs.writeFileSync(file(), 'nope');
    expect(readBindingFile(file())).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['an unknown version', { ...bindingFor(ROOT, 'SIM-1'), version: 2 }],
    [
      'an unknown backend',
      { ...bindingFor(ROOT, 'SIM-1'), device: { backend: 'local-tvos', platform: 'ios' } },
    ],
    [
      'an unknown origin',
      {
        ...bindingFor(ROOT, 'SIM-1'),
        device: { ...bindingFor(ROOT, 'SIM-1').device, origin: 'adopted' },
      },
    ],
  ])('reports unreadable for %s', (_name, record) => {
    fs.mkdirSync(registryDirectory(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(record));

    expect(readBindingFile(file())).toEqual({ kind: 'unreadable' });
  });
});
