import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { bin, collectOutput, setupFixtureAsync, waitForAsync, waitForExitAsync } from '../utils';

const MESSAGE = 'Please improve how error messages explain actionable next steps.';

describe('interactive feedback', () => {
  let projectRoot: string;
  let server: Server;
  let env: NodeJS.ProcessEnv;
  let requests: { feedback: string; metadata: { category: string } }[];

  beforeEach(async () => {
    projectRoot = await setupFixtureAsync('go-app');
    const directory = path.dirname(projectRoot);
    requests = [];
    server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        requests.push(JSON.parse(body));
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const preload = path.join(directory, 'interactive-feedback.cjs');
    // Run Clack's real key handling over pipes and block requests outside the local fixture.
    await fs.promises.writeFile(
      preload,
      `process.stdin.isTTY = true;
process.stdin.setRawMode = (raw) => raw ? process.stdin.ref() : process.stdin.unref();
process.stdout.isTTY = true;
process.stderr.isTTY = true;
process.stdout.columns = process.stderr.columns = 100;
process.stderr.rows = 40;
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(String(url)).origin !== ${JSON.stringify(origin)}) {
    throw new Error('Feedback test blocked a non-local request');
  }
  return fetch(url, options);
};
`
    );
    env = {
      ...process.env,
      HOME: path.join(directory, 'home'),
      USERPROFILE: path.join(directory, 'home'),
      __UNSAFE_EXPO_HOME_DIRECTORY: path.join(directory, 'expo-home'),
      NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
      CI: 'false',
      FORCE_COLOR: '0',
      EXPO_LOCAL: '1',
      EXPO_STAGING: undefined,
      EXPO_FEEDBACK_API_BASE_URL: origin,
      EXPO_TOKEN: undefined,
      EXPO_NO_TELEMETRY: '0',
      DO_NOT_TRACK: undefined,
      EXPO_OFFLINE: '1',
    };
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.promises.rm(path.dirname(projectRoot), { recursive: true, force: true });
  });

  async function runInteractiveAsync(
    args: string[],
    steps: { prompt: string; keys: string | null }[]
  ) {
    const child = spawn(process.execPath, [bin, 'feedback', ...args, '--json'], {
      cwd: projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = collectOutput(child);
    const ended = waitForExitAsync(child, output);
    try {
      for (const step of steps) {
        expect(
          await waitForAsync(() => output.stderr.includes(step.prompt), 10_000),
          output.all
        ).toBe(true);
        if (step.keys === null) child.stdin!.end();
        else child.stdin!.write(step.keys);
      }
      expect(await waitForAsync(() => child.exitCode !== null, 15_000), output.all).toBe(true);
      return await ended;
    } finally {
      if (child.exitCode === null) child.kill();
      await ended;
    }
  }

  it('selects a category and submits trimmed feedback while keeping stdout JSON', async () => {
    const result = await runInteractiveAsync(
      [],
      [
        { prompt: 'What is your feedback about?', keys: '\u001b[B'.repeat(3) + '\r' },
        { prompt: 'Share feedback with Expo', keys: `  ${MESSAGE}  \r` },
      ]
    );

    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ sent: true, feedbackId: expect.any(String) });
    expect(requests).toEqual([
      expect.objectContaining({
        feedback: MESSAGE,
        metadata: expect.objectContaining({ category: 'agent-cli' }),
      }),
    ]);
    expect(result.stderr).toContain('What is your feedback about?');
    expect(result.stderr).toContain('Share feedback with Expo');
  });

  it('preserves an explicit category without asking for it again', async () => {
    const result = await runInteractiveAsync(
      ['--category', 'docs'],
      [{ prompt: 'Share feedback with Expo', keys: `${MESSAGE}\r` }]
    );

    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout).sent).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ feedback: MESSAGE, metadata: { category: 'docs' } });
    expect(result.stderr).not.toContain('What is your feedback about?');
  });

  it('keeps prompting after invalid input and sends only the corrected message', async () => {
    const result = await runInteractiveAsync(
      ['--category', 'docs'],
      [
        { prompt: 'Share feedback with Expo', keys: `${MESSAGE.slice(0, 5)}\r` },
        {
          prompt: 'Feedback must be at least 40 characters.',
          keys: `${MESSAGE.slice(5)}\r`,
        },
      ]
    );

    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout).sent).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.feedback).toBe(MESSAGE);
  });

  it.each([
    ['Escape', '\u001b'],
    ['Ctrl-C', '\u0003'],
    ['Ctrl-D', '\u0004'],
    ['EOF', null],
  ])('cancels category selection on %s without sending feedback', async (_label, keys) => {
    const result = await runInteractiveAsync(
      [],
      [{ prompt: 'What is your feedback about?', keys }]
    );

    expect(result.exitCode, result.all).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'FEEDBACK_ERROR',
      message: 'Feedback prompt was cancelled.',
    });
    expect(result.stderr).not.toContain('Share feedback with Expo');
    expect(requests).toEqual([]);
  });

  it.each([
    ['Ctrl-C', '\u0003'],
    ['EOF', null],
  ])('cancels message input on %s without sending feedback', async (_label, keys) => {
    const result = await runInteractiveAsync(
      ['--category', 'agent-cli'],
      [{ prompt: 'Share feedback with Expo', keys }]
    );

    expect(result.exitCode, result.all).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'FEEDBACK_ERROR',
      message: 'Feedback prompt was cancelled.',
    });
    expect(requests).toEqual([]);
  });
});
