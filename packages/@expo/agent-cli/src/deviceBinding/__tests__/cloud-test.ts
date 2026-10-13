import fs from 'fs';
import path from 'path';
import { vol } from 'memfs';
import { acquireCloudBindingAsync, ownCloudIdsAsync } from '../cloud';
import { inspectBindingAsync } from '../inspect';
import { releaseWorktreeDevicesAsync } from '../release';
import { reapDevicesAsync } from '../reap';
import { bindingPathFor, readBindingFile, registryDirectory } from '../registry';
import { fakeTools } from './fakeTools';
const root = path.resolve('/work/app');
const other = path.resolve('/work/other');
const file = (r = root) => bindingPathFor(r, 'ios', 'cloud');
beforeEach(() => {
  vol.reset();
  vol.fromJSON({
    [path.join(root, 'package.json')]: '{}',
    [path.join(other, 'package.json')]: '{}',
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());
it('reusing a started session preserves origin and the session-cap clock', async () => {
  const tools = fakeTools();
  const first = await acquireCloudBindingAsync(root, {
    platform: 'ios',
    id: 'A',
    origin: 'started',
    tools,
  });
  tools.clock.now = new Date('2026-10-08T10:30:00Z');
  const second = await acquireCloudBindingAsync(root, {
    platform: 'ios',
    id: 'A',
    origin: 'dotenv',
    tools,
  });
  expect(second.boundAt).toBe(first.boundAt);
  expect(second.device).toEqual(first.device);
  expect(second.expiresAt).not.toBe(first.expiresAt);
  expect(await ownCloudIdsAsync(root)).toEqual(['A']);
});
it('session-id release ignores stale state but leaves a replacement alone', async () => {
  const tools = fakeTools();
  await acquireCloudBindingAsync(root, { platform: 'ios', id: 'A', origin: 'started', tools });
  await acquireCloudBindingAsync(root, { platform: 'ios', id: 'B', origin: 'started', tools });
  expect(await releaseWorktreeDevicesAsync(root, { sessionId: 'A', tools })).toEqual([]);
  expect(readBindingFile(file())).toMatchObject({ binding: { device: { id: 'B' } } });
  tools.clock.now = new Date('2026-10-08T12:00:00Z');
  expect(await releaseWorktreeDevicesAsync(root, { sessionId: 'B', tools })).toMatchObject([
    { id: 'B', released: true },
  ]);
  expect(readBindingFile(file())).toEqual({ kind: 'none' });
});
it('expired cloud inspection is gone and writes nothing', async () => {
  const tools = fakeTools();
  await acquireCloudBindingAsync(root, { platform: 'ios', id: 'A', origin: 'started', tools });
  const before = readBindingFile(file());
  tools.clock.now = new Date('2026-10-08T12:00:00Z');
  expect(await inspectBindingAsync(root, 'ios', 'cloud', tools)).toMatchObject({
    state: 'gone',
    cause: 'expired',
  });
  expect(readBindingFile(file())).toEqual(before);
});
it.each([false, true])(
  'reap stops under the binding root, or caller when deleted=%s',
  async (deleted) => {
    const tools = fakeTools();
    await acquireCloudBindingAsync(other, { platform: 'ios', id: 'A', origin: 'started', tools });
    if (deleted) fs.rmSync(other, { recursive: true });
    else tools.clock.now = new Date('2026-10-08T11:01:00Z');
    tools.stopCloud = vi.fn(async () => {
      expect(fs.existsSync(`${registryDirectory()}/.lock`)).toBe(false);
      return { ok: true, reason: null };
    });
    await reapDevicesAsync(root, { tools });
    expect(tools.stopCloud).toHaveBeenCalledWith(deleted ? root : other, 'A');
    expect(readBindingFile(file(other))).toEqual({ kind: 'none' });
  }
);
it('a dotenv binding is removed, never stopped by reap', async () => {
  const tools = fakeTools();
  await acquireCloudBindingAsync(other, { platform: 'ios', id: 'A', origin: 'dotenv', tools });
  fs.rmSync(other, { recursive: true });
  tools.stopCloud = vi.fn();
  await reapDevicesAsync(root, { tools });
  expect(tools.stopCloud).not.toHaveBeenCalled();
  expect(readBindingFile(file(other))).toEqual({ kind: 'none' });
});

it('forgets a started session past the service cap without a stop call', async () => {
  const tools = fakeTools();
  await acquireCloudBindingAsync(other, { platform: 'ios', id: 'A', origin: 'started', tools });
  tools.clock.now = new Date('2026-10-08T12:00:00Z');
  tools.stopCloud = vi.fn();
  const reports = await reapDevicesAsync(root, { tools });
  expect(reports).toMatchObject([{ id: 'A', reason: 'session-cap' }]);
  expect(tools.stopCloud).not.toHaveBeenCalled();
  expect(readBindingFile(file(other))).toEqual({ kind: 'none' });
});
