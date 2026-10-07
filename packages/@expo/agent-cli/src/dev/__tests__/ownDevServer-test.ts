// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person can complete
// The reuse rules: which options a running dev server lacks, what a reuse plan runs, and which
// `/status` answers make the lock's server this project's. The last against a real HTTP server.

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

import type { DevServerLockInfo } from '../../devLock';
import type { PlanStep, StartPlan } from '../../project/types';
import {
  ownDevServerAsync,
  ownDevServerStop,
  portReasons,
  serverOptions,
  startOptionsMismatch,
  withReusedDevServer,
} from '../ownDevServer';

const caller = { detachArgv: ['--ios'], platform: 'ios' as const };

function planStep(id: string, argv: string[], reason = `${id} step`): PlanStep {
  return { id, argv, reason, timeClass: 'minutes', runsOn: null };
}

function start(...options: string[]): PlanStep {
  return planStep('start', ['expo', 'start', ...options]);
}

describe(serverOptions, () => {
  it.each([
    [['-c'], ['--clear']],
    [['--host', 'tunnel'], ['--tunnel']],
    [['--host=tunnel'], ['--tunnel']],
    // The Expo CLI's default host, so absent on either side.
    [['--host', 'lan'], []],
    [['--lan'], []],
    [['--localhost'], ['--host localhost']],
    [['--port', '8081', '-p', '8082', '--port=8083'], []],
    [['--go', '--dev-client', '--web'], []],
    [['--clear', '--', '--tunnel'], ['--clear']],
    [
      ['--reset-cache', '-m', 'localhost'],
      ['--clear', '--host localhost'],
    ],
    [['-d', '-g', '-w'], []],
    [['--tunnel', 'expo'], ['--tunnel']],
    [['--tunnel', 'ngrok'], ['--tunnel ngrok']],
    [
      ['--tunnel', '--clear'],
      ['--tunnel', '--clear'],
    ],
    // Neither changes the bundle or where it is served; their values are not read as options.
    [['--max-workers', '4', '--scheme', 'myapp'], []],
    [['--max-workers=4', '--private-key-path', 'keys/p.pem'], ['--private-key-path keys/p.pem']],
  ])(`reads %p as %p`, (args, expected) => {
    expect(serverOptions(args)).toEqual(expected);
  });
});

