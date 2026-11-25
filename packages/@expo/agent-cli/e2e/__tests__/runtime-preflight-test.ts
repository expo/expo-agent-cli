// @ref llp/0005-runtime-loop-tools.rfc.md §One preflight for the runtime family
// @ref llp/0010-agent-conventions.rfc.md §Exit codes
//
// The whole `runtime:*` family against the three states a driving agent actually hits: no dev
// server, a dev server with no app, and a dev server with an app on it. Every other suite in this
// tier tests one command; this one tests that they **agree**, which is the property a family has and
// a set of six commands does not.
//
// The middle state is the one that was inconsistent. `runtime:tree` asked its bundle gate first, so
// with no app connected it answered `20` when the project did not compile and `1` when it did — one
// situation, two bands, decided by a fact about the *code* rather than about the connection. It also
// spent up to twenty seconds of the gate's budget before saying what it knew in a millisecond.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { digestOf } from '../../src/devLock/address';
import { hostPlatform } from '../../src/smoke/suggest';
import { canonicalizeExistingPath } from '../../src/utils/dir';
import { appRuntime, expoGoRuntimeTarget } from '../runtimeTargetFixtures';
import {
  executeAgentCliAsync,
  expoHomeOf,
  holdLockForAsync,
  installStubBinAsync,
  setupFixtureAsync,
  startStubDevServerAsync,
  stubExpoEnv,
  type StubDevServer,
} from '../utils';
import {
  appStartedMarkerPath,
  installStubXcrunAsync as installStatefulXcrunAsync,
} from './installedAppStubs';

/** A port nothing listens on, for the "no dev server" state. */
const DEAD_URL = 'http://127.0.0.1:1';

/**
 * A debugger target the default selector will consider.
 *
 * `reactNative.capabilities.nativePageReloads` is the gate: a fixture without it is not a connected
 * app, it is a page no runtime command would ever talk to (`createDefaultTargetSelector`).
 */
const EXPO_GO_TARGET = {
  id: '1',
  appId: 'host.exp.Exponent',
  title: 'React Native Experimental (Improved Chrome Reloads)',
  description: 'host.exp.Exponent',
  type: 'node',
  devtoolsFrontendUrl: '',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
  deviceName: 'iPhone 17 Pro',
  reactNative: { capabilities: { nativePageReloads: true }, logicalDeviceId: 'device-1' },
};

/** Every command whose whole job needs a JavaScript runtime to read or drive. */
const NEEDS_AN_APP: [name: string, argv: string[]][] = [
  ['runtime:eval', ['runtime:eval', '1 + 1']],
  ['runtime:errors', ['runtime:errors', '--duration', '100ms']],
  ['runtime:tree', ['runtime:tree']],
  ['runtime:tap', ['runtime:tap', 'add-note']],
  ['runtime:type', ['runtime:type', 'hello', '--testID', 'note-input']],
];

let projectRoot: string;
beforeAll(async () => {
  projectRoot = await setupFixtureAsync('go-app');
});

/** Run one of the family against a dev server, with `--json` so the envelope is readable. */
async function runAsync(argv: string[], devServerUrl: string) {
  return await executeAgentCliAsync(
    projectRoot,
    [...argv, '--dev-server-url', devServerUrl, '--json'],
    { reject: false, env: stubExpoEnv(projectRoot) }
  );
}

