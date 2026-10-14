import { vol } from 'memfs';

import { deviceCommand } from '../errors';
import { EXTEND_EVERY_MS, LEASE_MS } from '../lease';
import { withLeaseExtendedAsync } from '../renew';
import { bindingPathFor, readBindingFile } from '../registry';
import { bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';
const file = () => bindingPathFor(ROOT, 'ios', 'local-ios');

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
});
afterEach(() => vi.useRealTimers());

it('timer picks up late cloud files, warns lost once, and resumes revived files', async () => {
  vi.useFakeTimers();
  const tools = fakeTools();
  const warn = vi.fn();
  let finish!: () => void;
  const work = withLeaseExtendedAsync(
    ROOT,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    { tools, warn }
  );
  const cloudFile = bindingPathFor(ROOT, 'android', 'cloud');
  const cloud = {
    ...bindingFor(ROOT, 'unused'),
    device: {
      backend: 'cloud' as const,
      platform: 'android' as const,
      id: 'session',
      origin: 'started' as const,
    },
  };
  writeBinding(cloudFile, cloud);
  tools.clock.now = new Date(tools.now().getTime() + EXTEND_EVERY_MS);
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  expect(readBindingFile(cloudFile)).toMatchObject({
    binding: { expiresAt: new Date(tools.now().getTime() + LEASE_MS).toISOString() },
  });
  tools.clock.now = new Date(tools.now().getTime() + LEASE_MS + 1);
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS * 2);
  expect(warn).toHaveBeenCalledTimes(1);
  writeBinding(cloudFile, {
    ...cloud,
    expiresAt: new Date(tools.now().getTime() + LEASE_MS).toISOString(),
  });
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  tools.clock.now = new Date(tools.now().getTime() + LEASE_MS + 1);
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  expect(warn).toHaveBeenCalledTimes(2);
  finish();
  await work;
  expect(vi.getTimerCount()).toBe(0);
});

it('foreground-exit-touches-no-binding', async () => {
  const binding = bindingFor(ROOT, 'OLD');
  writeBinding(file(), binding);
  await withLeaseExtendedAsync(ROOT, async () => {}, { tools: fakeTools() });
  expect(readBindingFile(file())).toEqual({ kind: 'binding', binding });
});

it('a lost lease names the dev command, with --eas for a cloud file', async () => {
  vi.useFakeTimers();
  const tools = fakeTools();
  const warn = vi.fn();
  writeBinding(file(), bindingFor(ROOT, 'SIM'));
  writeBinding(bindingPathFor(ROOT, 'android', 'cloud'), {
    ...bindingFor(ROOT, 'unused'),
    device: { backend: 'cloud', platform: 'android', id: 'session', origin: 'started' },
  });
  let finish!: () => void;
  const work = withLeaseExtendedAsync(
    ROOT,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    { tools, warn }
  );
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  tools.clock.now = new Date(tools.now().getTime() + LEASE_MS + 1);
  await vi.advanceTimersByTimeAsync(EXTEND_EVERY_MS);
  finish();
  await work;
  expect(warn.mock.calls.map(([message]) => message)).toEqual([
    expect.stringContaining(`"${deviceCommand('ios')}"`),
    expect.stringContaining('dev --android --eas --detach --wait-ready'),
  ]);
});
