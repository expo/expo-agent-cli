// @ref llp/0004-smart-start-and-project-state.rfc.md §Status
// Which port the lock publishes. The dev server picks it, not the wrapper, so the wrapper reads
// it back out of the dev server's report. `start.log` is the `@expo/cli` 57 report, which discovery
// still reads, and must not give the previous run's answer.

import { vol } from 'memfs';
import path from 'path';

import {
  DEFAULT_DEV_SERVER_PORT,
  readLastLoggedDevServerPort,
  readPortArg,
  resolveDevServerPortAsync,
} from '../port';

const projectRoot = path.join(path.sep, 'project');

/** The `LOG_EVENTS` file this process's `2g` writes, which the port watch reads Metro's report from. */
const eventLog = vi.hoisted(
  () => require('path').join(require('path').sep, 'events.jsonl') as string
);
vi.mock('2g', async (importOriginal) => ({
  ...(await importOriginal<typeof import('2g')>()),
  getEventLoggerInfo: () => ({
    destination: 'file',
    isUserVisibleOutput: false,
    debug: true,
    file: eventLog,
  }),
}));

/** Append Metro's report of `port` to the event log, as `2g` writes it. */
function report(port: number) {
  const previous = vol.existsSync(eventLog) ? String(vol.readFileSync(eventLog)) : '';
  vol.writeFileSync(
    eventLog,
    previous + JSON.stringify({ _e: 'metro:instantiate', _t: Date.now(), port }) + '\n'
  );
}
const startLogPath = path.join(projectRoot, '.expo', 'dev', 'logs', 'start.log');

/** Write a `start.log` from `metro:instantiate` entries, as `2g` serializes them (`_e`, `_t`). */
function writeStartLog(entries: { port: number; at: number }[]) {
  vol.fromJSON({
    [startLogPath]: entries
      .map(({ port, at }) => JSON.stringify({ _e: 'metro:instantiate', _t: at, port }))
      .join('\n'),
  });
}

beforeEach(() => vol.reset());

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

describe(readLastLoggedDevServerPort, () => {
  it(`reads the last logged port`, () => {
    writeStartLog([
      { port: 8082, at: 1000 },
      { port: 8090, at: 2000 },
    ]);

    expect(readLastLoggedDevServerPort(projectRoot)).toBe(8090);
  });

  it(`reports nothing without a log`, () => {
    expect(readLastLoggedDevServerPort(projectRoot)).toBeNull();
  });

  it(`survives a torn write`, () => {
    vol.fromJSON({
      [startLogPath]: [
        JSON.stringify({ _e: 'metro:instantiate', _t: 1000, port: 8082 }),
        '{"_e":"metro:instantiate","_t":2000,"po',
      ].join('\n'),
    });

    expect(readLastLoggedDevServerPort(projectRoot)).toBe(8082);
  });

  it(`ignores entries older than the run that is asking`, () => {
    // The log outlives the dev server that wrote it, so the previous run's port is exactly the
    // zombie answer this lock exists to make impossible.
    writeStartLog([{ port: 8090, at: 1000 }]);

    expect(readLastLoggedDevServerPort(projectRoot, { since: 2000 })).toBeNull();
    expect(readLastLoggedDevServerPort(projectRoot, { since: 1000 })).toBe(8090);
  });

  it(`takes the newest entry at or after the cutoff`, () => {
    writeStartLog([
      { port: 8090, at: 1000 },
      { port: 8082, at: 3000 },
    ]);

    expect(readLastLoggedDevServerPort(projectRoot, { since: 2000 })).toBe(8082);
  });

  it(`ignores an entry with no timestamp when a cutoff is given`, () => {
    vol.fromJSON({
      [startLogPath]: JSON.stringify({ _e: 'metro:instantiate', port: 8090 }),
    });

    expect(readLastLoggedDevServerPort(projectRoot, { since: 1000 })).toBeNull();
    // Without a cutoff the entry is still a candidate: discovery probes it before trusting it.
    expect(readLastLoggedDevServerPort(projectRoot)).toBe(8090);
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
