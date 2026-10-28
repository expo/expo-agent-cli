// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// Real CLI, bindings and HTTP; the inspector/device tools are protocol doubles.
import fs from 'node:fs';

import { bindOtherWorktreeAsync, runtimeTarget } from '../runtimeTargetFixtures';
import { executeAgentCliAsync, setupFixtureAsync, startStubDevServerAsync } from '../utils';
import { bindingFixture, BOOTED_SIMULATOR, installStubXcrunAsync } from './installedAppStubs';

async function besideOtherWorktreeAsync(bindingName: string = BOOTED_SIMULATOR.name) {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  await installStubXcrunAsync(root, { simulators: [BOOTED_SIMULATOR] });
  await fs.promises.rm(await bindingFixture(root, BOOTED_SIMULATOR.udid));
  const otherRoot = await bindOtherWorktreeAsync(root, BOOTED_SIMULATOR.udid, bindingName);
  const targets = [
    runtimeTarget('foreign', { deviceName: BOOTED_SIMULATOR.name, appId: 'host.exp.Exponent' }),
    runtimeTarget('own', {
      deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
      appId: 'host.exp.exponent',
    }),
  ];
  return { root, otherRoot, targets };
}

it('runtime:eval skips a renamed foreign simulator and names its worktree', async () => {
  const { root, otherRoot, targets } = await besideOtherWorktreeAsync('Previous simulator name');
  const evaluated: string[] = [];
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets,
    inspectorEvaluate: (expression, device) => {
      if (!expression.includes('selected-app-sentinel')) return undefined;
      evaluated.push(device);
      return device;
    },
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      ['runtime:eval', '"selected-app-sentinel"', '--dev-server-url', server.url, '--json'],
      { reject: false }
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout).value).toBe('own');
    expect(evaluated).toEqual(['own']);
    expect(result.stderr).toContain(otherRoot);
    expect(result.stderr).toContain(BOOTED_SIMULATOR.name);
  } finally {
    await server.close();
  }
});

it('runtime:reload checks only its own Android bundle beside a foreign iOS app', async () => {
  const { root, otherRoot, targets } = await besideOtherWorktreeAsync();
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets,
    messagePeers: { android: 'role=android' },
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      [
        'runtime:reload',
        '--dev-server-url',
        server.url,
        '--method',
        'dev-server',
        '--timeout',
        '2s',
        '--json',
        '--no-followups',
      ],
      { reject: false }
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(server.bundlePlatforms()).toEqual(['android']);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reloaded: true,
      bundlePlatforms: ['android'],
      bundlePlatformSource: 'connected-app',
      skippedApps: [
        { deviceName: BOOTED_SIMULATOR.name, group: 'other-worktree', projectRoots: [otherRoot] },
      ],
    });
  } finally {
    await server.close();
  }
});