describe(startOptionsMismatch, () => {
  const missingStartOptions = (step: PlanStep, running: string[]) =>
    startOptionsMismatch(step, running).missing;

  // `agent-cli start` publishes `['start', ...typed]`, and every `dev` start names a run target.
  it(`reuses a bare start for a start that names a run target`, () => {
    expect(missingStartOptions(start('--dev-client'), ['start'])).toEqual([]);
    expect(missingStartOptions(start('--go'), ['start', '--dev-client'])).toEqual([]);
    expect(missingStartOptions(start('--web'), ['start'])).toEqual([]);
  });

  it(`reads aliases on either side as one option`, () => {
    expect(missingStartOptions(start('--tunnel'), ['start', '--host', 'tunnel'])).toEqual([]);
    expect(missingStartOptions(start('--host', 'localhost'), ['start', '--localhost'])).toEqual([]);
  });

  it(`reuses a server with no host option for --lan, the default host`, () => {
    expect(missingStartOptions(start('--lan'), ['start'])).toEqual([]);
  });

  it(`names an option the running server lacks`, () => {
    expect(missingStartOptions(start('--tunnel'), ['start'])).toEqual(['--tunnel']);
    expect(missingStartOptions(start('--go', '--tunnel'), ['start', '-c'])).toEqual(['--tunnel']);
  });

  // `--clear` acts once at start: a server started with it earlier cleared nothing for this run.
  it(`always counts --clear as missing`, () => {
    expect(missingStartOptions(start('--clear'), ['start', '--clear'])).toEqual(['--clear']);
    expect(missingStartOptions(start('-c'), ['start', '-c'])).toEqual(['--clear']);
  });

  // A value is part of its option, so a stop never says "lacks localhost".
  it(`names a value-taking option with its value`, () => {
    expect(missingStartOptions(start('--host', 'localhost'), ['start', '--tunnel'])).toEqual([
      '--host localhost',
    ]);
    expect(
      missingStartOptions(start('--private-key-path', 'k.pem'), [
        'start',
        '--private-key-path=k.pem',
      ])
    ).toEqual([]);
  });

  // `--max-workers` sets Metro's parallelism, and the open builds its URL from the lock's.
  it(`does not compare --max-workers or --scheme`, () => {
    expect(
      startOptionsMismatch(start('--max-workers', '4', '--scheme', 'x'), [
        'start',
        '--max-workers',
        '2',
      ])
    ).toEqual({ missing: [], extra: [] });
  });

  it(`ignores the port on both sides`, () => {
    expect(
      missingStartOptions(start('--dev-client', '--port', '8190'), ['start', '--port', '8081'])
    ).toEqual([]);
  });

  // A holder from an older version answers without `args`: its options are unknown.
  it(`compares unknown options against a bare start, and computes no extra`, () => {
    expect(startOptionsMismatch(start('--dev-client'), null)).toEqual({ missing: [], extra: null });
    expect(startOptionsMismatch(start('--dev-client', '--tunnel'), null)).toEqual({
      missing: ['--tunnel'],
      extra: null,
    });
  });

  it(`asks nothing of a run:* step, which a reuse installs with --no-bundler`, () => {
    expect(missingStartOptions(planStep('run', ['expo', 'run:ios']), ['start', '--go'])).toEqual(
      []
    );
  });

  // A mode option builds the bundle, so a server started with one serves every run against it so.
  it(`names the mode options the running server was started with and the run lacks`, () => {
    expect(startOptionsMismatch(start('--go'), ['start', '--no-dev', '--minify'])).toEqual({
      missing: [],
      extra: ['--no-dev', '--minify'],
    });
    expect(startOptionsMismatch(start('--go'), ['start', '--offline'])).toEqual({
      missing: [],
      extra: ['--offline'],
    });
    expect(startOptionsMismatch(start('--go', '--tunnel'), ['start', '--https'])).toEqual({
      missing: ['--tunnel'],
      extra: ['--https'],
    });
    expect(
      startOptionsMismatch(planStep('run', ['expo', 'run:ios']), ['start', '--no-dev'])
    ).toEqual({ missing: [], extra: ['--no-dev'] });
  });

  it(`reuses a server whose mode options the run asks for too`, () => {
    expect(startOptionsMismatch(start('--go', '--no-dev'), ['start', '--no-dev'])).toEqual({
      missing: [],
      extra: [],
    });
  });

  // A host option says where the server is reachable, which a run that did not ask for it loses
  // nothing by.
  it(`reuses a server with a host option the run does not ask for`, () => {
    for (const host of [['--tunnel'], ['--lan'], ['--localhost'], ['--host', 'lan']]) {
      expect(startOptionsMismatch(start('--go'), ['start', ...host])).toEqual({
        missing: [],
        extra: [],
      });
    }
  });
});

describe(withReusedDevServer, () => {
  const lock = { port: 8190 } as DevServerLockInfo;

  it(`drops expo start`, () => {
    const install = planStep('install', ['expo', 'run:ios', '--no-bundler']);
    const serving = start('--dev-client', '--port', '8190');
    const plan = { steps: [install, serving] } as StartPlan;

    expect(withReusedDevServer(plan, serving, lock, true).steps).toEqual([install]);
  });

  // The Expo CLI refuses `--port` with `--no-bundler`.
  it(`turns run:* into an install with --no-bundler and no port`, () => {
    const serving = planStep(
      'run',
      ['expo', 'run:ios', '--port', '8190', '--device', 'iPhone'],
      'Builds the ios app here, installs it, and starts the dev server. Stale.'
    );
    const plan = { steps: [serving] } as StartPlan;

    const [step] = withReusedDevServer(plan, serving, lock, true).steps;
    const [unopened] = withReusedDevServer(plan, serving, lock, false).steps;

    expect(step!.argv).toEqual(['expo', 'run:ios', '--device', 'iPhone', '--no-bundler']);
    expect(step!.reason).toContain('the step starts none, and the app is opened against it.');
    expect(step!.reason).toContain('port 8190');
    expect(unopened!.reason).toMatch(/the step starts none\.$/);
  });
});

