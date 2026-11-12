// @ref llp/0035-one-device-per-worktree.rfc.md §Android tests
import { vol } from 'memfs';

import { canonicalizeExistingPath } from '../../utils/dir';
import { acquireDeviceAsync, releaseWorktreeDevicesAsync } from '..';
import { inspectBindingAsync } from '../inspect';
import { bindingPathFor, readBindingFile } from '../registry';
import { findBoundDeviceAsync } from '../rungs';
import { AVD } from './fakeAndroidTools';
import { androidBindingFor, bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';
const OTHER = '/work/other';
const SPAWN_ARGS = ['-avd', AVD, '-ports', '5554,5555', '-no-snapshot-save', '-read-only'];

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}', [`${OTHER}/package.json`]: '{}' });
});

const file = (root = ROOT) => bindingPathFor(root, 'android', 'local-android');
const spawned = (port: number, emulatorPid: number) =>
  ({ kind: 'spawned', avd: AVD, port, emulatorPid }) as const;

describe(acquireDeviceAsync, () => {
  it('spawns a read-only instance of the first AVD on 5554 and binds its serial and pid', async () => {
    const tools = fakeTools();

    const result = await acquireDeviceAsync(ROOT, 'android', { tools });

    expect(result).toMatchObject({ action: 'spawned', justBooted: true });
    expect(tools.spawned).toEqual([SPAWN_ARGS]);
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding).toMatchObject({
      device: { serial: 'emulator-5554', origin: { kind: 'spawned', avd: AVD, port: 5554 } },
      projectRoot: canonicalizeExistingPath(ROOT),
    });
    expect(read.kind === 'binding' && read.binding.device).toMatchObject({
      origin: { emulatorPid: expect.any(Number) },
    });
  });

  // only-create-and-spawn-under-lock
  it('reads the inventory before the lock, spawns under it, and polls the boot after it', async () => {
    const tools = fakeTools();

    await acquireDeviceAsync(ROOT, 'android', { tools });

    const locked = tools.calls.map((call, index) => [
      call.slice(0, 2).join(' '),
      tools.lockedAt[index],
    ]);
    expect(locked).toEqual([
      ['devices -l', false],
      ['emulator -list-avds', false],
      ['emulator -avd', true],
      ['devices', false],
      ['-s emulator-5554', false],
    ]);
    expect(tools.calls.at(-1)).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'getprop',
      'sys.boot_completed',
    ]);
  });

  it('takes the next even port beside a running instance and another worktree', async () => {
    const tools = fakeTools({ emulators: [{ serial: 'emulator-5554', state: 'device' }] });
    writeBinding(file(OTHER), androidBindingFor(OTHER, 'emulator-5556', spawned(5556, 77)));

    const result = await acquireDeviceAsync(ROOT, 'android', { tools });

    expect(result.device).toMatchObject({ serial: 'emulator-5558' });
    expect(tools.spawned[0]).toContain('5558,5559');
  });

  it('takes the next even port beside an instance that is still booting', async () => {
    const tools = fakeTools({ emulators: [{ serial: 'emulator-5554', state: 'offline' }] });

    const result = await acquireDeviceAsync(ROOT, 'android', { tools });

    expect(result.device).toMatchObject({ serial: 'emulator-5556' });
    expect(tools.spawned[0]).toContain('5556,5557');
  });

  // busy-ports-include-alive-emulators
  it('keeps the port of an expired binding whose instance is alive, and frees one whose pid is dead', async () => {
    const tools = fakeTools({ alivePids: [77] });
    const expired = { expiresAt: '2026-10-08T09:00:00.000Z' };
    writeBinding(
      file(OTHER),
      androidBindingFor(OTHER, 'emulator-5554', spawned(5554, 77), expired)
    );
    writeBinding(
      bindingPathFor('/work/third', 'android', 'local-android'),
      androidBindingFor('/work/third', 'emulator-5556', spawned(5556, 78), expired)
    );

    const result = await acquireDeviceAsync(ROOT, 'android', { tools });

    expect(result.device).toMatchObject({ serial: 'emulator-5556' });
  });

  it('reuses the own instance while its pid is alive, renews the lease and boots again', async () => {
    const tools = fakeTools({
      emulators: [{ serial: 'emulator-5556', state: 'device', pid: 77 }],
    });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5556', spawned(5556, 77)));

    const result = await acquireDeviceAsync(ROOT, 'android', { tools });

    expect(result).toMatchObject({ action: 'reused', justBooted: false });
    expect(tools.spawned).toEqual([]);
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.expiresAt).toBe('2026-10-08T11:00:00.000Z');
    expect(tools.calls).toContainEqual([
      '-s',
      'emulator-5556',
      'shell',
      'getprop',
      'sys.boot_completed',
    ]);
  });

  it.each(['spawned', 'explicit'] as const)('replaces missing %s', async (kind) => {
    const tools = fakeTools();
    writeBinding(
      file(),
      androidBindingFor(ROOT, 'emulator-5556', kind === 'spawned' ? spawned(5556, 77) : { kind })
    );

    const result = await acquireDeviceAsync(ROOT, 'android', { tools });

    expect(result).toMatchObject({ action: 'spawned' });
    expect(result.device).toMatchObject({ serial: 'emulator-5554' });
  });

  it.each([
    [
      'a pid ps shows running another command',
      { command: 'node server.js' },
      {},
      { state: 'gone', cause: 'device-gone' },
      { action: 'spawned', device: { serial: 'emulator-5554' } },
    ],
    [
      'a live pid where ps does not exist',
      {},
      { noPs: true },
      { state: 'up' },
      { action: 'reused', device: { serial: 'emulator-5556' } },
    ],
  ])(
    'checks a live pid against the AVD and the ports before it reuses or reports the instance: %s',
    async (_case, row, rowTools, inspected, acquired) => {
      const tools = fakeTools({
        emulators: [{ serial: 'emulator-5556', state: 'device', pid: 77, ...row }],
        ...rowTools,
      });
      writeBinding(file(), androidBindingFor(ROOT, 'emulator-5556', spawned(5556, 77)));

      const inspection = await inspectBindingAsync(ROOT, 'android', 'local-android', tools);
      const result = await acquireDeviceAsync(ROOT, 'android', { tools });

      expect(inspection).toMatchObject(inspected);
      expect(result).toMatchObject(acquired);
      expect(tools.killed).toEqual([]);
    }
  );

  it('reuses an own explicit binding whose serial adb lists offline, and spawns nothing', async () => {
    const tools = fakeTools({ emulators: [{ serial: 'emulator-5554', state: 'offline' }] });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', { kind: 'explicit' }));

    const result = await acquireDeviceAsync(ROOT, 'android', { tools });

    expect(result).toMatchObject({ action: 'reused', device: { serial: 'emulator-5554' } });
    expect(tools.spawned).toEqual([]);
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.device.origin).toEqual({ kind: 'explicit' });
  });

  // let-go-runs-before-refusal
  it('lets go of the dead own instance before it refuses no-avd, and kills nothing', async () => {
    const tools = fakeTools({ avds: [] });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5556', spawned(5556, 77)));

    const error = await acquireDeviceAsync(ROOT, 'android', { tools }).catch((e) => e);

    expect(error.data).toEqual({ reason: 'no-avd' });
    expect(error.exitCode).toBe(7);
    expect(readBindingFile(file())).toEqual({ kind: 'none' });
    expect(tools.killed).toEqual([]);
  });

  it('refuses no-free-port naming every serial and its worktree, or not ours', async () => {
    const serials = Array.from({ length: 16 }, (_, i) => `emulator-${5554 + 2 * i}`);
    const tools = fakeTools({ emulators: serials.map((serial) => ({ serial, state: 'device' })) });
    writeBinding(file(OTHER), androidBindingFor(OTHER, 'emulator-5554', spawned(5554, 77)));

    const error = await acquireDeviceAsync(ROOT, 'android', { tools }).catch((e) => e);

    expect(error.code).toBe('DEVICE_UNAVAILABLE');
    expect(error.exitCode).toBe(20);
    expect(error.data.reason).toBe('no-free-port');
    expect(error.data.boundBy).toContainEqual({ id: 'emulator-5554', root: OTHER });
    expect(error.data.boundBy).toContainEqual({ id: 'emulator-5584', root: null });
    expect(error.message).toContain('emulator-5584 (not ours)');
    expect(tools.spawned).toEqual([]);
  });

  it('refuses spawn-failed when the child has no pid, and writes nothing', async () => {
    const tools = fakeTools({ spawnFails: true });

    const error = await acquireDeviceAsync(ROOT, 'android', { tools }).catch((e) => e);

    expect(error.data).toEqual({ reason: 'spawn-failed' });
    expect(readBindingFile(file())).toEqual({ kind: 'none' });
  });

  // failed-boot-lets-go
  it('lets go of the binding when the child exits during the boot', async () => {
    const tools = fakeTools({ exitsWith: 1 });

    const error = await acquireDeviceAsync(ROOT, 'android', { tools }).catch((e) => e);

    expect(error.data).toEqual({ reason: 'boot-failed' });
    expect(error.message).toContain('exited with 1');
    expect(readBindingFile(file())).toEqual({ kind: 'none' });
  });

  it.each([
    [
      'an exit during the boot',
      { exitsWith: 1, prints: 'PANIC: Missing emulator engine' },
      'boot-failed',
      'exited with 1: PANIC: Missing emulator engine',
    ],
    [
      'a spawn that fails',
      { spawnFails: true, prints: 'spawn /sdk/emulator ENOENT' },
      'spawn-failed',
      'could not be started: spawn /sdk/emulator ENOENT',
    ],
  ])('puts what the emulator said on the refusal for %s', async (_case, options, reason, said) => {
    const tools = fakeTools(options);

    await expect(acquireDeviceAsync(ROOT, 'android', { tools })).rejects.toMatchObject({
      data: { reason },
      message: expect.stringContaining(said),
    });
  });

  it.each(['devices', '-s emulator-5554 shell getprop sys.boot_completed'])(
    'refuses another emulator answering when the child exits during %s',
    async (exitDuring) => {
      const tools = fakeTools();
      const spawnEmulator = tools.spawnEmulator;
      const isPidAlive = tools.isPidAlive;
      let exitedPid: number | undefined;
      let exitChild!: () => void;
      tools.spawnEmulator = (args) => {
        const child = spawnEmulator(args);
        return {
          ...child,
          exited: new Promise<number | null>((resolve) => {
            exitChild = () => {
              exitedPid = child.pid;
              resolve(1);
            };
          }),
        };
      };
      tools.isPidAlive = (pid) => pid !== exitedPid && isPidAlive(pid);
      const adb = tools.adb;
      tools.adb = async (args, options) => {
        const result = await adb(args, options);
        if (args.join(' ') === exitDuring) {
          exitChild();
          // A human's emulator won the port and keeps answering under the same serial.
          tools.emulators.splice(0, 1, { serial: 'emulator-5554', state: 'device' });
        }
        return result;
      };

      await expect(acquireDeviceAsync(ROOT, 'android', { tools })).rejects.toMatchObject({
        code: 'DEVICE_UNAVAILABLE',
        data: { reason: 'boot-failed' },
        message: expect.stringContaining('exited with 1'),
      });
      expect(readBindingFile(file())).toEqual({ kind: 'none' });
      expect(tools.killed).toEqual([]);
    }
  );

  it('kills the instance it spawned when the boot runs out of time', async () => {
    const tools = fakeTools({ neverBoots: true });
    tools.now = () => {
      tools.clock.now = new Date(tools.clock.now.getTime() + 300_000);
      return tools.clock.now;
    };

    const error = await acquireDeviceAsync(ROOT, 'android', { tools }).catch((e) => e);

    expect(error.data).toEqual({ reason: 'boot-failed' });
    expect(error.message).toContain('sys.boot_completed');
    expect(readBindingFile(file())).toEqual({ kind: 'none' });
    expect(tools.killed).toEqual([4001]);
  });

  it('throws the tool error when adb cannot run', async () => {
    const tools = fakeTools({ adbSpawnError: true });

    const error = await acquireDeviceAsync(ROOT, 'android', { tools }).catch((e) => e);

    expect(error.code).toBe('ADB_NOT_RUNNABLE');
  });

  it('reports adb exiting non-zero as an adb failure that quotes stderr, in the inventory and in get-state', async () => {
    const tools = fakeTools();
    tools.adb = async () => ({
      stdout: '',
      stderr: 'error: could not install *smartsocket* listener\n',
      exitCode: 1,
    });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', { kind: 'explicit' }));

    const error = await acquireDeviceAsync(ROOT, 'android', { tools }).catch((e) => e);
    const inspection = await inspectBindingAsync(ROOT, 'android', 'local-android', tools);

    for (const failure of [error, inspection.toolError]) {
      expect(failure).toMatchObject({
        code: 'ADB_FAILED',
        message: expect.stringContaining('exited 1: error: could not install *smartsocket*'),
      });
    }
  });
});

