import fs from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { executeAgentCliAsync, setupFixtureAsync } from '../utils';

const { version } = require('../../package.json') as { version: string };
const MESSAGE = 'Please improve how error messages explain actionable next steps.';
const SESSION_ID = 'session_ABC-123';

type FeedbackRequest = {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: {
    feedback: string;
    metadata: Record<string, unknown> & { feedbackId: string };
  };
};

/** Exercise the published bundle against a local HTTP endpoint, with no real user credentials. */
async function setupFeedbackAsync() {
  const projectRoot = await setupFixtureAsync('go-app');
  const directory = path.dirname(projectRoot);
  const home = path.join(directory, 'home');
  const expoHome = path.join(directory, 'custom Expo home');
  const stateFile = path.join(expoHome, 'state.json');
  await fs.promises.mkdir(expoHome, { recursive: true });
  await fs.promises.writeFile(
    stateFile,
    JSON.stringify({ auth: { sessionSecret: 'fixture-session-secret' } })
  );

  const requests: FeedbackRequest[] = [];
  let status = 200;
  let responseBody = '{}';
  let transportFailure: 'disconnect' | 'timeout' | undefined;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(body),
      });
      if (transportFailure === 'disconnect') {
        request.socket.destroy();
        return;
      }
      if (transportFailure === 'timeout') {
        return;
      }
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(responseBody);
    });
  });
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Guard the actual fetch rather than replacing it: even an endpoint regression cannot send
  // fixture feedback to production. EXPO_OFFLINE separately prevents command telemetry workers.
  const preload = path.join(directory, 'local-feedback-only.cjs');
  const telemetrySpawns = path.join(directory, 'telemetry-spawns.jsonl');
  await fs.promises.writeFile(
    preload,
    `const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const file = Array.isArray(args) ? args[0] : null;
  if (typeof file === 'string' && path.basename(file) === 'index.js' &&
      path.basename(path.dirname(file)) === 'telemetry') {
    fs.appendFileSync(${JSON.stringify(telemetrySpawns)}, JSON.stringify(args) + '\\n');
    throw new Error('Feedback test blocked a telemetry worker');
  }
  return spawn.apply(this, arguments);
};
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(String(url)).origin !== ${JSON.stringify(origin)}) {
    throw new Error('Feedback test blocked a non-local request');
  }
  return fetch(url, options);
};
`
  );

  return {
    projectRoot,
    stateFile,
    requests,
    telemetryWasSpawned: () => fs.existsSync(telemetrySpawns),
    readTelemetrySpawns: (): string[][] =>
      fs.existsSync(telemetrySpawns)
        ? fs
            .readFileSync(telemetrySpawns, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
    env: {
      HOME: home,
      USERPROFILE: home,
      __UNSAFE_EXPO_HOME_DIRECTORY: expoHome,
      NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
      EXPO_LOCAL: '1',
      EXPO_STAGING: undefined,
      EXPO_FEEDBACK_API_BASE_URL: origin,
      EXPO_TOKEN: undefined,
      EXPO_NO_TELEMETRY: '0',
      DO_NOT_TRACK: undefined,
      EXPO_OFFLINE: '1',
    } satisfies Record<string, string | undefined>,
    respondWith(code: number, body: string) {
      status = code;
      responseBody = body;
    },
    async crashAfterResult() {
      await fs.promises.appendFile(
        preload,
        `const log = console.log;
console.log = function (message) {
  log.apply(this, arguments);
  if (typeof message === 'string' && message.startsWith('{"sent":')) {
    process.nextTick(() => { throw new Error('Feedback fixture failed after printing'); });
  }
};
`
      );
    },
    async failTransportWith(failure: 'disconnect' | 'timeout') {
      transportFailure = failure;
      if (failure === 'timeout') {
        // Exercise a real aborted fetch without waiting for the production 15-second deadline.
        await fs.promises.appendFile(
          preload,
          'const timeout = AbortSignal.timeout;\nAbortSignal.timeout = () => timeout(1_000);\n'
        );
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.promises.rm(directory, { recursive: true, force: true });
    },
  };
}

describe('@expo/agent-cli feedback', () => {
  let feedback: Awaited<ReturnType<typeof setupFeedbackAsync>>;

  beforeEach(async () => {
    feedback = await setupFeedbackAsync();
  });

  afterEach(async () => {
    await feedback.close();
  });

  it('posts the existing feedback contract and teaches the new continuation command', async () => {
    const result = await executeAgentCliAsync(
      feedback.projectRoot,
      [
        'feedback',
        '--message',
        `  ${MESSAGE}  `,
        '--category',
        ' DOCS ',
        '--subject',
        ' https://docs.expo.dev/router/introduction/ ',
        '--resume',
        SESSION_ID,
      ],
      { env: { ...feedback.env, EXPO_TOKEN: 'fixture-token' } }
    );

    expect(result.exitCode).toBe(0);
    expect(feedback.requests).toHaveLength(1);
    const request = feedback.requests[0]!;
    expect(request).toMatchObject({
      method: 'POST',
      url: '/v2/feedback/cli-send',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fixture-token',
        'user-agent': `agent-cli/${version}`,
      },
      body: {
        feedback: MESSAGE,
        metadata: {
          category: 'docs',
          feedbackId: SESSION_ID,
          subject: 'https://docs.expo.dev/router/introduction/',
          cli: { name: 'agent-cli', version },
          agentEnvironment: { detected: expect.any(Boolean) },
          sandboxEnvironment: { detected: expect.any(Boolean) },
          device: { arch: process.arch, platform: process.platform },
          node: { version: process.versions.node },
          project: {
            isExpoProject: true,
            name: 'go-app',
            slug: 'go-app',
            sdkVersion: '54.0.0',
            platforms: ['ios', 'android', 'web'],
            expoPackageVersion: '54.0.0',
          },
        },
      },
    });
    expect(request.headers['expo-session']).toBeUndefined();
    expect(Object.keys(request.body).sort()).toEqual(['feedback', 'metadata']);
    expect(request.body.metadata).toHaveProperty('packageManager');
    expect(request.body.metadata).not.toHaveProperty('user');
    expect(JSON.stringify(request.body)).not.toContain('fixture-token');
    expect(JSON.stringify(request.body)).not.toContain('fixture-session-secret');
    expect(result.all).toContain('Thanks for the feedback!');
    expect(result.all).toContain(`--resume ${SESSION_ID} --message "<message>"`);
    expect(result.all).toMatch(/npx (?:--yes )?@expo\/agent-cli(?:@latest)? feedback/);
    expect(result.all).not.toContain('npx submit-expo-feedback');
  });

  it('supports aliases, a session in a custom Expo home, and one JSON result', async () => {
    const result = await executeAgentCliAsync(
      feedback.projectRoot,
      [
        'feedback',
        '-m',
        MESSAGE,
        '-c',
        ' AGENT-CLI ',
        '-s',
        'npx @expo/agent-cli status',
        '--json',
      ],
      { env: feedback.env }
    );

    const request = feedback.requests[0]!;
    expect(request.headers['expo-session']).toBe('fixture-session-secret');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body.metadata).toMatchObject({
      category: 'agent-cli',
      subject: 'npx @expo/agent-cli status',
    });
    expect(request.body.metadata.feedbackId).toMatch(/^[a-f0-9]{12}$/);
    expect(JSON.parse(result.stdout)).toEqual({
      sent: true,
      feedbackId: request.body.metadata.feedbackId,
    });
  });

  it('preserves one JSON result when a late error reaches the shared crash handler', async () => {
    await feedback.crashAfterResult();
    const result = await executeAgentCliAsync(
      feedback.projectRoot,
      ['feedback', '-m', MESSAGE, '--json'],
      { env: feedback.env, reject: false }
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      sent: true,
      feedbackId: feedback.requests[0]!.body.metadata.feedbackId,
    });
    expect(result.stderr).toContain('Feedback fixture failed after printing');
  });

  it('keeps dynamic config output off stdout in JSON mode', async () => {
    await fs.promises.writeFile(
      path.join(feedback.projectRoot, 'app.config.js'),
      `console.log('Config console diagnostic');
process.stdout.write('Config stdout diagnostic\\n');
module.exports = ({ config }) => ({ ...config, name: 'Dynamic config app' });
`
    );
    const result = await executeAgentCliAsync(
      feedback.projectRoot,
      ['feedback', '-m', MESSAGE, '--json'],
      { env: feedback.env }
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sent: true,
      feedbackId: feedback.requests[0]!.body.metadata.feedbackId,
    });
    expect(result.stderr).toContain('Config console diagnostic');
    expect(result.stderr).toContain('Config stdout diagnostic');
    expect(feedback.requests[0]!.body.metadata.project).toMatchObject({
      name: 'Dynamic config app',
    });
  });

  it('accepts deprecated positional feedback anonymously outside an Expo project', async () => {
    await fs.promises.rm(feedback.stateFile);
    const bareDirectory = path.join(path.dirname(feedback.projectRoot), 'bare');
    await fs.promises.mkdir(bareDirectory);
    const result = await executeAgentCliAsync(bareDirectory, ['feedback', ...MESSAGE.split(' ')], {
      env: feedback.env,
    });

    expect(feedback.requests).toHaveLength(1);
    const request = feedback.requests[0]!;
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['expo-session']).toBeUndefined();
    expect(request.body.feedback).toBe(MESSAGE);
    expect(request.body.metadata).toMatchObject({
      category: 'unknown',
      project: { isExpoProject: false },
    });
    expect(request.body.metadata).not.toHaveProperty('subject');
    expect(result.stderr).toContain('Passing feedback as a positional argument is deprecated.');
  });

  it('replaces an invalid resume ID and reports the generated ID', async () => {
    const result = await executeAgentCliAsync(
      feedback.projectRoot,
      ['feedback', '-m', MESSAGE, '--resume', 'invalid/id'],
      { env: feedback.env }
    );

    const id = feedback.requests[0]!.body.metadata.feedbackId;
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(result.all).toContain(
      `The provided feedback ID is invalid, so a new one was generated: ${id}`
    );
    expect(result.all).toContain(`--resume ${id}`);
  });

  it.each([
    { args: [], message: 'Feedback message is required in non-interactive environments.' },
    { args: ['-m', ' '], message: 'Feedback cannot be empty.' },
    { args: ['-m', 'a'.repeat(39)], message: 'Feedback must be at least 40 characters.' },
    { args: ['-m', 'a'.repeat(5_001)], message: 'Feedback cannot exceed 5,000 characters.' },
    {
      args: ['-m', MESSAGE, MESSAGE],
      message: 'either --message or a positional argument, not both',
    },
    { args: ['-m', MESSAGE, '-c', 'website'], message: 'Invalid feedback category "website".' },
    { args: ['--catgory', 'docs', MESSAGE], message: '--catgory' },
  ])('rejects invalid input without submitting: $message', async ({ args, message }) => {
    const result = await executeAgentCliAsync(
      feedback.projectRoot,
      ['feedback', ...args, '--json'],
      {
        env: feedback.env,
        reject: false,
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.all).toContain(message);
    expect(JSON.parse(result.stdout)).toHaveProperty('error');
    expect(feedback.requests).toEqual([]);
  });

  it.each([
    {
      body: JSON.stringify({ errors: [{ message: 'Feedback endpoint is unavailable.' }] }),
      message: 'Feedback endpoint is unavailable.',
    },
    { body: 'not json', message: 'Failed to send feedback (503 Service Unavailable)' },
  ])('surfaces the server failure: $message', async ({ body, message }) => {
    feedback.respondWith(503, body);
    const result = await executeAgentCliAsync(feedback.projectRoot, ['feedback', '-m', MESSAGE], {
      env: feedback.env,
      reject: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.all).toContain(message);
    expect(result.all).not.toContain('Thanks for the feedback!');
    expect(feedback.requests).toHaveLength(1);
  });

  it.each([
    ['DO_NOT_TRACK', '1'],
    ['DO_NOT_TRACK', 'true'],
    ['DO_NOT_TRACK', 'yes'],
    ['DO_NOT_TRACK', ''],
    ['EXPO_NO_TELEMETRY', '1'],
    ['EXPO_NO_TELEMETRY', 'true'],
    ['EXPO_NO_TELEMETRY', 'yes'],
    ['EXPO_NO_TELEMETRY', ''],
  ])('honors %s=%s before validating or submitting', async (name, value) => {
    const result = await executeAgentCliAsync(feedback.projectRoot, ['feedback', '--json'], {
      env: { ...feedback.env, EXPO_OFFLINE: '0', [name]: value },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sent: false, feedbackId: null });
    expect(result.stderr).toContain('Feedback was not sent because telemetry is off.');
    expect(result.stderr).toContain('Do not enable telemetry or ask the user to enable it.');
    expect(feedback.requests).toEqual([]);
    expect(feedback.telemetryWasSpawned()).toBe(false);
  });

  it.each(['disconnect', 'timeout'] as const)(
    'prints the JSON error envelope for a transport failure: %s',
    async (failure) => {
      await feedback.failTransportWith(failure);
      const result = await executeAgentCliAsync(
        feedback.projectRoot,
        ['feedback', '-m', MESSAGE, '--json'],
        { env: feedback.env, reject: false }
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        error: {
          code: 'FEEDBACK_ERROR',
          message: expect.stringContaining('Failed to send feedback:'),
          suggestedCommand: expect.stringContaining(' feedback --help'),
          needsHuman: null,
          data: null,
        },
      });
      expect(result.stderr).toContain('Failed to send feedback:');
      expect(result.all).not.toContain('Thanks for the feedback!');
      expect(feedback.requests).toHaveLength(1);
    }
  );

  it.each([
    ['DO_NOT_TRACK', '1'],
    ['DO_NOT_TRACK', 'true'],
    ['DO_NOT_TRACK', 'yes'],
    ['DO_NOT_TRACK', ''],
    ['EXPO_NO_TELEMETRY', '1'],
    ['EXPO_NO_TELEMETRY', 'true'],
    ['EXPO_NO_TELEMETRY', 'yes'],
    ['EXPO_NO_TELEMETRY', ''],
  ])(
    'prevents feedback and command telemetry when project config sets %s=%s',
    async (name, value) => {
      await fs.promises.writeFile(
        path.join(feedback.projectRoot, 'app.config.js'),
        `process.env.${name} = '${value}';\nmodule.exports = ({ config }) => config;\n`
      );
      const result = await executeAgentCliAsync(
        feedback.projectRoot,
        ['feedback', '-m', MESSAGE, '--json'],
        { env: { ...feedback.env, EXPO_OFFLINE: '0' } }
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ sent: false, feedbackId: null });
      expect(result.stderr).toContain('Feedback was not sent because telemetry is off.');
      expect(result.all).not.toContain('Thanks for the feedback!');
      expect(feedback.requests).toEqual([]);
      expect(feedback.telemetryWasSpawned()).toBe(false);
    }
  );

  it('records one command event when feedback remains enabled after loading config', async () => {
    const result = await executeAgentCliAsync(
      feedback.projectRoot,
      ['feedback', '-m', MESSAGE, '--json'],
      {
        env: {
          ...feedback.env,
          EXPO_OFFLINE: '0',
          EXPO_NO_TELEMETRY: 'false',
          DO_NOT_TRACK: 'false',
        },
      }
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('sent', true);
    expect(feedback.requests).toHaveLength(1);
    const spawns = feedback.readTelemetrySpawns();
    expect(spawns).toHaveLength(1);
    expect(JSON.parse(spawns[0]![1]!)).toMatchObject({ command: 'feedback', version });
  });

  it('offers help without submitting, including when telemetry is off', async () => {
    const result = await executeAgentCliAsync(feedback.projectRoot, ['feedback', '--help'], {
      env: { ...feedback.env, DO_NOT_TRACK: '1' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('npx @expo/agent-cli feedback');
    for (const option of ['--message', '--category', '--subject', '--resume', '--json']) {
      expect(result.stdout).toContain(option);
    }
    expect(result.stdout).toContain('agent-cli: full agent CLI command');
    expect(result.stdout).toContain('skills: exact skill name');
    expect(result.stdout).toContain('simulator: EAS Simulator feature or workflow');
    expect(result.stderr).not.toContain('Feedback was not sent');
    expect(feedback.requests).toEqual([]);
  });
});