describe(ownDevServerAsync, () => {
  const projectRoot = '/tmp/workspace/apps/my-app';
  const options = { port: null, platform: 'ios' as const, opens: true };
  let server: Server | null = null;

  /** A dev server whose `/status` answers ready, with this project-root header or none. */
  async function serveStatusAsync(root: string | null): Promise<DevServerLockInfo> {
    server = createServer((_request, response) => {
      response.writeHead(200, root == null ? {} : { 'X-React-Native-Project-Root': root });
      response.end('packager-status:running');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      pid: 4242,
      startedAt: '2026-10-06T00:00:00.000Z',
      projectRoot,
      args: ['start'],
    };
  }

  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = null;
  });

  it(`is none without a live lock`, async () => {
    expect(await ownDevServerAsync(projectRoot, null, options, start('--go'))).toEqual({
      kind: 'none',
    });
  });

  // The lock is this project's evidence; a Metro that names no root does not contradict it.
  it(`counts a server with no root header as this project's`, async () => {
    const lock = await serveStatusAsync(null);

    const own = await ownDevServerAsync(projectRoot, lock, options, start('--go'));

    expect(own).toMatchObject({ kind: 'serving', missing: [] });
    expect(ownDevServerStop(own, caller)).toBeNull();
  });

  // A monorepo's `metro.config.js` sets `projectRoot` to the workspace root.
  it(`counts a server whose root contains this project as this project's`, async () => {
    const lock = await serveStatusAsync('/tmp/workspace');

    const own = await ownDevServerAsync(projectRoot, lock, options, start('--go'));

    expect(own).toMatchObject({ kind: 'serving' });
  });

  // Since the lock is published at the spawn, another project's Metro can answer on its port
  // until this project's busy-port retry moves to a free one.
  it(`reads a sibling's root as a foreign port, and suggests running again first`, async () => {
    const lock = await serveStatusAsync('/tmp/workspace/apps/other-app');

    const own = await ownDevServerAsync(projectRoot, lock, options, start('--go'));

    expect(own).toMatchObject({
      kind: 'foreign',
      reportedProjectRoot: '/tmp/workspace/apps/other-app',
    });
    const stop = ownDevServerStop(own, { detachArgv: ['--clear', '--ios'], platform: 'ios' });
    expect(stop).toMatchObject({
      code: 'DEV_SERVER_PORT_FOREIGN',
      suggestedCommand: 'npx @expo/agent-cli dev --ios --clear',
      message: expect.stringContaining(
        'the server answering there reports another project root (/tmp/workspace/apps/other-app)'
      ),
    });
    // `--force` there would stop the other project's dev server.
    expect(stop!.message).not.toContain('--force');
    expect(stop!.message).toContain('in the middle of its busy-port retry');
    expect(stop!.message).toContain(
      'How: run "npx @expo/agent-cli dev --ios --clear" again in a few seconds. If the stop repeats, stop this project\'s dev server with "npx @expo/agent-cli dev:stop"'
    );
  });

  it(`names the options the running server lacks`, async () => {
    const lock = await serveStatusAsync(projectRoot);

    const own = await ownDevServerAsync(projectRoot, lock, options, start('--go', '--tunnel'));

    expect(own).toMatchObject({ kind: 'serving', missing: ['--tunnel'] });
    expect(ownDevServerStop(own, caller)).toMatchObject({
      code: 'DEV_SERVER_OPTIONS_MISMATCH',
    });
  });

  it(`names both sides when the running server was started with --no-dev`, async () => {
    const lock = {
      ...(await serveStatusAsync(projectRoot)),
      args: ['start', '--no-dev', '--minify'],
    };

    const serving = start('--go', '--tunnel');
    const own = await ownDevServerAsync(projectRoot, lock, options, serving);

    expect(own).toMatchObject({
      kind: 'serving',
      missing: ['--tunnel'],
      extra: ['--no-dev', '--minify'],
    });
    const stop = ownDevServerStop(own, caller);
    expect(stop).toMatchObject({ code: 'DEV_SERVER_OPTIONS_MISMATCH' });
    expect(stop!.message).toContain(
      'without --tunnel and with --no-dev --minify, which this run does not ask for, so nothing was started.'
    );
    expect(stop!.message).toContain('or run without --tunnel.');
    const plan: StartPlan = { steps: [serving] } as StartPlan;
    expect(portReasons(plan, serving, own, { mode: 'run', port: null, opens: true })[0]).toMatch(
      /without --tunnel and with --no-dev --minify, which this run does not ask for; the run stops/
    );
  });

  // `[]` would claim a bare start; the CLI does not know that of an older holder.
  it(`says the options are unknown for a holder without args`, async () => {
    const lock = { ...(await serveStatusAsync(projectRoot)), args: null };

    const reused = await ownDevServerAsync(projectRoot, lock, options, start('--go'));
    const own = await ownDevServerAsync(projectRoot, lock, options, start('--go', '--tunnel'));

    expect(reused).toMatchObject({ kind: 'serving', missing: [], extra: null });
    expect(ownDevServerStop(reused, caller)).toBeNull();
    const stop = ownDevServerStop(own, caller);
    expect(stop).toMatchObject({ code: 'DEV_SERVER_OPTIONS_MISMATCH' });
    expect(stop!.message).toContain(
      `running on port ${lock.port} and its options are unknown (started by an older version), while this run asks for --tunnel, so nothing was started.`
    );
    expect(stop!.message).not.toContain(`running on port ${lock.port} without`);
  });

  // One project has one lock, so a second dev server on the named port could not hold it.
  it(`stops for a lock on another port than the one named`, async () => {
    const lock = await serveStatusAsync(projectRoot);

    const own = await ownDevServerAsync(projectRoot, lock, { ...options, port: 1 }, start('--go'));

    expect(own).toEqual({ kind: 'elsewhere', lock, port: 1, named: true });
    const stop = ownDevServerStop(own, caller);
    expect(stop).toMatchObject({ code: 'DEV_SERVER_ON_OTHER_PORT', exitCode: 20 });
    expect(stop!.message).toContain(`running on port ${lock.port}`);
    expect(stop!.message).toContain('not on the named port 1');
    expect(stop!.message).toContain(
      'How: use the running server ("npx @expo/agent-cli smoke --ios" or "npx @expo/agent-cli status"), stop it with "npx @expo/agent-cli dev:stop", or drop --port.'
    );
  });

  // `expo run:* --no-bundler` builds and launches the app against 8081 (the Expo CLI's
  // `resolveBundlerProps`); only the open after the steps moves it to the lock's port.
  describe('a run:* step that a reuse installs', () => {
    const run = planStep('run', ['expo', 'run:ios']);

    it(`stops for a lock off 8081 when no open follows`, async () => {
      const lock = await serveStatusAsync(projectRoot);

      const own = await ownDevServerAsync(projectRoot, lock, { ...options, opens: false }, run);

      expect(own).toEqual({ kind: 'elsewhere', lock, port: 8081, named: false });
      const stop = ownDevServerStop(own, caller);
      expect(stop).toMatchObject({ code: 'DEV_SERVER_ON_OTHER_PORT', exitCode: 20 });
      expect(stop!.message).toContain(`running on port ${lock.port} (pid 4242), not on port 8081`);
      expect(stop!.message).toContain('builds and launches the app against port 8081');
      expect(stop!.message).toContain('How: run without --no-open');
      expect(
        portReasons({ steps: [run] } as StartPlan, run, own, {
          mode: 'plan',
          port: null,
          opens: false,
        })
      ).toEqual([expect.stringContaining('points the app at port 8081 with no open after it')]);
    });

    it(`reuses a lock off 8081 when the open follows`, async () => {
      const lock = await serveStatusAsync(projectRoot);

      const own = await ownDevServerAsync(projectRoot, lock, options, run);

      expect(own).toMatchObject({ kind: 'serving' });
      expect(
        portReasons({ steps: [run] } as StartPlan, run, own, { ...options, mode: 'run' })
      ).toEqual([
        `The dev server is already running on port ${lock.port}; the install uses the running server, and the app is opened against it.`,
      ]);
    });

    it(`reuses a lock on 8081 with no open, and does not say the app is opened`, async () => {
      const lock = { ...(await serveStatusAsync(projectRoot)), port: 8081 };

      const own = await ownDevServerAsync(projectRoot, lock, { ...options, opens: false }, run);

      expect(own).toMatchObject({ kind: 'serving' });
      expect(
        portReasons({ steps: [run] } as StartPlan, run, own, {
          mode: 'run',
          port: null,
          opens: false,
        })
      ).toEqual([
        'The dev server is already running on port 8081; the install uses the running server.',
      ]);
    });
  });

  // The `--detach` parent compares no options: the plan is the child's.
  it(`compares no options without a serving step`, async () => {
    const lock = { ...(await serveStatusAsync(projectRoot)), args: ['start', '--no-dev'] };

    expect(await ownDevServerAsync(projectRoot, lock, options, null)).toEqual({
      kind: 'serving',
      lock,
      missing: [],
      extra: [],
    });
  });

  // `elsewhere` says the server runs there, so it is decided only for a server that answers.
  it(`reads a lock on another port whose /status does not answer as starting`, async () => {
    const lock = await serveStatusAsync(projectRoot);
    await new Promise((resolve) => server!.close(resolve));
    server = null;

    const own = await ownDevServerAsync(projectRoot, lock, { ...options, port: 1 }, start('--go'));

    expect(own).toEqual({ kind: 'starting', lock });
  });
});