describe('no dev server is running', () => {
  it.each(NEEDS_AN_APP)(`%s exits 1 with NO_DEV_SERVER and the ladder out`, async (_name, argv) => {
    const result = await runAsync(argv, DEAD_URL);

    // A tool error, not an outcome: nothing was attempted, so there is nothing about the subject to
    // report (llp/0010 §Exit codes).
    expect(result.exitCode).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe('NO_DEV_SERVER');
    // One ladder, in one order: start the dev server, then open the app.
    expect(error.message).toContain(DEAD_URL);
    expect(error.message).toContain('npx @expo/agent-cli dev --detach');
    expect(error.message).toContain('npx @expo/agent-cli navigate /');
    expect(error.suggestedCommand).toBe(
      `npx @expo/agent-cli dev --detach --${process.platform === 'darwin' ? 'ios' : 'android'}`
    );
    // And the counts the refusal observed, so an agent branches on numbers (llp/0010 §The `--json`
    // error envelope).
    expect(error.data).toEqual({
      devServerUrl: DEAD_URL,
      devServerReachable: false,
      debuggerTargets: 0,
      commandSocketClients: null,
      platform: null,
    });
  });

  // `runtime:reload` is in the same state for the same reason, and its own: a reload makes the app
  // fetch the served bundle again, so with no dev server that fetch has nowhere to go.
  it('runtime:reload exits 1 with NO_DEV_SERVER', async () => {
    const result = await runAsync(['runtime:reload'], DEAD_URL);

    expect(result.exitCode).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe('NO_DEV_SERVER');
    expect(error.message).toContain('nothing to reload the app onto');
    expect(error.data.devServerReachable).toBe(false);
  });

  // @ref llp/0005 §Cloud simulator — the F5x/S5 rule. A caller who passed
  // `--eas` is on a machine whose device is elsewhere: a suggestion without the flag sends them
  // to a simulator they have not got, and one without `--tunnel` starts a dev server the session
  // cannot reach.
  it('keeps --eas and --tunnel in the ladder when the caller passed --eas', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['runtime:reload', '--eas', '--dev-server-url', DEAD_URL, '--json'],
      { reject: false, env: stubExpoEnv(projectRoot) }
    );

    const { error } = JSON.parse(result.stdout);
    expect(error.message).toContain('npx @expo/agent-cli dev --detach --tunnel');
    expect(error.message).toContain(
      `npx @expo/agent-cli navigate / --${process.platform === 'darwin' ? 'ios' : 'android'} --eas`
    );
  });
});

describe('a dev server with no app connected', () => {
  let stub: StubDevServer;
  beforeAll(async () => {
    stub = await startStubDevServerAsync({ targets: [] });
  });
  afterAll(async () => {
    await stub.close();
  });

  it.each(NEEDS_AN_APP)(
    // 22 rather than 1, and the same 22 for all five: an empty target list is the one refusal of
    // this family a second look can disagree with, because a reloading app is absent from it for
    // about half a second (F141). The wait is inside the preflight, so the code says "asked for as
    // long as it was worth asking" rather than "asked once".
    `%s exits 22 with NO_APP_CONNECTED and names the command that opens one`,
    async (_name, argv) => {
      const result = await runAsync(argv, stub.url);

      expect(result.exitCode).toBe(22);
      const { error } = JSON.parse(result.stdout);
      expect(error.code).toBe('NO_APP_CONNECTED');
      // Which list is empty, and on which dev server.
      expect(error.message).toContain(`${stub.url}/json/list`);
      expect(error.message).toContain('npx @expo/agent-cli navigate /');
      expect(error.suggestedCommand).toBe('npx @expo/agent-cli navigate /');
      expect(error.data).toEqual({
        devServerUrl: stub.url,
        devServerReachable: true,
        debuggerTargets: 0,
        commandSocketClients: null,
        platform: null,
      });
    }
  );

  // The inconsistency wave 23 removed, at the process boundary. `runtime:tree` asked the bundle
  // gate before it asked whether there was an app, so with nothing connected the exit code was
  // decided by whether the *project compiled*: `20` for a broken bundle and `1` for a clean one, for
  // one situation. Nothing can be read off a screen that is not there, whatever the code on disk
  // says, so the connection is the first question and the answer to it is one code — `22` since
  // F141 — whatever the bundle would have said.
  it.each(NEEDS_AN_APP)(
    `%s answers no-app with 22 even when the project does not compile`,
    async (_name, argv) => {
      const broken = await startStubDevServerAsync({ targets: [], bundle: 'broken' });
      try {
        const result = await runAsync(argv, broken.url);

        expect(result.exitCode).toBe(22);
        expect(JSON.parse(result.stdout).error.code).toBe('NO_APP_CONNECTED');
      } finally {
        await broken.close();
      }
    }
  );

  // The one command of the family that does not refuse here, and the reason is in its ladder: a
  // relaunch is what *starts* an app, so "no app is connected" is a rung rather than a refusal.
  it('runtime:reload does not refuse: it starts the app instead', async () => {
    const started = appStartedMarkerPath(projectRoot);
    const withApp = await startStubDevServerAsync({
      targets: [EXPO_GO_TARGET],
      messagePeers: {},
      targetsAppearWithFile: started,
    });
    await installStubXcrunAsync(projectRoot);
    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['runtime:reload', '--ios', '--dev-server-url', withApp.url, '--json'],
        { reject: false, env: stubExpoEnv(projectRoot) }
      );

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ reloaded: true, method: 'device' });
    } finally {
      await withApp.close();
      fs.rmSync(started, { force: true });
    }
  });

  // ...and neither does `runtime:stop`, for the reason llp/0010 gives: the state it was asked for
  // already holds, and an agent that stops an app twice must not have to special-case the second
  // run. The dev server is its evidence for *which* app, never a precondition.
  it('runtime:stop exits 0 with nothing connected, and with no dev server at all', async () => {
    await installStubXcrunAsync(projectRoot);

    for (const devServerUrl of [stub.url, DEAD_URL]) {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['runtime:stop', '--ios', '--dev-server-url', devServerUrl, '--json'],
        { reject: false, env: stubExpoEnv(projectRoot) }
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ stopped: true, connectedAppIds: [] });
    }
  });
});

