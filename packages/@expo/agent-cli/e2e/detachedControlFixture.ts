import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  collectOutput,
  executeAgentCliAsync,
  killAsync,
  setupFixtureAsync,
  spawnAgentCli,
  waitForAsync,
  waitForExitAsync,
} from './utils';

export async function detachedControlFixture(platform: 'ios' | 'android') {
  const root = await setupFixtureAsync('go-app');
  const barrier = path.join(root, 'config-barrier');
  fs.mkdirSync(barrier);
  fs.mkdirSync(path.join(root, '.expo', 'dev', 'logs'), { recursive: true });
  const script = path.join(root, 'node_modules', 'expo', 'bin', 'cli');
  const original = fs.readFileSync(script, 'utf8').replace(/^#![^\n]*\n/, '');
  fs.writeFileSync(
    script,
    `(async () => {
      if (process.argv[2] === 'config') {
        const fs = require('node:fs');
        const path = require('node:path');
        const directory = ${JSON.stringify(barrier)};
        fs.writeFileSync(path.join(directory, 'entered-' + process.pid), '');
        process.on('SIGTERM', () => {
          fs.writeFileSync(path.join(directory, 'cancelled-' + process.pid), '');
          process.exit(0);
        });
        await new Promise((resolve) => {
          const poll = setInterval(() => {
            if (fs.existsSync(path.join(directory, 'release'))) {
              clearInterval(poll);
              resolve();
            }
          }, 20);
        });
      }
      ${original}
    })();`
  );
  const children: ReturnType<typeof spawnAgentCli>[] = [];
  const args = ['dev', `--${platform}`, '--eas', '--go', '--no-open', '--json'];
  function start(extraArgs: string[] = []) {
    const id = randomUUID();
    const child = spawnAgentCli(root, [...args, ...extraArgs], {
      env: {
        __EXPO_AGENT_CLI_DETACHED: '1',
        __EXPO_AGENT_CLI_DETACHED_ATTEMPT: id,
      },
    });
    children.push(child);
    return { child, id, result: waitForExitAsync(child, collectOutput(child)) };
  }
  const marks = (name: string) =>
    fs.readdirSync(barrier).filter((file) => file.startsWith(`${name}-`));
  const record = (id: string) =>
    path.join(root, '.expo', 'dev', 'detached-run', `owner-${id}.json`);
  const run = (argv: string[]) => executeAgentCliAsync(root, argv, { reject: false });
  async function cleanup() {
    fs.writeFileSync(path.join(barrier, 'release'), '');
    await Promise.all(children.map((child) => killAsync(child, 'SIGKILL')));
    for (const file of marks('entered')) {
      const pid = Number(file.slice('entered-'.length));
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
      } catch {}
    }
    await waitForAsync(
      () => children.every((child) => child.exitCode != null || child.signalCode != null),
      5000
    );
  }
  return { root, barrier, start, marks, record, run, cleanup };
}
