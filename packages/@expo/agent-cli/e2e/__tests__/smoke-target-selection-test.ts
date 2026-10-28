// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
// Run the published command through real pipes and HTTP/WebSocket connections. The device tools
// and inspector protocol are doubles; this checks reload dispatch, not real Hermes behavior.
import fs from 'node:fs';
import path from 'node:path';

import { digestOf } from '../../src/devLock/address';
import { makeTarget } from '../../src/runtime/__tests__/targetSelectionFixtures';
import { writeCloudBindingAsync } from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  setupFixtureAsync,
  startStubDevServerAsync,
} from '../utils';
import { bindingFixture, BOOTED_SIMULATOR, installStubXcrunAsync } from './installedAppStubs';

it.each([
  { name: "another worktree's app", cloud: false },
  { name: 'a local simulator (bound cloud session, no --eas)', cloud: true },
])('smoke reloads only its own app beside $name', async ({ cloud }) => {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  await installStubXcrunAsync(root, { simulators: [BOOTED_SIMULATOR] });
  const localFile = await bindingFixture(root, BOOTED_SIMULATOR.udid, BOOTED_SIMULATOR.name);
  if (cloud) {
    await fs.promises.rm(localFile);
    await writeCloudBindingAsync(expoHomeOf(root), root, { id: 'session' });
  } else {
    const otherRoot = await fs.promises.mkdtemp(path.join(root, 'other-worktree-'));
    const binding = JSON.parse(await fs.promises.readFile(localFile, 'utf8'));
    binding.projectRoot = otherRoot;
    await fs.promises.rm(localFile);
    await fs.promises.writeFile(
      path.join(path.dirname(localFile), `${digestOf(otherRoot)}-ios-local-ios.json`),
      JSON.stringify(binding)
    );
  }
  const target = (id: string, deviceName: string) =>
    makeTarget({
      id,
      deviceName,
      appId: 'host.exp.Exponent',
      webSocketDebuggerUrl: `ws://127.0.0.1:1/inspector/debug?device=${id}&page=1`,
      reactNative: { capabilities: { nativePageReloads: true }, logicalDeviceId: id },
    });
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets: [target('other', BOOTED_SIMULATOR.name), target('own', 'iPhone 17')],
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
        '--no-start',
        '--no-screenshot',
        '--window',
        '100ms',
        '--timeout',
        '5s',
        '--json',
        '--no-followups',
      ],
      { reject: false }
    );
    const report = JSON.parse(result.stdout);
    expect(report.reload).toMatchObject({
      disposition: 'reloaded',
      verifiedBy: 'debugger-context-replaced',
      targetOutcomes: [
        { targetId: 'own', deviceName: 'iPhone 17', outcome: 'context-replaced', reason: null },
      ],
    });
    expect(server.broadcasts()).toBe(0);
    expect(server.pageReloads()).toEqual(['own']);
  } finally {
    await server.close();
  }
});