describe(releaseWorktreeDevicesAsync, () => {
  // kill-checks-arguments-not-binary
  it.each([
    ['the AVD and the ports', `qemu-system-aarch64 ${SPAWN_ARGS.join(' ')}`, true],
    ['another AVD', 'qemu-system-aarch64 -avd Other -ports 5554,5555 -read-only', false],
    ['other ports', `emulator -avd ${AVD} -ports 5556,5557 -read-only`, false],
    ['an AVD whose name starts with ours', `emulator -avd ${AVD}_API_36 -ports 5554,5555`, false],
  ])('kills a spawned instance only when its arguments name %s', async (_case, command, killed) => {
    const tools = fakeTools({
      emulators: [{ serial: 'emulator-5554', state: 'device', pid: 77, command }],
    });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77)));

    const released = await releaseWorktreeDevicesAsync(ROOT, { platform: 'android', tools });

    expect(released).toEqual([
      expect.objectContaining({
        backend: 'local-android',
        id: 'emulator-5554',
        released: true,
        shutDown: killed,
      }),
    ]);
    expect(tools.killed).toEqual(killed ? [77] : []);
    expect(readBindingFile(file())).toEqual({ kind: 'none' });
  });

  it('kills by pid alone where ps does not exist', async () => {
    const tools = fakeTools({
      emulators: [{ serial: 'emulator-5554', state: 'device', pid: 77 }],
      noPs: true,
    });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77)));

    await releaseWorktreeDevicesAsync(ROOT, { platform: 'android', tools });

    expect(tools.killed).toEqual([77]);
  });

  it('removes the file of a dead instance and kills nothing', async () => {
    const tools = fakeTools();
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77)));

    const released = await releaseWorktreeDevicesAsync(ROOT, { platform: 'android', tools });

    expect(released[0]).toMatchObject({ shutDown: false, reason: 'pid 77 is not running' });
    expect(tools.killed).toEqual([]);
    expect(readBindingFile(file())).toEqual({ kind: 'none' });
  });

  it('writes a spawned binding back, expired, when the kill throws and the instance still runs', async () => {
    const tools = fakeTools({
      emulators: [{ serial: 'emulator-5554', state: 'device', pid: 77 }],
      noPs: true,
    });
    tools.kill = () => {
      throw new Error('kill EPERM');
    };
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77)));

    const released = await releaseWorktreeDevicesAsync(ROOT, { platform: 'android', tools });

    expect(released).toEqual([expect.objectContaining({ released: false, reason: 'kill EPERM' })]);
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding).toMatchObject({
      device: { origin: { emulatorPid: 77 } },
      expiresAt: '2026-10-08T10:00:00.000Z',
    });
  });

  it('expires an explicit binding and keeps its file and its device', async () => {
    const tools = fakeTools({ emulators: [{ serial: 'emulator-5554', state: 'device' }] });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', { kind: 'explicit' }));

    await releaseWorktreeDevicesAsync(ROOT, { platform: 'android', tools });

    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.expiresAt).toBe('2026-10-08T10:00:00.000Z');
    expect(tools.killed).toEqual([]);
  });

  it('expires an explicit binding and keeps its file when adb does not find its serial', async () => {
    const tools = fakeTools();
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', { kind: 'explicit' }));

    await releaseWorktreeDevicesAsync(ROOT, { platform: 'android', tools });

    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.expiresAt).toBe('2026-10-08T10:00:00.000Z');
    expect(tools.androidCalls).toEqual([]);
  });

  it('lets go of both platforms without a platform', async () => {
    const tools = fakeTools({
      simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }],
      emulators: [{ serial: 'emulator-5554', state: 'device', pid: 77 }],
    });
    writeBinding(bindingPathFor(ROOT, 'ios', 'local-ios'), bindingFor(ROOT, 'SIM-1'));
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77)));

    const released = await releaseWorktreeDevicesAsync(ROOT, { tools });

    expect(released.map((device) => device.id)).toEqual(['SIM-1', 'emulator-5554']);
  });

  it('release validates the Android pid even when its serial did not change', async () => {
    const registry = await import('../registry');
    const old = androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77));
    const replacement = androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 88));
    writeBinding(file(), old);
    const lock = registry.withRegistryLockAsync;
    const replaced = vi
      .spyOn(registry, 'withRegistryLockAsync')
      .mockImplementation(async (work, options) => {
        writeBinding(file(), replacement);
        return lock(work, options);
      });
    const tools = fakeTools({ alivePids: [77, 88] });
    try {
      expect(await releaseWorktreeDevicesAsync(ROOT, { tools, platform: 'android' })).toEqual([]);
      expect(readBindingFile(file())).toEqual({ kind: 'binding', binding: replacement });
      expect(tools.killed).toEqual([]);
    } finally {
      replaced.mockRestore();
    }
  });
});

