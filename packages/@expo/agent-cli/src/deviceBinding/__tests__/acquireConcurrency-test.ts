// @ref llp/0035-one-device-per-worktree.rfc.md §iOS tests
import fs from 'fs';
import path from 'path';

import { acquireDeviceAsync, releaseWorktreeDevicesAsync } from '..';
import {
  bindingPathFor,
  readBindingFile,
  withRegistryLockAsync,
  writeBindingFile,
} from '../registry';
import { bindingFor, fakeTools, type FakeTools } from './fakeTools';

// memfs permits replacing a non-empty directory; the registry lock needs real rename semantics.
vi.unmock('fs');
vi.unmock('node:fs');
const os = await vi.importActual<typeof import('os')>('os');
let directory: string;
let root: string;
const file = () => bindingPathFor(root, 'ios', 'local-ios');

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-acquire-'));
  root = path.join(directory, 'app');
  fs.mkdirSync(root);
  vi.stubEnv('__UNSAFE_EXPO_HOME_DIRECTORY', path.join(directory, 'expo-home'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Hold the first n device snapshots until the test lets both callers advance. */
function pauseSnapshots(tools: FakeTools, count: number) {
  const ready = signal();
  const proceed = signal();
  const simctl = tools.simctl;
  let snapshots = 0;
  tools.simctl = async (args, options) => {
    const result = await simctl(args, options);
    if (args[0] === 'list' && args[1] === 'devices' && ++snapshots <= count) {
      if (snapshots === count) ready.resolve();
      await proceed.promise;
    }
    return result;
  };
  return { ready: ready.promise, resume: proceed.resolve };
}

async function replaceBinding(tools: FakeTools, udid: string) {
  await withRegistryLockAsync(
    async () => {
      writeBindingFile(file(), bindingFor(root, udid));
    },
    { tools, waitMs: 1_000 }
  );
}

function expectDeviceCallsOutsideLock(tools: FakeTools) {
  tools.calls.forEach((call, index) => {
    expect(tools.lockedAt[index], call.join(' ')).toBe(call[0] === 'create');
  });
}

it.each(['unbound', 'missing', 'unavailable'] as const)(
  'creates only one simulator for concurrent acquisitions of an %s worktree',
  async (initial) => {
    const tools = fakeTools({
      simulators:
        initial === 'unavailable'
          ? [{ udid: 'OLD', name: 'old', state: 'Shutdown', isAvailable: false }]
          : [],
    });
    if (initial !== 'unbound') await replaceBinding(tools, 'OLD');
    const gate = pauseSnapshots(tools, 2);
    const results = Promise.all([
      acquireDeviceAsync(root, 'ios', { tools }),
      acquireDeviceAsync(root, 'ios', { tools }),
    ]);
    await gate.ready;
    gate.resume();

    const acquired = await results;
    expect(acquired.map(({ action }) => action).sort()).toEqual(['created', 'reused']);
    expect(acquired.map(({ device }) => device)).toEqual([
      expect.objectContaining({ udid: 'CREATED-1' }),
      expect.objectContaining({ udid: 'CREATED-1' }),
    ]);
    expect(tools.calls.filter(([command]) => command === 'create')).toHaveLength(1);
    expect(tools.calls.filter(([command]) => command === 'bootstatus')).toEqual([
      ['bootstatus', 'CREATED-1', '-b'],
      ['bootstatus', 'CREATED-1', '-b'],
    ]);
    expect(readBindingFile(file())).toMatchObject({ binding: { device: { udid: 'CREATED-1' } } });
    expectDeviceCallsOutsideLock(tools);
  }
);

it('does not refresh for lease or name changes and uses the current binding', async () => {
  const tools = fakeTools({ simulators: [{ udid: 'SIM', name: 'old', state: 'Booted' }] });
  await replaceBinding(tools, 'SIM');
  const gate = pauseSnapshots(tools, 1);
  const waiting = acquireDeviceAsync(root, 'ios', { tools });
  await gate.ready;
  await withRegistryLockAsync(
    async () => {
      writeBindingFile(
        file(),
        bindingFor(root, 'SIM', {
          name: 'renamed',
          boundAt: '2026-10-08T09:30:00.000Z',
          expiresAt: '2026-10-08T12:00:00.000Z',
        })
      );
    },
    { tools, waitMs: 1_000 }
  );
  gate.resume();

  expect(await waiting).toMatchObject({
    action: 'reused',
    device: { udid: 'SIM', name: 'renamed' },
  });
  expect(tools.calls.filter(([command]) => command === 'list')).toHaveLength(2);
});

it('leaves the newer binding intact when refreshing inventory times out', async () => {
  const tools = fakeTools();
  const gate = pauseSnapshots(tools, 1);
  const waiting = acquireDeviceAsync(root, 'ios', { tools }).catch((error) => error);
  await gate.ready;
  await replaceBinding(tools, 'NEW');
  const newer = fs.readFileSync(file(), 'utf8');
  const simctl = tools.simctl;
  tools.simctl = async (args, options) =>
    args[0] === 'list' && args[1] === 'devices'
      ? { stdout: '', stderr: '', exitCode: null }
      : simctl(args, options);
  gate.resume();

  expect(await waiting).toMatchObject({
    code: 'DEVICE_UNAVAILABLE',
    data: { reason: 'create-timeout' },
  });
  expect(fs.readFileSync(file(), 'utf8')).toBe(newer);
  expect(tools.calls.some(([command]) => command === 'create')).toBe(false);
});

it('stops after three changed snapshots without replacing the last binding', async () => {
  const tools = fakeTools();
  const simctl = tools.simctl;
  let snapshots = 0;
  tools.simctl = async (args, options) => {
    const result = await simctl(args, options);
    if (args[0] === 'list' && args[1] === 'runtimes') {
      await replaceBinding(tools, `NEW-${++snapshots}`);
    }
    return result;
  };

  const error = await acquireDeviceAsync(root, 'ios', { tools }).catch((error) => error);
  expect(error).toMatchObject({
    code: 'DEVICE_UNAVAILABLE',
    exitCode: 22,
    data: { reason: 'binding-changed' },
  });
  expect(error.message).toContain('How: run the command again.');
  expect(snapshots).toBe(3);
  expect(readBindingFile(file())).toEqual({ kind: 'binding', binding: bindingFor(root, 'NEW-3') });
  expect(tools.calls.some(([command]) => command === 'create' || command === 'bootstatus')).toBe(
    false
  );
  expectDeviceCallsOutsideLock(tools);
});

it('serializes captured shutdown and rechecks authority after waiting for a successor', async () => {
  const tools = fakeTools({
    simulators: [{ udid: 'SIM', name: 'owned', state: 'Booted' }],
    alivePids: [process.pid],
  });
  const expected = bindingFor(root, 'SIM');
  await replaceBinding(tools, 'SIM');
  const shutdown = signal(),
    resume = signal();
  let waiting = signal();
  const simctl = tools.simctl,
    alive = tools.isPidAlive;
  tools.simctl = async (args, options) => {
    if (args[0] === 'shutdown') {
      shutdown.resolve();
      await resume.promise;
    }
    return simctl(args, options);
  };
  tools.isPidAlive = (pid) => {
    if (pid === process.pid) waiting.resolve();
    return alive(pid);
  };
  const released = releaseWorktreeDevicesAsync(root, { platform: 'ios', tools, expected });
  await shutdown.promise;
  const acquired = acquireDeviceAsync(root, 'ios', { tools });
  try {
    expect(
      await Promise.race([waiting.promise.then(() => 'waiting'), acquired.then(() => 'acquired')])
    ).toBe('waiting');
    expect(readBindingFile(file())).toMatchObject({ binding: { boundAt: expected.boundAt } });
    expect(tools.calls.some(([command]) => command === 'bootstatus')).toBe(false);
  } finally {
    resume.resolve();
    await Promise.all([released, acquired]);
  }
  const [rows, successor] = await Promise.all([released, acquired]);
  const replacementBinding = successor.binding;
  if (!replacementBinding) throw new Error('Successor acquired no binding');
  expect(rows).toEqual([expect.objectContaining({ released: true, shutDown: true })]);
  expect(replacementBinding.boundAt).not.toBe(expected.boundAt);
  expect(tools.simulators[0]?.state).toBe('Booted');
  expect(tools.calls.filter(([command]) => ['shutdown', 'bootstatus'].includes(command!))).toEqual([
    ['shutdown', 'SIM'],
    ['bootstatus', 'SIM', '-b'],
  ]);

  const held = signal(),
    resumeLock = signal();
  waiting = signal();
  let allowed = true;
  const blocker = withRegistryLockAsync(
    async () => {
      held.resolve();
      await resumeLock.promise;
      writeBindingFile(file(), { ...replacementBinding });
      allowed = false;
    },
    { tools, waitMs: 1_000 }
  );
  await held.promise;
  const skipped = releaseWorktreeDevicesAsync(root, {
    platform: 'ios',
    tools,
    expected: replacementBinding,
    canRelease: async () => allowed,
  });
  try {
    await waiting.promise;
  } finally {
    resumeLock.resolve();
  }
  await blocker;
  expect(await skipped).toEqual([]);
  expect(readBindingFile(file())).toEqual({ kind: 'binding', binding: replacementBinding });
  expect(tools.simulators[0]?.state).toBe('Booted');
  expect(tools.calls.filter(([command]) => command === 'shutdown')).toHaveLength(1);
});
