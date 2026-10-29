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
import {
  bindingFixture,
  BOOTED_SIMULATOR,
  installStubAdbAsync,
  installStubXcrunAsync,
} from './installedAppStubs';

const RELOAD_FLAGS = ['--timeout', '2s', '--json', '--no-followups'];

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

it.each([
  ['runtime:eval', '"1"'],
  ['runtime:errors', '--duration', '100ms'],
])(
  '%s refuses with NO_APP_CONNECTED when only a foreign app is listed after the preflight',
  async (...args) => {
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
        [...args, '--dev-server-url', server.url, '--json'],
        { reject: false }
      );
      expect(result.exitCode, result.all).toBe(1);
      const { error } = JSON.parse(result.stdout);
      expect(error.code).toBe('NO_APP_CONNECTED');
      // Read from the parsed message: JSON escapes a Windows path's backslashes.
      expect(error.message).toContain(otherRoot);
    } finally {
      await server.close();
    }
  }
);

it.each([[[]], [['--android']]])(
  'runtime:eval %j refuses like the preflight when the list is empty after the preflight',
  async (flags) => {
    const { root, targets } = await besideOtherWorktreeAsync();
    const own = targets[1]!;
    let reads = 0;
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: () => (reads++ === 0 ? [own] : []),
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        ['runtime:eval', '"1"', ...flags, '--dev-server-url', server.url, '--json'],
        { reject: false }
      );
      expect(result.exitCode, result.all).toBe(22);
      expect(JSON.parse(result.stdout).error.code).toBe('NO_APP_CONNECTED');
      expect(result.stdout).toContain('no app is connected to it');
    } finally {
      await server.close();
    }
  }
);

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
      ['runtime:reload', '--dev-server-url', server.url, '--method', 'dev-server', ...RELOAD_FLAGS],
      { reject: false }
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(server.bundlePlatforms()).toEqual(['android']);
    expect(server.broadcasts()).toBe(0);
    expect(server.pageReloads()).toEqual(['own']);
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

it('runtime:reload selects its bound cloud platform without a platform flag', async () => {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  await installStubXcrunAsync(root, { simulators: [BOOTED_SIMULATOR] });
  await fs.promises.rm(await bindingFixture(root, BOOTED_SIMULATOR.udid));
  await writeCloudBindingAsync(expoHomeOf(root), root, { id: '01a15bf1', platform: 'android' });
  // No local emulator, whatever the host has attached: one of this model would claim the cloud app.
  const adb = await installStubAdbAsync(root, 'host.exp.exponent', {
    attached: false,
    bound: false,
  });
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets: [
      runtimeTarget('local', { deviceName: BOOTED_SIMULATOR.name, appId: 'host.exp.Exponent' }),
      runtimeTarget('cloud', { deviceName: 'sdk_gphone64_arm64 - 15 - API 35' }),
    ],
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
      { reject: false, env: { ...adb.env, AGENT_CLI_NO_DEVICE: '0' } }
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(server.bundlePlatforms()).toEqual(['android']);
    expect(server.broadcasts()).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      reloaded: true,
      bundlePlatforms: ['android'],
      bundlePlatformSource: 'bound-device',
    });
    expect(report.scope).toEqual({
      platform: 'android',
      platformFrom: 'bound-device',
      bound: true,
      device: { backend: 'cloud', id: '01a15bf1', name: null },
    });
    expect(report).not.toHaveProperty('targetSelection');
  } finally {
    await server.close();
  }
});

