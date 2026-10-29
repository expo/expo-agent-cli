import { vol } from 'memfs';

import { keptDevices, liveIosBindings } from '../records';
import { bindingPathFor } from '../registry';
import { PROGRAM_PREFIX } from '../../programName';
import { writeCloudBinding } from './fakeCloudBinding';
import { bindingFor, writeBinding } from './fakeTools';

const ROOT = '/work/app';

beforeEach(() => vol.reset());

it('reports a kept device with released null, not false', () => {
  writeBinding(bindingPathFor(ROOT, 'ios', 'local-ios'), bindingFor(ROOT, 'SIM-1'));

  expect(keptDevices(ROOT)).toEqual([
    expect.objectContaining({ id: 'SIM-1', released: null, shutDown: false, reason: null }),
  ]);
});

it('names the runnable stop command in the reason of a kept cloud session', () => {
  writeCloudBinding(ROOT, 'ios', 'sess-1');

  expect(keptDevices(ROOT)[0]!.reason).toContain(`use ${PROGRAM_PREFIX} dev:stop --eas`);
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
describe('a live iOS binding', () => {
  const now = new Date('2026-10-08T10:00:00.000Z');

  it('this worktree, live', () => {
    vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
    writeBinding(
      bindingPathFor(ROOT, 'ios', 'local-ios'),
      bindingFor(ROOT, 'SIM-1', { name: 'iPhone 17 Pro' })
    );

    expect(liveIosBindings(ROOT, now)).toEqual([
      { udid: 'SIM-1', name: 'iPhone 17 Pro', projectRoot: ROOT, own: true },
    ]);
  });
});
