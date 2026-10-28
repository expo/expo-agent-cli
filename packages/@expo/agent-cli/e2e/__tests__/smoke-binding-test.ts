// These cases run the CLI and real configuration/binding readers. Device tools and the inspector
// are protocol doubles; successful evaluation proves selection and wiring, not Hermes behavior.
import fs from 'node:fs';
import path from 'node:path';

import { installStubEasAsync, writeCloudBindingAsync } from '../stubEas';
import { runtimeTarget } from '../runtimeTargetFixtures';
import { makeTarget } from '../../src/runtime/__tests__/targetSelectionFixtures';
import {
  executeAgentCliAsync,
  expoHomeOf,
  readStubExpoInvocations,
  setupFixtureAsync,
  startStubDevServerAsync,
} from '../utils';
import { bindingFixture, BOOTED_SIMULATOR, installStubXcrunAsync } from './installedAppStubs';

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

it.skipIf(process.platform !== 'darwin').each([
  {
    name: 'expired binding',
    expiresAt: '2000-01-01T00:00:00.000Z',
    ownBooted: true,
    selected: 'other',
  },
  {
    name: 'bound simulator that is not up',
    expiresAt: '2999-01-01T00:00:00.000Z',
    ownBooted: false,
    selected: null,
  },
  {
    name: 'development build on the live bound simulator beside another app',
    expiresAt: '2999-01-01T00:00:00.000Z',
    ownBooted: true,
    selected: 'own',
  },
])('smoke evaluates the selected app with $name', async ({ expiresAt, ownBooted, selected }) => {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  const own = { udid: 'SIM-OWN', name: 'agent-cli own', state: 'Booted' as const };
  const other = BOOTED_SIMULATOR;
  await installStubXcrunAsync(root, { simulators: ownBooted ? [own, other] : [other] });
  const file = await bindingFixture(root, own.udid, own.name);
  const binding = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  await fs.promises.writeFile(file, JSON.stringify({ ...binding, expiresAt }));
  const targets = [runtimeTarget('other', { deviceName: other.name, appId: 'host.exp.Exponent' })];
  if (selected === 'own') {
    targets.push(runtimeTarget('own', { deviceName: own.name, appId: 'dev.example.app' }));
  }
  const evaluated = new Set<string>();
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets,
    inspectorEvaluate: (_expression, device) => {
      evaluated.add(device);
      return 1;
    },
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      [
        'smoke',
        '--ios',
        '--dev-server-url',
        server.url,
        '--no-start',
        '--no-reload',
        '--no-screenshot',
        '--window',
        '100ms',
        '--timeout',
        '5s',
        '--json',
        '--no-followups',
      ],
      { reject: false, env: { AGENT_CLI_NO_DEVICE: '0' } }
    );
    const report = JSON.parse(result.stdout);
    if (selected == null) {
      // The binding is the scope whether or not its simulator is up: the other app is not read.
      expect(result.exitCode, result.all).toBe(22);
      expect(report.appsConnected).toBe(0);
      expect(report.phases).toContainEqual(
        expect.objectContaining({ id: 'app', status: 'inconclusive' })
      );
      expect([...evaluated]).toEqual([]);
      return;
    }
    expect(result.exitCode, result.all).toBe(0);
    expect(report.appsConnected).toBe(1);
    expect(report.phases).toContainEqual(expect.objectContaining({ id: 'runtime', status: 'ok' }));
    expect([...evaluated]).toEqual([selected]);
  } finally {
    await server.close();
  }
});
