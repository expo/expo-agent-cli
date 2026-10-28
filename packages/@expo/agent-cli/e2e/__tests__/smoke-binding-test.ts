// These cases run the CLI and real configuration/binding readers. Device tools and the inspector
// are protocol doubles; successful evaluation proves selection and wiring, not Hermes behavior.
import fs from 'node:fs';
import path from 'node:path';

import { installStubEasAsync, writeCloudBindingAsync } from '../stubEas';
import { makeTarget } from '../../src/runtime/__tests__/targetSelectionFixtures';
import {
  executeAgentCliAsync,
  expoHomeOf,
  readStubExpoInvocations,
  setupFixtureAsync,
  startStubDevServerAsync,
} from '../utils';
import { installStubXcrunAsync } from './installedAppStubs';

it('smoke evaluates the cloud app selected by deviceBackend config without --eas', async () => {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  const file = path.join(root, 'package.json');
  const pkg = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  pkg.expo = { ...pkg.expo, 'agent-cli': { deviceBackend: 'eas' } };
  await fs.promises.writeFile(file, JSON.stringify(pkg));
  await installStubXcrunAsync(root, { simulators: [] });
  await installStubEasAsync(root);
  await writeCloudBindingAsync(expoHomeOf(root), root, { id: 'sess-e2e' });
  const ready = path.join(root, '.expo-started');
  const expoBin = path.join(root, 'node_modules/expo/bin/cli');
  const original = await fs.promises.readFile(expoBin, 'utf8');
  await fs.promises.writeFile(
    expoBin,
    original.replace(
      '#!/usr/bin/env node',
      `#!/usr/bin/env node
if (process.argv[2] === 'start') require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`
    )
  );
  const server = await startStubDevServerAsync({
    projectRoot: root,
    readyWithFile: ready,
    targets: [
      makeTarget({
        id: 'cloud',
        deviceName: 'iPhone 17',
        reactNative: { capabilities: { nativePageReloads: true }, logicalDeviceId: 'cloud' },
      }),
    ],
    inspectorEvaluate: () => 1,
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      [
        'smoke',
        '--ios',
        '--dev-server-url',
        server.url,
        '--no-reload',
        '--no-screenshot',
        '--window',
        '100ms',
        '--timeout',
        '5s',
        '--json',
        '--no-followups',
      ],
      {
        reject: false,
        env: {
          STUB_EXPO_DELAY_MS: '30000',
          STUB_EXPO_TUNNEL_HOST: 'stub-tunnel.example',
          STUB_EXPO_DEV_SERVER_PORT: String(server.port),
        },
      }
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(readStubExpoInvocations(root).find(({ args }) => args[0] === 'start')?.args).toContain(
      '--tunnel'
    );
    const report = JSON.parse(result.stdout);
    expect(report.started, result.all).toBe(true);
    expect(report.runtimeSupported).toBe(true);
    expect(report.phases).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'runtime', status: 'ok' })])
    );
  } finally {
    await executeAgentCliAsync(root, ['dev:stop', '--json'], { reject: false });
    await server.close();
  }
});
