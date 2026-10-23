import fs from 'fs';
import path from 'path';
import { vol } from 'memfs';
import {
  acquireCloudBindingAsync,
  claimable,
  live,
  readCloudBindings,
  releaseCloudBindingAsync,
} from '../cloud';
import { bindingPathFor, readBindingFile } from '../registry';
import { cloudBindingFor, writeCloudBinding } from './fakeCloudBinding';
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
  expect(
    live(readCloudBindings(root).bindings, tools.now()).map(({ device }) => device.id)
  ).toEqual(['A']);
});
it('session-id release ignores stale state but leaves a replacement alone', async () => {
  const tools = fakeTools();
  await acquireCloudBindingAsync(root, { platform: 'ios', id: 'A', origin: 'started', tools });
  await acquireCloudBindingAsync(root, { platform: 'ios', id: 'B', origin: 'started', tools });
  expect(await releaseCloudBindingAsync(root, 'A', tools)).toEqual([]);
  expect(readBindingFile(file())).toMatchObject({ binding: { device: { id: 'B' } } });
  tools.clock.now = new Date('2026-10-08T12:00:00Z');
  expect(await releaseCloudBindingAsync(root, 'B', tools)).toMatchObject([
    { id: 'B', released: true },
  ]);
  expect(readBindingFile(file())).toEqual({ kind: 'none' });
});
describe('two starts in one worktree at once', () => {
  const at = new Date('2026-10-08T10:00:00Z');
  async function race({
    boundAt,
    origin = 'started',
    dotenv,
  }: {
    boundAt: string;
    origin?: 'started' | 'dotenv';
    dotenv: string;
  }) {
    const tools = fakeTools();
    tools.clock.now = new Date(boundAt);
    await acquireCloudBindingAsync(root, { platform: 'ios', id: 'A', origin, tools });
    tools.clock.now = new Date('2026-10-08T10:02:00Z');
    tools.stopCloud = vi.fn(async () => ({ ok: true, reason: null }));
    const kept = await acquireCloudBindingAsync(root, {
      platform: 'ios',
      id: 'B',
      origin: 'started',
      start: { at, dotenvId: () => dotenv },
      tools,
    });
    return { tools, kept };
  }

  it('keeps the session the dotenv names and stops the replaced started one', async () => {
    const { tools, kept } = await race({ boundAt: '2026-10-08T10:01:00Z', dotenv: 'B' });
    expect(tools.stopCloud).toHaveBeenCalledTimes(1);
    expect(tools.stopCloud).toHaveBeenCalledWith(root, 'A');
    expect(readBindingFile(file())).toMatchObject({ binding: { device: { id: 'B' } } });
    expect(kept.device).toMatchObject({ id: 'B' });
  });

  it('keeps the earlier binding and stops its own session when the dotenv names the other', async () => {
    const { tools, kept } = await race({ boundAt: '2026-10-08T10:01:00Z', dotenv: 'A' });
    expect(tools.stopCloud).toHaveBeenCalledTimes(1);
    expect(tools.stopCloud).toHaveBeenCalledWith(root, 'B');
    expect(readBindingFile(file())).toMatchObject({ binding: { device: { id: 'A' } } });
    expect(kept.device).toMatchObject({ id: 'A' });
  });

  it('replaces a binding made before this start without a stop', async () => {
    const { tools } = await race({ boundAt: '2026-10-08T09:00:00Z', dotenv: 'B' });
    expect(tools.stopCloud).not.toHaveBeenCalled();
    expect(readBindingFile(file())).toMatchObject({ binding: { device: { id: 'B' } } });
  });

  it('never stops a replaced dotenv session', async () => {
    const { tools } = await race({
      boundAt: '2026-10-08T10:01:00Z',
      origin: 'dotenv',
      dotenv: 'B',
    });
    expect(tools.stopCloud).not.toHaveBeenCalled();
    expect(readBindingFile(file())).toMatchObject({ binding: { device: { id: 'B' } } });
  });
});

describe(readCloudBindings, () => {
  it('reads both platforms at any age, and names an unreadable file', () => {
    writeCloudBinding(root, 'ios', 'A', { expiresAt: '2026-10-08T09:30:00.000Z' });
    fs.mkdirSync(path.dirname(bindingPathFor(root, 'android', 'cloud')), { recursive: true });
    fs.writeFileSync(bindingPathFor(root, 'android', 'cloud'), 'garbage');
    expect(readCloudBindings(root)).toEqual({
      bindings: [cloudBindingFor(root, 'ios', 'A', { expiresAt: '2026-10-08T09:30:00.000Z' })],
      unreadable: [{ platform: 'android', path: bindingPathFor(root, 'android', 'cloud') }],
    });
  });
});

describe(claimable, () => {
  const now = new Date('2026-10-08T10:00:00.000Z');
  const expired = { expiresAt: '2026-10-08T09:30:00.000Z' };
  const bindings = [
    cloudBindingFor(root, 'ios', 'expired-ios', expired),
    cloudBindingFor(root, 'android', 'expired-android', expired),
    cloudBindingFor(root, 'android', 'live-android'),
  ];

  it('counts the asked platform at any age and the other platform only while live', () => {
    expect(claimable(bindings, 'ios', now).map(({ device }) => device.id)).toEqual([
      'expired-ios',
      'live-android',
    ]);
    expect(live(bindings, now).map(({ device }) => device.id)).toEqual(['live-android']);
  });

  // The probe names the first bound id when none is listed, so the asked platform's comes first.
  it('puts the asked platform first', () => {
    expect(claimable(bindings, 'android', now).map(({ device }) => device.id)).toEqual([
      'expired-android',
      'live-android',
    ]);
    const mixed = [cloudBindingFor(root, 'ios', 'live-ios'), cloudBindingFor(root, 'android', 'a')];
    expect(claimable(mixed, 'android', now).map(({ device }) => device.id)).toEqual([
      'a',
      'live-ios',
    ]);
  });
});
