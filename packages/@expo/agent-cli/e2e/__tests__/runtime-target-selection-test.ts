// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// Real CLI, bindings and HTTP; the inspector/device tools are protocol doubles.
import fs from 'node:fs';

import { bindOtherWorktreeAsync, runtimeTarget } from '../runtimeTargetFixtures';
import { installStubEasAsync, writeCloudBindingAsync } from '../stubEas';
import {
  executeAgentCliAsync,
  expoHomeOf,
  setupFixtureAsync,
  startStubDevServerAsync,
} from '../utils';
import { bindingFixture, BOOTED_SIMULATOR, installStubXcrunAsync } from './installedAppStubs';

async function besideOtherWorktreeAsync(bindingName: string = BOOTED_SIMULATOR.name) {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  await installStubXcrunAsync(root, { simulators: [BOOTED_SIMULATOR] });
  await fs.promises.rm(await bindingFixture(root, BOOTED_SIMULATOR.udid));
  const otherRoot = await bindOtherWorktreeAsync(root, BOOTED_SIMULATOR.udid, bindingName);
  const targets = [
    runtimeTarget('foreign', {
      deviceName: BOOTED_SIMULATOR.name,
      appId: 'host.exp.Exponent',
    }),
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

it('runtime:eval refuses with NO_APP_CONNECTED when only a foreign app is listed after the preflight', async () => {
  const { root, otherRoot, targets } = await besideOtherWorktreeAsync();
  const [foreign, own] = targets;
  let reads = 0;
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets: () => (reads++ === 0 ? [own!] : [foreign!]),
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      ['runtime:eval', '"1"', '--dev-server-url', server.url, '--json'],
      { reject: false }
    );
    expect(result.exitCode, result.all).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('NO_APP_CONNECTED');
    expect(result.stdout).toContain(otherRoot);
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
        {
          deviceName: BOOTED_SIMULATOR.name,
          group: 'other-worktree',
          projectRoots: [otherRoot],
        },
      ],
    });
  } finally {
    await server.close();
  }
});

