import fs from 'node:fs';
import path from 'node:path';

import { executeAgentCliAsync, setupFixtureAsync, waitForAsync } from '../utils';

const { version } = require('../../package.json') as { version: string };

type TelemetryRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: {
    sentAt: string;
    batch: {
      type: string;
      event: string;
      anonymousId: string;
      properties: Record<string, unknown>;
      context: {
        app: { name: string; version: string };
        agent?: { id: string; sessionId?: string };
        sandbox_provider?: string;
      };
    }[];
  };
};

type WorkerEvent = { type: 'spawn' | 'request' | 'settled' | 'aborted' | 'exit'; pid: number };

/**
 * Run the published bundle and its real detached worker. Only the final fetch is replaced: it
 * captures the production request and remains pending until the test releases it or its signal
 * aborts. No request from this suite can reach the telemetry service.
 *
 * Observing the real spawn in the parent makes "no worker" assertions synchronous with parent
 * exit, even when CI schedules a detached process late. It does not replace the child process.
 */
async function setupTelemetryAsync() {
  const projectRoot = await setupFixtureAsync('go-app');
  const directory = path.join(projectRoot, 'telemetry test');
  const home = path.join(directory, 'expo-home');
  const preload = path.join(directory, 'capture.cjs');
  const requestsFile = path.join(directory, 'requests.jsonl');
  const eventsFile = path.join(directory, 'workers.jsonl');
  const upstreamFile = path.join(directory, 'upstream.jsonl');
  const gateFile = path.join(directory, 'release');
  await fs.promises.mkdir(home, { recursive: true });
  await fs.promises.writeFile(
    path.join(home, 'state.json'),
    JSON.stringify({ uuid: 'fe2e0000-1234-4234-8234-123456789012' })
  );
  await fs.promises.writeFile(
    preload,
    String.raw`const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const requestsFile = ${JSON.stringify(requestsFile)};
const eventsFile = ${JSON.stringify(eventsFile)};
const gateFile = ${JSON.stringify(gateFile)};
const isWorker = (file) => typeof file === 'string' &&
  path.basename(file) === 'index.js' && path.basename(path.dirname(file)) === 'telemetry';
const record = (type, pid = process.pid) =>
  fs.appendFileSync(eventsFile, JSON.stringify({ type, pid }) + '\n');

// Block network access even if worker discovery breaks after a packaging change.
globalThis.fetch = async () => { throw new Error('Unexpected external request in telemetry test'); };

if (isWorker(process.argv[1])) {
  process.on('exit', () => record('exit'));
  let attempts = 0;
  globalThis.fetch = (url, options = {}) => {
    fs.appendFileSync(requestsFile, JSON.stringify({
      url: String(url),
      method: options.method,
      headers: Object.fromEntries(new Headers(options.headers)),
      body: JSON.parse(options.body),
    }) + '\n');
    record('request');
    if (++attempts <= Number(process.env.TELEMETRY_TEST_FAILURES || 0)) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (aborted) => {
        clearInterval(timer);
        options.signal?.removeEventListener('abort', onAbort);
        record(aborted ? 'aborted' : 'settled');
        if (aborted) reject(options.signal.reason);
        else resolve(new Response(null, { status: 200 }));
      };
      const onAbort = () => finish(true);
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setInterval(() => {
        if (fs.existsSync(gateFile)) finish(false);
      }, 20);
    });
  };
} else {
  if (process.argv[1]?.replaceAll('\\', '/').endsWith('/node_modules/expo/bin/cli')) {
    fs.appendFileSync(${JSON.stringify(upstreamFile)}, JSON.stringify({
      noTelemetry: process.env.EXPO_NO_TELEMETRY,
      offline: process.env.EXPO_OFFLINE,
      internal: process.env.__EXPO_AGENT_CLI_INTERNAL_INVOCATION,
    }) + '\n');
  }
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    const child = spawn.apply(this, arguments);
    if (Array.isArray(args) && isWorker(args[0])) record('spawn', child.pid);
    return child;
  };
}
`
  );

  function readLines<T>(file: string): T[] {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }

  const readEvents = () => readLines<WorkerEvent>(eventsFile);
  const readRequests = () => readLines<TelemetryRequest>(requestsFile);
  const releaseRequest = () => fs.promises.writeFile(gateFile, '');
  return {
    projectRoot,
    env: {
      // NODE_OPTIONS accepts double-quoted paths, including a fixture directory with spaces.
      NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
      __UNSAFE_EXPO_HOME_DIRECTORY: home,
      EXPO_NO_TELEMETRY: '0',
      DO_NOT_TRACK: '0',
      EXPO_OFFLINE: '0',
      EXPO_STAGING: '0',
      EXPO_LOCAL: '0',
      EXPO_TOKEN: undefined,
      TELEMETRY_TEST_FAILURES: '0',
      CODEX_THREAD_ID: 'telemetry-e2e-agent-session',
      E2B_SANDBOX: 'true',
      // These sandboxes precede E2B in the detector's list.
      REPLIT_SESSION: undefined,
      REPLIT_CONTAINER: undefined,
      REPLIT_USER: undefined,
      BOLT_ENV: undefined,
      BOLT_ORIGIN: undefined,
      BOLT_SERVER_URL: undefined,
    } satisfies Record<string, string | undefined>,
    readEvents,
    readRequests,
    releaseRequest,
    readUpstreamEnvironment: () => readLines<Record<string, string>>(upstreamFile),
    async waitForRequest() {
      expect(await waitForAsync(() => readRequests().length > 0, 10_000)).toBe(true);
      return readRequests()[0]!;
    },
    async close() {
      await releaseRequest();
      const workers = readEvents().filter((event) => event.type === 'spawn');
      const exited = await waitForAsync(
        () =>
          workers.every((worker) =>
            readEvents().some((event) => event.type === 'exit' && event.pid === worker.pid)
          ),
        10_000
      );
      if (!exited) {
        for (const worker of workers) {
          try {
            process.kill(worker.pid, 'SIGKILL');
          } catch {
            // It may have exited between reading the lifecycle log and cleanup.
          }
        }
      }
      await fs.promises.rm(path.dirname(projectRoot), { recursive: true, force: true });
      expect(exited, 'telemetry workers should exit after the request finishes').toBe(true);
    },
  };
}

