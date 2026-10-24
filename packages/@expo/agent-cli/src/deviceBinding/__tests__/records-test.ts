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
  const OTHER = '/work/other';
  const now = new Date('2026-10-08T10:00:00.000Z');

  it.each([
    { name: 'another worktree, live', root: OTHER, expiresAt: undefined, own: false },
    { name: 'this worktree, live', root: ROOT, expiresAt: undefined, own: true },
    {
      name: 'a lease that ran out, as a release leaves it',
      root: OTHER,
      expiresAt: now.toISOString(),
      own: null,
    },
    {
      name: 'a worktree whose root is deleted',
      root: '/work/deleted',
      expiresAt: undefined,
      own: null,
    },
  ])('$name', ({ root, expiresAt, own }) => {
    vol.fromJSON({ [`${ROOT}/package.json`]: '{}', [`${OTHER}/package.json`]: '{}' });
    writeBinding(
      bindingPathFor(root, 'ios', 'local-ios'),
      bindingFor(root, 'SIM-1', { name: 'iPhone 17 Pro', expiresAt })
    );

    expect(liveIosBindings(ROOT, now)).toEqual(
      own == null ? [] : [{ udid: 'SIM-1', name: 'iPhone 17 Pro', projectRoot: root, own }]
    );
  });
});