// Which app `runtime:eval` reads when another worktree's simulator loads from this dev server.
// The stub `simctl` lists the booted simulators; the registry holds the other worktree's bindings.
describe('runtime:eval and the worktrees that bound the booted simulators', () => {
  const CLONE = 'agent-cli c4ed0a60';
  const clone = (state: 'Booted' | 'Shutdown' = 'Booted') => ({
    name: CLONE,
    state,
  });
  const FAR_FUTURE = '2999-01-01T00:00:00.000Z';
  const expired = '2000-01-01T00:00:00.000Z';
  type Foreign = { udid: string; expiresAt?: string; deleted?: boolean };

  it.each([
    {
      name: 'a simulator this worktree and another one both bind',
      sims: [{ udid: 'SIM-A', ...clone() }],
      own: 'SIM-A',
      foreign: [{ udid: 'SIM-A' }] as Foreign[],
      read: 'clone',
    },
    {
      name: 'one of two booted simulators with its name bound elsewhere',
      sims: [
        { udid: 'SIM-A', ...clone() },
        { udid: 'SIM-B', ...clone() },
      ],
      foreign: [{ udid: 'SIM-A' }] as Foreign[],
      read: 'clone',
    },
    {
      name: 'each booted simulator with its name bound elsewhere',
      sims: [
        { udid: 'SIM-A', ...clone() },
        { udid: 'SIM-B', ...clone() },
      ],
      foreign: [{ udid: 'SIM-A' }, { udid: 'SIM-B' }] as Foreign[],
      read: 'own',
      skipped: 2,
    },
    {
      name: 'no simulator with its name booted',
      sims: [{ udid: 'SIM-A', ...clone('Shutdown') }],
      foreign: [{ udid: 'SIM-A' }] as Foreign[],
      read: 'clone',
    },
    {
      name: 'a simulator whose other binding belongs to a deleted worktree',
      sims: [{ udid: 'SIM-A', ...clone() }],
      foreign: [{ udid: 'SIM-A', deleted: true }] as Foreign[],
      read: 'clone',
    },
    {
      name: 'a simulator whose other binding ran out, and renews no lease',
      sims: [{ udid: 'SIM-A', ...clone() }],
      own: 'SIM-OWN',
      foreign: [{ udid: 'SIM-A', expiresAt: expired }] as Foreign[],
      read: 'clone',
    },
  ])('reads the right app beside $name', async ({ sims, own, foreign, read, skipped = 0 }) => {
    const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
    await installStubXcrunAsync(root, {
      simulators: [
        ...sims,
        ...(own === 'SIM-OWN' ? [{ udid: own, name: 'Own', state: 'Booted' as const }] : []),
      ],
    });
    await fs.promises.rm(await bindingFixture(root, sims[0]!.udid));
    const ownFile = own
      ? await bindingFixture(root, own, own === 'SIM-OWN' ? 'Own' : CLONE, FAR_FUTURE)
      : null;
    const otherRoots: string[] = [];
    for (const { udid, expiresAt, deleted } of foreign) {
      const otherRoot = await bindOtherWorktreeAsync(root, udid, CLONE, expiresAt);
      if (deleted) await fs.promises.rm(otherRoot, { recursive: true });
      otherRoots.push(otherRoot);
    }
    const targets = [
      runtimeTarget('clone', {
        deviceName: CLONE,
        appId: 'host.exp.Exponent',
      }),
      ...(read === 'own'
        ? [
            runtimeTarget('own', {
              deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
            }),
          ]
        : []),
    ];
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
      expect(evaluated).toEqual([read]);
      if (skipped > 0) {
        for (const otherRoot of otherRoots) expect(result.stderr).toContain(otherRoot);
      } else {
        expect(result.stderr).not.toContain('other-worktree-');
      }
      if (ownFile) {
        expect(JSON.parse(await fs.promises.readFile(ownFile, 'utf8')).expiresAt).toBe(FAR_FUTURE);
      }
    } finally {
      await server.close();
    }
  });

  it('refuses with --ios when only another worktree has an app on the simulator', async () => {
    const { root, otherRoot } = await besideOtherWorktreeAsync();
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [runtimeTarget('foreign', { deviceName: BOOTED_SIMULATOR.name })],
      inspectorEvaluate: () => undefined,
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        ['runtime:eval', '1', '--ios', '--dev-server-url', server.url, '--json'],
        { reject: false }
      );
      expect(result.exitCode, result.all).toBe(1);
      const { error } = JSON.parse(result.stdout);
      expect(error.code).toBe('NO_APP_CONNECTED');
      expect(error.message).toContain(otherRoot);
    } finally {
      await server.close();
    }
  });

  it('runtime:reload reads only the app of its EAS Simulator session beside a foreign simulator', async () => {
    const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
    await installStubXcrunAsync(root, { simulators: [{ udid: 'SIM-A', ...clone() }] });
    await fs.promises.rm(await bindingFixture(root, 'SIM-A'));
    await installStubEasAsync(root);
    await writeCloudBindingAsync(expoHomeOf(root), root, { id: 'sess-e2e' });
    const otherRoot = await bindOtherWorktreeAsync(root, 'SIM-A', CLONE);
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [
        runtimeTarget('clone', { deviceName: CLONE, appId: 'dev.example.app' }),
        runtimeTarget('cloud', { deviceName: 'iPhone 17', appId: 'dev.example.app' }),
      ],
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        [
          'runtime:reload',
          '--ios',
          '--eas',
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
      expect(JSON.parse(result.stdout)).toMatchObject({
        reloaded: true,
        skippedApps: [{ deviceName: CLONE, group: 'other-worktree', projectRoots: [otherRoot] }],
      });
    } finally {
      await server.close();
    }
  });
});
