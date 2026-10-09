import fs from 'fs';
import { vol } from 'memfs';

import { clearInspectCache, inspectBindingCachedAsync } from '../inspect';
import { bindingPathFor } from '../registry';
import { readBindingSummaryAsync } from '../summary';
import { bindingFor, fakeTools, writeBinding } from './fakeTools';

const ROOT = '/work/app';
beforeEach(() => {
  clearInspectCache();
  vol.reset();
  vol.fromJSON({ [`${ROOT}/package.json`]: '{}' });
});

it('reports local and cloud bindings without renewing leases, reaping, or probing cloud', async () => {
  const tools = fakeTools({ simulators: [{ udid: 'SIM', name: 'sim', state: 'Booted' }] });
  const file = bindingPathFor(ROOT, 'ios', 'local-ios');
  const cloudFile = bindingPathFor(ROOT, 'android', 'cloud');
  writeBinding(file, bindingFor(ROOT, 'SIM'));
  writeBinding(cloudFile, {
    ...bindingFor(ROOT, 'unused'),
    expiresAt: '2999-01-01T00:00:00Z',
    device: { backend: 'cloud', platform: 'android', id: 'session', origin: 'started' },
  });
  const before = [fs.readFileSync(file, 'utf8'), fs.readFileSync(cloudFile, 'utf8')];
  await inspectBindingCachedAsync(ROOT, 'ios', 'local-ios', { tools });
  const binding = await readBindingSummaryAsync(ROOT);
  expect(binding).toEqual([
    {
      platform: 'ios',
      backend: 'local-ios',
      id: 'SIM',
      name: 'agent-cli 0000',
      origin: 'created',
      state: 'up',
      expiresAt: '2026-10-08T11:00:00.000Z',
    },
    {
      platform: 'android',
      backend: 'cloud',
      id: 'session',
      name: 'session',
      origin: 'started',
      state: 'recorded',
      expiresAt: '2999-01-01T00:00:00Z',
    },
  ]);
  expect(tools.calls).toHaveLength(1);
  expect([fs.readFileSync(file, 'utf8'), fs.readFileSync(cloudFile, 'utf8')]).toEqual(before);
});
