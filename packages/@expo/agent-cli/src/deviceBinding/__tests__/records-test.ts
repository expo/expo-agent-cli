import { vol } from 'memfs';

import { keptDevices } from '../records';
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
