import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { cloudBindingFile, installStubEasAsync, STUB_EAS_SCRIPT, stubEasArgs } from './stubEas';
import {
  collectOutput,
  executeAgentCliAsync,
  expoHomeOf,
  freePortAsync,
  killAsync,
  setupFixtureAsync,
  spawnAgentCli,
  waitForAsync,
  waitForExitAsync,
} from './utils';

export async function detachedSessionFixture(platform: 'ios' | 'android') {
  const root = await setupFixtureAsync('go-app');
  const barrier = path.join(root, 'session-barrier');
  fs.mkdirSync(barrier);
  fs.mkdirSync(path.join(root, '.expo', 'dev', 'logs'), { recursive: true });
  const original = fs.readFileSync(STUB_EAS_SCRIPT, 'utf8').replace(/^#![^\n]*\n/, '');
  await installStubEasAsync(root, {
    script: `(async () => {
    if (['simulator', 'simulator:stop'].includes(process.argv[2])) {
      const fs = require('node:fs'), path = require('node:path');
      const directory = ${JSON.stringify(barrier)};
      const phase = process.argv[2] === 'simulator' ? 'start' : 'stop';
      fs.writeFileSync(path.join(directory, phase + '-entered'), String(process.pid));
      process.on('SIGTERM', () => {
        fs.writeFileSync(path.join(directory, phase + '-signalled'), '');
        process.exit(143);
      });
      await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (fs.existsSync(path.join(directory, phase + '-release'))) { clearInterval(poll); resolve(); }
        }, 20);
      });
      if (phase === 'start' && fs.existsSync(path.join(directory, 'no-receipt'))) process.exit(0);
    }
    ${original}
  })();`,
  });
  const expo = path.join(root, 'node_modules', 'expo', 'bin', 'cli');
  fs.writeFileSync(
    expo,
    `if (process.argv[2] === 'start') require('node:fs').writeFileSync(${JSON.stringify(path.join(barrier, 'metro-pid'))}, String(process.pid));\n` +
      fs.readFileSync(expo, 'utf8').replace(/^#![^\n]*\n/, '')
  );
  const id = randomUUID();
  const port = await freePortAsync();
  const child = spawnAgentCli(root, ['dev', `--${platform}`, '--eas', '--go', '--json'], {
    env: {
      __EXPO_AGENT_CLI_DETACHED: '1',
      __EXPO_AGENT_CLI_DETACHED_ATTEMPT: id,
      STUB_EXPO_LISTEN: '1',
      STUB_EXPO_DEV_SERVER_PORT: String(port),
      STUB_EXPO_DELAY_MS: '60000',
      STUB_EXPO_TUNNEL_HOST: 'receipt.tunnel.example',
      STUB_SIM_SESSIONS: '0',
      STUB_SIM_START_ID: `receipt-${platform}`,
    },
  });
  const output = collectOutput(child);
  const result = waitForExitAsync(child, output);
  const record = path.join(root, '.expo', 'dev', 'detached-run', `owner-${id}.json`);
  const binding = cloudBindingFile(expoHomeOf(root), fs.realpathSync(root), platform);
  const mark = (name: string) => path.join(barrier, name);
  const release = (phase: 'start' | 'stop') => fs.writeFileSync(mark(`${phase}-release`), '');
  const stop = (flags: string[] = [], timeout = '200ms') =>
    executeAgentCliAsync(root, ['dev:stop', ...flags, '--timeout', timeout, '--json'], {
      reject: false,
    });
  function metroDown(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const done = (closed: boolean) => {
        socket.destroy();
        resolve(closed);
      };
      socket.on('error', () => done(true));
      socket.on('connect', () => done(false));
      socket.setTimeout(300, () => done(false));
    });
  }
  async function entered(phase: 'start' | 'stop') {
    expect(
      await waitForAsync(() => fs.existsSync(mark(`${phase}-entered`)), 15_000),
      output.all
    ).toBe(true);
  }
  async function cleanup() {
    release('start');
    release('stop');
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
    await waitForAsync(() => child.exitCode != null || child.signalCode != null, 3000);
    for (const name of ['start-entered', 'stop-entered', 'metro-pid']) {
      if (!fs.existsSync(mark(name))) continue;
      const pid = Number(fs.readFileSync(mark(name), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
      } catch {}
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await killAsync(child, 'SIGKILL');
  }
  return {
    root,
    child,
    result,
    record,
    binding,
    mark,
    release,
    stop,
    metroDown,
    entered,
    cleanup,
    commands: () => stubEasArgs(root),
  };
}