// This worktree's simulator and another worktree's clone simulator are both booted, and both load
// from this dev server. The clone's app is skipped: nothing is sent to it and nothing it does proves
// this reload (llp/0005 §What proves a reload).
describe("runtime:reload beside another worktree's iOS app", () => {
  const BOUND = { AGENT_CLI_NO_DEVICE: '0' };
  const CLONE = {
    udid: 'SIM-CLONE',
    name: 'agent-cli c4ed0a60',
    state: 'Booted',
  } as const;
  const ownIos = () =>
    runtimeTarget('own', {
      deviceName: BOOTED_SIMULATOR.name,
      appId: 'host.exp.Exponent',
    });
  const cloneIos = () =>
    runtimeTarget('clone', {
      deviceName: CLONE.name,
      appId: 'host.exp.Exponent',
    });

  async function besideCloneAsync() {
    const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
    const { calls } = await installStubXcrunAsync(root, {
      simulators: [BOOTED_SIMULATOR, CLONE],
    });
    await bindOtherWorktreeAsync(root, CLONE.udid, CLONE.name);
    return { root, xcrunCalls: calls };
  }

  it.each([
    { pageReload: 'replaces-context' as const, reloaded: true },
    { pageReload: 'keeps-context' as const, reloaded: false },
  ])(
    'sends Page.reload to its own app only, and a page of the skipped app proves nothing ($pageReload)',
    async ({ pageReload, reloaded }) => {
      const { root } = await besideCloneAsync();
      const server = await startStubDevServerAsync({
        projectRoot: root,
        targets: [ownIos(), cloneIos()],
        pageReload,
      });
      try {
        const result = await executeAgentCliAsync(
          root,
          [
            'runtime:reload',
            '--ios',
            '--dev-server-url',
            server.url,
            '--method',
            'dev-server',
            ...RELOAD_FLAGS,
          ],
          { reject: false, env: BOUND }
        );
        expect(server.broadcasts(), result.all).toBe(0);
        expect(server.pageReloads()).toEqual(['own']);
        expect(JSON.parse(result.stdout)).toMatchObject({
          reloaded,
          ...(reloaded ? {} : { appsReconnected: 0 }),
        });
        if (!reloaded) {
          expect(result.stderr).toContain('nothing could prove the reload and nothing was watched');
        }
      } finally {
        await server.close();
      }
    }
  );

  it('sends no Page.reload when its own app cannot keep the marker', async () => {
    const { root } = await besideCloneAsync();
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [ownIos(), cloneIos()],
      inspectorSocket: 'no-debugger',
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        [
          'runtime:reload',
          '--ios',
          '--dev-server-url',
          server.url,
          '--method',
          'dev-server',
          ...RELOAD_FLAGS,
        ],
        { reject: false, env: BOUND }
      );
      expect(server.pageReloads()).toEqual([]);
      expect(server.broadcasts()).toBe(0);
      expect(result.stderr).toContain('so none was sent');
      expect(result.stderr).toContain('runtime:reload --method device');
      expect(result.stderr).not.toContain('could not reach');
    } finally {
      await server.close();
    }
  });

  // The clone runs on a booted local simulator, which exists only on macOS.
  it.skipIf(process.platform !== 'darwin')(
    'reads the target list again after the bundle gate, and does not broadcast to a new app',
    async () => {
      const { root } = await besideCloneAsync();
      const elsewhere = runtimeTarget('far', { deviceName: 'Ada’s phone' });
      let server: Awaited<ReturnType<typeof startStubDevServerAsync>> | undefined;
      server = await startStubDevServerAsync({
        projectRoot: root,
        targets: () => (server?.bundlePlatforms().length ? [ownIos(), elsewhere] : [ownIos()]),
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
            ...RELOAD_FLAGS,
          ],
          { reject: false, env: BOUND }
        );
        expect(server.bundlePlatforms(), result.all).not.toEqual([]);
        expect(server.broadcasts()).toBe(0);
      } finally {
        await server.close();
      }
    }
  );

  it('relaunches its own app on its own simulator when the dev server reaches none', async () => {
    const { root, xcrunCalls } = await besideCloneAsync();
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [ownIos(), cloneIos()],
      messagePeers: {},
      inspectorSocket: 'none',
    });
    try {
      const result = await executeAgentCliAsync(
        root,
        [
          'runtime:reload',
          '--ios',
          '--dev-server-url',
          server.url,
          '--timeout',
          '2s',
          '--no-followups',
        ],
        { reject: false, env: BOUND }
      );
      const terminated = xcrunCalls().filter((call) => call[1] === 'terminate');
      expect(terminated, result.all).toEqual([
        ['simctl', 'terminate', BOOTED_SIMULATOR.udid, 'host.exp.Exponent'],
      ]);
      expect(result.stdout).toContain('via stopping the app on the device and opening it again');
    } finally {
      await server.close();
    }
  });

  it('relaunches within --timeout when its own app keeps its context after Page.reload', async () => {
    const { root, xcrunCalls } = await besideCloneAsync();
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [ownIos(), cloneIos()],
      pageReload: 'keeps-context',
    });
    try {
      const started = Date.now();
      const result = await executeAgentCliAsync(
        root,
        [
          'runtime:reload',
          '--dev-server-url',
          server.url,
          '--timeout',
          '30s',
          '--json',
          '--no-followups',
        ],
        { reject: false, env: BOUND }
      );
      expect(Date.now() - started, result.all).toBeLessThan(20_000);
      expect(server.pageReloads()).toEqual(['own']);
      const report = JSON.parse(result.stdout);
      expect(report.attempts.map((attempt: { method: string }) => attempt.method)).toEqual([
        'page-reload',
        'device',
      ]);
      expect(report.attempts[0].outcomes).toMatchObject([
        { targetId: 'own', outcome: 'delivered-unproved' },
      ]);
      expect(xcrunCalls().filter((call) => call[1] === 'terminate')).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('does not wait out --timeout after a relaunch that nothing can prove', async () => {
    const { root } = await besideCloneAsync();
    const server = await startStubDevServerAsync({
      projectRoot: root,
      targets: [ownIos(), cloneIos()],
      messagePeers: {},
      inspectorSocket: 'none',
    });
    try {
      const started = Date.now();
      const result = await executeAgentCliAsync(
        root,
        [
          'runtime:reload',
          '--ios',
          '--dev-server-url',
          server.url,
          '--timeout',
          '20s',
          '--json',
          '--no-followups',
        ],
        { reject: false, env: BOUND }
      );
      expect(Date.now() - started, result.all).toBeLessThan(10_000);
      expect(result.exitCode).toBe(22);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ reloaded: true, verifiedBy: 'app-relaunch' });
      expect(report.bundlesAfterReload.reason).toContain('keeps its page id');
      expect(result.stderr).toContain('a relaunched app registers again under the page id it had');
      expect(result.stderr).not.toContain('the runtime that answers now is the one from before');
    } finally {
      await server.close();
    }
  });
});

it("runtime:reload does not take another platform's churn as its proof", async () => {
  const root = await fs.promises.realpath(await setupFixtureAsync('go-app'));
  const server = await startStubDevServerAsync({
    projectRoot: root,
    targets: [
      runtimeTarget('go-ios', {
        deviceName: 'iPhone 17',
        appId: 'host.exp.Exponent',
      }),
      runtimeTarget('go-android', {
        deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
        appId: 'host.exp.exponent',
      }),
    ],
    messagePeers: { 'socket#1': 'role=ios', 'socket#2': 'role=ios' },
    reloadTargets: 'stale',
  });
  try {
    const result = await executeAgentCliAsync(
      root,
      [
        'runtime:reload',
        '--ios',
        '--dev-server-url',
        server.url,
        '--method',
        'dev-server',
        ...RELOAD_FLAGS,
      ],
      { reject: false }
    );
    const report = JSON.parse(result.stdout);
    expect(report.reloaded, result.all).toBe(false);
    expect(report.attempts[0].reason).toContain("outside this run's scope");
    expect(result.stderr).not.toContain('--eas');
    expect(result.stderr).not.toContain('tunnel');
  } finally {
    await server.close();
  }
});
