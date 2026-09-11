import { spawn } from 'child_process';
import { EventEmitter } from 'events';

import { spawnCaptureAsync, spawnCaptureBufferAsync } from '../spawnCapture';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function mockSpawn(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  vi.mocked(spawn).mockReturnValue(child as any);
  return child;
}

describe(spawnCaptureAsync, () => {
  it(`should capture the output and the exit code`, async () => {
    const child = mockSpawn();

    const promise = spawnCaptureAsync('adb', ['devices']);
    child.stdout.emit('data', 'List of devices attached\n');
    child.stderr.emit('data', 'daemon started\n');
    child.emit('close', 0, null);

    await expect(promise).resolves.toEqual({
      stdout: 'List of devices attached\n',
      stderr: 'daemon started\n',
      exitCode: 0,
    });
    expect(spawn).toHaveBeenCalledWith('adb', ['devices'], expect.anything());
  });

  it(`should report a non-zero exit code instead of rejecting`, async () => {
    const child = mockSpawn();

    const promise = spawnCaptureAsync('adb', ['shell']);
    child.stderr.emit('data', 'Error: Activity not started');
    child.emit('close', 1, null);

    await expect(promise).resolves.toMatchObject({
      exitCode: 1,
      stderr: 'Error: Activity not started',
    });
  });

  it(`should report a missing binary instead of rejecting`, async () => {
    const child = mockSpawn();

    const promise = spawnCaptureAsync('adb', ['devices']);
    child.emit('error', Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }));

    const result = await promise;

    expect(result.exitCode).toBeNull();
    expect(result.spawnError?.code).toBe('ENOENT');
  });

  it(`should report a signal as a null exit code`, async () => {
    const child = mockSpawn();

    const promise = spawnCaptureAsync('xcrun', ['simctl']);
    child.emit('close', null, 'SIGKILL');

    await expect(promise).resolves.toMatchObject({ exitCode: null });
  });
});

describe(spawnCaptureBufferAsync, () => {
  it(`keeps stdout as the bytes the tool wrote`, async () => {
    const child = mockSpawn();
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xfe]);

    const promise = spawnCaptureBufferAsync('adb', ['exec-out', 'dd']);
    child.stdout.emit('data', bytes.subarray(0, 3));
    child.stdout.emit('data', bytes.subarray(3));
    child.emit('close', 0, null);

    const result = await promise;
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
    expect(result.stdout.equals(bytes)).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