describe(inspectBindingAsync, () => {
  // spawned-booting-is-not-up
  it('reports a spawned instance adb lists offline as not-up', async () => {
    const tools = fakeTools({
      emulators: [{ serial: 'emulator-5554', state: 'offline', pid: 77 }],
    });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77)));

    expect(await inspectBindingAsync(ROOT, 'android', 'local-android', tools)).toMatchObject({
      state: 'not-up',
    });
  });

  // get-state-not-found-is-gone
  it('reports a serial get-state does not find as gone, not as a tool failure', async () => {
    const tools = fakeTools({ alivePids: [77] });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77)));

    expect(await inspectBindingAsync(ROOT, 'android', 'local-android', tools)).toMatchObject({
      state: 'gone',
      cause: 'device-gone',
    });
    expect(tools.calls).toEqual([['-s', 'emulator-5554', 'get-state']]);
  });

  it('reports a spawned instance whose pid is dead as gone, whatever adb lists', async () => {
    const tools = fakeTools({
      emulators: [{ serial: 'emulator-5554', state: 'device' }],
      alivePids: [],
    });
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77)));

    expect(await inspectBindingAsync(ROOT, 'android', 'local-android', tools)).toMatchObject({
      state: 'gone',
      cause: 'device-gone',
    });
  });

  it.each([
    ['up', { emulators: [{ serial: 'emulator-5554', state: 'device' as const }] }, { state: 'up' }],
    ['unknown from the tool', { adbSpawnError: true }, { state: 'unknown', cause: 'tool' }],
    ['unknown from a timeout', { stateTimesOut: true }, { state: 'unknown', cause: 'timeout' }],
  ])('reports an explicit binding %s', async (_name, options, expected) => {
    const tools = fakeTools(options);
    writeBinding(file(), androidBindingFor(ROOT, 'emulator-5554', { kind: 'explicit' }));

    expect(await inspectBindingAsync(ROOT, 'android', 'local-android', tools)).toMatchObject(
      expected
    );
  });
});