describe('a dev server with an app connected', () => {
  let stub: StubDevServer;
  beforeAll(async () => {
    stub = await startStubDevServerAsync({
      targets: [EXPO_GO_TARGET],
      // The app answers the debugger, and answers every expression with nothing — which is past the
      // preflight and into each command's own business.
      inspectorEvaluate: () => undefined,
    });
  });
  afterAll(async () => {
    await stub.close();
  });

  // The claim is only about the preflight: whatever each command then makes of the app, none of
  // them may answer "there is no app" about a dev server that just named one.
  it.each(NEEDS_AN_APP)(`%s gets past the preflight`, async (_name, argv) => {
    const result = await runAsync(argv, stub.url);

    const payload = JSON.parse(result.stdout);
    expect(payload.error?.code).not.toBe('NO_APP_CONNECTED');
    expect(payload.error?.code).not.toBe('NO_DEV_SERVER');
    // This runtime answers `undefined` to each question, so it cannot say whether a bundle ran.
    expect(payload.error?.code).not.toBe('APP_NOT_LOADED');
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §A loaded app
// The dev server lists the app's debugger target and the runtime answers, before the app runs its
// JavaScript bundle. The preflight is shared, so tap and type run on one platform.
describe('a dev server whose app ran no bundle', () => {
  type Platform = 'ios' | 'android';

  async function runOnAsync(
    platform: Platform,
    argv: string[],
    runtime: ReturnType<typeof appRuntime>
  ) {
    const stub = await startStubDevServerAsync({
      targets: [expoGoRuntimeTarget(platform)],
      inspectorEvaluate: runtime.evaluate,
    });
    try {
      return await runAsync([...argv, `--${platform}`], stub.url);
    } finally {
      await stub.close();
    }
  }

  const command = (name: string) => NEEDS_AN_APP.find(([n]) => n === name)!;
  const [evaluate, errors, tree, tap, type] = [
    'runtime:eval',
    'runtime:errors',
    'runtime:tree',
    'runtime:tap',
    'runtime:type',
  ].map(command);
  const failOnError: (typeof NEEDS_AN_APP)[number] = [
    'runtime:errors --fail-on-error',
    [...errors![1], '--fail-on-error'],
  ];
  it.each([
    ...(['ios', 'android'] as const).flatMap((platform) =>
      [errors!, failOnError, tree!].map(([name, argv]) => [name, platform, argv] as const)
    ),
    [tap![0], 'ios', tap![1]] as const,
    [type![0], 'ios', type![1]] as const,
  ])('%s refuses an app that ran no bundle (--%s)', async (_name, platform, argv) => {
    const result = await runOnAsync(platform, argv, appRuntime({}));

    expect(result.exitCode).toBe(22);
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe('APP_NOT_LOADED');
    expect(error.data.debuggerTargets).toBe(1);
    expect(error.suggestedCommand).toBe(`npx @expo/agent-cli navigate / --${platform}`);
  });

  // `runtime:eval` reports a value and makes no claim about the app, so it reads the empty runtime.
  it.each(['ios', 'android'] as const)(
    'runtime:eval evaluates in an app that ran no bundle, and says so (--%s)',
    async (platform) => {
      const result = await runOnAsync(platform, evaluate![1], appRuntime({}));

      expect(result.exitCode, result.all).toBe(0);
      expect(result.stderr).toContain('ran no JavaScript bundle');
    }
  );

  it.each(['ios', 'android'] as const)(
    'waits for a bundle that runs inside the wait (--%s)',
    async (platform) => {
      const result = await runOnAsync(
        platform,
        ['runtime:eval', 'typeof globalThis.__r'],
        appRuntime({}, { loadedAfterAsks: 2 })
      );

      expect(result.exitCode, result.all).toBe(0);
      expect(JSON.parse(result.stdout).value).toBe('function');
    }
  );

  // The bundle ran: the Metro `require` is defined. React Native says "not ready" after the crash.
  it('reads an app whose bundle crashed at the top level', async () => {
    const crashed = appRuntime({ __r() {}, RN$isRuntimeReady: () => false });

    const result = await runOnAsync('ios', errors![1], crashed);

    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout).error).toBeUndefined();
  });

  // @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
  // `app`, `foreign` and `parent` are the fixture, a sibling worktree and the directory that holds
  // both. `header` is the root the dev server names; `lock` finds the server through this project's
  // lock instead of `--dev-server-url`.
  type Root = 'app' | 'foreign' | 'parent';
  type Case = {
    global?: Root;
    env?: Root;
    header?: Root | null;
    cwd?: Root | 'outside';
    lock?: boolean;
  };
  const eval_ = (c: Case, exitCode: 0 | 20) =>
    [evaluate![0], 'ios', c, exitCode, evaluate![1]] as const;
  it.each([
    ...NEEDS_AN_APP.map(([name, argv]) => [name, 'ios', { env: 'foreign' }, 20, argv] as const),
    ...[evaluate!, tree!].map(
      ([name, argv]) => [name, 'android', { env: 'foreign' }, 20, argv] as const
    ),
    eval_({ global: 'foreign', env: 'app' }, 20),
    eval_({ global: 'app', env: 'foreign' }, 0),
    eval_({ env: 'app' }, 0),
    eval_({}, 0),
    eval_({ env: 'app', cwd: 'outside' }, 0),
    eval_({ env: 'app', cwd: 'parent' }, 0),
    eval_({ env: 'app', header: 'parent' }, 0),
    eval_({ env: 'foreign', header: null }, 0),
    eval_({ env: 'foreign', header: null, lock: true }, 20),
    eval_({ env: 'app', header: null, lock: true }, 0),
  ])('%s --%s with %j exits %i', async (_name, platform: Platform, c: Case, exitCode, argv) => {
    const parent = path.dirname(projectRoot);
    const rootOf = (root: Root) =>
      ({ app: projectRoot, foreign: path.join(parent, 'other-worktree'), parent })[root];
    const header = c.header === undefined ? 'app' : c.header;
    const cwd =
      c.cwd === 'outside'
        ? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-cli-outside-'))
        : rootOf(c.cwd ?? 'app');
    const runtime = appRuntime({
      __r() {},
      ...(c.global && { __EXPO_PROJECT_ROOT__: rootOf(c.global) }),
      ...(c.env && { process: { env: { EXPO_PUBLIC_PROJECT_ROOT: rootOf(c.env) } } }),
    });
    const stub = await startStubDevServerAsync({
      targets: [expoGoRuntimeTarget(platform)],
      inspectorEvaluate: runtime.evaluate,
      projectRoot: header == null ? null : rootOf(header),
    });
    const release = c.lock ? await holdLockForAsync(projectRoot, stub) : null;
    let result;
    try {
      result = await executeAgentCliAsync(
        cwd,
        [...argv, `--${platform}`, ...(c.lock ? [] : ['--dev-server-url', stub.url]), '--json'],
        { reject: false, env: stubExpoEnv(projectRoot) }
      );
    } finally {
      release?.();
      await stub.close();
    }

    expect(result.exitCode, result.all).toBe(exitCode);
    if (exitCode === 0) return;
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe('FOREIGN_BUNDLE');
    expect(error.message).toContain(canonicalizeExistingPath(rootOf('foreign')));
    expect(error.message).toContain(canonicalizeExistingPath(projectRoot));
    expect(error.suggestedCommand).toMatch(
      new RegExp(`^npx @expo/agent-cli navigate exp://127\\.0\\.0\\.1:\\d+ --${platform}$`)
    );
    expect(error.data).toMatchObject({
      devServerReachable: true,
      debuggerTargets: 1,
      platform,
    });
  });

  // `runtime:stop` reads which app runs, not what its runtime answers.
  it('runtime:stop stops an app that ran no bundle', async () => {
    await installStatefulXcrunAsync(projectRoot, {
      simulators: [{ udid: 'PREFLIGHT-SIM', name: 'iPhone 17 Pro', state: 'Booted' }],
      runningAppIds: ['host.exp.Exponent'],
    });

    const result = await runOnAsync('ios', ['runtime:stop'], appRuntime({}));

    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ bundleId: 'host.exp.Exponent' });
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Android
// A run that names a platform reads only the apps it can place there. An app nothing places on
// either platform (a development build on someone's phone) is not evidence about `--android`.
describe('a run that names a platform', () => {
  const ANDROID_TARGET = {
    ...EXPO_GO_TARGET,
    id: '2',
    appId: 'host.exp.exponent',
    description: 'host.exp.exponent',
    deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=2&page=1',
  };
  const UNPLACED_TARGET = {
    ...EXPO_GO_TARGET,
    id: '3',
    appId: 'com.example.app',
    description: 'com.example.app',
    deviceName: 'Ada’s phone',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=3&page=1',
  };

  async function runAndroidAsync(stub: StubDevServer) {
    return await executeAgentCliAsync(
      projectRoot,
      ['runtime:eval', '1 + 1', '--android', '--dev-server-url', stub.url, '--json'],
      { reject: false, env: { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '1' } }
    );
  }

  it(`reads the app it places on that platform, not the other platform's`, async () => {
    const evaluated = new Set<string>();
    const stub = await startStubDevServerAsync({
      targets: [UNPLACED_TARGET, EXPO_GO_TARGET, ANDROID_TARGET],
      inspectorEvaluate: (_expression, device) => {
        evaluated.add(device);
        return undefined;
      },
    });
    try {
      const result = await runAndroidAsync(stub);

      expect(JSON.parse(result.stdout).error?.code).not.toBe('NO_APP_CONNECTED');
      expect([...evaluated]).toEqual(['2']);
    } finally {
      await stub.close();
    }
  });

  it('does not read an app nothing places on a run without --eas', async () => {
    const stub = await startStubDevServerAsync({
      targets: [{ ...UNPLACED_TARGET, deviceName: 'iPhone 17' }],
      inspectorEvaluate: () => undefined,
    });
    try {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['runtime:eval', '1 + 1', '--ios', '--dev-server-url', stub.url, '--json'],
        { reject: false, env: { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '1' } }
      );

      expect(JSON.parse(result.stdout).error.code).toBe('NO_APP_CONNECTED');
    } finally {
      await stub.close();
    }
  });

  it('does not read an app nothing places', async () => {
    const stub = await startStubDevServerAsync({
      targets: [UNPLACED_TARGET],
      inspectorEvaluate: () => undefined,
    });
    try {
      const result = await runAndroidAsync(stub);

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe('NO_APP_CONNECTED');
    } finally {
      await stub.close();
    }
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §What proves a reload — **F141.** An app that is
// re-registering holds no debugger target for about half a second, and the whole family reads that
// list. The grace period that waits it out was `runtime:errors`' alone, because F39 was found on the
// `reload → errors` chain — so `runtime:tree`, which asks the identical question, asked it once and
// refused. Every command that needs a runtime now waits out the same window.
describe('a dev server whose app is re-registering', () => {
  it.each(NEEDS_AN_APP)(`%s waits for the app to come back`, async (_name, argv) => {
    // Empty at first, and answering with the app once the file exists — which a timer creates
    // inside the reconnect window, exactly as a reloading app registers inside it.
    const appeared = path.join(projectRoot, `.reconnected-${argv[0]}`);
    fs.rmSync(appeared, { force: true });
    const reconnecting = await startStubDevServerAsync({
      targets: [EXPO_GO_TARGET],
      targetsAppearWithFile: appeared,
      inspectorEvaluate: () => undefined,
    });
    const timer = setTimeout(() => fs.writeFileSync(appeared, ''), 600);

    try {
      const result = await runAsync(argv, reconnecting.url);

      // Not 22 and not 1: the list filled while this command was still asking, so there was an app
      // to answer about. Which is the whole finding — the retry was always going to work.
      expect(JSON.parse(result.stdout).error?.code).not.toBe('NO_APP_CONNECTED');
    } finally {
      clearTimeout(timer);
      await reconnecting.close();
      fs.rmSync(appeared, { force: true });
    }
  });
});

/** The stateful stub `xcrun`, listing this file's one booted simulator. */
async function installStubXcrunAsync(root: string): Promise<void> {
  await installStatefulXcrunAsync(root, {
    simulators: [{ udid: 'PREFLIGHT-SIM', name: 'iPhone 17 Pro', state: 'Booted' }],
  });
}

// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// Another worktree's clone simulator, still booted and bound to it, loads its JavaScript from this
// port and is the only app on it. Every command that needs an app refuses rather than read it.
describe(`a dev server whose only app runs on another worktree's simulator`, () => {
  const CLONE = 'agent-cli c4ed0a60';
  let otherRoot: string;
  let bindingFile: string;
  let stub: StubDevServer;
  beforeAll(async () => {
    otherRoot = canonicalizeExistingPath(
      await fs.promises.mkdtemp(path.join(path.dirname(projectRoot), 'other-worktree-'))
    );
    bindingFile = path.join(
      expoHomeOf(projectRoot),
      'agent-cli',
      'bindings',
      `${digestOf(otherRoot)}-ios-local-ios.json`
    );
    await fs.promises.mkdir(path.dirname(bindingFile), { recursive: true });
    const now = Date.now();
    await fs.promises.writeFile(
      bindingFile,
      JSON.stringify({
        version: 1,
        device: {
          backend: 'local-ios',
          platform: 'ios',
          udid: 'OTHER-SIM',
          name: CLONE,
          origin: 'created',
        },
        projectRoot: otherRoot,
        boundAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60 * 60_000).toISOString(),
      })
    );
    const scriptPath = path.join(projectRoot, '.stub-bin', 'xcrun-other-worktree.js');
    await fs.promises.writeFile(
      scriptPath,
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
              { udid: 'OTHER-SIM', name: CLONE, state: 'Booted' },
            ],
          },
        })
      )});`
    );
    await installStubBinAsync(path.join(projectRoot, '.stub-bin'), 'xcrun', scriptPath);
    stub = await startStubDevServerAsync({
      targets: [{ ...EXPO_GO_TARGET, deviceName: CLONE }],
      inspectorEvaluate: () => undefined,
    });
  });
  afterAll(async () => {
    await stub.close();
    fs.rmSync(bindingFile, { force: true });
  });

  it.each(NEEDS_AN_APP)(
    `%s exits 1 with NO_APP_CONNECTED and names that worktree`,
    async (_name, argv) => {
      const result = await runAsync(argv, stub.url);

      expect(result.exitCode).toBe(1);
      const { error } = JSON.parse(result.stdout);
      expect(error.code).toBe('NO_APP_CONNECTED');
      expect(error.message).toContain(`"${CLONE}"`);
      expect(error.message).toContain(otherRoot);
      expect(error.suggestedCommand).toBe(`npx @expo/agent-cli navigate / --${hostPlatform()}`);
    }
  );
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// N2-33: a worktree bound to an EAS Simulator iOS session, and one app on a local simulator with the
// session app's app id, loading from the same port. It is not the session's app, so the read refuses
// and names both, and no scope line says the session was read.
describe('a worktree bound to an EAS Simulator session, with only a local app connected', () => {
  let stub: StubDevServer;
  let cloudBinding: string;
  beforeAll(async () => {
    cloudBinding = await bindToSessionAsync();
    stub = await startStubDevServerAsync({
      targets: [{ ...EXPO_GO_TARGET, appId: 'dev.vonovak.cyclable' }],
      inspectorEvaluate: () => undefined,
    });
  });
  afterAll(async () => {
    await stub.close();
    fs.rmSync(cloudBinding, { force: true });
  });

  it('runtime:tree refuses with NO_APP_CONNECTED and does not name the session as read', async () => {
    // Devices on, so the read reads the binding; the stub `xcrun` is the only device tool.
    const result = await executeAgentCliAsync(
      projectRoot,
      ['runtime:tree', '--dev-server-url', stub.url, '--json'],
      { reject: false, env: { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '0' } }
    );

    expect(result.exitCode).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe('NO_APP_CONNECTED');
    expect(error.message).toContain('"iPhone 17 Pro"');
    expect(error.message).toContain('the EAS Simulator session 01a160c1');
    expect(error.message).toContain('is not the device this run reads');
    expect(error.message).not.toContain("the other worktree's build");
    expect(result.stderr).not.toContain('Scoped to ios');
  });
});

// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
// N2-17: the same session binding, with the session's app ("iPhone 17") beside an app on the booted
// local simulator ("iPhone 17 Pro"). The dev server relays a broadcast to both, so runtime:reload
// sends none: it reloads the session's app over Page.reload and proves it there.
describe('a worktree bound to an EAS Simulator session, beside a local app', () => {
  let stub: StubDevServer;
  let cloudBinding: string;
  beforeAll(async () => {
    cloudBinding = await bindToSessionAsync();
    const devBuild = { ...EXPO_GO_TARGET, appId: 'dev.vonovak.cyclable' };
    stub = await startStubDevServerAsync({
      targets: [
        devBuild,
        {
          ...devBuild,
          id: '2',
          deviceName: 'iPhone 17',
          webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=2&page=1',
        },
      ],
    });
  });
  afterAll(async () => {
    await stub.close();
    fs.rmSync(cloudBinding, { force: true });
  });

  it('runtime:reload sends no broadcast and reloads only the session app', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['runtime:reload', '--dev-server-url', stub.url, '--no-bundle-check', '--json'],
      { reject: false, env: { ...stubExpoEnv(projectRoot), AGENT_CLI_NO_DEVICE: '0' } }
    );

    expect(stub.broadcasts()).toBe(0);
    expect(stub.pageReloads()).toEqual(['2']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reloaded: true,
      verifiedBy: 'debugger-context-replaced',
      bundlesAfterReload: {
        observed: null,
        reason: expect.stringContaining('new JavaScript context'),
      },
      skippedApps: [{ deviceName: 'iPhone 17 Pro', group: 'other-device' }],
    });
  });
});

/**
 * Bind this worktree to an EAS Simulator iOS session, with "iPhone 17 Pro" booted on this machine
 * and not bound to it. Returns the binding file.
 */
async function bindToSessionAsync(): Promise<string> {
  await installStubXcrunAsync(projectRoot);
  const root = canonicalizeExistingPath(projectRoot);
  const bindings = path.join(expoHomeOf(projectRoot), 'agent-cli', 'bindings');
  await fs.promises.rm(path.join(bindings, `${digestOf(root)}-ios-local-ios.json`), {
    force: true,
  });
  const cloudBinding = path.join(bindings, `${digestOf(root)}-ios-cloud.json`);
  await fs.promises.writeFile(
    cloudBinding,
    JSON.stringify({
      version: 1,
      device: { backend: 'cloud', platform: 'ios', id: '01a160c1', origin: 'started' },
      projectRoot: root,
      boundAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
  );
  return cloudBinding;
}
