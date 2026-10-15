import { vol } from 'memfs';

import { keptDevices } from '../records';
import { bindingPathFor } from '../registry';
import { bindingFor, writeBinding } from './fakeTools';

const ROOT = '/work/app';

beforeEach(() => vol.reset());

it('reports a kept device with released null, not false', () => {
  writeBinding(bindingPathFor(ROOT, 'ios', 'local-ios'), bindingFor(ROOT, 'SIM-1'));

  expect(keptDevices(ROOT)).toEqual([
    expect.objectContaining({ id: 'SIM-1', released: null, shutDown: false, reason: null }),
  ]);
});
