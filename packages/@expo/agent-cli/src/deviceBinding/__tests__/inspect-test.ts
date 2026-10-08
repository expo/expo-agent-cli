// @ref llp/0031-ios-binding.plan.md §Tests
import { vol } from 'memfs';

import { inspectBindingAsync, useBoundDeviceAsync } from '../inspect';
import { bindingPathFor, readBindingFile } from '../registry';
import { bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';
const file = () => bindingPathFor(ROOT, 'ios', 'local-ios');

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
});

describe(inspectBindingAsync, () => {
  // inspect-state-order: the first row that matches wins, in the order of the table.
  it.each([
    ['none', {}, { state: 'none' }],
    ['unreadable', { text: '{' }, { state: 'unreadable' }],
    [
      'unknown from the tool',
      { bind: 'SIM-1', spawnError: true },
      { state: 'unknown', cause: 'tool' },
    ],
    [
      'unknown from a timeout',
      { bind: 'SIM-1', listTimesOut: true },
      { state: 'unknown', cause: 'timeout' },
    ],
    [
      'gone when expired, even with the device up',
      { bind: 'SIM-1', expired: true, listed: 'Booted' },
      { state: 'gone', cause: 'expired' },
    ],
    ['up', { bind: 'SIM-1', listed: 'Booted' }, { state: 'up' }],
    ['not-up', { bind: 'SIM-1', listed: 'Shutdown' }, { state: 'not-up' }],
    ['gone when not listed', { bind: 'SIM-1' }, { state: 'gone', cause: 'device-gone' }],
  ] as const)('reports %s', async (_name, setup, expected) => {
    const tools = fakeTools({
      simulators: 'listed' in setup ? [{ udid: 'SIM-1', name: 'x', state: setup.listed }] : [],
      spawnError: 'spawnError' in setup,
      listTimesOut: 'listTimesOut' in setup,
    });
    if ('text' in setup) {
      vol.fromJSON({ [file()]: setup.text });
    } else if ('bind' in setup) {
      writeBinding(
        file(),
        bindingFor(ROOT, setup.bind, {
          expiresAt: 'expired' in setup ? '2026-10-08T09:59:59.000Z' : undefined,
        })
      );
    }

    expect(await inspectBindingAsync(ROOT, 'ios', 'local-ios', tools)).toMatchObject(expected);
  });

  // read-verb-one-subprocess-per-binding
  it('spawns one subprocess for a binding and none without one', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }] });

    await inspectBindingAsync(ROOT, 'ios', 'local-ios', tools);
    expect(tools.calls).toEqual([]);

    writeBinding(file(), bindingFor(ROOT, 'SIM-1'));
    await inspectBindingAsync(ROOT, 'ios', 'local-ios', tools);
    expect(tools.calls).toEqual([['list', 'devices', '-j']]);
  });

  it('reports a cloud binding as recorded without a subprocess', async () => {
    const tools = fakeTools();
    writeBinding(bindingPathFor(ROOT, 'ios', 'cloud'), {
      ...bindingFor(ROOT, 'unused'),
      device: { backend: 'cloud', platform: 'ios', id: 'session-1', origin: 'started' },
    });

    expect(await inspectBindingAsync(ROOT, 'ios', 'cloud', tools)).toMatchObject({
      state: 'recorded',
    });
    expect(tools.calls).toEqual([]);
  });
});

describe(useBoundDeviceAsync, () => {
  it('extends a live lease and returns the device', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }] });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1', { expiresAt: '2026-10-08T10:30:00.000Z' }));
    const inspection = await inspectBindingAsync(ROOT, 'ios', 'local-ios', tools);

    const device = await useBoundDeviceAsync(inspection, tools);

    expect(device).toMatchObject({ udid: 'SIM-1' });
    const read = readBindingFile(file());
    expect(read.kind === 'binding' && read.binding.expiresAt).toBe('2026-10-08T11:00:00.000Z');
  });

  // expired-is-gone
  it('throws gone when the lease expired since the inspect', async () => {
    const tools = fakeTools({ simulators: [{ udid: 'SIM-1', name: 'x', state: 'Booted' }] });
    writeBinding(file(), bindingFor(ROOT, 'SIM-1', { expiresAt: '2026-10-08T10:00:01.000Z' }));
    const inspection = await inspectBindingAsync(ROOT, 'ios', 'local-ios', tools);
    tools.clock.now = new Date('2026-10-08T10:00:02.000Z');

    const error = await useBoundDeviceAsync(inspection, tools).catch((e) => e);

    expect(error.code).toBe('NO_BOUND_DEVICE');
    expect(error.data).toEqual({ reason: 'gone' });
    expect(error.message).toContain('lease');
    expect(tools.calls).toEqual([['list', 'devices', '-j']]);
  });
});
