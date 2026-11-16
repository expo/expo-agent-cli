// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// Which port the lock publishes. The dev server picks it, not the wrapper, so the wrapper reads
// it back out of the dev server's report, and must not take the previous run's answer.

import { vol } from 'memfs';
import path from 'path';

import { DEFAULT_DEV_SERVER_PORT, readPortArg, resolveDevServerPortAsync } from '../port';

const projectRoot = path.join(path.sep, 'project');

/**
 * Where this process's `2g` writes, which the port watch reads Metro's report from: the `LOG_EVENTS`
 * file by default, or a session whose stream of reports ends at once (the mocked `tap` below).
 */
const eventLog = vi.hoisted(() => ({
  file: require('path').join(require('path').sep, 'events.jsonl') as string,
  sessionDir: null as string | null,
}));
vi.mock('2g', async (importOriginal) => ({
  ...(await importOriginal<typeof import('2g')>()),
  getEventLoggerInfo: () =>
    eventLog.sessionDir
      ? {
          destination: 'session',
          isUserVisibleOutput: false,
          debug: false,
          sessionDir: eventLog.sessionDir,
        }
      : { destination: 'file', isUserVisibleOutput: false, debug: true, file: eventLog.file },
}));
vi.mock('2g/api', () => ({ tap: async function* () {} }));

/** Append Metro's report of `port` to the event log, as `2g` writes it. */
function report(port: number) {
  const previous = vol.existsSync(eventLog.file) ? String(vol.readFileSync(eventLog.file)) : '';
  vol.writeFileSync(
    eventLog.file,
    previous + JSON.stringify({ _e: 'metro:instantiate', _t: Date.now(), port }) + '\n'
  );
}

beforeEach(() => {
  vol.reset();
  eventLog.sessionDir = null;
});

describe(readPortArg, () => {
  it.each([
    [['start', '--port', '8082'], 8082],
    [['start', '--port=8083'], 8083],
    [['start', '-p', '8084'], 8084],
    [['start', '-p=8085'], 8085],
    [['run:ios', '--device', 'iPhone', '--port', '9000'], 9000],
  ])(`reads the port out of %p`, (args, expected) => {
    expect(readPortArg(args)).toBe(expected);
  });

  it.each([
    [['start']],
    [['start', '--port']],
    [['start', '--port', 'later']],
    // The value after the separator belongs to whatever `expo start` forwards it to.
    [['start', '--', '--port', '8082']],
  ])(`names no port in %p`, (args) => {
    expect(readPortArg(args)).toBeNull();
  });
});

describe(resolveDevServerPortAsync, () => {
  const watch = {
    isRunning: () => true,
    intervalMs: 1,
    timeoutMs: 50,
    servesAnotherProject: async () => false,
  };

  // `expo start` walks past a taken port, so the port it asked for is not the port it got.
  it.each([[['start']], [['start', '--port', '8082']]])(
    `resolves the port the dev server reported, whatever %p asked for`,
    async (args) => {
      report(8090);

      await expect(
        resolveDevServerPortAsync(projectRoot, args, { since: 1000, ...watch })
      ).resolves.toEqual({ port: 8090, source: 'reported' });
    }
  );

  it.each([
    [['start', '--port', '8082'], { port: 8082, source: 'arg' }],
    [['start'], { port: DEFAULT_DEV_SERVER_PORT, source: 'default' }],
  ])(
    `falls back to what %p asked for when the dev server reports nothing`,
    async (args, expected) => {
      await expect(
        resolveDevServerPortAsync(projectRoot, args, { since: 1000, ...watch })
      ).resolves.toEqual(expected);
    }
  );

  // A `LOG_EVENTS` file outlives the run, and a line that cannot prove it is this run's is skipped.
  it(`takes only a whole report written at or after the spawn`, async () => {
    vol.writeFileSync(
      eventLog.file,
      [
        JSON.stringify({ _e: 'metro:instantiate', _t: 500, port: 9000 }),
        '{"_e":"metro:instantiate","_t":2000,"po',
        JSON.stringify({ _e: 'metro:instantiate', port: 9001 }),
        JSON.stringify({ _e: 'metro:instantiate', _t: 2000, port: 8090 }),
      ].join('\n')
    );

    await expect(
      resolveDevServerPortAsync(projectRoot, ['start'], { since: 1000, ...watch })
    ).resolves.toEqual({ port: 8090, source: 'reported' });
  });

  // One `LOG_EVENTS` file can serve two runs at once, so a report in it can be the other run's.
  it(`skips a reported port another project's dev server answers`, async () => {
    report(8096);
    report(8097);

    await expect(
      resolveDevServerPortAsync(projectRoot, ['start'], {
        since: 1000,
        ...watch,
        servesAnotherProject: async (port) => port === 8096,
      })
    ).resolves.toEqual({ port: 8097, source: 'reported' });
  });

  // `2g` follows a session through its live socket and gives up silently when it cannot connect,
  // so the stream of reports can end while the dev server runs. The wait then goes on without it,
  // for as long as it would with no report at all.
  it(`keeps waiting when the stream of reports ends before the dev server does`, async () => {
    eventLog.sessionDir = path.join(path.sep, 'session');
    let running = true;
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const result = resolveDevServerPortAsync(projectRoot, ['start'], {
      since: 1000,
      intervalMs: 1,
      timeoutMs: 10,
      isRunning: () => running,
      stopped,
      servesAnotherProject: async () => true,
    });
    let settled = false;
    void result.then(() => (settled = true));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    running = false;
    stop();
    await expect(result).resolves.toBeNull();
  });

  it(`stops waiting as soon as the dev server is gone`, async () => {
    const startedAt = Date.now();

    await expect(
      resolveDevServerPortAsync(projectRoot, ['start'], {
        since: 1000,
        isRunning: () => false,
        intervalMs: 1000,
        timeoutMs: 60_000,
        servesAnotherProject: async () => false,
      })
    ).resolves.toEqual({ port: DEFAULT_DEV_SERVER_PORT, source: 'default' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it(`reads another project's root off the /status header of the fallback port`, async () => {
    const http = require('http') as typeof import('http');
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'X-React-Native-Project-Root': encodeURI('/somewhere/else') });
      response.end('packager-status:running');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as import('net').AddressInfo).port;

    try {
      await expect(
        resolveDevServerPortAsync(projectRoot, ['start', '--port', String(port)], {
          since: 1000,
          intervalMs: 1,
          timeoutMs: 10,
          isRunning: () => false,
        })
      ).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