describe(findBoundDeviceAsync, () => {
  it('drives the bound instance with --android and extends its lease', async () => {
    const tools = fakeTools({ emulators: [{ serial: 'emulator-5554', state: 'device', pid: 77 }] });
    writeBinding(
      file(),
      androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77), {
        expiresAt: '2026-10-08T10:30:00.000Z',
      })
    );

    const found = await findBoundDeviceAsync(ROOT, { platform: 'android', extend: true, tools });

    expect(found.device).toMatchObject({ backend: 'local-android', serial: 'emulator-5554' });
    expect(tools.calls).toEqual([['-s', 'emulator-5554', 'get-state']]);
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.expiresAt).toBe('2026-10-08T11:00:00.000Z');
  });

  // any-up-wins-across-platforms
  it('takes the instance bound after the simulator when both are up', async () => {
    const tools = fakeTools({
      simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }],
      emulators: [{ serial: 'emulator-5554', state: 'device', pid: 77 }],
    });
    writeBinding(bindingPathFor(ROOT, 'ios', 'local-ios'), bindingFor(ROOT, 'SIM-1'));
    writeBinding(
      file(),
      androidBindingFor(ROOT, 'emulator-5554', spawned(5554, 77), {
        boundAt: '2026-10-08T09:30:00.000Z',
      })
    );

    const found = await findBoundDeviceAsync(ROOT, {
      extend: false,
      tools,
      hostPlatform: 'darwin',
    });

    expect(found.device).toMatchObject({ serial: 'emulator-5554' });
  });
});
