import fs from 'fs';
import path from 'path';
import { vol } from 'memfs';
import {
  acquireCloudBindingAsync,
  claimable,
  claimCloudBindingsAsync,
  live,
  readCloudBindings,
} from '../cloud';
import { releaseCloudSessionsAsync, releaseStartedSessionAsync } from '../cloudRelease';
import { reapDevicesAsync } from '../reap';
import { bindingPathFor, readBindingFile, registryDirectory } from '../registry';
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
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line) => void lines.push(String(line)));
    const { reports } = await reapDevicesAsync(root, { tools });
    expect(tools.stopCloud).toHaveBeenCalledWith(deleted ? root : other, 'A');
    expect(readBindingFile(file(other))).toEqual({ kind: 'none' });
    expect(reports[0]!.reason).toBe(deleted ? 'deleted-worktree' : 'expired');
    if (!deleted) expect(lines).toContain('Stopped EAS Simulator session A (expired).');
  }
);
it.each([true, false])(
  'reap names the stopped session, or the stop by hand (ok=%s)',
  async (ok) => {
    const tools = fakeTools();
    await acquireCloudBindingAsync(other, { platform: 'ios', id: 'A', origin: 'started', tools });
    fs.rmSync(other, { recursive: true });
    tools.stopCloud = vi.fn(async () => ({ ok, reason: ok ? null : 'boom' }));
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line) => void lines.push(String(line)));
    const { reports } = await reapDevicesAsync(root, { tools });
    if (ok)
      expect(lines).toContain(
        `Stopped EAS Simulator session A of worktree ${other}: that worktree no longer exists, so no other command can stop it.`
      );
    else expect(reports[0]!.error).toContain('simulator:stop --id A');
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
  const { reports } = await reapDevicesAsync(root, { tools });
  expect(reports).toMatchObject([{ id: 'A', reason: 'session-cap' }]);
  expect(tools.stopCloud).not.toHaveBeenCalled();
  expect(readBindingFile(file(other))).toEqual({ kind: 'none' });
});