describe('@expo/agent-cli telemetry', () => {
  let telemetry: Awaited<ReturnType<typeof setupTelemetryAsync>>;

  beforeEach(async () => {
    telemetry = await setupTelemetryAsync();
  });

  afterEach(async () => {
    await telemetry.close();
  });

  it('exits with the command result while its bundled telemetry request is still pending', async () => {
    const args = ['runtime', 'eval', '--json'];
    const baseline = await executeAgentCliAsync(telemetry.projectRoot, args, {
      env: { ...telemetry.env, EXPO_NO_TELEMETRY: '1' },
      reject: false,
    });
    const result = await executeAgentCliAsync(telemetry.projectRoot, args, {
      env: telemetry.env,
      reject: false,
    });
    const request = await telemetry.waitForRequest();

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(baseline.stdout);
    expect(result.stderr).toBe(baseline.stderr);
    expect(JSON.parse(result.stdout)).toHaveProperty('error');
    expect(telemetry.readEvents().map((event) => event.type)).toContain('request');
    expect(telemetry.readEvents().map((event) => event.type)).not.toContain('settled');
    expect(telemetry.readEvents().map((event) => event.type)).not.toContain('aborted');
    expect(telemetry.readEvents().map((event) => event.type)).not.toContain('exit');

    expect(request.url).toBe('https://cdp.expo.dev/v1/batch');
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('24TKR7CQAaGgIrLTgu3Fp4OdOkI:').toString('base64')}`,
      'content-type': 'application/json',
      'user-agent': `expo-agent-cli/${version}`,
    });
    expect(request.body.batch).toHaveLength(1);
    expect(request.body.batch[0]).toMatchObject({
      type: 'track',
      event: 'action',
      anonymousId: 'fe2e0000-1234-4234-8234-123456789012',
      properties: { action: 'expo-agent-cli runtime:eval' },
      context: {
        app: { name: 'expo/agent-cli', version },
        agent: { id: 'codex', sessionId: 'telemetry-e2e-agent-session' },
        sandbox_provider: 'e2b',
      },
    });
    expect(request.body.batch[0]!.properties).toEqual({ action: 'expo-agent-cli runtime:eval' });
  });

  it('retries the same event twice in the worker without waiting in the command process', async () => {
    const args = ['runtime:eval', '--json'];
    const baseline = await executeAgentCliAsync(telemetry.projectRoot, args, {
      env: { ...telemetry.env, EXPO_NO_TELEMETRY: '1' },
      reject: false,
    });
    const result = await executeAgentCliAsync(telemetry.projectRoot, args, {
      env: { ...telemetry.env, TELEMETRY_TEST_FAILURES: '2' },
      reject: false,
    });

    expect(result.exitCode).toBe(baseline.exitCode);
    expect(result.stdout).toBe(baseline.stdout);
    expect(result.stderr).toBe(baseline.stderr);
    expect(await waitForAsync(() => telemetry.readRequests().length === 3, 10_000)).toBe(true);
    const requests = telemetry.readRequests();
    expect(requests).toEqual([requests[0], requests[0], requests[0]]);
    expect(telemetry.readEvents().filter((event) => event.type === 'spawn')).toHaveLength(1);
    expect(telemetry.readEvents().map((event) => event.type)).not.toContain('settled');
    expect(telemetry.readEvents().map((event) => event.type)).not.toContain('exit');
    await telemetry.releaseRequest();
    expect(
      await waitForAsync(
        () => telemetry.readEvents().some((event) => event.type === 'exit'),
        10_000
      )
    ).toBe(true);
    expect(telemetry.readEvents().filter((event) => event.type === 'settled')).toHaveLength(1);
  });

  it('repairs a corrupt identity once across concurrent bundled workers', async () => {
    const home = telemetry.env.__UNSAFE_EXPO_HOME_DIRECTORY;
    const filename = path.join(home, 'agent-cli-telemetry-id');
    await fs.promises.unlink(path.join(home, 'state.json'));
    await fs.promises.writeFile(filename, 'corrupt');
    await telemetry.releaseRequest();

    await Promise.all(
      Array.from({ length: 4 }, () =>
        executeAgentCliAsync(telemetry.projectRoot, ['runtime:eval', '--json'], {
          env: telemetry.env,
          reject: false,
        })
      )
    );

    expect(await waitForAsync(() => telemetry.readRequests().length === 4, 10_000)).toBe(true);
    const saved = await fs.promises.readFile(filename, 'utf8');
    expect(saved).toMatch(/^[a-f0-9-]{36}$/);
    expect(telemetry.readRequests().map((request) => request.body.batch[0]!.anonymousId)).toEqual(
      Array(4).fill(saved)
    );
  });

  it('records a forwarded command without collecting arguments or changing its output', async () => {
    const args = ['prebuild', '--template', 'private-template-secret'];
    const baseline = await executeAgentCliAsync(telemetry.projectRoot, args, {
      env: { ...telemetry.env, EXPO_NO_TELEMETRY: '1' },
    });
    const result = await executeAgentCliAsync(telemetry.projectRoot, args, {
      env: telemetry.env,
    });
    const request = await telemetry.waitForRequest();

    expect(result.exitCode).toBe(0);
    // The stub's JSONL has its own timestamps, which legitimately differ between invocations.
    const readOutputEvents = (stdout: string) =>
      stdout
        .trim()
        .split('\n')
        .map((line) => {
          const { timestamp, ...event } = JSON.parse(line);
          expect(typeof timestamp).toBe('number');
          return event;
        });
    expect(readOutputEvents(result.stdout)).toEqual(readOutputEvents(baseline.stdout));
    // Windows batch shims emit DEP0190 with the current Node PID, even with telemetry disabled.
    const normalizeWarningPid = (stderr: string) =>
      stderr.replace(/^\(node:\d+\)(?= \[DEP0190\] DeprecationWarning:)/gm, '(node:PID)');
    expect(normalizeWarningPid(result.stderr)).toBe(normalizeWarningPid(baseline.stderr));
    expect(request.body.batch[0]!.properties).toEqual({ action: 'expo-agent-cli prebuild' });
    expect(JSON.stringify(request)).not.toContain('private-template-secret');
    expect(JSON.stringify(request)).not.toContain('--template');
    expect(telemetry.readRequests()).toHaveLength(1);
  });

  it('records one invocation when dev relaunches itself in the background', async () => {
    try {
      const result = await executeAgentCliAsync(
        telemetry.projectRoot,
        ['dev', '--web', '--no-open', '--detach', '--json'],
        {
          env: {
            ...telemetry.env,
            STUB_EXPO_DELAY_MS: '20000',
            STUB_EXPO_DEV_SERVER_PORT: '8396',
          },
        }
      );
      expect(JSON.parse(result.stdout)).toMatchObject({ alreadyRunning: false, ready: null });
      const request = await telemetry.waitForRequest();
      expect(request.body.batch[0]!.properties).toEqual({ action: 'expo-agent-cli dev:run' });
      expect(telemetry.readEvents().filter((event) => event.type === 'spawn')).toHaveLength(1);
      // The internal marker is consumed by our child; Expo keeps its own telemetry settings.
      expect(telemetry.readUpstreamEnvironment()).toEqual([{ noTelemetry: '0', offline: '0' }]);
    } finally {
      await executeAgentCliAsync(telemetry.projectRoot, ['dev:stop', '--json'], {
        env: { ...telemetry.env, EXPO_NO_TELEMETRY: '1' },
        reject: false,
      });
    }
  });

  it.each([
    [],
    ['--help'],
    ['--version'],
    ['help'],
    ['runtime'],
    ['runtime:eval', '--help'],
    ['runtime', 'eval', '-h'],
    ['prebuild', '--help'],
    ['private-unknown-command'],
    ['runtime:private-unknown-action'],
  ])('does not launch telemetry for %j', async (...args) => {
    await executeAgentCliAsync(telemetry.projectRoot, args, {
      env: telemetry.env,
      reject: false,
    });

    expect(telemetry.readEvents()).toEqual([]);
    expect(telemetry.readRequests()).toEqual([]);
  });

  it.each([
    ...['EXPO_NO_TELEMETRY', 'DO_NOT_TRACK'].flatMap((name) =>
      ['1', 'true', 'TRUE', 'yes', ''].map((value) => [name, value] as const)
    ),
    ['EXPO_OFFLINE', '1'] as const,
  ])('honors %s=%j before spawning a worker', async (name, value) => {
    const result = await executeAgentCliAsync(telemetry.projectRoot, ['runtime:eval', '--json'], {
      env: { ...telemetry.env, [name]: value },
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toHaveProperty('error');
    expect(telemetry.readEvents()).toEqual([]);
    expect(telemetry.readRequests()).toEqual([]);
  });

  it('bounds the detached worker lifetime when the telemetry request never completes', async () => {
    const result = await executeAgentCliAsync(telemetry.projectRoot, ['runtime:eval', '--json'], {
      env: telemetry.env,
      reject: false,
    });
    await telemetry.waitForRequest();

    expect(result.exitCode).toBe(1);
    expect(
      await waitForAsync(
        () => telemetry.readEvents().some((event) => event.type === 'exit'),
        10_000
      )
    ).toBe(true);
    expect(telemetry.readEvents().map((event) => event.type)).not.toContain('settled');
    expect(telemetry.readRequests()).toHaveLength(1);
  });
});
