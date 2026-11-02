import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import {
  collectOutput,
  killAsync,
  setupFixtureAsync,
  spawnAgentCli,
  waitForAsync,
  waitForExitAsync,
} from './utils';

/** A real detached CLI and an external Expo server double, each independently observable. */
export async function detachedRunFixture() {
  const root = await setupFixtureAsync('go-app');
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const pidFile = path.join(root, 'recovery-server-pid');
  const script = path.join(root, 'node_modules', 'expo', 'bin', 'cli');
  // Observe the external process, without changing CLI internals or its process-group policy.
  fs.writeFileSync(
    script,
    fs
      .readFileSync(script, 'utf8')
      .replace(
        "'use strict';",
        `'use strict';\nif (process.argv[2] === 'start') require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`
      )
  );
  const env = {
    STUB_EXPO_LISTEN: '1',
    STUB_EXPO_DELAY_MS: '120000',
    STUB_EXPO_DEV_SERVER_PORT: String(port),
  };
  const owners = new Set<number>();
  async function run(args: string[]) {
    const child = spawnAgentCli(root, args, { env });
    const result = waitForExitAsync(child, collectOutput(child));
    const timer = setTimeout(() => void killAsync(child, 'SIGKILL'), 20_000);
    try {
      return await result;
    } finally {
      clearTimeout(timer);
    }
  }
  async function start() {
    const result = await run([
      'dev',
      '--android',
      '--go',
      '--local',
      '--no-open',
      '--port',
      String(port),
      '--detach',
      '--wait-ready',
      '--json',
    ]);
    if (result.exitCode === 0) owners.add(JSON.parse(result.stdout).pid);
    return result;
  }
  function serverPid() {
    return Number(fs.readFileSync(pidFile, 'utf8'));
  }
  async function stopServer() {
    if (!fs.existsSync(pidFile)) return;
    try {
      process.kill(serverPid(), 'SIGKILL');
    } catch {}
    await waitForAsync(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/status`);
        return false;
      } catch {
        return true;
      }
    }, 5000);
  }
  async function cleanup() {
    await run(['dev:stop', '--json']);
    for (const pid of owners) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await stopServer();
  }
  return { root, port, run, start, serverPid, stopServer, cleanup };
}