it('a claim renews an expired own binding, so another worktree does not reap it', async () => {
  const tools = fakeTools();
  await acquireCloudBindingAsync(root, { platform: 'ios', id: 'A', origin: 'started', tools });
  const later = new Date('2026-10-08T11:30:00Z');
  vi.setSystemTime(later);
  tools.clock.now = later;
  expect(await claimCloudBindingsAsync(root, 'ios', tools)).toEqual({
    boundIds: ['A'],
    unreadable: null,
    renewed: expect.objectContaining({ id: 'A' }),
  });
  tools.stopCloud = vi.fn();
  await reapDevicesAsync(other, { tools });
  expect(tools.stopCloud).not.toHaveBeenCalled();
  expect(readBindingFile(file())).toMatchObject({ binding: { device: { id: 'A' } } });
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

describe(releaseCloudSessionsAsync, () => {
  it('removes the bindings before the stops, and stops an unbound id too', async () => {
    const tools = fakeTools();
    const binding = writeCloudBinding(root, 'ios', 'A');
    tools.stopCloud = vi.fn(async () => {
      expect(readCloudBindings(root).bindings).toEqual([]);
      return { ok: true, reason: null };
    });
    const result = await releaseCloudSessionsAsync(root, ['P', 'A'], 'test', tools);
    expect(result).toEqual({
      releases: [
        { id: 'P', binding: null, ok: true, reason: null },
        { id: 'A', binding, ok: true, reason: null },
      ],
      lockError: null,
    });
    expect(vi.mocked(tools.stopCloud).mock.calls).toEqual([
      [root, 'P'],
      [root, 'A'],
    ]);
  });

  it('writes the binding back when its stop fails', async () => {
    const tools = fakeTools();
    const binding = writeCloudBinding(root, 'ios', 'A');
    tools.stopCloud = vi.fn(async () => ({ ok: false, reason: 'refused' }));
    const { releases } = await releaseCloudSessionsAsync(root, ['A'], 'test', tools);
    expect(releases).toMatchObject([
      {
        id: 'A',
        ok: false,
        reason: expect.stringMatching(/^refused; ".* simulator:stop --id A" ends it$/),
      },
    ]);
    expect(readBindingFile(file())).toEqual({ kind: 'binding', binding });
  });

  it.each([true, false])('keeps a replacement bound during a stop (stop ok: %s)', async (ok) => {
    const tools = fakeTools();
    writeCloudBinding(root, 'ios', 'A');
    tools.stopCloud = vi.fn(async () => {
      writeCloudBinding(root, 'ios', 'B');
      return { ok, reason: ok ? null : 'refused' };
    });
    await releaseCloudSessionsAsync(root, ['A'], 'test', tools);
    expect(readBindingFile(file())).toMatchObject({ binding: { device: { id: 'B' } } });
  });

  it('leaves a binding it was not asked about', async () => {
    const tools = fakeTools();
    writeCloudBinding(root, 'android', 'B');
    await releaseCloudSessionsAsync(root, ['A'], 'test', tools);
    expect(readCloudBindings(root).bindings).toMatchObject([{ device: { id: 'B' } }]);
  });
});

// @ref llp/0035-one-device-per-worktree.rfc.md §Session binding — a session no binding records belongs to no run
describe(releaseStartedSessionAsync, () => {
  const stubbedTools = () => {
    const tools = fakeTools();
    tools.stopCloud = vi.fn(async () => ({ ok: true, reason: null }));
    return tools;
  };

  it('stops a session no binding records', async () => {
    const tools = stubbedTools();
    expect(await releaseStartedSessionAsync(root, 'A', 'test', tools)).toEqual({
      outcome: 'stopped',
    });
    expect(tools.stopCloud).toHaveBeenCalledWith(root, 'A');
  });

  it("stops this run's own binding and removes it", async () => {
    const tools = stubbedTools();
    writeCloudBinding(root, 'ios', 'A');
    tools.stopCloud = vi.fn(async () => {
      expect(readCloudBindings(root).bindings).toEqual([]);
      return { ok: true, reason: null };
    });
    expect(await releaseStartedSessionAsync(root, 'A', 'test', tools)).toEqual({
      outcome: 'stopped',
    });
  });

  it('keeps a session another run bound between the start and the stop', async () => {
    const tools = stubbedTools();
    writeCloudBinding(root, 'ios', 'A', { origin: 'dotenv' });
    const release = await releaseStartedSessionAsync(root, 'A', 'test', tools);
    expect(release).toMatchObject({ outcome: 'kept' });
    expect(release.outcome !== 'stopped' && release.reason).toBe(
      'another run in this worktree recorded it, so it stays'
    );
    expect(tools.stopCloud).not.toHaveBeenCalled();
    expect(readCloudBindings(root).bindings).toMatchObject([{ device: { id: 'A' } }]);
  });

  it('stops nothing when the registry lock cannot be taken', async () => {
    const tools = stubbedTools();
    const registry = await import('../registry');
    const locked = vi
      .spyOn(registry, 'withRegistryLockAsync')
      .mockRejectedValue(new Error('lock wait timed out'));
    try {
      const release = await releaseStartedSessionAsync(root, 'A', 'test', tools);
      expect(release).toMatchObject({ outcome: 'kept' });
      expect(release.outcome !== 'stopped' && release.reason).toContain('lock wait timed out');
      expect(release.outcome !== 'stopped' && release.reason).not.toContain('simulator:stop');
      expect(tools.stopCloud).not.toHaveBeenCalled();
    } finally {
      locked.mockRestore();
    }
  });

  it('stops nothing when a binding file cannot be read', async () => {
    const tools = stubbedTools();
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), 'garbage');
    expect(await releaseStartedSessionAsync(root, 'A', 'test', tools)).toMatchObject({
      outcome: 'kept',
    });
    expect(tools.stopCloud).not.toHaveBeenCalled();
  });

  it('writes the binding back and names the stop when the stop fails', async () => {
    const tools = stubbedTools();
    writeCloudBinding(root, 'ios', 'A');
    tools.stopCloud = vi.fn(async () => ({ ok: false, reason: 'refused' }));
    const release = await releaseStartedSessionAsync(root, 'A', 'test', tools);
    expect(release).toMatchObject({ outcome: 'failed' });
  });
});
