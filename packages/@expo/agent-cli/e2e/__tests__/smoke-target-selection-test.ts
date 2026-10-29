// @ref llp/0005-runtime-loop-tools.rfc.md §How it reloads
// Run the published command through real pipes and HTTP/WebSocket connections. The device tools
// and inspector protocol are doubles; this checks reload dispatch, not real Hermes behavior.
import fs from 'node:fs';
import path from 'node:path';

import { bindOtherWorktreeAsync, runtimeTarget } from '../runtimeTargetFixtures';
import { writeCloudBindingAsync } from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  setupFixtureAsync,
  startStubDevServerAsync,
} from '../utils';
import { bindingFixture, BOOTED_SIMULATOR, installStubXcrunAsync } from './installedAppStubs';

const CLONE = { udid: 'SIM-CLONE', name: 'agent-cli c4ed0a60', state: 'Booted' } as const;
const app = (id: string, deviceName: string) =>
  runtimeTarget(id, { deviceName, appId: 'host.exp.Exponent' });

// Both rows read a booted local simulator, which exists only on macOS.
it.skipIf(process.platform !== 'darwin').each([
  { name: "another worktree's app", cloud: false },
  { name: 'a local simulator (bound cloud session, no --eas)', cloud: true },
])('smoke reloads only its own app beside $name', async ({ cloud }) => {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  let targets;
  if (cloud) {
    // The session's app runs on a cloud model no local tool reports.
    await installStubXcrunAsync(root, { simulators: [BOOTED_SIMULATOR] });
    await fs.promises.rm(await bindingFixture(root, BOOTED_SIMULATOR.udid, BOOTED_SIMULATOR.name));
    await writeCloudBindingAsync(expoHomeOf(root), root, { id: 'session' });
    targets = [app('other', BOOTED_SIMULATOR.name), app('own', 'iPhone 17')];
  } else {
    // This worktree's app runs on its bound simulator; another worktree's clone loads from the port.
    await installStubXcrunAsync(root, { simulators: [BOOTED_SIMULATOR, CLONE] });
    await bindingFixture(root, BOOTED_SIMULATOR.udid, BOOTED_SIMULATOR.name);
    await bindOtherWorktreeAsync(root, CLONE.udid, CLONE.name);
    targets = [app('other', CLONE.name), app('own', BOOTED_SIMULATOR.name)];
  }
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets,
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
      { reject: false, env: { AGENT_CLI_NO_DEVICE: '0' } }
    );
    const report = JSON.parse(result.stdout);
    expect(report.reload).toMatchObject({
      disposition: 'reloaded',
      verifiedBy: 'debugger-context-replaced',
      targetOutcomes: [{ targetId: 'own', outcome: 'context-replaced', reason: null }],
    });
    expect(server.broadcasts()).toBe(0);
    expect(server.pageReloads()).toEqual(['own']);
  } finally {
    await server.close();
  }
});

// The skipped app is on iOS, so an Android bundle served after `Page.reload` is this app's proof.
it('smoke takes an Android bundle as proof when Page.reload kept the context beside an iOS app', async () => {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  await installStubXcrunAsync(root, { simulators: [BOOTED_SIMULATOR] });
  await fs.promises.rm(await bindingFixture(root, BOOTED_SIMULATOR.udid));
  await bindOtherWorktreeAsync(root, BOOTED_SIMULATOR.udid, BOOTED_SIMULATOR.name);
  const logPath = path.join(root, '.expo', 'dev', 'logs', 'dev-detached.log');
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
  await fs.promises.writeFile(logPath, 'Starting Metro Bundler\n');
  const targets = [
    app('other', BOOTED_SIMULATOR.name),
    runtimeTarget('own', {
      deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
      appId: 'host.exp.exponent',
    }),
  ];
  let bundled = false;
  let server: Awaited<ReturnType<typeof startStubDevServerAsync>> | undefined;
  server = await startStubDevServerAsync({
    projectRoot: root,
    targets: () => {
      if (!bundled && server?.pageReloads().length) {
        bundled = true;
        fs.appendFileSync(logPath, 'Android Bundled 25ms node_modules/expo-router/entry.js\n');
      }
      return targets;
    },
    pageReload: 'keeps-context',
    inspectorEvaluate: () => 1,
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      [
        'smoke',
        '--android',
        '--dev-server-url',
        server.url,
        '--no-start',
        '--no-screenshot',
        '--window',
        '100ms',
        '--timeout',
        '20s',
        '--json',
        '--no-followups',
      ],
      { reject: false }
    );
    const report = JSON.parse(result.stdout);
    expect(server.pageReloads(), result.all).toEqual(['own']);
    expect(server.broadcasts()).toBe(0);
    expect(report.reload).toMatchObject({
      disposition: 'reloaded',
      verifiedBy: 'dev-server-bundle',
      bundleServed: true,
      targetOutcomes: [{ targetId: 'own', outcome: 'delivered-unproved' }],
    });
  } finally {
    await server.close();
  }
});
